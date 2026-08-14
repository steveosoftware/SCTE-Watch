# SCTE-WATCH — project context

A local Node.js web app for testing HLS/DASH streams and inspecting SCTE-35 cue markers. Grew out of `scte35watch.py` (the original CLI script at the repo root) into a browser UI.

No AI/Claude/Anthropic branding anywhere in this project — keep it that way (no comments, no commit trailers, no UI text referencing it).

## Running it

```bash
cd webapp
node server.js        # serves on http://127.0.0.1:8787 by default
```

No `npm install` needed — the server (`server.js`) uses only Node built-ins, and the frontend loads hls.js/dash.js from jsdelivr CDN via plain `<script>` tags (not bundled). `PORT`/`HOST` env vars override the default bind.

## File layout

```
scte35watch.py           original CLI script (predates the web app; not touched)
webapp/
  server.js              static file server + CORS proxy (/api/fetch)
  package.json           no deps; just `node server.js`
  public/
    index.html           page shell, three panels
    style.css            all styling (dark theme, minimalist)
    scte35.js            SCTE-35 binary decoder + HLS master-playlist parser (pure logic)
    glossary.js           term definitions + safe HTML-escaping/linking helpers
    glossary-ui.js        click-to-modal glossary UI (event delegation)
    net.js                 fetchViaProxy() — thin wrapper around /api/fetch
    stream-tester.js       HLS/DASH playback via hls.js/dash.js, stats, variants table
    manifest-inspector.js  live manifest polling + SCTE-35 cue log
    app.js                 standalone "decode a SCTE-35 string" panel
```

## The three panels (top to bottom on the page)

### 1. HLS & DASH Stream Tester
- URL input (auto-detects HLS vs DASH by extension, or force either), Load & Play / Stop.
- Actual playback via hls.js / dash.js against a `<video>` — fetches manifests/segments **directly from the browser**, not through the server proxy (MSE needs real byte streams; proxying through JSON/base64 would be wasteful and broken for live). This means playback is subject to the stream origin's real CORS policy — a CORS failure here is a genuine finding about the stream, not a bug in the tool.
- Live stats: bandwidth estimate, current quality, buffer health, dropped frames, startup time (polled every 1s).
- Variants table (resolution/bandwidth/codecs), populated from hls.js `levels` / dash.js `getBitrateInfoListFor`.
- Video box has a fixed `aspect-ratio: 16/9` so it doesn't jump in size when a stream loads.
- Embedded CEA-608/708 captions vs sidecar WebVTT subtitles: both can land as native `<video>` TextTracks and double-render. Sidecar (`kind: "subtitles"`) tracks are force-disabled on `addtrack`, and `hls.subtitleTrack = -1` stops hls.js from even loading them — only embedded captions show.
- Dispatches `tester:load` / `tester:stop` CustomEvents on `document` with `{url, format}` — this is how the Manifest Inspector knows what to watch, without any direct coupling between the two modules.
- No "load sample" button — everything is driven by user-entered input only (explicitly requested).

### 2. Manifest Inspector
- Listens for `tester:load`/`tester:stop`; independently fetches the manifest via the server proxy (`/api/fetch`, sidesteps CORS for text).
- "Showing" dropdown: Master playlist + each variant (HLS) or just "MPD" (DASH). Defaults to the **lowest-bandwidth variant**, not the master, since that's the one worth watching for live cue changes.
- User-configurable poll interval (seconds).
- Auto-polls only while the manifest is actually live: HLS media playlists without `#EXT-X-ENDLIST`, or DASH MPDs with `type="dynamic"`. Stops polling itself once it sees a static/VOD manifest.
- "Download variant log" button saves the currently-displayed manifest text.
- **SCTE-35 cues sub-panel**: scans whichever manifest is being watched for cue tag lines (`CUE_PATTERN` in scte35.js), decodes any SCTE-35 payload found, and appends a timestamped entry — deduped by `#EXT-X-MEDIA-SEQUENCE` so an unchanged playlist window doesn't spam repeat entries. This only works for HLS (`currentFormat === "hls"`); DASH shows a static "HLS-only" note since MPDs don't carry these tags the same way.
- **Only detects out-of-band SCTE-35** (cues signaled in the manifest text itself) — not in-band cues muxed into the actual transport stream/segments, which would require demuxing the media (this tool never does). There's a note to this effect in the UI, with both terms linked to glossary definitions.
- Both the raw manifest box and the SCTE cues box are resizable (`resize: vertical` + `overflow: auto`) and have their own scrollbars — they don't grow the page.
- "Download SCTE log" button saves the accumulated cue-detection log.

### 3. Decode a SCTE-35 string
- Standalone: paste a base64 (`/DAv...`) or hex (`0xFC30...`) SCTE-35 payload, click Decode.
- Unrelated to playback/polling — kept as-is per explicit request when the old "Watch an HLS stream" panel (redundant with the Manifest Inspector) was removed.

## Click-to-glossary feature

Any recognized SCTE-35/HLS term in decoded output (splice command names, segmentation type names, UPID types, and the cue-related HLS tag names like `EXT-X-CUE-OUT`/`EXT-X-DATERANGE`) renders as a clickable underlined span. Clicking pops a small modal (`#glossary-modal` in index.html, driven by `glossary-ui.js`) with a plain-English definition. ~80 terms defined in `glossary.js`.

**Security note or importance:** decoded SCTE-35 fields (especially UPID content) come from attacker-controllable payload bytes — rendering required switching several places from `.textContent` to `.innerHTML`. To avoid an XSS hole, `glossaryTerm()`/`linkifyTagLine()` in `glossary.js` only ever wrap a value in a live `<span>` when that exact value is a key in the fixed `GLOSSARY` dict; everything else goes through `escapeHtml()` and is always inert text. `scte35.js`'s `formatDecoded()` is the single source of this HTML-safe output — there's no separate plain-text formatter anymore (the old one was removed once nothing consumed it).

## Known/verified behavior

- DASH playback was verified end-to-end with a headless-browser test against `dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` — real frame decode, stats, variants table, and manifest all confirmed working (2026-08-13).
- The server previously crashed entirely (unhandled exception, not just a 400) on a malformed request URL — fixed by wrapping the `new URL(...)` parse in try/catch in `server.js`.
- `/api/log` (old "save watch log to server file" feature) was removed along with the old Watch panel — dead code, nothing calls it anymore.
