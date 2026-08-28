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
// Why it polls: these streams carry no #EXT-X-PROGRAM-DATE-TIME, so the
// manifest has no wallclock anchor and the only observable instant is
// "now" at the live edge. A single check yields a yes/no; watching across
// polls catches the asset transition and turns it into a drift figure.
//
// Credential policy (see CONTEXT.md): no Gracenote key is stored. The user
// supplies their own; it lives in memory for the page's lifetime, and
// every error path redacts it before anything reaches the DOM.

import {
  parseXmltv,
  parseGracenoteSchedule,
  normalizeXmltvSchedule,
  normalizeGracenoteSchedule,
  parseMediaPlaylistAssets,
  comparePlaybackToSchedule,
  buildObservationCsv,
  gracenoteScheduleUrl,
  addDays,
} from "./epg.js";
import { parseMaster } from "./scte35.js";
import { fetchViaProxy } from "./net.js";
import { escapeHtml, glossaryTerm } from "./glossary.js";

const $ = (id) => document.getElementById(id);
const playbackInput = $("epg-playback-url");
const intervalInput = $("epg-interval");
const keyInput = $("epg-key");
const prgSvcInput = $("epg-prgsvcid");
const dateInput = $("epg-date");
const daysInput = $("epg-days");
const xmltvInput = $("epg-xmltv-url");
const gracenoteFields = $("epg-gracenote-fields");
const xmltvFields = $("epg-xmltv-fields");
const runBtn = $("epg-run");
const stopBtn = $("epg-stop");
const downloadBtn = $("epg-download");
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
let lastStatusKey = null;

function appendLog(html) {
  outputEl.innerHTML += (outputEl.textContent ? "\n" : "") + html;
  outputEl.scrollTop = outputEl.scrollHeight;
}

const STATUS_TEXT = {
  match: "✓ correct asset playing",
  "wrong-asset": "⚠ WRONG ASSET — a different scheduled programme is playing",
  unscheduled: "⚠ UNSCHEDULED ASSET — playing something the schedule doesn't list at all",
  "no-asset-id": "· couldn't read an asset id from the segment URLs",
  "no-schedule": "· schedule has no entry covering right now",
};

function renderVerdict(result, nowMs) {
  const bad = result.status === "wrong-asset" || result.status === "unscheduled";
  verdictEl.className = "status " + (bad ? "warn" : "");
  const parts = [escapeHtml(STATUS_TEXT[result.status] ?? result.status)];
  parts.push(`playing <strong>${escapeHtml(result.playingAssetId ?? "—")}</strong>`);
  if (result.expected) {
    const title = result.expected.title ? ` (${escapeHtml(result.expected.title)})` : "";
    parts.push(`expected <strong>${escapeHtml(result.expected.assetId ?? "—")}</strong>${title}`);
  }
  if (result.drift) {
    const d = result.drift.seconds;
    parts.push(`${glossaryTerm("start-time drift")} ${d > 0 ? "+" : ""}${d}s`);
  }
  verdictEl.innerHTML = parts.join(" &nbsp;·&nbsp; ") + ` &nbsp;·&nbsp; ${ts(nowMs)}Z`;
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
  return normalizeGracenoteSchedule(parsed);
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
    const result = comparePlaybackToSchedule(playback, schedule, nowMs);

    renderVerdict(result, nowMs);

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
      appendLog(
        escapeHtml(
          `[${ts(nowMs)}] ${result.status.padEnd(13)} playing=${result.playingAssetId ?? "—"} ` +
            `expected=${expected}${title}`
        )
      );
      if (result.drift) {
        appendLog(
          escapeHtml(
            `    transition observed ${ts(result.drift.observedStartMs)} vs scheduled ` +
              `${ts(result.drift.scheduledStartMs)} → ${result.drift.seconds > 0 ? "+" : ""}${result.drift.seconds}s`
          )
        );
      }
    }

    for (const t of playback.transitions) {
      appendLog(escapeHtml(`    asset change in window: ${t.fromAssetId} → ${t.toAssetId} at ${ts(t.atMs)}`));
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
  downloadBtn.disabled = true;

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
