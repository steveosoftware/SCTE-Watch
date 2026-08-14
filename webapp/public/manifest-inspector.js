// Prints the raw manifest text during playback, driven by "tester:load" /
// "tester:stop" events dispatched from stream-tester.js. Fetches
// independently through /api/fetch rather than reaching into hls.js/dash.js
// internals — those libraries parse manifests into structured objects and
// don't reliably retain the raw text, and a separate fetch keeps this panel
// decoupled from whichever playback engine is in use.

import { fetchViaProxy } from "./net.js";
import {
  parseMaster,
  CUE_PATTERN,
  extractPayloadFromTagLine,
  decodeScte35,
  formatDecoded,
} from "./scte35.js";
import { escapeHtml, linkifyTagLine } from "./glossary.js";

const $ = (id) => document.getElementById(id);
const selectEl = $("manifest-select");
const intervalInput = $("manifest-interval");
const statusEl = $("manifest-status");
const outputEl = $("manifest-output");
const scteStatusEl = $("manifest-scte-status");
const scteOutputEl = $("manifest-scte-output");
const manifestDownloadBtn = $("manifest-download-btn");
const scteDownloadBtn = $("scte-download-btn");

let pollTimer = null;
let variants = [];
let currentFormat = null;
let lastSeq = null;

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
// poll. Manifests without a sequence number (master playlists, MPDs) always
// get logged once and never re-logged on subsequent identical polls.
function updateScteCues(text) {
  if (currentFormat !== "hls") return;

  const seqMatch = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  const seq = seqMatch ? seqMatch[1] : null;
  if (seq !== null && seq === lastSeq) return;
  lastSeq = seq;

  const lines = text.split(/\r?\n/);
  const markers = lines.filter((l) => CUE_PATTERN.test(l));
  const seqTag = seq !== null ? ` SEQ=${seq}` : "";
  if (!markers.length) {
    appendScteHtml(escapeHtml(`[${ts()}]${seqTag}  no markers`));
    scteStatusEl.textContent = "Watching for cues…";
    return;
  }
  appendScteHtml(escapeHtml(`[${ts()}]${seqTag}  ** CUE MARKERS FOUND **`));
  for (const marker of markers) {
    appendScteHtml(`  ${linkifyTagLine(marker)}`);
    const raw = extractPayloadFromTagLine(marker);
    if (raw) for (const dline of formatDecoded(decodeScte35(raw))) appendScteHtml(dline);
  }
  appendScteHtml(escapeHtml("---"));
  scteStatusEl.textContent = `${markers.length} cue marker line(s) found.`;
}

function render(text) {
  if (outputEl.textContent === text) return;
  outputEl.textContent = text;
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

// Fetches once, then keeps re-fetching at the user's chosen interval as long
// as `stillLive(text)` says so — stops itself once a VOD/static manifest shows up.
function watch(url, stillLive) {
  clearPoll();
  const poll = async () => {
    try {
      const { text } = await fetchViaProxy(url);
      render(text);
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
  scteStatusEl.textContent = "SCTE-35 cue detection is HLS-only.";
  watchTarget(url, isDynamicMpd);
}

document.addEventListener("tester:load", (e) => {
  clearPoll();
  outputEl.textContent = "";
  scteStatusEl.textContent = "";
  scteOutputEl.textContent = "";
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
