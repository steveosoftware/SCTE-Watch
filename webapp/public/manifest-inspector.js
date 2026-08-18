// Prints the raw manifest text during playback, driven by "tester:load" /
// "tester:stop" events dispatched from stream-tester.js. Fetches
// independently through /api/fetch rather than reaching into hls.js/dash.js
// internals — those libraries parse manifests into structured objects and
// don't reliably retain the raw text, and a separate fetch keeps this panel
// decoupled from whichever playback engine is in use.

import { fetchViaProxy, fetchCdnChain } from "./net.js";
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
  findDiscontinuities,
  isPlaylistStale,
  findVariantLadderAnomalies,
  findHlsKeys,
  findDashContentProtection,
  summarizeDrm,
} from "./scte35.js";
import { escapeHtml, linkifyTagLine } from "./glossary.js";
import { buildCdnChain } from "./cdn-fingerprint.js";

const $ = (id) => document.getElementById(id);
const selectEl = $("manifest-select");
const intervalInput = $("manifest-interval");
const statusEl = $("manifest-status");
const healthEl = $("manifest-health");
const drmEl = $("manifest-drm");
const cdnEl = $("manifest-cdn");
const outputEl = $("manifest-output");
const scteStatusEl = $("manifest-scte-status");
const scteOutputEl = $("manifest-scte-output");
const manifestDownloadBtn = $("manifest-download-btn");
const scteDownloadBtn = $("scte-download-btn");

let pollTimer = null;
let variants = [];
let currentFormat = null;
let lastSeq = null;
let lastDashEventsKey = null;
let ladderAnomalies = []; // set once at master load; surfaced on every health update since it's a load-time, not per-poll, finding

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function intervalMs() {
  return Math.max(1, parseFloat(intervalInput.value) || 4) * 1000;
}

function appendScteHtml(html) {
  scteOutputEl.innerHTML += (scteOutputEl.textContent ? "\n" : "") + html;
  scteOutputEl.scrollTop = scteOutputEl.scrollHeight;
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
  outputEl.innerHTML = text.split("\n").map(linkifyTagLine).join("\n");
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
      selectEl.value = "master";
      watchTarget(url, () => false);
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
