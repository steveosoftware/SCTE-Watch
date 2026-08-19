# SCTE-WATCH — roadmap

Update this alongside `CONTEXT.md` as items land.

## Explicitly out of scope

- **Multi-channel monitor grid** (a dashboard polling a saved list of streams concurrently) — this app is a single-stream tester/inspector, not an ops monitoring platform.
- **Stuck-in-break alerting / webhooks** (paging on a cue-out with no matching cue-in) — same reason; alerting infrastructure is out of scope.

## Open decisions (not yet made)

- **`scte35watch.py`** — the original CLI at repo root. Actively maintained, deprecated in favor of the web app, or kept as reference? Its fate affects whether it gets test coverage and whether the in-band work should reuse it (it's already Python, which is the natural host for `threefive`).
- **hls.js / dash.js delivery** — currently loaded from jsdelivr at floating major versions with no integrity hashes (see Hygiene below). Pin exact versions + SRI, or vendor the files into `public/`? Vendoring also removes a runtime external dependency, which matters for an Amplify deploy.

## Sequence

1. ~~**Phase 0 — testing foundation.**~~ **Done** (2026-08-16).
2. ~~**Phase 1 — client-side only.**~~ **Done** (2026-08-16).
3. ~~**Phase 2 — security hardening.**~~ **Done** (2026-08-16). Prerequisite for public deploy — satisfied, re-verified live in Phase 3's Lambda environment.
4. ~~**Phase 3 — Amplify migration.**~~ **Done** (2026-08-18). Live at https://roadmap.d3qk02ponpvf7m.amplifyapp.com/. Unblocks everything server-side below — **not yet started on any of it**.
5. **Phase 4 — server-dependent features.** In progress. VAST/VMAP validator ✅ done (2026-08-18). ccextractor and in-band SCTE-35 not started.
6. **Gracenote EPG drift detection — unblocked** (2026-08-19). API query shape confirmed from operator's existing local scripts; not yet built. See its own section below (moved out of "Blocked").

---

## Phase 0 — Testing foundation ✅ Done

- `tests/unit/` — 95 tests via Node's built-in `node:test`, zero new runtime dependency. Covers `scte35.js` (decoder golden-file suite, `pts_adjustment` regression, wallclock timeline, DASH EventStream/ContentProtection parsing, continuity checks), `glossary.js` (including the XSS-invariant suite), `net.js`, and `ssrf-guard.js`.
- `tests/fixtures/` — committed HLS/DASH fixtures (real captured + clearly-labeled synthetic ones for cases real streams didn't happen to exercise, like `pts_adjustment` and multi-DRM). All unit and offline e2e tests run against these, never live URLs.
- `tests/e2e/playback.test.js` — real headless Chromium (Playwright, devDependency) against a real spawned `server.js`. Two tiers:
  - **offline/deterministic** (6 tests) — fixtures served by a throwaway local HTTP server spun up in the test file; safe anywhere, never flaky.
  - **live network** (2 tests) — real HLS/DASH playback against mux.dev/akamaized.net, confirming actual frame decode (not just "no errors"). Kept in `npm run test:e2e`, deliberately excluded from `npm test`, since real-world outages are a property of what they test, not a test bug.
- `npm test` (unit) / `npm run test:e2e` (e2e, requires `npx playwright install chromium` once).
- Not done: wiring into GitHub Actions. Straightforward once wanted — no blockers.

## Phase 1 — Client-side features ✅ Done

All shipped in `scte35.js` (pure, portable — still runs under plain Node, no DOM dependency added) and wired into `manifest-inspector.js`.

- **`pts_adjustment` bug — fixed.** Was documented but never applied; now added to every absolute PTS (`splice_insert`/`time_signal`), never to `break_duration` (a relative span). Regression-tested against a fixture with a real 10.000s adjustment.
- **PTS → wallclock — shipped** as `findCueWallclocks()`. Uses `#EXT-X-DATERANGE`'s `START-DATE` when present (authoritative), otherwise interpolates from `#EXT-X-PROGRAM-DATE-TIME` + accumulated `#EXTINF` — no PTS-anchor guessing, since the manifest never actually gives us one. Displayed inline in the SCTE cue log.
- **DASH out-of-band SCTE-35 — shipped** as `findDashScte35Events()`. Handles the `xml+bin` encoding (`<Signal><Binary>` → the same `decodeScte35()` used for HLS, unchanged) and explicitly flags pure-XML-encoded signals as "not yet decoded" rather than silently dropping them. The "HLS-only" UI message is gone — DASH cue detection is real now.
- **Continuity & health checks — shipped**: sequence-gap detection (`detectSequenceGap`), `#EXT-X-DISCONTINUITY` counting, live-edge staleness (`isPlaylistStale`, 3× target duration tolerance), and a variant-ladder monotonicity check (`findVariantLadderAnomalies`) run once at master load. Surfaced in a new "Health" status line, warns visibly (amber) when non-OK.
  - Scope note: ladder check runs once at load time since the master isn't re-polled after the initial fetch — a mid-session ladder change wouldn't be caught. Noted, not built; would need periodic master re-fetching.
- **DRM/encryption signaling — shipped**: `findHlsKeys()` (`#EXT-X-KEY`/`#EXT-X-SESSION-KEY`) and `findDashContentProtection()` (`<ContentProtection>`), both mapped through a shared DRM-system UUID table (Widevine/PlayReady/FairPlay/ClearKey/clear). New "DRM" status line; rotation tracked by fingerprint-diffing across polls, same pattern as the SCTE SEQ dedup.
- **Captions/subtitles/language glossary coverage — shipped** (2026-08-18). New `GLOSSARY` entries for HLS `EXT-X-MEDIA` (the tag, its `TYPE=` enum, and the `LANGUAGE`/`ASSOC-LANGUAGE`/`INSTREAM-ID`/`AUTOSELECT`/`DEFAULT`/`FORCED`/`GROUP-ID`/`CHARACTERISTICS` attributes) and DASH's `Role`/`Accessibility` elements plus their caption-relevant values and `lang` attribute — aimed at operators leaning on this tool to understand a stream they didn't produce. The raw manifest box (not just the SCTE cue log) is now run through `linkifyTagLine()` too, so these are actually clickable while reading a real master playlist/MPD, not just theoretical dictionary entries. Attribute *values* (language codes, group/name strings, URIs) are deliberately never linked — only fixed vocabulary, same XSS-safety invariant as the rest of `glossary.js`.

## Phase 2 — Security hardening ✅ Done

`/api/fetch`'s SSRF exposure is closed, in a new `ssrf-guard.js` module (pure logic split out for unit testing):

- **IP-range blocking**: loopback, RFC1918, link-local (including the cloud IMDS address `169.254.169.254`), CGNAT, and the IPv6 equivalents (`::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped addresses checked recursively) — resolving hostnames via `dns.lookup` ourselves rather than trusting `fetch`'s internal resolution, and checking **every** resolved address, not just the first.
- **Redirect re-validation**: switched from `redirect: "follow"` to manual hop-walking, re-running the same hostname check on every redirect target. A redirect to a blocked address is never followed — verified by a test asserting `fetch` was called exactly once when that happens.
- **Response size cap**: 20MB, enforced by streaming the body rather than buffering an unbounded response first.
- Verified three ways: unit tests (95, including exhaustive IP-range coverage and mocked-fetch redirect/cap behavior), e2e tests (via an explicit, narrowly-scoped `SSRF_GUARD_ALLOW_PRIVATE_TARGETS` env var that only the test harness sets — never inferred, off by default), and a manual check against the running server with no bypass confirming `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, and `localhost` are all rejected while a real public URL still succeeds.
- **Known remaining gap, documented in `ssrf-guard.js`**: this validates the resolved IP before connecting but doesn't pin the actual TCP connection to that validated address — `fetch()` re-resolves DNS itself. A DNS answer that changes between our check and fetch's own lookup (DNS rebinding) could theoretically still slip through. Closing that fully needs a custom low-level dispatcher; not implemented. Worth revisiting specifically when Phase 3 lands this on a public Lambda.
- **Not done**: auth/rate limiting on the expensive endpoints — deferred, since it's only meaningful once Phase 3 actually exposes this publicly.

---

## Phase 3 — AWS Amplify hosting migration ✅ Done

Blocks: ccextractor captions, in-band SCTE-35 (if it needs native tools), the Gracenote proxy, and likely the VAST/VMAP fetch. **All of those still not started** — this phase only unblocked them.

`server.js` was a persistent `http.createServer` process, which doesn't map onto Amplify Hosting (static output + optional framework SSR compute, no arbitrary always-on custom server). Split the concerns:

- **Static site**: `webapp/public/` served as-is by Amplify Hosting. Build spec: `baseDirectory: webapp/public`, no build commands (there's nothing to build — still plain `<script>` tags, no bundler).
- **`/api/fetch` and `/api/dns-chain`**: pulled the request-handling logic out of `server.js` into `webapp/api-handlers.js` — pure functions (`handleFetchRequest`, `handleDnsChainRequest`) that take plain args and return `{status, body}`, no transport awareness. `server.js` now just calls into it for local dev; `webapp/lambda/handler.js` is the same logic wrapped for API Gateway's event/response shape. Zero code duplication, zero behavior drift between local and deployed — same SSRF guard, same everything, verified by the same test suite (`tests/unit/api-handlers.test.js`, new).
- **Deployed as a hand-rolled Lambda + API Gateway HTTP API**, not the full Amplify Gen 2 (`@aws-amplify/backend`/CDK) toolchain — deliberate, to match this project's zero-runtime-dependency ethos (`server.js` itself has always used only Node built-ins). The Lambda's own zip has no npm dependencies either — `ssrf-guard.js`/`cdn-chain.js`/`api-handlers.js` were already pure Node (`node:dns`, `node:net`, built-in `fetch`), so nothing new was needed.
- **Deployed resources** (`us-east-1`, account `288975517126`):
  - IAM role `scte-watch-api-lambda-role` — trust policy scoped to `lambda.amazonaws.com` only, one attached managed policy (`AWSLambdaBasicExecutionRole` — CloudWatch Logs write, nothing else).
  - Lambda `scte-watch-api` (Node.js 20.x, 256MB, 25s timeout).
  - API Gateway HTTP API `kncmoavpw9` (`https://kncmoavpw9.execute-api.us-east-1.amazonaws.com`), routes `GET /api/fetch` and `GET /api/dns-chain`, `AWS_PROXY` integration to the Lambda, `$default` auto-deploy stage.
  - Amplify app custom rule: `/api/<*>` → the API Gateway URL, status `200` (a rewrite, not a redirect — keeps the client's `fetch("/api/...")` calls same-origin, so `net.js` needed zero changes and CORS never enters the picture).
- Verified end-to-end against the live URL: SSRF guard blocks `169.254.169.254` and other private ranges through the deployed Lambda exactly as it does locally, and a real DASH manifest (`dash.akamaized.net`) fetches successfully through the guarded proxy.
- **Not done, now more urgent than when this was theoretical**: auth/rate limiting on `/api/fetch` and `/api/dns-chain` (see Phase 2's "not done") — these are live, public, unauthenticated endpoints on the internet now, not endpoints on a laptop bound to `127.0.0.1`. Operator's stated plan is an Amplify-level password gate (Amplify Hosting supports basic auth per-branch) as a stopgap; not yet turned on.
- **DNS-rebinding gap** (documented in `ssrf-guard.js` since Phase 2): still open, now running in the actual public environment the gap matters for. Same caveat as before — the resolved IP is validated but not pinned to the TCP connection.
- **Native-tool work (ccextractor, in-band demux) is NOT built yet** — Phase 3 only proves the Lambda deployment path works for pure-JS handlers. A Lambda Layer with a bundled binary, `/tmp` staging, and the packaging concerns below are still Phase 4 work.
- Constraints to design around for Phase 4 specifically: deployment package/layer size limits, `/tmp` is ephemeral and size-capped, execution time is capped (fine for "grab 1–2 segments," not for anything long-running), and cold-start latency on infrequently-hit routes.

---

## Phase 4 — Server-dependent features

### VAST / VMAP validator ✅ Done (2026-08-18)

New standalone panel (same pattern as the SCTE-35 string decoder — paste input, get structured output), closing the loop from "cue detected" to "ad response validated." Paste a VAST/VMAP URL or raw XML; validates structure; shows the ad pod breakdown (ad system, creative, duration, media files, tracking pixels). URL input rides on the same hardened `/api/fetch` proxy as everything else (ad servers generally don't set CORS headers).

- `public/vast.js` — pure/DOM-free parsing (regex against XML text, same style as `scte35.js`'s DASH parsing, no `DOMParser`), `public/vast-ui.js` — the panel wiring/rendering.
- **Follows VAST Wrapper chains** (`resolveVastChain()`), capped at 5 hops — real ad responses are routinely chained through several vendors before reaching an actual `InLine` ad; a chain that doesn't resolve within the cap is flagged, not silently dropped.
- **VMAP** ad breaks resolve their `AdSource` (inline `VASTAdData` or a fetched `AdTagURI`) and follow that break's own wrapper chain the same way a standalone VAST URL does.
- Output is glossary-linked (`AdSystem`, `InLine`/`Wrapper`, `Linear`/`Companion`/`NonLinear`, `MediaFile`, `Impression`, `ClickThrough`/`ClickTracking`, `TrackingEvents`, `VMAP`/`AdBreak`) — same XSS-safety invariant as the rest of `glossary.js`: only fixed vocabulary ever gets wrapped, never the free-text/URL content ad servers actually control.
- Tested: 15 new unit tests (`tests/unit/vast.test.js`, synthetic fixtures — no real ad server captured) plus 2 new e2e tests in `tests/e2e/playback.test.js`'s offline tier (pasted raw XML, and a real proxy fetch following a Wrapper to its InLine target against a local fixture server).
- Not built: full Companion/NonLinear creative detail (type detection only — nothing in this app renders a companion banner, so there was no reason to parse its dimensions/asset URL yet).

### Captions via ccextractor

New endpoint: fetch a segment or two (not the whole stream), pipe through a bundled `ccextractor` binary, return extracted SRT/VTT. New panel: point at a segment URL (or "grab the current segment" from whatever's loaded in the Stream Tester), render captions as text, downloadable. Gate behind the DRM signaling check (now built — see Phase 1) — refuse/warn rather than running on a stream signaling real DRM.

### In-band SCTE-35

**Scoped to MPEG-TS.** Confirmed with the user (2026-08-18): their setups are standard HLS with `.ts` segments, not fMP4 — the fMP4/`emsg` path (originally floated as the cheaper no-native-dependency option) is **not** a priority here and can be deprioritized/dropped from the plan. Build for MPEG-TS first.

- **MPEG-TS**: needs real PID/PES demuxing — lean on `threefive` (Python, parses both in-band and out-of-band) as a subprocess, or `tsduck`. `threefive` fits naturally given the project's Python origin. This means **this item needs the Amplify Function migration (Phase 3)** or an equivalent place to run a subprocess — unlike the fMP4 path, there's no realistic pure-JS shortcut for TS demuxing.

Fetch a real segment, demux, extract the `splice_info_section`, run it through the **existing** `decodeScte35()` — the binary format is identical to out-of-band, only the transport differs, so the decoder needs zero changes.

**Cost / sampling strategy — must be decided before building.** Manifest polling is a few KB per tick; repeatedly fetching *segments* to scan for in-band cues is orders of magnitude more bandwidth, plus per-invocation Lambda cost and egress. Needs an explicit strategy — on-demand only, 1-in-N sampling, or only-on-discontinuity — or this becomes a surprise bill.

**UI design question, still open**: how to show in-band and out-of-band cues together without cluttering the Manifest Inspector — likely two clearly-labeled sub-columns or a toggle within the existing SCTE-35 cues box, reusing the glossary system rather than inventing new vocabulary. Needs a real design pass once detection works.

**Natural follow-on**: a reconciliation check flagging when in-band and out-of-band disagree (an event/PTS present in one but not the other) — a real packager bug class. PTS→wallclock (needed for a common time basis) is now built (Phase 1). Not committed to yet.

---

## Gracenote EPG drift detection — unblocked, not yet built

**API shape confirmed** (2026-08-19) from a set of working Bash scripts the operator already runs for a related manual QA process (comparing Gracenote's outbound schedule against platform exports) — reviewed and summarized here, not committed to the repo (they contain a live API key; see security note below).

**API**: Gracenote **On API v3**, base `https://on-api.gracenote.com/v3`. Auth is a static `api_key` query-string param on every request — no OAuth, no per-request signing, no visible rotation (the same key appears reused across script versions going back to 2023). Endpoints used:

- **`/Sources?api_key=…&prgSvcId=…`** — channel name lookup for a given `prgSvcId` (Gracenote's own channel/service ID, not the operator's own channel ID — the scripts always take both as separate params and never derive one from the other).
- **`/Schedules?api_key=…&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&prgSvcId=…`** — the actual "what's on when" data, this is the one that matters for drift detection. Response shape **bifurcates by content type**, detected empirically (fetch once, peek at the first entry's `remoteId`; if it starts with `XM` the channel is Xumo-stitched):
  - Xumo-stitched: entries under `//broadcast`, with `../../@prgSvcId`, `../../@date`, `../@time`, `../@dur`, `../@TMSId`, and a `id[@type='remoteId']` child (the Xumo asset ID).
  - Simulcast (standard linear): entries under `//event` directly, with `@prgSvcId`, `@date`, `@time`, `@dur`, `@TMSId`.
  - Either way, the field that matters most for us is **TMSId** — Gracenote's canonical program ID, scoped to a `{date, time, duration}` window on this channel.
- **`/Programs?api_key=…&tmsId=A,B,C,…`** — batched program metadata lookup, comma-joined TMS IDs in **one request** (the scripts also have an older one-tmsId-at-a-time variant with a manual `sleep 2` throttle between calls — the batched form is strictly better and is what we should use; no reason to replicate the throttled version). Field mapping depends on the TMS ID prefix: `EP`/`SH` (episode/show) → title/duration/desc/rating; `MV` (movie) → title/runTime/desc/rating.

**A drift-detector prototype already exists**, just comparing the wrong two things for our purposes: `xumo_vs_gracenote.sh` fetches a Gracenote `/Schedules` window, parses a separately-exported Xumo XML file (a manual export, not an API — from `~/Downloads/{callsign}_{date}.xml`), merges them side-by-side by row position, and flags rows where the asset ID or start time disagree, then computes an `(total − mismatches) / total` alignment percentage. The comparison logic (and its CSV-merge/report pattern) transfers directly to our actual goal — swap "Xumo export" for "this stream's own SCTE-35-derived wallclock timeline" and the shape of the check is the same.

**Design for our version**: a Lambda endpoint that takes `{prgSvcId, timestamp}` (not an arbitrary URL — unlike `/api/fetch`, this one needs to attach a secret server-side, so it must construct the Gracenote URL itself from safe, narrow params rather than proxying a client-supplied target), fetches `/Schedules` for a window around `timestamp`, finds the entry whose `{date,time,duration}` window contains it, and returns `{title, tmsId, startTime, endTime}`. The client then compares that boundary against its own wallclock-mapped SCTE-35 `Program Start`/`Program End` cue (via `findCueWallclocks()`, built in Phase 1) — a mismatch beyond some tolerance is drift. `Programs` (the title/desc lookup) is only needed for a human-readable report, not for the boundary-time check itself.

**Security note**: the API key lives in plaintext in the operator's local scripts (`~/Downloads/gracenote/*.sh`, several copies including archived versions) — fine for a local manual-QA tool, **not** how it should land here. Needs to move to a Lambda environment variable (or Secrets Manager) when this gets built, exactly per the existing plan below — never shipped to the client, never committed to this repo.

Plan once built: server-side proxy (the Lambda above) holding the API key — never shipped to the client — comparing EPG "what's on now" against the stream's own signaling (SCTE-35 `Program Start`/`Program End` descriptors, or `#EXT-X-PROGRAM-DATE-TIME`). PTS→wallclock, needed so EPG times and cue times share a basis, is already built (Phase 1).

---

## Hygiene backlog

- **No README at repo root.** Public repo with an empty landing page; `CONTEXT.md`/`ROADMAP.md` live inside `webapp/`. Needs at least a description, screenshot, and run instructions.
- **Floating CDN dependencies, no SRI.** `index.html` loads `hls.js@1` and `dashjs@4` — floating major versions, no `integrity` attributes. A CDN-side update can change behavior with zero commits on our side, which directly undermines regression testing (tests break with no code change). Pin exact versions + add SRI hashes, or vendor locally. See Open decisions above.
- ~~**No `test` script** in `package.json`~~ — done (Phase 0): `test` and `test:e2e`.
