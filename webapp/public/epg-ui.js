// "EPG drift" panel — checks whether the asset actually playing on a linear
// channel is the one the schedule says should be playing right now.
//
// This compares the STREAM against a schedule, not two schedules against
// each other: two metadata sources can agree perfectly while the channel
// plays the wrong thing. The asset id comes out of the segment path
// (see extractAssetId), and the schedule side is either Gracenote or
// XMLTV — one or the other, never both, since in practice a channel has
// one or the other.
//
// Why it polls: the panel can't assume the manifest carries a wallclock
// anchor. Many streams publish #EXT-X-PROGRAM-DATE-TIME (playlist-level or
// per-segment) and many don't, so the only instant it can always observe
// is "now" at the live edge. A single check yields a yes/no; watching
// across polls catches the asset transition and turns it into a drift
// figure. Note it doesn't read PDT even where one exists — see
// parseMediaPlaylistAssets.
//
// Credential policy (see CONTEXT.md): the app never holds a Gracenote key
// of its own. The user supplies theirs; it goes only to Gracenote, never
// to our backend, and every error path redacts it before anything reaches
// the DOM. It is remembered in this browser's localStorage (opt-out via
// the checkbox) so it doesn't have to be retyped every session — see the
// storage block below for what that trade costs.

import {
  parseXmltv,
  parseGracenoteSchedule,
  normalizeXmltvSchedule,
  normalizeGracenoteSchedule,
  parseMediaPlaylistAssets,
  comparePlaybackToSchedule,
  buildObservationCsv,
  buildScheduleCsv,
  formatScheduleListing,
  gracenoteScheduleUrl,
  gracenoteProgramsUrl,
  parseGracenotePrograms,
  attachProgramTitles,
  distinctTmsIds,
  chunk,
  PROGRAMS_BATCH_SIZE,
  xumoAssetUrl,
  parseXumoAsset,
  isLikelyFiller,
  addDays,
} from "./epg.js";
import { parseMaster } from "./scte35.js";
import { fetchViaProxy } from "./net.js";
import { escapeHtml, glossaryTerm } from "./glossary.js";

const $ = (id) => document.getElementById(id);
const playbackInput = $("epg-playback-url");
const intervalInput = $("epg-interval");
const keyInput = $("epg-key");
const rememberKeyInput = $("epg-remember-key");
const prgSvcInput = $("epg-prgsvcid");
const dateInput = $("epg-date");
const daysInput = $("epg-days");
const xmltvInput = $("epg-xmltv-url");
const gracenoteFields = $("epg-gracenote-fields");
const xmltvFields = $("epg-xmltv-fields");
const runBtn = $("epg-run");
const stopBtn = $("epg-stop");
const downloadBtn = $("epg-download");
const printBtn = $("epg-print");
const downloadScheduleBtn = $("epg-download-schedule");
const statusEl = $("epg-status");
const verdictEl = $("epg-verdict");
const outputEl = $("epg-output");

dateInput.value = new Date().toISOString().slice(0, 10);

function selectedSource() {
  return document.querySelector('input[name="epg-source"]:checked').value;
}

function syncSourceFields() {
  const gn = selectedSource() === "gracenote";
  gracenoteFields.hidden = !gn;
  xmltvFields.hidden = gn;
}
for (const r of document.querySelectorAll('input[name="epg-source"]')) {
  r.addEventListener("change", syncSourceFields);
}
syncSourceFields();

// The Gracenote key is remembered in this browser's localStorage, opt-out
// via the checkbox. It's the one field worth persisting: everything else
// in the panel is an id or a URL that changes per check, while the key is
// the same long opaque string every session, and retyping it was the main
// friction in using the panel at all.
//
// What this does NOT change (see CONTEXT.md's credential policy): the key
// is still the user's own, still never sent anywhere but Gracenote, never
// held by our backend, never in a Lambda env var, never committed. The
// cost of persisting is that it now survives the tab — so on a shared
// machine, or with any XSS on this origin, the exposure window is every
// future visit rather than just the session. Hence: an explicit,
// visible toggle, and unticking it wipes the stored copy immediately.
const KEY_STORAGE_ID = "scte-watch.gracenote-api-key";
const REMEMBER_STORAGE_ID = "scte-watch.gracenote-remember-key";

// localStorage throws outright when storage is disabled (Safari private
// browsing, blocked cookies), so every access is guarded — a browser that
// won't persist should cost the user a retype, not a broken panel.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStored(id) {
  try {
    return storage()?.getItem(id) ?? null;
  } catch {
    return null;
  }
}

function writeStored(id, value) {
  try {
    if (value === null) storage()?.removeItem(id);
    else storage()?.setItem(id, value);
  } catch {
    /* storage unavailable or full — persistence is a convenience, not a requirement */
  }
}

function rememberingKey() {
  return rememberKeyInput.checked;
}

// An empty field stores nothing rather than an empty entry, so "no key
// remembered" and "a key remembered that happens to be blank" can't differ.
function persistKey() {
  writeStored(KEY_STORAGE_ID, rememberingKey() && keyInput.value ? keyInput.value : null);
}

// Restore before anything else touches the field, so a remembered key is
// already in place when the panel first renders.
(function restoreKey() {
  const remembered = readStored(REMEMBER_STORAGE_ID);
  rememberKeyInput.checked = remembered === null ? true : remembered === "1";
  if (rememberKeyInput.checked) keyInput.value = readStored(KEY_STORAGE_ID) ?? "";
})();

keyInput.addEventListener("input", persistKey);
rememberKeyInput.addEventListener("change", () => {
  writeStored(REMEMBER_STORAGE_ID, rememberingKey() ? "1" : "0");
  // Unticking is a "forget it" instruction, not just a preference for
  // next time — the stored copy goes now.
  persistKey();
});

function redact(s) {
  return String(s).replace(/api_key=[^&\s"']+/gi, "api_key=***");
}

function ts(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(11, 19);
}

let pollTimer = null;
let observations = [];
let mediaPlaylistUrl = null;
let schedule = [];
let scheduleLabel = "";
let printedSchedule = [];
let lastStatusKey = null;
const assetInfoCache = new Map();

// Transitions seen so far this session, keyed by the media-sequence number
// of the first segment of the new asset.
//
// Two problems this solves. First, a transition stays visible for as long
// as it's inside the playlist window (~60s), so re-reading it every poll
// re-reports the same event several times. Second, its wall-clock time is
// an ESTIMATE interpolated backwards from the live edge, and it shifts by
// up to a segment duration between polls as the window slides — so the
// same event appeared at 13:08:17, then :22, then :20. The sequence number
// doesn't move, so it's the identity; and the FIRST sighting is the most
// accurate estimate (fewest segments between the transition and the anchor
// at the live edge), so first write wins.
const seenTransitions = new Map();
const MAX_SEEN_TRANSITIONS = 500;

// One lookup per distinct asset, not per poll. Best-effort: a failure here
// must never sink the comparison, which is the actual job.
async function describeAsset(assetId) {
  if (!assetId) return null;
  if (assetInfoCache.has(assetId)) return assetInfoCache.get(assetId);
  let info = null;
  try {
    info = parseXumoAsset((await fetchViaProxy(xumoAssetUrl(assetId))).text);
  } catch {
    info = null;
  }
  assetInfoCache.set(assetId, info);
  return info;
}

// `cls` tints one line (see logTone). Kept as an inline span rather than a
// full-width block so this <pre> keeps real newlines in its text content.
function appendLog(html, cls = "") {
  const line = cls ? `<span class="${cls}">${html}</span>` : html;
  outputEl.innerHTML += (outputEl.textContent ? "\n" : "") + line;
  outputEl.scrollTop = outputEl.scrollHeight;
}

const STATUS_TEXT = {
  match: "✓ correct asset playing",
  "wrong-asset": "⚠ WRONG ASSET — a different scheduled programme is playing",
  unscheduled: "⚠ UNSCHEDULED ASSET — playing something the schedule doesn't list at all",
  "no-asset-id": "· couldn't read an asset id from the segment URLs",
  "no-schedule": "· schedule has no entry covering right now",
};

// "unscheduled" has three causes and they matter very differently. In
// order of how often they actually occur:
//
//   1. Ad slate / filler in a break. EPGs schedule programmes, not break
//      filler, so short-form content is legitimately absent. NOT drift.
//      Detected via the asset's contentType (see isLikelyFiller).
//   2. Genuine drift — an episode playing that the schedule never lists.
//   3. A mispaired channel: the playback URL and the schedule id are
//      different channels. Nothing links the Xumo channel id and Gracenote
//      prgSvcId namespaces, so this can't be checked automatically.
//
// Real drift more usually surfaces as `wrong-asset` (playing something
// that IS scheduled, at the wrong time), which is why `unscheduled` alone
// shouldn't be presented as an alarm.
const FILLER_NOTE = "short-form filler (ad slate/bumper) — EPGs don't schedule break filler, so this is expected in a break, not drift";
const PAIRING_HINT =
  "not filler and not on the schedule — either genuine drift, or the playback URL " +
  "and the schedule id are different channels (nothing links those two id namespaces, so this can't be checked automatically)";

// One rule for both the banner and the log line, so they can't disagree
// about how serious something is:
//   ok   — the right asset is on air
//   bad  — a real finding: the wrong asset, or unscheduled content that
//          isn't break filler
//   ""   — neither. Filler in an ad break is routine and must not read as
//          an alarm; no-asset-id/no-schedule are the tool not knowing,
//          which is not the same as the channel being wrong.
function toneFor(result, info) {
  if (result.status === "match") return "ok";
  if (result.status === "wrong-asset") return "bad";
  if (result.status === "unscheduled") return isLikelyFiller(info) ? "" : "bad";
  return "";
}

function renderVerdict(result, nowMs, info) {
  const tone = toneFor(result, info);
  verdictEl.className = "status " + tone;
  const parts = [escapeHtml(STATUS_TEXT[result.status] ?? result.status)];
  const playingLabel = info && info.title ? `${result.playingAssetId} — ${info.title}` : result.playingAssetId ?? "—";
  parts.push(`playing <strong>${escapeHtml(playingLabel)}</strong>`);
  if (result.expected) {
    const title = result.expected.title ? ` (${escapeHtml(result.expected.title)})` : "";
    parts.push(`expected <strong>${escapeHtml(result.expected.assetId ?? "—")}</strong>${title}`);
  }
  if (result.drift) {
    const d = result.drift.seconds;
    parts.push(`${glossaryTerm("start-time drift")} ${d > 0 ? "+" : ""}${d}s`);
  }
  let html = parts.join(" &nbsp;·&nbsp; ") + ` &nbsp;·&nbsp; ${ts(nowMs)}Z`;
  if (result.status === "unscheduled") {
    html += `<br><span class="note">${escapeHtml(isLikelyFiller(info) ? FILLER_NOTE : PAIRING_HINT)}</span>`;
  }
  verdictEl.innerHTML = html;
}

async function loadSchedule() {
  if (selectedSource() === "xmltv") {
    const url = xmltvInput.value.trim();
    if (!url) throw new Error("Need an XMLTV URL");
    const parsed = parseXmltv((await fetchViaProxy(url)).text);
    scheduleLabel = `XMLTV · ${parsed.channel.displayName ?? "?"} (${parsed.channel.id ?? "?"})`;
    for (const w of parsed.warnings) appendLog(escapeHtml(`⚠ ${w}`));
    return normalizeXmltvSchedule(parsed);
  }
  const apiKey = keyInput.value.trim();
  const prgSvcId = prgSvcInput.value.trim();
  const startDate = dateInput.value;
  const days = Math.max(1, parseInt(daysInput.value, 10) || 2);
  if (!apiKey || !prgSvcId || !startDate) throw new Error("Need a Gracenote key, prgSvcId and start date");
  const endDate = addDays(startDate, days);
  if (!endDate) throw new Error("Start date is not a valid YYYY-MM-DD date");
  const parsed = parseGracenoteSchedule(
    (await fetchViaProxy(gracenoteScheduleUrl({ apiKey, prgSvcId, startDate, endDate }))).text
  );
  scheduleLabel = `Gracenote · prgSvcId ${prgSvcId}`;
  for (const w of parsed.warnings) appendLog(escapeHtml(`⚠ ${w}`));
  let sched = normalizeGracenoteSchedule(parsed);

  // /Schedules carries no titles, only TMS ids. Fetch them from /Programs
  // so the report is readable — batched over distinct ids, and entirely
  // best-effort: a failure here costs titles, never the comparison.
  const ids = distinctTmsIds(sched);
  if (ids.length) {
    const batches = chunk(ids, PROGRAMS_BATCH_SIZE);
    statusEl.textContent = `Fetching titles for ${ids.length} programmes…`;
    const merged = new Map();
    let failed = 0;
    for (const batch of batches) {
      try {
        const text = (await fetchViaProxy(gracenoteProgramsUrl({ apiKey, tmsIds: batch }))).text;
        for (const [k, v] of parseGracenotePrograms(text)) merged.set(k, v);
      } catch {
        failed += 1;
      }
    }
    if (merged.size) sched = attachProgramTitles(sched, merged);
    appendLog(
      escapeHtml(
        `titles: resolved ${merged.size} of ${ids.length} distinct programmes` +
          (failed ? ` (${failed} of ${batches.length} batches failed)` : "")
      )
    );
  }
  return sched;
}

// Accepts either a master or a media playlist. A master gets resolved to
// its lowest-bandwidth variant — same convention the Manifest Inspector
// uses, and the rendition doesn't matter here since every variant carries
// the same asset in its segment paths.
async function resolveMediaPlaylist(url) {
  const { text, finalUrl } = await fetchViaProxy(url);
  if (!/#EXT-X-STREAM-INF/.test(text)) return url;
  const variants = parseMaster(text, finalUrl);
  if (!variants.length) throw new Error("Master playlist lists no variants");
  return variants[0].url;
}

async function poll() {
  try {
    const { text } = await fetchViaProxy(mediaPlaylistUrl);
    const nowMs = Date.now();
    const playback = parseMediaPlaylistAssets(text, nowMs);

    // Record only transitions we haven't already logged, and keep each
    // one's first (best) time estimate rather than the latest wobble.
    const freshTransitions = [];
    for (const t of playback.transitions) {
      const id = t.atSequence ?? `${t.fromAssetId}->${t.toAssetId}@${t.atMs}`;
      if (!seenTransitions.has(id)) {
        seenTransitions.set(id, t);
        freshTransitions.push(t);
      }
    }
    if (seenTransitions.size > MAX_SEEN_TRANSITIONS) {
      for (const k of [...seenTransitions.keys()].slice(0, seenTransitions.size - MAX_SEEN_TRANSITIONS)) {
        seenTransitions.delete(k);
      }
    }

    // Compare against the stable set, so the drift figure stops jittering
    // once a transition has been observed.
    const stablePlayback = { ...playback, transitions: [...seenTransitions.values()] };
    const result = comparePlaybackToSchedule(stablePlayback, schedule, nowMs);
    const info = await describeAsset(result.playingAssetId);

    renderVerdict(result, nowMs, info);

    // Log only when something changes — a monitor that reprints an
    // unchanged line every few seconds buries the events that matter.
    const key = `${result.status}|${result.playingAssetId}|${result.expected?.assetId ?? ""}`;
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      observations.push({
        atMs: nowMs,
        status: result.status,
        playingAssetId: result.playingAssetId,
        expected: result.expected,
        drift: result.drift,
        note: scheduleLabel,
      });
      downloadBtn.disabled = false;

      const expected = result.expected ? result.expected.assetId ?? "—" : "—";
      const title = result.expected?.title ? `  ${result.expected.title}` : "";
      const tone = toneFor(result, info);
      appendLog(
        escapeHtml(
          `[${ts(nowMs)}] ${result.status.padEnd(13)} playing=${result.playingAssetId ?? "—"} ` +
            `expected=${expected}${title}`
        ),
        tone ? `line-${tone}` : ""
      );
      if (info && info.title) {
        appendLog(
          escapeHtml(`    asset: ${info.title} (${info.contentType ?? "?"}${info.runtimeS ? ", " + info.runtimeS + "s" : ""})`),
          "line-muted"
        );
      }
      if (result.status === "unscheduled") {
        appendLog(escapeHtml(`    ${isLikelyFiller(info) ? FILLER_NOTE : PAIRING_HINT}`), "line-muted");
      }
      if (result.drift) {
        appendLog(
          escapeHtml(
            `    started ~${ts(result.drift.observedStartMs)}, scheduled ${ts(result.drift.scheduledStartMs)}` +
              ` → ${result.drift.seconds > 0 ? "+" : ""}${result.drift.seconds}s` +
              ` (±1 segment; estimated from the live edge, not read from PROGRAM-DATE-TIME)`
          ),
          "line-muted"
        );
      }
    }

    // Only newly-seen transitions, so an event is reported once.
    for (const t of freshTransitions) {
      const at = t.atSequence !== null && t.atSequence !== undefined ? ` (segment #${t.atSequence})` : "";
      appendLog(escapeHtml(`    asset transition: ${t.fromAssetId} → ${t.toAssetId} at ~${ts(t.atMs)}${at}`), "line-muted");
    }

    statusEl.textContent = `Watching · ${observations.length} event(s) logged`;
  } catch (e) {
    statusEl.textContent = `Error: ${redact(e.message)}`;
    statusEl.classList.add("warn");
  }
  const intervalMs = Math.max(1, parseFloat(intervalInput.value) || 10) * 1000;
  pollTimer = setTimeout(poll, intervalMs);
}

function stop() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  runBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.classList.remove("warn");
  statusEl.textContent = `Stopped · ${observations.length} event(s) logged`;
}

runBtn.addEventListener("click", async () => {
  outputEl.innerHTML = "";
  verdictEl.innerHTML = "";
  verdictEl.className = "status";
  statusEl.classList.remove("warn");
  observations = [];
  lastStatusKey = null;
  seenTransitions.clear();
  downloadBtn.disabled = true;
  printedSchedule = [];
  downloadScheduleBtn.disabled = true;

  const playbackUrl = playbackInput.value.trim();
  if (!playbackUrl) {
    statusEl.textContent = "Need a playback URL.";
    return;
  }

  runBtn.disabled = true;
  try {
    statusEl.textContent = "Loading schedule…";
    schedule = await loadSchedule();
    if (!schedule.length) throw new Error("Schedule loaded but contains no programmes");
    appendLog(escapeHtml(`schedule: ${scheduleLabel} · ${schedule.length} programmes`));
    // The schedule is in hand either way, so offer it without making the
    // user stop the run to press Print.
    printedSchedule = schedule;
    downloadScheduleBtn.disabled = false;

    statusEl.textContent = "Resolving playlist…";
    mediaPlaylistUrl = await resolveMediaPlaylist(playbackUrl);
    appendLog(escapeHtml(`watching: ${mediaPlaylistUrl}`));

    stopBtn.disabled = false;
    await poll();
  } catch (e) {
    statusEl.textContent = `Error: ${redact(e.message)}`;
    statusEl.classList.add("warn");
    runBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", stop);

downloadBtn.addEventListener("click", () => {
  if (!observations.length) return;
  const blob = new Blob([buildObservationCsv(observations)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `epg_drift_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// "Print schedule" — the listing on its own, with no stream involved.
// Useful before a drift run (does this prgSvcId look like the right
// channel?) and afterwards (what was actually meant to be airing?), and
// it's the only way to see the schedule for someone who has no key of
// their own to paste into the panel.
//
// While a run is in progress this prints the schedule already loaded
// rather than re-fetching: it's the same channel and window, and a second
// fetch would spend the user's quota and interleave with the live log.
printBtn.addEventListener("click", async () => {
  const running = pollTimer !== null;
  printBtn.disabled = true;
  statusEl.classList.remove("warn");
  try {
    if (!running) {
      outputEl.innerHTML = "";
      verdictEl.innerHTML = "";
      statusEl.textContent = "Loading schedule…";
      schedule = await loadSchedule();
    }
    printedSchedule = schedule;
    if (!printedSchedule.length) throw new Error("Schedule loaded but contains no programmes");
    for (const line of formatScheduleListing(printedSchedule, { label: scheduleLabel, nowMs: Date.now() })) {
      appendLog(escapeHtml(line));
    }
    downloadScheduleBtn.disabled = false;
    if (!running) statusEl.textContent = `Schedule printed · ${printedSchedule.length} programme(s)`;
  } catch (e) {
    statusEl.textContent = `Error: ${redact(e.message)}`;
    statusEl.classList.add("warn");
  }
  printBtn.disabled = false;
});

downloadScheduleBtn.addEventListener("click", () => {
  if (!printedSchedule.length) return;
  const blob = new Blob([buildScheduleCsv(printedSchedule)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `epg_schedule_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
