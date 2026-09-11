// Prints the raw manifest text during playback, driven by "tester:load" /
// "tester:stop" events dispatched from stream-tester.js. Fetches
// independently through /api/fetch rather than reaching into hls.js/dash.js
// internals — those libraries parse manifests into structured objects and
// don't reliably retain the raw text, and a separate fetch keeps this panel
// decoupled from whichever playback engine is in use.

import { fetchViaProxy, fetchCdnChain, analyzeSegment } from "./net.js";
import {
  parseMaster,
  extractPayloadFromTagLine,
  decodeScte35,
  formatDecoded,
  findCueWallclocks,
  findDashScte35Events,
  bytesFromBase64,
  extractMediaSequence,
  extractTargetDuration,
  detectSequenceGap,
  compareMediaSequence,
  findDiscontinuities,
  isPlaylistStale,
  findVariantLadderAnomalies,
  findHlsKeys,
  findDashContentProtection,
  summarizeDrm,
} from "./scte35.js";
import { escapeHtml, linkifyTagLine } from "./glossary.js";
import { analyzeTsSegment, compareSegmentBoundary } from "./tsanalyze.js";
import { buildCdnChain } from "./cdn-fingerprint.js";

const $ = (id) => document.getElementById(id);
const selectEl = $("manifest-select");
const intervalInput = $("manifest-interval");
const statusEl = $("manifest-status");
const healthEl = $("manifest-health");
const drmEl = $("manifest-drm");
const cdnEl = $("manifest-cdn");
const sequenceEl = $("manifest-sequence");
const outputEl = $("manifest-output");
const scteStatusEl = $("manifest-scte-status");
const scteOutputEl = $("manifest-scte-output");
const manifestDownloadBtn = $("manifest-download-btn");
const scteDownloadBtn = $("scte-download-btn");
const tsScanBtn = $("ts-scan-btn");
const tsScanCount = $("ts-scan-count");
const tsScanStatus = $("ts-scan-status");
const tsScanOutput = $("ts-scan-output");

let pollTimer = null;
let variants = [];
let currentFormat = null;
let lastSeq = null;
let lastDashEventsKey = null;
// The media playlist currently being polled. The segment scan needs it to
// resolve segment URIs, and it is NOT the URL the tester was given — that
// may have been a master.
let watchedPlaylistUrl = null;
let watchedPlaylistText = null;
let ladderAnomalies = []; // set once at master load; surfaced on every health update since it's a load-time, not per-poll, finding

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function intervalMs() {
  return Math.max(1, parseFloat(intervalInput.value) || 4) * 1000;
}

// Keeps a log box following new output WITHOUT stealing the scroll position
// from someone reading back through it.
//
// The rule: follow the tail only while the reader is already at the tail.
// Scroll up and your position is held, however many polls arrive; scroll
// back to the bottom and following re-arms on its own. No mode to toggle,
// nothing to remember — the scroll position IS the signal.
//
// Both boxes here update every few seconds, which is what makes the naive
// version unusable: the SCTE log appends and jumps to the newest line, and
// the manifest box replaces its whole contents (so assigning innerHTML
// resets the view to the top). Different mechanics, same problem.
//
// A few pixels of tolerance because scrollHeight/clientHeight/scrollTop can
// be fractional under browser zoom or a HiDPI scale factor, and an exact
// equality test would silently never match — leaving the log permanently
// "scrolled up" and never following again.
const SCROLL_TAIL_TOLERANCE_PX = 4;

function isPinnedToTail(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_TAIL_TOLERANCE_PX;
}

// Note for the replace-everything case (the manifest box): restoring the
// same scrollTop is the best available anchor, but a live playlist window
// slides — each poll drops a segment off the top and adds one at the
// bottom — so the lines under that offset drift by roughly one segment per
// poll. Far better than being thrown to the top, short of anchoring on a
// specific line's identity, which the sliding window makes its own problem.
function preservingScroll(el, mutate) {
  const pinned = isPinnedToTail(el);
  const previousTop = el.scrollTop;
  mutate();
  el.scrollTop = pinned ? el.scrollHeight : previousTop;
}

function appendScteHtml(html) {
  preservingScroll(scteOutputEl, () => {
    scteOutputEl.innerHTML += (scteOutputEl.textContent ? "\n" : "") + html;
  });
}

// Mirrors the old watch loop: only log when the media sequence actually
// advances, so an unchanged playlist window doesn't spam a new entry every
// poll. Manifests without a sequence number (master playlists) always get
// logged once and never re-logged on subsequent identical polls.
function updateScteCuesHls(text) {
  const seq = extractMediaSequence(text);
  if (seq !== null && seq === lastSeq) return;
  lastSeq = seq;

  const cueLines = findCueWallclocks(text);
  const seqTag = seq !== null ? ` SEQ=${seq}` : "";
  if (!cueLines.length) {
    appendScteHtml(escapeHtml(`[${ts()}]${seqTag}  no markers`));
    scteStatusEl.textContent = "Watching for cues…";
    return;
  }
  appendScteHtml(escapeHtml(`[${ts()}]${seqTag}  ** CUE MARKERS FOUND **`));
  for (const { line, wallclockIso, source } of cueLines) {
    appendScteHtml(`  ${linkifyTagLine(line)}`);
    if (wallclockIso) {
      const note = source === "timeline" ? " (interpolated from PROGRAM-DATE-TIME)" : "";
      appendScteHtml(escapeHtml(`    wallclock    : ${wallclockIso}${note}`));
    }
    const raw = extractPayloadFromTagLine(line);
    if (raw) for (const dline of formatDecoded(decodeScte35(raw))) appendScteHtml(dline);
  }
  appendScteHtml(escapeHtml("---"));
  scteStatusEl.textContent = `${cueLines.length} cue marker line(s) found.`;
}

// DASH MPDs have no media-sequence concept, so dedup on the set of event
// ids+times instead — same goal as the HLS SEQ check: don't re-log
// identical content on an unchanged (or irrelevantly-changed) poll.
function updateScteCuesDash(text) {
  const events = findDashScte35Events(text);
  const key = JSON.stringify(events.map((e) => [e.id, e.presentationTimeS]));
  if (key === lastDashEventsKey) return;
  lastDashEventsKey = key;

  if (!events.length) {
    appendScteHtml(escapeHtml(`[${ts()}]  no SCTE-35 EventStream signals`));
    scteStatusEl.textContent = "Watching for cues…";
    return;
  }
  appendScteHtml(escapeHtml(`[${ts()}]  ** SCTE-35 EVENTSTREAM SIGNAL(S) FOUND **`));
  for (const evt of events) {
    const parts = [`id=${evt.id ?? "?"}`];
    if (evt.presentationTimeS !== null) parts.push(`presentationTime=${evt.presentationTimeS}s`);
    if (evt.durationS !== null) parts.push(`duration=${evt.durationS}s`);
    appendScteHtml(escapeHtml(`  <Event ${parts.join(" ")}> (scheme: ${evt.schemeIdUri})`));
    if (evt.base64) {
      for (const dline of formatDecoded(decodeScte35(bytesFromBase64(evt.base64)))) appendScteHtml(dline);
    } else if (evt.xmlOnly) {
      appendScteHtml(escapeHtml("    (XML-encoded signal — decoding not yet supported, see ROADMAP.md)"));
    }
  }
  appendScteHtml(escapeHtml("---"));
  scteStatusEl.textContent = `${events.length} SCTE-35 EventStream signal(s) found.`;
}

function updateScteCues(text) {
  if (currentFormat === "hls") return updateScteCuesHls(text);
  if (currentFormat === "dash") return updateScteCuesDash(text);
}

// Renders the raw manifest with known vocabulary (SCTE cue tags,
// EXT-X-MEDIA/subtitle/caption/language attributes, DASH Role/Accessibility)
// linked to their glossary definitions — the same treatment the SCTE cue
// log already gets. outputEl.textContent still reads back the original
// unwrapped text afterwards (glossaryTerm only ever wraps existing
// substrings, never adds characters), so the unchanged-check and the
// "download manifest" button both keep working against the raw text.
function render(text) {
  if (outputEl.textContent === text) return;
  preservingScroll(outputEl, () => {
    outputEl.innerHTML = text.split("\n").map(linkifyTagLine).join("\n");
  });
  updateScteCues(text);
}

function stamp() {
  statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function clearPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function isLiveHlsPlaylist(text) {
  return !/#EXT-X-ENDLIST/.test(text);
}

function isDynamicMpd(text) {
  return /type="dynamic"/i.test(text);
}

// Health-check state is scoped per watch() call (per target), not
// module-level — comparing a variant's text/sequence against a *different*
// target's from before a dropdown switch would produce bogus findings.
function watch(url, stillLive) {
  clearPoll();
  let prevText = null;
  let lastHealthSeq = null;
  // Scoped per target for the same reason as the rest of this state: after
  // a dropdown switch the previous variant's sequence numbers say nothing
  // about this one, and every variant numbers itself independently.
  let sequenceAnomalies = [];
  let lastSeqChangeAtMs = null;
  let lastDrmFingerprint = null;
  let drmRotations = 0;
  let cdnChainChecked = false;

  // Runs once per watched target, not per poll — a CDN chain doesn't
  // change mid-session the way cue/health state does. Uses headers from
  // the SAME fetch already happening below rather than a second request;
  // DNS is fetched alongside as a supplementary signal (see
  // cdn-fingerprint.js for how the two get combined).
  async function updateCdnChain(headers) {
    if (cdnChainChecked) return;
    cdnChainChecked = true;
    cdnEl.textContent = "Checking CDN chain…";
    cdnEl.classList.remove("warn");
    try {
      const hostname = new URL(url).hostname;
      const dnsChain = await fetchCdnChain(hostname).catch(() => []);
      const result = buildCdnChain({ dnsChain, headers });
      const breadcrumb = result.chain.length
        ? result.chain.join(" → ")
        : "Couldn't identify a CDN from response headers or DNS";
      if (result.chainedSameCdn) {
        cdnEl.textContent = `⚠ Chained CDN (same vendor back-to-back): ${breadcrumb}`;
        cdnEl.classList.add("warn");
      } else {
        cdnEl.textContent = breadcrumb;
      }
    } catch (e) {
      cdnEl.textContent = `CDN chain check failed: ${e.message}`;
    }
  }

  function updateDrm(text) {
    const entries =
      currentFormat === "hls"
        ? findHlsKeys(text).map((k) => ({
            drmSystem: k.drmSystem,
            keyid: [k.uri, k.iv].filter(Boolean).join(" iv="),
          }))
        : findDashContentProtection(text).map((cp) => ({
            drmSystem: cp.drmSystem,
            keyid: cp.defaultKid,
          }));
    const { text: summary, fingerprint } = summarizeDrm(entries);
    if (lastDrmFingerprint !== null && fingerprint !== lastDrmFingerprint) drmRotations += 1;
    lastDrmFingerprint = fingerprint;
    drmEl.textContent = drmRotations > 0 ? `${summary} · key changed ${drmRotations}x this session` : summary;
  }

  // The sequence line answers a question the Health line can't: "is this
  // advancing the way it should *right now*". Health reports exceptions, so
  // silence there means either healthy or not-yet-checked; this states the
  // current step explicitly on every poll, and keeps a running tally of
  // anomalies so one that happened several polls ago doesn't scroll away
  // into nothing.
  function updateSequence(text) {
    if (currentFormat !== "hls") {
      sequenceEl.textContent = "";
      sequenceEl.className = "status";
      return;
    }
    const r = compareMediaSequence(prevText, text);
    const at = new Date().toISOString().slice(11, 19);

    if (r.state === "skipped") {
      sequenceAnomalies.push(`${at} skipped ${r.missing} (${r.prevSeq}→${r.currSeq})`);
    } else if (r.state === "rewound") {
      sequenceAnomalies.push(`${at} went backwards (${r.prevSeq}→${r.currSeq})`);
    }

    let text_ = "";
    let tone = "";
    switch (r.state) {
      case "first":
        text_ = `at ${r.currSeq} · ${r.segCount} segments · watching for the next poll to compare`;
        break;
      case "unknown":
        text_ = "no #EXT-X-MEDIA-SEQUENCE in this playlist — nothing to track";
        break;
      case "unchanged":
        text_ = `at ${r.currSeq} · +0, playlist unchanged since the last poll`;
        break;
      case "sequential":
        text_ = `at ${r.currSeq} · +${r.advanced} sequential — every segment accounted for`;
        tone = "ok";
        break;
      case "skipped":
        text_ =
          `at ${r.currSeq} · JUMPED +${r.advanced} over a ${r.prevSegCount}-segment window — ` +
          `${r.missing} segment(s) came and went unseen`;
        tone = "bad";
        break;
      case "rewound":
        text_ =
          `at ${r.currSeq} · WENT BACKWARDS from ${r.prevSeq} — the numbering restarted ` +
          `(packager restart or origin failover)`;
        tone = "bad";
        break;
    }

    if (sequenceAnomalies.length) {
      const recent = sequenceAnomalies.slice(-3).join(", ");
      text_ += ` · ${sequenceAnomalies.length} anomal${sequenceAnomalies.length === 1 ? "y" : "ies"} this session: ${recent}`;
      // A clean poll after a bad one must not read as all-clear — the
      // stream did skip, and that's the finding worth keeping in view.
      if (!tone) tone = "warn";
      if (tone === "ok") tone = "warn";
    }

    sequenceEl.textContent = text_;
    sequenceEl.className = "status" + (tone ? " " + tone : "");
  }

  function updateHealth(text) {
    if (currentFormat !== "hls") {
      healthEl.textContent = "";
      healthEl.classList.remove("warn");
      return;
    }
    const findings = [];
    const targetDuration = extractTargetDuration(text);
    const seq = extractMediaSequence(text);
    const now = Date.now();
    if (seq !== lastHealthSeq) {
      lastHealthSeq = seq;
      lastSeqChangeAtMs = now;
    }
    if (isPlaylistStale(now, lastSeqChangeAtMs, targetDuration)) {
      findings.push(`stale — no new segments for over ${targetDuration * 3}s`);
    }
    const discontinuities = findDiscontinuities(text);
    if (discontinuities.length) {
      findings.push(`${discontinuities.length} discontinuit${discontinuities.length === 1 ? "y" : "ies"}`);
    }
    if (prevText !== null) {
      const gap = detectSequenceGap(prevText, text);
      if (gap) {
        findings.push(`sequence gap — ~${gap.missing} segment(s) likely skipped (SEQ ${gap.prevSeq}→${gap.currSeq})`);
      }
    }
    prevText = text;
    for (const a of ladderAnomalies) findings.push(`ladder: ${a.note}`);
    healthEl.textContent = findings.length ? findings.join(" · ") : "OK";
    healthEl.classList.toggle("warn", findings.length > 0);
  }

  // Fetches once, then keeps re-fetching at the user's chosen interval as
  // long as `stillLive(text)` says so — stops itself once a VOD/static
  // manifest shows up.
  const poll = async () => {
    try {
      const { text, headers } = await fetchViaProxy(url);
      render(text);
      watchedPlaylistText = text;
      // Enable the segment scan only for HLS media playlists — it needs
      // #EXTINF segment URIs to resolve, which a master doesn't have.
      tsScanBtn.disabled = !(currentFormat === "hls" && /#EXTINF/.test(text));
      // Order matters: updateHealth() consumes prevText and then advances
      // it to this poll's text, so anything else comparing against the
      // previous fetch has to run first.
      updateSequence(text);
      updateHealth(text); // runs every poll, even when text is unchanged — staleness detection depends on that
      updateDrm(text);
      updateCdnChain(headers);
      stamp();
      if (!stillLive(text)) return;
    } catch (e) {
      statusEl.textContent = `Fetch error: ${e.message}`;
    }
    pollTimer = setTimeout(poll, intervalMs());
  };
  poll();
}

function watchTarget(url, stillLive) {
  watchedPlaylistUrl = url;
  watchedPlaylistText = null;
  tsScanBtn.disabled = true;
  lastSeq = null;
  lastDashEventsKey = null;
  scteOutputEl.textContent = "";
  scteStatusEl.textContent = "";
  watch(url, stillLive);
}

selectEl.addEventListener("change", () => {
  const idx = selectEl.value;
  if (idx === "master") {
    watchTarget(selectEl.dataset.masterUrl, () => false); // master playlists don't change
  } else {
    watchTarget(variants[Number(idx)].url, isLiveHlsPlaylist);
  }
});

async function startHls(url) {
  selectEl.innerHTML = "";
  selectEl.disabled = true;
  selectEl.dataset.masterUrl = url;
  statusEl.textContent = "Loading manifest…";
  try {
    const { text, finalUrl } = await fetchViaProxy(url);
    variants = parseMaster(text, finalUrl);
    ladderAnomalies = findVariantLadderAnomalies(variants);

    const masterOpt = document.createElement("option");
    masterOpt.value = "master";
    masterOpt.textContent = "Master playlist";
    selectEl.appendChild(masterOpt);
    variants.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Variant: ${v.bandwidth} bps${i === 0 ? " (lowest — default)" : ""}`;
      selectEl.appendChild(opt);
    });
    selectEl.disabled = false;

    if (variants.length) {
      selectEl.value = "0";
      watchTarget(variants[0].url, isLiveHlsPlaylist);
    } else {
      // No #EXT-X-STREAM-INF, so this URL is a media playlist handed to us
      // directly rather than a master. It still gets the real liveness
      // predicate: a live media playlist is exactly the thing worth
      // polling, and #EXT-X-ENDLIST answers the question just as well here
      // as it does for a variant reached through a master. This used to be
      // a hardcoded `() => false`, which fetched once and stopped — so a
      // directly-loaded live playlist showed a single frozen snapshot, and
      // anything comparing consecutive polls (sequence continuity, cue
      // dedupe, staleness) had nothing to work with.
      selectEl.value = "master";
      watchTarget(url, isLiveHlsPlaylist);
    }
  } catch (e) {
    statusEl.textContent = `Fetch error: ${e.message}`;
  }
}

function startDash(url) {
  selectEl.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "master";
  opt.textContent = "MPD";
  selectEl.appendChild(opt);
  selectEl.disabled = true;
  watchTarget(url, isDynamicMpd);
}

document.addEventListener("tester:load", (e) => {
  clearPoll();
  outputEl.textContent = "";
  scteStatusEl.textContent = "";
  scteOutputEl.textContent = "";
  healthEl.textContent = "";
  healthEl.classList.remove("warn");
  sequenceEl.textContent = "";
  sequenceEl.className = "status";
  drmEl.textContent = "";
  cdnEl.textContent = "";
  cdnEl.classList.remove("warn");
  ladderAnomalies = [];
  const { url, format } = e.detail;
  currentFormat = format;
  if (format === "hls") startHls(url);
  else startDash(url);
});

document.addEventListener("tester:stop", () => {
  clearPoll();
  statusEl.textContent = "Stopped.";
});

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

manifestDownloadBtn.addEventListener("click", () => {
  downloadText(outputEl.textContent, `manifest_${Date.now()}.log`);
});

scteDownloadBtn.addEventListener("click", () => {
  downloadText(scteOutputEl.textContent, `scte35_markers_${Date.now()}.log`);
});

// ---------------------------------------------------- segment byte scan

// Reads real segment bytes and reports what the manifest cannot: whether
// packets are intact, and whether continuity counters survive the joins
// between segments.
//
// Explicitly user-triggered, and it says so in the UI. Everything else in
// this panel costs a few KB per poll; this costs megabytes per click, so
// running it on a timer would quietly turn a diagnostic into a bandwidth
// bill. The count is capped in the markup for the same reason.
//
// The distinction it exists to draw: a counter RESET at every boundary is
// packager configuration, harmless to players that decode each segment
// independently, and the usual cause of ffmpeg reporting "Packet corrupt"
// once per segment on an otherwise perfect stream. A JUMP has the shape of
// real loss. Reporting them as one number sends people hunting for an
// encoder fault that isn't there.
function segmentUris(playlistText, playlistUrl) {
  const out = [];
  for (const raw of playlistText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      out.push(new URL(line, playlistUrl).href);
    } catch {
      /* a relative URI we can't resolve is skipped rather than fatal */
    }
  }
  return out;
}

function tsLine(text, cls) {
  tsScanOutput.innerHTML += (tsScanOutput.textContent ? "\n" : "") + (cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
}

async function runSegmentScan() {
  if (!watchedPlaylistText || !watchedPlaylistUrl) return;
  const want = Math.max(2, Math.min(6, parseInt(tsScanCount.value, 10) || 3));
  const uris = segmentUris(watchedPlaylistText, watchedPlaylistUrl).slice(0, want);
  if (uris.length < 2) {
    tsScanStatus.textContent = "Need at least 2 segments in the playlist window.";
    tsScanStatus.className = "status warn";
    return;
  }

  tsScanBtn.disabled = true;
  tsScanOutput.hidden = false;
  tsScanOutput.innerHTML = "";
  tsScanStatus.className = "status";
  tsScanStatus.textContent = `Fetching ${uris.length} segments…`;

  try {
    const scans = [];
    let totalBytes = 0;
    let via = null;
    for (let i = 0; i < uris.length; i++) {
      tsScanStatus.textContent = `Fetching segment ${i + 1} of ${uris.length}…`;
      const r = await analyzeSegment(uris[i], analyzeTsSegment);
      scans.push(r.analysis);
      totalBytes += r.bytes || 0;
      via = r.via;
    }

    const first = scans[0];
    tsLine(`${uris.length} segments, ${(totalBytes / 1048576).toFixed(1)} MB, fetched ${via === "proxy" ? "via the server proxy (CORS blocked a direct read)" : "directly from the browser"}`);
    if (first.pmt) {
      const streams = first.pmt.streams.map((x) => `0x${x.pid.toString(16).padStart(4, "0")} ${x.name}`);
      tsLine(`PMT: ${streams.join("   ")}`);
      if (!first.pmt.streams.some((x) => x.streamType === 0x86)) {
        tsLine("     no stream_type 0x86 — this stream carries no in-band SCTE-35", "line-muted");
      }
    }

    // Per-segment integrity. These are the flags that indicate genuinely
    // damaged media, as opposed to the boundary question below.
    let tei = 0, sync = 0, within = 0, unaligned = 0;
    for (const s of scans) {
      tei += s.transportErrors;
      sync += s.syncLoss;
      within += s.ccErrorsWithin;
      if (!s.aligned) unaligned += 1;
    }
    const clean = tei === 0 && sync === 0 && within === 0 && unaligned === 0;
    tsLine("");
    tsLine("integrity, per segment:");
    tsLine(`   transport_error_indicator ... ${tei}`, tei ? "line-bad" : "line-ok");
    tsLine(`   sync-byte loss .............. ${sync}`, sync ? "line-bad" : "line-ok");
    tsLine(`   188-byte misalignment ....... ${unaligned}`, unaligned ? "line-bad" : "line-ok");
    tsLine(`   CC errors WITHIN a segment .. ${within}`, within ? "line-bad" : "line-ok");

    // The boundary question, which a single-segment scan cannot answer.
    tsLine("");
    tsLine(`continuity ACROSS the ${scans.length - 1} boundar${scans.length - 1 === 1 ? "y" : "ies"}:`);
    let resets = 0, jumps = 0, coincidences = 0;
    for (let i = 1; i < scans.length; i++) {
      for (const r of compareSegmentBoundary(scans[i - 1], scans[i])) {
        if (r.state === "absent") continue;
        const label = `   seg ${i} -> ${i + 1}  PID 0x${r.pid.toString(16).padStart(4, "0")}${r.name ? ` (${r.name})` : ""}`;
        if (r.state === "reset") {
          resets += 1;
          tsLine(`${label}  last CC ${r.lastCc}, expected ${r.expected}, got ${r.firstCc} — RESET`, "line-bad");
        } else if (r.state === "jump") {
          jumps += 1;
          tsLine(`${label}  last CC ${r.lastCc}, expected ${r.expected}, got ${r.firstCc} — JUMP`, "line-bad");
        } else {
          if (r.coincidental) coincidences += 1;
          tsLine(`${label}  continuous (${r.lastCc} -> ${r.firstCc})${r.coincidental ? " — but a reset looks identical here" : ""}`, "line-ok");
        }
      }
    }

    tsLine("");
    if (resets && clean) {
      tsLine("VERDICT: counters restart at each segment. Nothing is damaged — no error flags,", "line-bad");
      tsLine("no sync loss, every segment internally continuous. This is what makes ffmpeg", "line-bad");
      tsLine("report \"Packet corrupt\" once per segment. It is a packager setting, not corrupt media.", "line-bad");
    } else if (jumps) {
      tsLine("VERDICT: counters JUMP across a boundary — the shape of genuine packet loss.", "line-bad");
    } else if (clean) {
      tsLine("VERDICT: clean. Counters carry across boundaries and no integrity flags are set.", "line-ok");
    } else {
      tsLine("VERDICT: integrity flags set above — see the per-segment counts.", "line-bad");
    }
    if (coincidences) {
      tsLine(`(${coincidences} boundary/ies read as continuous only because the previous segment ended at 15;`, "line-muted");
      tsLine(" a reset to 0 is indistinguishable there. Re-scan for a clearer read.)", "line-muted");
    }

    tsScanStatus.textContent = `Scanned ${uris.length} segments (${(totalBytes / 1048576).toFixed(1)} MB).`;
  } catch (e) {
    tsScanStatus.textContent = `Scan failed: ${e.message}`;
    tsScanStatus.className = "status warn";
  } finally {
    tsScanBtn.disabled = false;
  }
}

tsScanBtn.addEventListener("click", runSegmentScan);
