# SCTE-WATCH — project context

A local Node.js web app for testing HLS/DASH streams and inspecting SCTE-35 cue markers. Grew out of `scte35watch.py` (the original CLI script at the repo root) into a browser UI.

No AI/Claude/Anthropic branding anywhere in this project — keep it that way (no comments, no commit trailers, no UI text referencing it).

## Repo state

Pushed to `https://github.com/steveosoftware/SCTE-Watch.git`. Branches: `main` (initial commit), `staging` (tracks `origin/staging`, created 2026-08-15), and `roadmap` (tracks `origin/roadmap`, branched off `staging` 2026-08-16 — **this is the active working branch** as of 2026-08-18; Phases 0–2 of ROADMAP.md plus the CDN-fingerprint rework and hls.js error glossary all landed here). As of 2026-08-18 there are uncommitted changes on `roadmap` — check `git status` before assuming HEAD reflects everything described below.

Future planning/scoping lives in `ROADMAP.md` alongside this file — check it before proposing new features, since scope decisions (what's explicitly excluded, what's blocked on external info, what needs the AWS Amplify migration first) are recorded there rather than re-litigated per conversation.

## Operator's real setup (matters for prioritization)

- **HLS with `.ts` segments — not fMP4.** Confirmed 2026-08-18. This directly affects the in-band SCTE-35 item in ROADMAP.md Phase 4: the fMP4/`emsg` path (which would've been pure-JS, no native dependency) is **not relevant** to this operator's actual streams — build the MPEG-TS/PID-demuxing path (`threefive` or `tsduck` subprocess) first, not the fMP4 path.
- Runs a FAST channel setup fronted by CDNs — the CDN-chain feature (Manifest Inspector's "CDN chain" line) exists specifically because of a real operational issue: chained CloudFront (CloudFront fronting CloudFront) breaks their setup and previously required manual `dig` diagnosis. See the CDN chain status line notes below for how that's detected.

## Running it

```bash
cd webapp
node server.js        # serves on http://127.0.0.1:8787 by default
```

Running the app itself still needs no `npm install` — `server.js` uses only Node built-ins, and the frontend loads hls.js/dash.js from jsdelivr CDN via plain `<script>` tags (not bundled). `PORT`/`HOST` env vars override the default bind.

**Running the tests DOES need `npm install`** (adds Playwright as a devDependency, for the e2e suite only — the app's own runtime dependency count is still zero). Then:

```bash
npm test            # unit tests (fast, no browser, no network)
npm run test:e2e     # e2e — needs `npx playwright install chromium` once first
```

See ROADMAP.md Phase 0 for what each suite covers.

## File layout

```
scte35watch.py           original CLI script (predates the web app; not touched — fate undecided, see ROADMAP.md)
webapp/
  server.js              static file server + CORS proxy (/api/fetch, SSRF-guarded, now also returns CDN-relevant response headers) + DNS chain endpoint (/api/dns-chain)
  ssrf-guard.js           IP-range blocking + guarded-redirect fetch + response-size cap for the proxy
  cdn-chain.js            CNAME-chain walker only (DNS-only, no SSRF surface) — naming which CDN(s) moved to cdn-fingerprint.js
  package.json            devDependency: playwright (tests only); npm scripts: start/test/test:e2e
  public/
    index.html            page shell, three panels + glossary modal
    style.css              all styling (dark theme, minimalist)
    scte35.js              SCTE-35 binary decoder + HLS/DASH manifest parsing (pure logic, DOM-free — runs under plain Node)
    glossary.js             term definitions (SCTE-35 + hls.js error types/details) + safe HTML-escaping/linking helpers
    glossary-ui.js          click-to-modal glossary UI (event delegation)
    cdn-fingerprint.js      names CDN(s) from response headers (primary) + DNS hostname suffixes (fallback) — isomorphic, no Node/DOM dependency
    net.js                   fetchViaProxy() (now also returns headers) + fetchCdnChain() — thin wrappers around the two /api/* endpoints
    stream-tester.js         HLS/DASH playback via hls.js/dash.js, stats, variants table (now beside the video, not below it)
    manifest-inspector.js    live manifest polling + SCTE-35 cue log + health + DRM + CDN-chain status lines
    app.js                   standalone "decode a SCTE-35 string" panel
  tests/
    fixtures/                committed HLS/DASH manifests + SCTE-35 payloads (real captures + labeled synthetic ones)
    unit/                    node:test suites — one file roughly per scte35.js/glossary.js/net.js/ssrf-guard.js concern
    e2e/playback.test.js     real headless-Chromium tests against a real spawned server.js
```

## The three panels (top to bottom on the page)

### 1. HLS & DASH Stream Tester
- URL input (auto-detects HLS vs DASH by extension, or force either), Load & Play / Stop.
- Actual playback via hls.js / dash.js against a `<video>` — fetches manifests/segments **directly from the browser**, not through the server proxy (MSE needs real byte streams; proxying through JSON/base64 would be wasteful and broken for live). This means playback is subject to the stream origin's real CORS policy — a CORS failure here is a genuine finding about the stream, not a bug in the tool.
- Live stats: bandwidth estimate, current quality, buffer health, dropped frames, startup time (polled every 1s).
- Variants table (resolution/bandwidth/codecs), populated from hls.js `levels` / dash.js `getBitrateInfoListFor` — sits **beside** the video (`.media-row` flex layout, `.variants-wrap` collapses via `:has()` when the table is `hidden`), not below it, to use the empty space next to the 16:9 box.
- Video box has a fixed `aspect-ratio: 16/9` so it doesn't jump in size when a stream loads.
- **hls.js errors are glossary-linked**: `ERROR` event handler renders `data.type`/`data.details` (e.g. `mediaError`/`bufferAppendNoProgress`) as clickable spans via `glossaryTerm()`, same modal as everything else. `glossary.js` now has entries for all of hls.js's `ErrorTypes` and most `ErrorDetails` (skipped: HLS Interstitials/asset-list errors — a niche feature this app doesn't touch). The existing `diagnose()` heuristic (CORS/mixed-content/auth/codec guesses) still runs underneath as a separate contextual hint line — the two are complementary, not redundant.
- Embedded CEA-608/708 captions vs sidecar WebVTT subtitles: both can land as native `<video>` TextTracks and double-render. Sidecar (`kind: "subtitles"`) tracks are force-disabled on `addtrack`, and `hls.subtitleTrack = -1` stops hls.js from even loading them — only embedded captions show.
- Dispatches `tester:load` / `tester:stop` CustomEvents on `document` with `{url, format}` — this is how the Manifest Inspector knows what to watch, without any direct coupling between the two modules.
- No "load sample" button — everything is driven by user-entered input only (explicitly requested).

### 2. Manifest Inspector
- Listens for `tester:load`/`tester:stop`; independently fetches the manifest via the server proxy (`/api/fetch`, sidesteps CORS for text).
- "Showing" dropdown: Master playlist + each variant (HLS) or just "MPD" (DASH). Defaults to the **lowest-bandwidth variant**, not the master, since that's the one worth watching for live cue changes.
- User-configurable poll interval (seconds).
- Auto-polls only while the manifest is actually live: HLS media playlists without `#EXT-X-ENDLIST`, or DASH MPDs with `type="dynamic"`. Stops polling itself once it sees a static/VOD manifest.
- "Download variant log" button saves the currently-displayed manifest text.
- **SCTE-35 cues sub-panel**: works for **both HLS and DASH** now.
  - HLS: scans cue tag lines (`CUE_PATTERN`), decodes any payload found, appends a timestamped entry — deduped by `#EXT-X-MEDIA-SEQUENCE`. Each cue's wall-clock time is shown too (`findCueWallclocks()` — authoritative from `#EXT-X-DATERANGE`'s `START-DATE` when present, otherwise interpolated from `#EXT-X-PROGRAM-DATE-TIME` + accumulated `#EXTINF`).
  - DASH: scans `<EventStream>`/`<Event>` (`findDashScte35Events()`), deduped by a fingerprint of event ids+times. The `xml+bin` encoding (`<Signal><Binary>`) decodes through the same `decodeScte35()` as HLS, unchanged. Pure-XML-encoded signals are explicitly flagged "not yet decoded" rather than silently dropped.
- **Only detects out-of-band SCTE-35** (cues signaled in the manifest text itself) — not in-band cues muxed into the actual transport stream/segments, which would require demuxing the media (this tool never does, yet — see ROADMAP.md Phase 4). There's a note to this effect in the UI, with both terms linked to glossary definitions.
- **Health status line**: sequence gaps, `#EXT-X-DISCONTINUITY` counts, live-edge staleness (no new segments for 3× target duration), and variant-ladder monotonicity anomalies (checked once at master load). Shows "OK" or amber warning text. HLS-only — clears for DASH.
- **DRM status line**: parses `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` (HLS) or `<ContentProtection>` (DASH), maps to a friendly DRM system name (Widevine/PlayReady/FairPlay/ClearKey/clear) via a shared UUID table, shows multi-DRM setups, tracks key/IV rotation across polls by fingerprint diffing.
- **CDN chain status line**: checked once per watched target (not per-poll — a CDN setup doesn't change mid-session), reusing headers from the manifest fetch that's already happening (no extra request). **Reworked 2026-08-17** from a DNS-CNAME-only approach after real-world testing showed a blind spot: hostnames on Route 53 ALIAS records (common for CloudFront custom domains) resolve straight to IPs with zero visible CNAME, so pure DNS walking reported "nothing" for a stream that genuinely was CloudFront. Detection now prioritizes the `Via` response header — CloudFront specifically appends to an existing Via header hop-by-hop (RFC 7230), so a real CloudFront-fronting-CloudFront chain shows up as two `(CloudFront)` entries in one header regardless of what DNS shows. Priority order (`cdn-fingerprint.js`'s `buildCdnChain()`): (1) a 2+-hop Via chain — direct proof chaining happened; (2) the fullest single-hop identification across *all* response headers (not just Via — Fastly's default Via is a generic `1.1 varnish` with no vendor name; the vendor only shows up in `X-Served-By`/`X-Fastly-Request-Id`, so a lone Via entry does NOT automatically outrank a more specific header); (3) DNS hostname-suffix fallback (`cdn-chain.js`, still does the raw `resolveCname` walk via `/api/dns-chain`) for when headers reveal nothing. Displays the actual **CDN vendor names** (CloudFront, Akamai, Fastly, Cloudflare, etc.), not raw hostnames — flags `⚠` when the same vendor appears back-to-back (`chainedSameCdn`). Verified against the real report that prompted this: `xumo-drct-ch109-8jv1c.fast.nbcuni.com` (ALIAS-to-CloudFront, confirmed via AWS's own published IP ranges) now correctly shows "CloudFront" from its `x-cache`/`x-amz-cf-*` headers.
  - **Known limitation, not yet solved**: only sees CDN layers that are visible via HTTP headers we receive. A CDN that doesn't participate in Via chaining (Akamai typically doesn't by default) sitting *behind* one that does would be invisible to us — an unnamed/missing hop should read as "can't see past this point," not "there's nothing there."
  - **Still unverified**: the actual 2+-hop chained-CloudFront warning path is only proven via mocked unit tests (`cdn-fingerprint.test.js`) — no confirmed real-world double-CloudFront URL has been tested against it yet. If one turns up, that's the next thing to verify.
- Both the raw manifest box and the SCTE cues box are resizable (`resize: vertical` + `overflow: auto`) and have their own scrollbars — they don't grow the page.
- "Download SCTE log" button saves the accumulated cue-detection log.

### 3. Decode a SCTE-35 string
- Standalone: paste a base64 (`/DAv...`) or hex (`0xFC30...`) SCTE-35 payload, click Decode.
- Unrelated to playback/polling — kept as-is per explicit request when the old "Watch an HLS stream" panel (redundant with the Manifest Inspector) was removed.

## Click-to-glossary feature

Any recognized SCTE-35/HLS term in decoded output (splice command names, segmentation type names, UPID types, and the cue-related HLS tag names like `EXT-X-CUE-OUT`/`EXT-X-DATERANGE`) renders as a clickable underlined span. Clicking pops a small modal (`#glossary-modal` in index.html, driven by `glossary-ui.js`) with a plain-English definition. ~80 terms defined in `glossary.js`.

**Security note or importance:** decoded SCTE-35 fields (especially UPID content) come from attacker-controllable payload bytes — rendering required switching several places from `.textContent` to `.innerHTML`. To avoid an XSS hole, `glossaryTerm()`/`linkifyTagLine()` in `glossary.js` only ever wrap a value in a live `<span>` when that exact value is a key in the fixed `GLOSSARY` dict; everything else goes through `escapeHtml()` and is always inert text. `scte35.js`'s `formatDecoded()` is the single source of this HTML-safe output — there's no separate plain-text formatter anymore (the old one was removed once nothing consumed it).

## Hosting target

Intended to be deployed on AWS Amplify. Current architecture (a persistent `http.createServer` process in `server.js`) doesn't map directly onto Amplify Hosting's model (static output + optional framework SSR compute) — the `/api/fetch` proxy and any future server-side work (ccextractor, in-band demux, Gracenote, VAST fetch) will need to become Amplify Functions (Lambda) instead. Full reasoning in `ROADMAP.md` under "Infrastructure prerequisite." Not yet started.

## Known/verified behavior

- **`pts_adjustment` bug — fixed** (2026-08-16). Was documented but never applied; now added to every absolute PTS, never to `break_duration` (a relative span). Regression-tested.
- **`/api/fetch` SSRF hardening — done** (2026-08-16), in `ssrf-guard.js`. Blocks loopback/RFC1918/link-local (incl. cloud IMDS)/CGNAT + IPv6 equivalents, re-validates every redirect hop instead of blindly following, caps response size at 20MB. Verified with unit tests, e2e tests (via an explicit test-only bypass env var, `SSRF_GUARD_ALLOW_PRIVATE_TARGETS`, off by default), and a manual check against the real running server. **Known remaining gap, documented in the file**: doesn't pin the TCP connection to the pre-validated IP, so a DNS-rebinding attack (address changes between our check and fetch's own re-resolution) isn't fully closed — worth revisiting when this lands on a public Lambda (Phase 3).
- **Test suite exists now**: 95 unit tests + 8 e2e tests, all passing. See ROADMAP.md Phase 0 and the "Running it" section above.
- DASH playback was verified end-to-end with a headless-browser test against `dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` — real frame decode, stats, variants table, and manifest all confirmed working (2026-08-13); now a permanent e2e test.
- The server previously crashed entirely (unhandled exception, not just a 400) on a malformed request URL — fixed by wrapping the `new URL(...)` parse in try/catch in `server.js`; now covered by an e2e test too.
- `/api/log` (old "save watch log to server file" feature) was removed along with the old Watch panel — dead code, nothing calls it anymore.
