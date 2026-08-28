# SCTE-WATCH — project context

A local Node.js web app for testing HLS/DASH streams and inspecting SCTE-35 cue markers. Grew out of `scte35watch.py` (the original CLI script at the repo root) into a browser UI.

No AI/Claude/Anthropic branding anywhere in this project — keep it that way (no comments, no commit trailers, no UI text referencing it).

## Repo state

Pushed to `https://github.com/steveosoftware/SCTE-Watch.git`. Branches: `main` (still just the initial commit — stale, not what's deployed), `staging` (tracks `origin/staging`, fast-forwarded to match `roadmap` as of 2026-08-18), and `roadmap` (tracks `origin/roadmap` — **this is the active working branch**; Phases 0–3 of ROADMAP.md all landed here). Working tree is clean as of 2026-08-18.

**Live deploy**: https://roadmap.d3qk02ponpvf7m.amplifyapp.com/ — Amplify app `SCTE-Watch` (`d3qk02ponpvf7m`, `us-east-1`), branch `roadmap`, no password gate yet (see Phase 3 notes in ROADMAP.md — the endpoints are public and unauthenticated right now).

Future planning/scoping lives in `ROADMAP.md` alongside this file — check it before proposing new features, since scope decisions (what's explicitly excluded, what's blocked on external info, what needs the AWS Amplify migration first) are recorded there rather than re-litigated per conversation.

## Operator's real setup (matters for prioritization)

- **HLS with `.ts` segments — not fMP4.** Confirmed 2026-08-18. This directly affects the in-band SCTE-35 item in ROADMAP.md Phase 4: the fMP4/`emsg` path (which would've been pure-JS, no native dependency) is **not relevant** to this operator's actual streams — build the MPEG-TS/PID-demuxing path (`threefive` or `tsduck` subprocess) first, not the fMP4 path.
- Runs a FAST channel setup fronted by CDNs — the CDN-chain feature (Manifest Inspector's "CDN chain" line) exists specifically because of a real operational issue: chained CloudFront (CloudFront fronting CloudFront) breaks their setup and previously required manual `dig` diagnosis. See the CDN chain status line notes below for how that's detected.
- **Has an existing manual Gracenote EPG QA process** — a set of Bash scripts at `~/Downloads/gracenote/` (local only, **deliberately not in this repo**: they carry a live API key in plaintext) that pull Gracenote On API v3 schedules and diff them against the platform's own EPG. Reviewed 2026-08-19/20; the scripts were also fixed in place 2026-08-20 (a write/read filename mismatch that broke the simulcast path, plus optional backdating) — those fixes live only on the operator's machine, not here.
  - The platform side is **Xumo XMLTV at a fetchable URL** (`https://carbon.xumo.com/epg/xmltv/{xumoChannelId}_{callsign}.xml`), confirmed 2026-08-25 — not the manual file export the scripts read. So the web version can automate both sides through the existing proxy.
  - Relevant for that work: the operator's channels span both Xumo-stitched and simulcast types, which the Gracenote `/Schedules` response shape differs between.
  - **Full write-up — API shape, join-key analysis, the decisions taken, and the defects worth not reproducing — is in ROADMAP.md's Gracenote section.** Read that before touching this feature; it is the authoritative record, not this bullet.

## Public-facing app — credential policy

This is deployed publicly, so **the app holds no third-party API credentials at all**. Any integration needing a key (Gracenote today, anything similar later) takes the *user's own* key via a UI input — `type="password"`, in-memory/sessionStorage only, never localStorage, never a Lambda env var, never committed. Per-user keys mean no shared quota to abuse, no secret in our infrastructure, and nothing for us to rotate. Decided 2026-08-20; it supersedes the earlier "Lambda holds the key" plan that ROADMAP.md used to describe. The operator gates the deployed site behind Amplify's own password protection separately (they manage that themselves — not something this codebase configures).

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
  server.js              static file server + thin node:http wrapper around api-handlers.js (local dev only — not what's deployed)
  api-handlers.js         pure request logic for /api/fetch and /api/dns-chain — {status, body} in, no transport awareness. Shared by server.js (local) and lambda/handler.js (deployed)
  lambda/handler.js        AWS Lambda entrypoint — same api-handlers.js logic, wrapped for API Gateway's event/response shape instead of node:http
  ssrf-guard.js           IP-range blocking + guarded-redirect fetch + response-size cap for the proxy
  cdn-chain.js            CNAME-chain walker only (DNS-only, no SSRF surface) — naming which CDN(s) moved to cdn-fingerprint.js
  package.json            devDependency: playwright (tests only); npm scripts: start/test/test:e2e
  public/
    index.html            page shell, five panels + glossary modal
    style.css              all styling (dark theme, minimalist)
    scte35.js              SCTE-35 binary decoder + HLS/DASH manifest parsing (pure logic, DOM-free — runs under plain Node)
    glossary.js             term definitions (SCTE-35 + hls.js error types/details) + safe HTML-escaping/linking helpers
    glossary-ui.js          click-to-modal glossary UI (event delegation)
    cdn-fingerprint.js      names CDN(s) from response headers (primary) + DNS hostname suffixes (fallback) — isomorphic, no Node/DOM dependency
    net.js                   fetchViaProxy() (now also returns headers) + fetchCdnChain() — thin wrappers around the two /api/* endpoints
    stream-tester.js         HLS/DASH playback via hls.js/dash.js, stats, variants table (now beside the video, not below it)
    manifest-inspector.js    live manifest polling + SCTE-35 cue log + health + DRM + CDN-chain status lines
    app.js                   standalone "decode a SCTE-35 string" panel
    vast.js                  VAST/VMAP parsing + wrapper-chain resolution (pure logic, DOM-free, same style as scte35.js)
    vast-ui.js               standalone "validate a VAST/VMAP ad response" panel
    epg.js                   XMLTV + Gracenote schedule parsing and the drift comparison (pure logic, DOM-free)
    epg-ui.js                standalone "EPG drift" panel
  tests/
    fixtures/                committed HLS/DASH manifests + SCTE-35 payloads + VAST/VMAP fixtures (real captures + labeled synthetic ones)
    unit/                    node:test suites — one file roughly per scte35.js/glossary.js/net.js/ssrf-guard.js/vast.js concern
    e2e/playback.test.js     real headless-Chromium tests against a real spawned server.js
```

## The five panels (top to bottom on the page)

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

### 4. Validate a VAST/VMAP ad response (shipped 2026-08-18, Phase 4)
- Standalone, same pattern as the SCTE-35 decoder panel: paste a VAST/VMAP **URL or raw XML**, click Validate. Auto-detects which of the two it is by root element (`vast.js`'s `detectVastVmap()` — checked against the actual root, not a substring search, since a VMAP document's inline `VASTAdData` legitimately embeds a full nested `<VAST>` element).
- URL input goes through the same hardened `/api/fetch` proxy as everything else (ad servers generally don't set CORS headers, same reasoning as the Manifest Inspector).
- **Follows VAST Wrapper chains automatically** (`resolveVastChain()` in `vast.js`) — ad-tech responses are routinely chained through several vendors (SSP → exchange → creative) before reaching a real `InLine` ad. Capped at 5 hops (mirrors `cdn-chain.js`'s `resolveCnameChain()` maxHops pattern) so a misconfigured or malicious chain can't loop forever; a chain that doesn't resolve within the cap is flagged in the output rather than silently truncated.
- **VMAP**: parses each `AdBreak` (type, `timeOffset`, id), then resolves its `AdSource` — either an inline `VASTAdData` (parsed directly) or an `AdTagURI` (fetched through the proxy) — following that ad break's own wrapper chain the same way a standalone VAST URL would.
- Output shows the ad pod breakdown per the original ask: ad system, creative type (`Linear`/`Companion`/`NonLinear`), duration, media files (url/type/bitrate/dimensions), click-through/click-tracking, and which tracking events (start/quartiles/complete/etc.) are wired up — glossary-linked the same way manifest output is (`glossaryTerm()` on fixed vocabulary only — ad server content is at least as untrusted as CDN manifest content, same XSS-safety invariant).
- `vast.js` is pure/DOM-free (regex against XML text, same style as `scte35.js`'s DASH parsing) — no `DOMParser` dependency, runs under plain Node for tests.

### 5. EPG drift — what's playing vs what's scheduled (shipped 2026-08-26, reworked 2026-08-27)
- **Checks the STREAM against a schedule**, not two schedules against each other. Two metadata sources can agree perfectly while the channel plays the wrong thing; only the stream answers "is the right asset on air right now."
- **The asset id comes out of the segment path**: `https://live-content-cf.xumo.com/149/content/XM05M7E0PC09SI/28980908/6_004.ts` → `XM05M7E0PC09SI`. Same `XM`-prefixed namespace as XMLTV's `<programme-id>` and Gracenote's `remoteId`, which is what makes the join possible. `extractAssetId()` keys on the `/content/` path segment, **not** the hostname — verified across `live-content.xumo.com`, `live-content.cdn.xumo.com` and `live-content-cf.xumo.com`, which vary by channel and CDN swap. Beacon-wrapped segments fall back to their `aid=` query param.
- **Schedule source is Gracenote OR XMLTV, never both** (radio toggle; the unselected source's fields are hidden). Per the operator: a channel typically has one or the other, not both. `normalizeXmltvSchedule()` / `normalizeGracenoteSchedule()` flatten either into a common `{startMs, stopMs, assetId, title, tmsId}` shape so everything downstream is source-agnostic.
- **It polls, and that's forced by the data.** These streams carry **no `#EXT-X-PROGRAM-DATE-TIME`** (verified on real Xumo channels — the playlists are bare: `VERSION`, `TARGETDURATION`, `MEDIA-SEQUENCE`, `EXTINF`, segment URLs, nothing else). With no wallclock anchor in the manifest, the only observable instant is "now" at the live edge. A single check therefore yields a yes/no; watching across polls catches the asset transition and converts it into a **drift figure in seconds**.
- **The timeline is interpolated backwards from the live edge**: the last segment's end is anchored at `now`, then `#EXTINF` durations are accumulated backwards. That's an estimate — it inherits packager latency — accurate to roughly a segment duration, which is the resolution the schedule is meaningful at anyway.
- **Verdicts**: `match`, `wrong-asset` (something else *that is scheduled* is playing), `unscheduled` (playing something the schedule doesn't list at all), `no-asset-id`, `no-schedule`. The wrong-asset/unscheduled split matters — the first is a scheduling problem, the second suggests the channel is playing content nobody scheduled.
- Accepts a master or media playlist; a master resolves to its lowest-bandwidth variant (same convention as the Manifest Inspector — the rendition is irrelevant since every variant carries the same asset in its paths).
- Logs only on **change**, not every poll — a monitor that reprints an unchanged line every few seconds buries the events that matter. **Download CSV** exports the observation log (`buildObservationCsv()`).
- **Credentials**: the user's own Gracenote key, `type="password"`, held in memory only, never persisted. Error paths run through `redact()`; an e2e test asserts the key never reaches the DOM.
- **Known unverified assumption**: `parseGracenoteTime()`'s handling of the `date`/`time` attribute serialization is inferred from the operator's scripts — a live Gracenote response has never been observed. Deliberately tolerant, and Gracenote `<error>` bodies surface verbatim. **Verify on first live run.** The XMLTV path is fully verified against real feeds.
- **Still in `epg.js` but unwired from the UI**: `compareSchedules()` / `buildComparisonCsv()`, the schedule-vs-schedule diff the panel originally did. Kept with its tests — comparing two schedule sources is still a real question, and it mirrors the operator's original shell workflow.

## Click-to-glossary feature

Any recognized SCTE-35/HLS term in decoded output (splice command names, segmentation type names, UPID types, and the cue-related HLS tag names like `EXT-X-CUE-OUT`/`EXT-X-DATERANGE`) renders as a clickable underlined span. Clicking pops a small modal (`#glossary-modal` in index.html, driven by `glossary-ui.js`) with a plain-English definition. 100+ terms defined in `glossary.js`.

**Raw manifest box is fully glossary-linked now, not just the SCTE cue log** (2026-08-18) — `manifest-inspector.js`'s `render()` runs every manifest line through `linkifyTagLine()` before display, same as the SCTE cue log always has. Added specifically for captions/subtitles/language, since that's a common point of confusion for people leaning on this tool to understand a stream they didn't produce: HLS `EXT-X-MEDIA` (the tag itself, plus its `TYPE=SUBTITLES`/`TYPE=CLOSED-CAPTIONS`/`TYPE=AUDIO`/`TYPE=VIDEO` enum, `LANGUAGE`/`ASSOC-LANGUAGE`/`INSTREAM-ID`/`AUTOSELECT`/`DEFAULT`/`FORCED`/`GROUP-ID`/`CHARACTERISTICS` attribute names) and DASH's `Role`/`Accessibility` elements plus their caption-relevant `value`s (`subtitle`/`caption`/`description`/`commentary`/`dub`/`main`) and `lang` attribute. Attribute *values* that are free text (the actual language code, group/name strings, URIs) are deliberately never linked — only the fixed vocabulary naming what a field means, never the attacker-controllable content inside it, same XSS-safety invariant as everywhere else in `glossary.js`. Implementation note: `linkifyInlineTokens()` in `glossary.js` runs its token-matching regexes against text that's *already* been through `escapeHtml()` — safe because every token it looks for is plain ASCII, which escaping leaves unchanged, so the regexes can never accidentally fire against raw/unescaped attacker content.

**Security note or importance:** decoded SCTE-35 fields (especially UPID content) come from attacker-controllable payload bytes — rendering required switching several places from `.textContent` to `.innerHTML`. To avoid an XSS hole, `glossaryTerm()`/`linkifyTagLine()` in `glossary.js` only ever wrap a value in a live `<span>` when that exact value is a key in the fixed `GLOSSARY` dict; everything else goes through `escapeHtml()` and is always inert text. `scte35.js`'s `formatDecoded()` is the single source of this HTML-safe output — there's no separate plain-text formatter anymore (the old one was removed once nothing consumed it).

## Hosting target

**Deployed** on AWS Amplify (2026-08-18). `webapp/public/` is served as static Amplify Hosting output (build spec: `baseDirectory: webapp/public`, no build step). `/api/fetch` and `/api/dns-chain` run as an AWS Lambda (`scte-watch-api`, `us-east-1`) behind an API Gateway HTTP API, reached through an Amplify rewrite rule (`/api/<*>` → the API Gateway URL, status 200) so the client's same-origin `fetch("/api/...")` calls work unchanged — no CORS, no code path difference between local dev and deployed. See ROADMAP.md Phase 3 for the exact resources and their ARNs/IDs.

## Known/verified behavior

- **`pts_adjustment` bug — fixed** (2026-08-16). Was documented but never applied; now added to every absolute PTS, never to `break_duration` (a relative span). Regression-tested.
- **`/api/fetch` SSRF hardening — done** (2026-08-16), in `ssrf-guard.js`. Blocks loopback/RFC1918/link-local (incl. cloud IMDS)/CGNAT + IPv6 equivalents, re-validates every redirect hop instead of blindly following, caps response size at 20MB. Verified with unit tests, e2e tests (via an explicit test-only bypass env var, `SSRF_GUARD_ALLOW_PRIVATE_TARGETS`, off by default), and a manual check against the real running server. **Known remaining gap, documented in the file**: doesn't pin the TCP connection to the pre-validated IP, so a DNS-rebinding attack (address changes between our check and fetch's own re-resolution) isn't fully closed — worth revisiting when this lands on a public Lambda (Phase 3).
- **Test suite exists now**: 95 unit tests + 8 e2e tests, all passing. See ROADMAP.md Phase 0 and the "Running it" section above.
- DASH playback was verified end-to-end with a headless-browser test against `dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` — real frame decode, stats, variants table, and manifest all confirmed working (2026-08-13); now a permanent e2e test.
- The server previously crashed entirely (unhandled exception, not just a 400) on a malformed request URL — fixed by wrapping the `new URL(...)` parse in try/catch in `server.js`; now covered by an e2e test too.
- `/api/log` (old "save watch log to server file" feature) was removed along with the old Watch panel — dead code, nothing calls it anymore.
