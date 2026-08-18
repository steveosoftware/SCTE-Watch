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
3. ~~**Phase 2 — security hardening.**~~ **Done** (2026-08-16). Prerequisite for public deploy — satisfied, but re-verify after Phase 3 (a Lambda's network position differs from this laptop's).
4. **Phase 3 — Amplify migration.** Not started. Unblocks everything server-side below.
5. **Phase 4 — server-dependent features.** Not started. ccextractor, in-band SCTE-35, VAST fetch.
6. **Blocked** — Gracenote, pending credentials.

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

## Phase 2 — Security hardening ✅ Done

`/api/fetch`'s SSRF exposure is closed, in a new `ssrf-guard.js` module (pure logic split out for unit testing):

- **IP-range blocking**: loopback, RFC1918, link-local (including the cloud IMDS address `169.254.169.254`), CGNAT, and the IPv6 equivalents (`::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped addresses checked recursively) — resolving hostnames via `dns.lookup` ourselves rather than trusting `fetch`'s internal resolution, and checking **every** resolved address, not just the first.
- **Redirect re-validation**: switched from `redirect: "follow"` to manual hop-walking, re-running the same hostname check on every redirect target. A redirect to a blocked address is never followed — verified by a test asserting `fetch` was called exactly once when that happens.
- **Response size cap**: 20MB, enforced by streaming the body rather than buffering an unbounded response first.
- Verified three ways: unit tests (95, including exhaustive IP-range coverage and mocked-fetch redirect/cap behavior), e2e tests (via an explicit, narrowly-scoped `SSRF_GUARD_ALLOW_PRIVATE_TARGETS` env var that only the test harness sets — never inferred, off by default), and a manual check against the running server with no bypass confirming `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, and `localhost` are all rejected while a real public URL still succeeds.
- **Known remaining gap, documented in `ssrf-guard.js`**: this validates the resolved IP before connecting but doesn't pin the actual TCP connection to that validated address — `fetch()` re-resolves DNS itself. A DNS answer that changes between our check and fetch's own lookup (DNS rebinding) could theoretically still slip through. Closing that fully needs a custom low-level dispatcher; not implemented. Worth revisiting specifically when Phase 3 lands this on a public Lambda.
- **Not done**: auth/rate limiting on the expensive endpoints — deferred, since it's only meaningful once Phase 3 actually exposes this publicly.

---

## Phase 3 — AWS Amplify hosting migration

Blocks: ccextractor captions, in-band SCTE-35 (if it needs native tools), the Gracenote proxy, and likely the VAST/VMAP fetch.

`server.js` today is a persistent `http.createServer` process — that model doesn't map onto Amplify Hosting, which serves static output (our `public/` directory is a perfect fit as-is) plus optional SSR compute for specific supported frameworks. It does not run an arbitrary always-on custom server.

Everything server-side becomes an **Amplify Function** (AWS Lambda):
- `/api/fetch` (the CORS proxy, hardened per Phase 2 — re-verify the DNS-rebinding gap above in this environment specifically) → a Lambda behind an API route.
- Native-tool work (ccextractor, in-band demuxing) → a Lambda with the binary bundled as a Lambda Layer (compiled for the target architecture — x86_64 or arm64/Graviton), downloading segments into `/tmp`, shelling out, returning results.
- Constraints to design around: deployment package/layer size limits, `/tmp` is ephemeral and size-capped, execution time is capped (fine for "grab 1–2 segments," not for anything long-running), and cold-start latency on infrequently-hit routes.
- Add auth/rate limiting on the expensive endpoints here (see Phase 2's "not done").

---

## Phase 4 — Server-dependent features

### VAST / VMAP validator

New standalone panel (same pattern as the SCTE-35 string decoder — paste input, get structured output), closing the loop from "cue detected" to "ad response validated." Paste a VAST/VMAP URL or raw XML; validate structure; show the ad pod breakdown (ad system, creative, duration, tracking pixels). URL input needs the fetch proxy (ad servers generally don't set CORS headers), so it rides on the same hardened endpoint.

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

## Blocked — waiting on external info

### Gracenote EPG drift detection

**Not starting** until the exact API query shape and credentials are provided.

Plan once unblocked: server-side proxy (Amplify Function) holding the API key — never shipped to the client — comparing EPG "what's on now" against the stream's own signaling (SCTE-35 `Program Start`/`Program End` descriptors, or `#EXT-X-PROGRAM-DATE-TIME`). PTS→wallclock, needed so EPG times and cue times share a basis, is now built (Phase 1).

---

## Hygiene backlog

- **No README at repo root.** Public repo with an empty landing page; `CONTEXT.md`/`ROADMAP.md` live inside `webapp/`. Needs at least a description, screenshot, and run instructions.
- **Floating CDN dependencies, no SRI.** `index.html` loads `hls.js@1` and `dashjs@4` — floating major versions, no `integrity` attributes. A CDN-side update can change behavior with zero commits on our side, which directly undermines regression testing (tests break with no code change). Pin exact versions + add SRI hashes, or vendor locally. See Open decisions above.
- ~~**No `test` script** in `package.json`~~ — done (Phase 0): `test` and `test:e2e`.
