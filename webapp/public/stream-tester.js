// HLS/DASH playback tester, wired to hls.js and dash.js (loaded globally via
// CDN <script> tags in index.html, since neither ships a reliably-versioned
// ESM build across CDNs).
//
// Unlike the watch panel, this fetches manifests and segments directly from
// the browser rather than through /api/fetch — MSE needs real byte streams,
// and proxying binary segments through a JSON/base64 endpoint would be both
// wasteful and broken for live/low-latency playback. That means playback
// here is subject to the origin's real CORS policy, same as it would be for
// an end user; a CORS failure is a genuine finding about the stream, not a
// bug in this tool.

const $ = (id) => document.getElementById(id);

const urlInput = $("tester-url");
const formatSelect = $("tester-format");
const loadBtn = $("tester-load");
const stopBtn = $("tester-stop");
const video = $("tester-video");
const statusEl = $("tester-status");
const bandwidthEl = $("tester-bandwidth");
const qualityEl = $("tester-quality");
const bufferEl = $("tester-buffer");
const droppedEl = $("tester-dropped");
const startupEl = $("tester-startup");
const variantsTable = $("tester-variants");
const variantsBody = variantsTable.querySelector("tbody");
const testerLog = $("tester-log");

let hls = null;
let dashPlayer = null;
let statsTimer = null;
let loadStart = 0;
let startupMeasured = false;

// Embedded CEA-608/708 captions and sidecar WebVTT subtitles both land as
// native <video> TextTracks (kind "captions" vs "subtitles" respectively).
// When a stream carries both, hls.js/dash.js can leave both in "showing"
// mode and the browser renders both overlays at once — the "doubling".
// Force sidecar tracks off so only the embedded captions render.
function suppressSidecarSubtitles(track) {
  if (track.kind === "subtitles") track.mode = "disabled";
}
video.textTracks.addEventListener("addtrack", (e) => suppressSidecarSubtitles(e.track));

function tlog(msg) {
  testerLog.textContent += `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  testerLog.scrollTop = testerLog.scrollHeight;
}

function fmtBps(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kbps`;
  return `${n} bps`;
}

function detectFormat(url) {
  const choice = formatSelect.value;
  if (choice !== "auto") return choice;
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "hls";
  if (clean.endsWith(".mpd")) return "dash";
  return null;
}

function resetStats() {
  statusEl.textContent = "idle";
  bandwidthEl.textContent = "–";
  qualityEl.textContent = "–";
  bufferEl.textContent = "–";
  droppedEl.textContent = "–";
  startupEl.textContent = "–";
  variantsTable.hidden = true;
  variantsBody.innerHTML = "";
}

function teardown() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (dashPlayer) {
    dashPlayer.reset();
    dashPlayer = null;
  }
  video.removeAttribute("src");
  video.load();
  stopBtn.disabled = true;
  loadBtn.disabled = false;
}

function bufferedSeconds() {
  const b = video.buffered;
  if (!b.length) return 0;
  for (let i = 0; i < b.length; i++) {
    if (video.currentTime >= b.start(i) && video.currentTime <= b.end(i)) {
      return b.end(i) - video.currentTime;
    }
  }
  return Math.max(0, b.end(b.length - 1) - video.currentTime);
}

function droppedFrameCount() {
  if (video.getVideoPlaybackQuality) {
    return video.getVideoPlaybackQuality().droppedVideoFrames;
  }
  return null;
}

function markStartup() {
  if (startupMeasured) return;
  startupMeasured = true;
  startupEl.textContent = `${((performance.now() - loadStart) / 1000).toFixed(2)}s`;
}

function startStatsLoop() {
  statsTimer = setInterval(() => {
    bufferEl.textContent = `${bufferedSeconds().toFixed(1)}s`;
    const dropped = droppedFrameCount();
    droppedEl.textContent = dropped === null ? "n/a" : String(dropped);

    if (hls) {
      bandwidthEl.textContent = fmtBps(hls.bandwidthEstimate);
      const lvl = hls.levels[hls.currentLevel];
      qualityEl.textContent = lvl ? `${lvl.height}p @ ${fmtBps(lvl.bitrate)}` : "–";
    } else if (dashPlayer) {
      try {
        const rateKbps = dashPlayer.getAverageThroughput?.("video");
        bandwidthEl.textContent = rateKbps ? fmtBps(rateKbps * 1000) : "–";
      } catch {
        bandwidthEl.textContent = "–";
      }
      try {
        const idx = dashPlayer.getQualityFor("video");
        const info = (dashPlayer.getBitrateInfoListFor("video") || [])[idx];
        qualityEl.textContent = info ? `${info.height}p @ ${fmtBps(info.bitrate)}` : "–";
      } catch {
        qualityEl.textContent = "–";
      }
    }
  }, 1000);
}

function populateVariantsFromHls() {
  variantsBody.innerHTML = "";
  hls.levels.forEach((lvl, i) => {
    const tr = document.createElement("tr");
    const res = lvl.width && lvl.height ? `${lvl.width}x${lvl.height}` : "–";
    const codecs = lvl.codecSet || lvl.attrs?.CODECS || "–";
    tr.innerHTML = `<td>${i}</td><td>${res}</td><td>${fmtBps(lvl.bitrate)}</td><td>${codecs}</td>`;
    variantsBody.appendChild(tr);
  });
  variantsTable.hidden = hls.levels.length === 0;
}

function populateVariantsFromDash() {
  variantsBody.innerHTML = "";
  let list = [];
  try {
    list = dashPlayer.getBitrateInfoListFor("video") || [];
  } catch {
    list = [];
  }
  list.forEach((info, i) => {
    const res = info.width && info.height ? `${info.width}x${info.height}` : "–";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i}</td><td>${res}</td><td>${fmtBps(info.bitrate)}</td><td>${info.mediaType || "–"}</td>`;
    variantsBody.appendChild(tr);
  });
  variantsTable.hidden = list.length === 0;
}

function diagnose(rawMessage) {
  const msg = (rawMessage || "").toLowerCase();
  if (msg.includes("cors") || msg.includes("access-control")) {
    return "Likely a CORS issue — the origin isn't sending Access-Control-Allow-Origin for this resource.";
  }
  if (location.protocol === "https:" && urlInput.value.trim().toLowerCase().startsWith("http://")) {
    return "Mixed content — this page is HTTPS but the stream URL is HTTP; browsers block that.";
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) {
    return "Looks like an authentication/token issue (401/403 from the server).";
  }
  if (msg.includes("codec") || msg.includes("mediasource") || msg.includes("notsupportederror")) {
    return "Possible codec incompatibility — this browser's MSE implementation may not support the stream's codec.";
  }
  return null;
}

function playHls(url) {
  if (!window.Hls || !window.Hls.isSupported()) {
    tlog("hls.js not supported in this browser; falling back to native <video> HLS playback.");
    video.src = url;
    video.addEventListener("loadedmetadata", () => { statusEl.textContent = "playing"; }, { once: true });
    video.play().catch((e) => tlog(`play() failed: ${e.message}`));
    return;
  }
  hls = new window.Hls({ enableWorker: true });
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    statusEl.textContent = "playing";
    populateVariantsFromHls();
    video.play().catch((e) => tlog(`play() failed: ${e.message}`));
  });
  hls.on(window.Hls.Events.LEVEL_SWITCHED, () => populateVariantsFromHls());
  hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
    hls.subtitleTrack = -1; // don't load the sidecar WebVTT rendition at all
  });
  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    tlog(`hls.js error: ${data.type}/${data.details}${data.response ? ` (HTTP ${data.response.code})` : ""}`);
    const hint = diagnose(`${data.type} ${data.details} ${data.response ? data.response.code : ""}`);
    if (hint) tlog(`   → ${hint}`);
    if (data.fatal) statusEl.textContent = `error: ${data.details}`;
  });
  hls.loadSource(url);
  hls.attachMedia(video);
}

function playDash(url) {
  if (!window.dashjs) {
    tlog("dash.js failed to load (check network/CDN access).");
    statusEl.textContent = "error: dash.js unavailable";
    return;
  }
  dashPlayer = window.dashjs.MediaPlayer().create();
  dashPlayer.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
    const msg = e.error?.message || JSON.stringify(e.error ?? e);
    tlog(`dash.js error: ${msg}`);
    const hint = diagnose(msg);
    if (hint) tlog(`   → ${hint}`);
    statusEl.textContent = "error";
  });
  dashPlayer.on(window.dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
    statusEl.textContent = "playing";
    populateVariantsFromDash();
  });
  dashPlayer.on(window.dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => populateVariantsFromDash());
  dashPlayer.initialize(video, url, true);
}

loadBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  teardown();
  resetStats();
  testerLog.textContent = "";

  const format = detectFormat(url);
  if (!format) {
    statusEl.textContent = "error: can't detect format";
    tlog("Could not auto-detect format from the URL extension — pick HLS or DASH explicitly.");
    return;
  }

  loadStart = performance.now();
  startupMeasured = false;
  statusEl.textContent = "loading…";
  loadBtn.disabled = true;
  stopBtn.disabled = false;
  tlog(`Loading ${format.toUpperCase()}: ${url}`);
  video.addEventListener("playing", markStartup, { once: true });
  startStatsLoop();
  document.dispatchEvent(new CustomEvent("tester:load", { detail: { url, format } }));

  if (format === "hls") playHls(url);
  else playDash(url);
});

stopBtn.addEventListener("click", () => {
  teardown();
  resetStats();
  statusEl.textContent = "stopped";
  tlog("Stopped.");
  document.dispatchEvent(new CustomEvent("tester:stop"));
});
