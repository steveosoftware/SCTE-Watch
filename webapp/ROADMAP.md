# SCTE-WATCH — roadmap

Update this alongside `CONTEXT.md` as items land.

## Explicitly out of scope

- **Multi-channel monitor grid** (a dashboard polling a saved list of streams concurrently) — this app is a single-stream tester/inspector, not an ops monitoring platform.
- **Stuck-in-break alerting / webhooks** (paging on a cue-out with no matching cue-in) — same reason; alerting infrastructure is out of scope.

## Open decisions (not yet made)

- **`scte35watch.py`** — the original CLI at repo root. Actively maintained, deprecated in favor of the web app, or kept as reference? Its fate affects whether it gets test coverage. (It used to also bear on the in-band SCTE-35 work, as the natural host for a Python `threefive` subprocess — that reasoning is dead: in-band is pure JS, see the corrected Phase 4 entry. The question is now purely about the CLI itself.)
- **hls.js / dash.js delivery** — currently loaded from jsdelivr at floating major versions with no integrity hashes (see Hygiene below). Pin exact versions + SRI, or vendor the files into `public/`? Vendoring also removes a runtime external dependency, which matters for an Amplify deploy.

## Sequence

1. ~~**Phase 0 — testing foundation.**~~ **Done** (2026-08-16).
2. ~~**Phase 1 — client-side only.**~~ **Done** (2026-08-16).
3. ~~**Phase 2 — security hardening.**~~ **Done** (2026-08-16). Prerequisite for public deploy — satisfied, re-verified live in Phase 3's Lambda environment.
4. ~~**Phase 3 — Amplify migration.**~~ **Done** (2026-08-18). Live at https://roadmap.d3qk02ponpvf7m.amplifyapp.com/. Unblocks everything server-side below — **not yet started on any of it**.
5. **Phase 4 — server-dependent features.** In progress. VAST/VMAP validator ✅ done (2026-08-18). ccextractor and in-band SCTE-35 not started.
6. ~~**EPG drift detection.**~~ **Done** (2026-08-26; comparison basis reworked 2026-08-27 to check the *stream* rather than a second schedule; verified against production 2026-08-28). Credential question resolved — the REST `api_key` API is the approach, FTP is a separate pipeline and out of scope. Serialization verified against a live response. PDT anchoring landed 2026-09-10, fixing a boundary false alarm along with it. **One open item**: channel pairing can't be auto-verified in Gracenote mode. See its own section below.

---

## Phase 0 — Testing foundation ✅ Done

- `tests/unit/` — Node's built-in `node:test`, zero new runtime dependency (95 at the time of Phase 0; 269 as of 2026-08-28 — re-run rather than trusting a number written here). Covers `scte35.js` (decoder golden-file suite, `pts_adjustment` regression, wallclock timeline, DASH EventStream/ContentProtection parsing, continuity checks), `glossary.js` (including the XSS-invariant suite), `net.js`, and `ssrf-guard.js`.
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

Blocks: ccextractor captions and the Gracenote proxy. (Originally listed in-band SCTE-35 too — **it isn't blocked by this phase**, corrected 2026-09-11: it's pure JS and runs in the browser. The VAST/VMAP fetch shipped 2026-08-18 through the existing proxy.)

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

~~**MPEG-TS**: needs real PID/PES demuxing — lean on `threefive` (Python) as a subprocess, or `tsduck`… this item needs an equivalent place to run a subprocess — there's no realistic pure-JS shortcut for TS demuxing.~~

**CORRECTED 2026-09-11 — no subprocess, no native tool, and no server needed.** That assessment predates `public/tsanalyze.js` (built for the segment byte scan) and rested on an assumption that turns out to be wrong. Demonstrated working end to end in pure JS against a real `splice_insert` captured from a live channel:

1. **Find the PID** — `analyzeTsSegment()` already walks PAT → PMT and surfaces `stream_type 0x86`. **Built.**
2. **Reassemble the section** — ~25 lines. **New, and the only new code needed.**
3. **Decode** — `decodeScte35()`, unchanged. **Built.**

Why the "needs PES demuxing" premise was wrong: **SCTE-35 in TS is section-carried, not PES.** The expensive part of demuxing is reassembling PES streams — video scattered across thousands of packets with adaptation fields and PTS handling. A splice_info_section is PSI-shaped: pointer_field, `table_id` `0xFC`, a 12-bit `section_length`, done — and almost always inside a single 188-byte packet. The original note's own prediction about the decoder was exactly right (`decodeScte35()` already rejects anything whose first byte isn't `0xFC`, so section bytes drop straight in); it just overestimated the step before it.

Consequence: this can run **in the browser**, like the segment byte scan, via `analyzeSegment()`'s direct-fetch-with-proxy-fallback. A Lambda works too but buys nothing and costs egress. Phase 3 is *not* a prerequisite for this item.

Not yet proven: multi-packet sections (the reassembler handles them, but only the single-packet path is tested — that's the normal case), behaviour against a real in-band stream (none available; the fixture is synthetic around a real payload), and cross-poll dedupe (a cue lives in the stream for its whole lifetime, so it needs the same media-sequence keying the manifest path already uses).

**Cost / sampling strategy — still the real open question, and the only one.** Measured against a live channel 2026-09-11 (727-byte playlist, 3.1MB 1080p segment, 217KB 144p segment, 6.006s segments, 4s poll), for 24h of *continuous* monitoring:

| | per 24h |
|---|---|
| manifest polling only (today) | 15 MB |
| + scan every segment, 144p | 2.9 GB |
| + scan every segment, 1080p | **41.6 GB** (~2,843x) |
| + 1-in-10 sampling, 1080p | 4.2 GB |
| + 1-in-10 sampling, 144p | 313 MB |
| one on-demand 3-segment scan (144p) | 0.6 MB |

The jump is the whole point: an out-of-band cue lives in a 727-byte file, an in-band cue lives in a 3.1MB one, and nothing in the code looks different — it's one `fetch()`.

Options, with the trade named:

- **On-demand** — what the segment byte scan does. Free until pressed; useless for catching a cue you weren't already watching for.
- **1-in-N sampling** — 10x cheaper, but a 30s break spans ~5 segments, so 1-in-10 misses whole breaks. Trading correctness for cost, and for *cue detection* that trade is bad.
- **Only-on-discontinuity** — best of the three. Breaks usually coincide with `#EXT-X-DISCONTINUITY`, which is visible in the cheap file, so poll manifests and open segments only when the manifest says something happened. Caveat: a packager that sets no discontinuity tags (like stream_37099, verified) makes this blind.

Two things that shrink the problem regardless: **pick the lowest-bandwidth variant** (217KB vs 3.1MB, a free 14x, and the SCTE-35 PID carries identical bytes in every rendition — cues aren't re-encoded per variant), and **fetch client-side** so there is no Lambda egress at all. With both, "surprise bill" becomes a bandwidth-politeness question about someone else's CDN rather than an AWS invoice.

**UI design question, still open**: how to show in-band and out-of-band cues together without cluttering the Manifest Inspector — likely two clearly-labeled sub-columns or a toggle within the existing SCTE-35 cues box, reusing the glossary system rather than inventing new vocabulary. Needs a real design pass once detection works.

**Natural follow-on**: a reconciliation check flagging when in-band and out-of-band disagree (an event/PTS present in one but not the other) — a real packager bug class. PTS→wallclock (needed for a common time basis) is now built (Phase 1). Not committed to yet.

---

## EPG drift detection ✅ Done (2026-08-26, reworked 2026-08-27)

**API shape confirmed** (2026-08-19) from a set of working Bash scripts the operator already runs for a related manual QA process (comparing Gracenote's outbound schedule against platform exports) — reviewed and summarized here, not committed to the repo (they contain a live API key; see security note below).

**API**: Gracenote **On API v3**, base `https://on-api.gracenote.com/v3`. Auth is a static `api_key` query-string param on every request — no OAuth, no per-request signing, no visible rotation (the same key appears reused across script versions going back to 2023). Endpoints used:

- **`/Sources?api_key=…&prgSvcId=…`** — channel name lookup for a given `prgSvcId` (Gracenote's own channel/service ID, not the operator's own channel ID — the scripts always take both as separate params and never derive one from the other).
- **`/Schedules?api_key=…&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&prgSvcId=…`** — the actual "what's on when" data, this is the one that matters for drift detection. Response shape **bifurcates by content type**, detected empirically (fetch once, peek at the first entry's `remoteId`; if it starts with `XM` the channel is Xumo-stitched):
  - Xumo-stitched: entries under `//broadcast`, with `../../@prgSvcId`, `../../@date`, `../@time`, `../@dur`, `../@TMSId`, and a `id[@type='remoteId']` child (the Xumo asset ID).
  - Simulcast (standard linear): entries under `//event` directly, with `@prgSvcId`, `@date`, `@time`, `@dur`, `@TMSId`.
  - Either way, the field that matters most for us is **TMSId** — Gracenote's canonical program ID, scoped to a `{date, time, duration}` window on this channel.
- **`/Programs?api_key=…&tmsId=A,B,C,…`** — batched program metadata lookup, comma-joined TMS IDs in **one request** (the scripts also have an older one-tmsId-at-a-time variant with a manual `sleep 2` throttle between calls — the batched form is strictly better and is what we should use; no reason to replicate the throttled version). Field mapping depends on the TMS ID prefix: `EP`/`SH` (episode/show) → title/duration/desc/rating; `MV` (movie) → title/runTime/desc/rating.

**A drift-detector prototype already exists**: `xumo_vs_gracenote.sh` fetches a Gracenote `/Schedules` window, parses a separately-exported platform XML file, merges them side-by-side by row position, flags rows where the asset ID or start time disagree, and computes an `(total − mismatches) / total` alignment percentage. Its comparison logic and CSV-merge/report pattern transfer directly.

### Decisions made 2026-08-20

**1. Credentials: user-supplied, never ours.** The app is public-facing, so it will **not** hold a Gracenote key at all — no Lambda env var, no Secrets Manager, nothing server-side. Instead the panel takes the user's own `api_key` in a UI input (`type="password"`, never committed). Rationale: per-user keys mean no shared quota to abuse, no secret in our infra, nothing for us to rotate, and no way for a stranger to spend the operator's API budget. This **supersedes** the earlier "Lambda holds the key" plan. *(The "in-memory only, never localStorage" half of this decision was revisited 2026-08-28 — see "Remembering the key" below. The part that matters, no credential of ours anywhere, still holds.)*
  - Mechanically this needs **zero backend work**: browsers can't call Gracenote directly (no CORS), but the client can build the full Gracenote URL *including* the key and pass it through the existing `/api/fetch` proxy.
  - Known caveat, accepted for now: that puts the key in a query string transiting our Lambda. Nothing writes it down today (our handler logs no request URLs; HTTP API access logging is off by default), but it's one config change away from landing in CloudWatch. A dedicated route taking the key in a header would close that if it ever matters.

**2. Compare EPG-vs-EPG, not EPG-vs-SCTE.** The original plan assumed SCTE-35 could tell us where *programs* start and end. That relies on segmentation descriptors `0x10`/`0x11` (Program Start/Program End) — and in practice most FAST packagers emit **ad-break** signaling only (`CUE-OUT`/`CUE-IN`, Provider Placement Opportunity) and never emit program boundaries at all. A CUE-OUT marks an ad, not a show. `#EXT-X-PROGRAM-DATE-TIME` doesn't rescue it either: PDT gives the wallclock of a *segment*, not where a program boundary falls, so comparing "Gracenote says Show X is on now" against "PDT says it's now" is near-tautological.
  - **Primary check** is therefore two schedule sources against each other (Gracenote vs the platform's own EPG export) — always available, no stream cooperation needed, and the failure it catches (bad metadata) is the one that actually happens routinely.
  - **SCTE-35 reconciliation becomes opportunistic**: if a stream *does* carry `0x10`/`0x11`, show the comparison; otherwise say "this stream doesn't signal program boundaries" and move on. Cheap to add later — descriptor decoding and wallclock mapping are both already built (Phase 1) — but a bonus, not the feature.
  - **Scope note, named deliberately**: EPG-vs-EPG doesn't touch the stream at all. It's a metadata QA tool living inside a stream inspector. That's acceptable — it's a standalone panel like the VAST/VMAP validator, same shape — but it is a different surface from the rest of the app.

**3. Port target, and what to fix in the port.** Two real defects in the reference script, worth *not* reproducing:
  - **The merge is positional, not keyed.** `paste` glues the two CSVs together by line number; nothing joins on time or ID. The platform side is `sort`ed, the Gracenote side stays in API document order. Any difference in row count or ordering silently produces nonsense instead of an error. **The web version must join on start time**, not row position — this is the single most important correctness fix in the port.
  - **The asset check is stitched-only.** `$7 != $16` compares the platform's `StationProgramID` against Gracenote's `remoteId`, which only exists in the `broadcast` (Xumo-stitched) branch. In the `event` (simulcast) branch that column is `updateDate`, so it mismatches on every row.

**4. Date inputs use `<input type="date">`.** Requested 2026-08-20: the panel needs to either show the expected date format or give a calendar picker. The native date input does both at once and is the right call — it renders a calendar dropdown, and the browser guarantees its `.value` is always `YYYY-MM-DD` no matter what locale-specific format it *displays* to the user (a US viewer sees `08/24/2023`; the value is still `2023-08-24`). That's exactly the format Gracenote's `startDate`/`endDate` want, so there's no parsing, no formatting, and no "enter dates as YYYY-MM-DD" helper text to write or keep accurate. Worth knowing this is browser-native behavior we're leaning on deliberately, not an accident — don't "helpfully" swap it for a text input later.

### Platform EPG source — resolved 2026-08-25

**It's a fetchable URL, so both sides automate.** No file-upload input needed; the panel takes a Xumo XMLTV URL and pulls it through the existing `/api/fetch` proxy alongside the Gracenote call. (This supersedes the earlier open question about the manual `~/Downloads/{callsign}_{YYYYMMDD}.xml` export — that file was presumably a hand-saved copy of one of these feeds, and its `AffiliateStation`/`CalendarDT`/`StationProgramID` schema is *not* what the live feeds serve.)

**Format is standard XMLTV**, `https://carbon.xumo.com/epg/xmltv/{xumoChannelId}_{callsign}.xml`. Samples reviewed: `88840011_XSNFH` (FilmRise Horror, movies) and `88840016_XSNFF` (Forensic Files, series).

- Root `<tv date="…">`, one `<channel id="…">` with `<display-name>`, then `<programme start="…" stop="…" channel="…">` entries.
- Times are XMLTV format — `20260825225917 +0000` (`YYYYMMDDHHMMSS ±ZZZZ`), UTC in these samples.
- **~7 days of schedule per file** (173h and 152h in the samples), and **perfectly contiguous** — every programme's `stop` equals the next one's `start`, zero gaps or overlaps.

**Join keys, in order of usefulness:**

| Field | Example | Notes |
|---|---|---|
| `start` attribute | `20260825225917 +0000` | **Unique within a file** (verified on both samples). This is the join key. |
| `<programme-id>` | `XM03Z0K05Q9CN4` | Xumo asset ID. 100% present, always `XM`-prefixed — this is what Gracenote returns as `id[@type='remoteId']` on stitched channels, i.e. the thing the old script's asset check was reaching for. |
| `<tms-id>` | `MV001824280000`, `EP022439260403` | Gracenote TMS ID, same `EP`/`SH`/`MV` prefix convention the Gracenote scripts already key off. |
| `<external-id system="xumo">` | `XM03Z0K05Q9CN4` | Duplicate of `programme-id` in both samples. |

**Two findings that directly shape the comparison logic:**

1. **TMS IDs repeat — do not join on them.** The movie channel has 83 TMS IDs but only **31 distinct** (a title airs several times a week); the series channel, 324 entries and 232 distinct. Start time is the only unique key. This independently confirms the fix already flagged above: **join on start time**, never on row position or program ID.
2. **17% of the movie channel has no `tms-id` at all** — 17 of 100 entries, spanning 7 distinct titles, all alternate cuts (`[Broadcast Edit]`, `Director's Cut`). The series channel has 100% coverage. These are a legitimate data gap, not corruption, so the comparison must report them as **"no TMS mapping"** rather than counting them as mismatches — otherwise a movie channel's alignment score is permanently and misleadingly wrong.

**Movies vs series field differences** (the "slight format difference"): series programmes additionally carry `<sub-title>`, `<date>` (original air date), `<series-id>`, `<series-description>`, and two `<episode-num>` systems (`xmltv_ns` zero-based `5.29.0`, `onscreen` `S6E30`). Movie programmes have none of those. Everything else — `title`, `desc`, `credits`, `category`, `keyword`, `rating`, `icon`, and the ID fields above — is common to both. A parser should treat the episode/series block as optional rather than branching on content type.

**Still user-supplied: the channel-ID mapping.** XMLTV identifies the channel by **Xumo** channel ID (`88840011`); Gracenote identifies it by `prgSvcId` (`156201`). Neither feed carries the other's identifier, so the panel needs both from the user — exactly as the old scripts took `prgSvcId` and `callsign` as separate arguments.

**5. Inputs are the full XMLTV URL + the Gracenote ID** (decided 2026-08-26). The Xumo channel ID is an *address*, not a join key — it only selects which feed to fetch, and the feed URL needs the callsign alongside it (`88840011` + `XSNFH`). Asking for both pieces separately would be two inputs to build one URL, and brittle if Xumo changes the path pattern. So the panel takes the **whole XMLTV URL** pasted in, and reads the channel id / display name back *out* of the fetched document.

**6. Channel-pairing guardrail.** Because the two IDs are unverified user assertions, pairing the wrong two channels yields a clean-looking ~0%-aligned report that reads as catastrophic drift but is really just operator error. Cheap to catch: Gracenote `/Sources?prgSvcId=` returns a channel `<name>`, XMLTV carries `<display-name>`. Compare them and surface both names as a **confirmation signal** to the user, warning on mismatch. Non-blocking (legitimate naming differences exist), but it turns a silently-misleading report into an obviously-suspect one.

**The two `*_cms.json` files are not EPG data** and aren't part of this feature. They're Roku CMS channel manifests — `providerName`/`categories`/`playlists`/`liveFeeds[]`, where `liveFeeds[]` carries channel id, title, advisory rating, thumbnail, description, and **the HLS master URL**. No programme listings, no times, no TMS IDs; the two samples describe different channels (`88884008`, `88884125`) than the XMLTV samples. Worth remembering separately though: they map a channel to its playable HLS master, which is a plausible future convenience (pick a channel → auto-fill the Stream Tester URL), just unrelated to drift detection.

### Shipped 2026-08-26

`public/epg.js` (pure parsing + comparison) and `public/epg-ui.js` (the panel). All six decisions above were built as specified. Implementation notes worth keeping:

- **One parser, not two branches.** The shell scripts sniffed the first entry's `remoteId` to choose between `//broadcast` and `//event` XPaths — but those describe the *same* tree (`<schedule prgSvcId date>` > `<event time dur TMSId>`), with stitched channels merely adding a nested `<broadcast><id type="remoteId">`. Matching `<event>` and reading the optional nested id handles both, so the sniffing step (and the bug where the two branches disagreed on a filename) simply doesn't exist here.
- **Pairing is a linear two-pointer merge** over both start-sorted lists. `pairWindowSeconds` (default 300) decides what counts as the same slot; `driftToleranceSeconds` (default 0, exposed in the UI) decides what counts as drift. Separating those two knobs matters — one generous window to *identify* a pair, one strict threshold to *judge* it.
- **`alignmentPct` is `null`, never `0`,** when nothing is comparable — a 0% would read as total failure rather than "no data."
- **Test coverage**: 46 unit tests (`tests/unit/epg.test.js`) plus 4 e2e tests in the offline tier, including one asserting the API key never reaches the DOM. XMLTV fixtures are trimmed from the real feeds (`xmltv-movies.xml` deliberately keeps an entry with no `tms-id`); Gracenote fixtures are clearly labeled **SYNTHETIC**.

**✅ Resolved — the REST API is the approach** (2026-08-27, confirmed by the operator: *"api approach is not being retired. it's the approach we'll use."*). The FTP user/password mentioned earlier is a separate pipeline and is **out of scope for this feature**. No FTP client, no credential handling beyond the user-supplied `api_key`, no change to the data path.

For the record, since it was investigated: FTP would have needed a genuinely different design, not a different auth header — browsers dropped FTP entirely (Chrome 88 / Firefox 90), `ssrf-guard.js` rejects non-http(s) by design and Node's built-in `fetch()` has no FTP support, FTP credentials are account logins rather than scoped tokens, and FTP delivery is bulk file drops rather than per-channel/date-window queries. If it ever does become relevant, the recommended shape is operator-supplied files rather than the app holding credentials.

### Shipped 2026-08-26

`public/epg.js` (pure parsing + comparison) and `public/epg-ui.js` (the panel). All six decisions above were built as specified. Implementation notes worth keeping:

- **One parser, not two branches.** The shell scripts sniffed the first entry's `remoteId` to choose between `//broadcast` and `//event` XPaths — but those describe the *same* tree (`<schedule prgSvcId date>` > `<event time dur TMSId>`), with stitched channels merely adding a nested `<broadcast><id type="remoteId">`. Matching `<event>` and reading the optional nested id handles both, so the sniffing step (and the bug where the two branches disagreed on a filename) simply doesn't exist here.
- **Pairing is a linear two-pointer merge** over both start-sorted lists. `pairWindowSeconds` (default 300) decides what counts as the same slot; `driftToleranceSeconds` (default 0, exposed in the UI) decides what counts as drift. Separating those two knobs matters — one generous window to *identify* a pair, one strict threshold to *judge* it.
- **`alignmentPct` is `null`, never `0`,** when nothing is comparable — a 0% would read as total failure rather than "no data."
- **Test coverage**: 46 unit tests (`tests/unit/epg.test.js`) plus 4 e2e tests in the offline tier, including one asserting the API key never reaches the DOM. XMLTV fixtures are trimmed from the real feeds (`xmltv-movies.xml` deliberately keeps an entry with no `tms-id`); Gracenote fixtures are clearly labeled **SYNTHETIC**.

**⚠ Open — which Gracenote credential/transport actually applies (raised 2026-08-26, awaiting operator).** The operator mentioned Gracenote access being "a user and a password for the FTP connection," which does not match what the reference scripts do. Unresolved; do not rework the panel's auth until this is settled.

- **What's evidenced today**: all six scripts authenticate solely with `api_key` over HTTPS to `on-api.gracenote.com/v3` — no FTP, no username/password anywhere in them. That path is confirmed *live*: a real request during testing returned a valid Gracenote XML error document, so the endpoint and key both function.
- **Why this isn't a swap of auth headers.** FTP would need a genuinely different data path:
  - Browsers removed FTP entirely (Chrome 88 / Firefox 90, 2021) — `fetch("ftp://…")` does not exist client-side.
  - `ssrf-guard.js` rejects any non-http/https protocol by design, and Node's built-in `fetch()` has no FTP support — so the proxy can't carry it either. It would require a real FTP client dependency in the Lambda, breaking the project's zero-runtime-dependency property.
  - Credential posture degrades sharply: an `api_key` is a scoped, revocable token (fine for "paste your own"), whereas FTP credentials are typically a full account login. Routing those through our infrastructure is a materially different risk from what the credential policy in CONTEXT.md was written for.
  - The data model differs too — FTP delivery is bulk file drops, not per-channel/date-window queries. That's a different feature, not a variant of this one.
- **If FTP turns out to be the path**, the recommended shape is: the operator pulls the files down themselves and the panel accepts an uploaded/pasted file, keeping credentials off our infrastructure entirely. Preferred even if the FTP connection were technically possible.
- **Most likely resolution** (unconfirmed): the operator has both — the REST API for queries and a separate FTP drop for bulk delivery — in which case the panel as built is already correct and the FTP is an unrelated pipeline.

**✅ Gracenote serialization — now VERIFIED** (2026-08-28, against a live `/Schedules?prgSvcId=157905` response). This replaces the earlier "unverified assumption" warning. What the real response looks like:

```xml
<on schemaVersion="3.27"><schedules type="tv">
  <schedule prgSvcId="157905" date="2026-08-28" updateDate="2026-08-28T02:04:42Z">
    <event TMSId="EP022439260099" rootId="9131772" time="00:19" dur="PT00H28M" isGeneric="false">
      <quals>CC|HD 720p</quals>
      <broadcast><id type="remoteId">XM0S73JEOMUUNL</id></broadcast>
    </event>
```

The structural inference from the shell scripts was correct — `<schedule prgSvcId date>` > `<event time dur TMSId>` with a nested `<broadcast><id type="remoteId">` on stitched channels, and one parser covering both channel types. Three concrete corrections came out of it:

1. **`dur` is an ISO 8601 duration (`PT00H28M`), not seconds or `HH:MM:SS`.** This was a live bug: every real duration parsed to `null`, which nulled `stopMs`, which made `findScheduledAt` match nothing — surfacing to the operator as *"I'm not seeing a Gracenote schedule returned"* rather than as a parse error. `parseDurationSeconds` now handles ISO (with any component omitted) plus the previous forms.
2. **`time` is `HH:MM`** — no seconds component. Already handled.
3. **The response body carries no credential** — `api_key` is a request parameter and is not echoed back in `<requestParameters>` (verified before committing a capture). So real responses are safe to keep as fixtures.

`tests/fixtures/gracenote-schedule-real.xml` is a trimmed real capture and is now the fixture that pins this serialization; the synthetic fixtures were regenerated to use the real ISO duration format so they can't drift from reality again.

**Another parser gap found the same way**: XML comments were not stripped, so markup-shaped text inside a comment was matched as real markup. Fixed with `stripComments()` ahead of all matching, on both the XMLTV and Gracenote paths.

### First live run — 2026-08-28

Ran end to end against a real channel (`88893069`) and a real Gracenote schedule (`prgSvcId 157905`). Three things came out of it:

**1. The Gracenote → Xumo asset mapping exists exactly as hoped.** Every one of the 103 events carries `<broadcast><id type="remoteId">XM…</id></broadcast>`, and that is the Xumo asset id — the same namespace as the `/content/{ASSET_ID}/` path in the `.ts` segment URLs. The join the whole feature depends on is real and direct.

**2. `unscheduled` is usually not an alarm — it's an ad break.** The first live verdict was `UNSCHEDULED`, which initially looked like a mispaired channel. It wasn't: the playing asset `XM05M7E0PC09SI` resolves to *"Forensic Files EN Ad Slate 2026 2 Minutes"* (`SHORT-FORM`, 120s), while the schedule expected `XM0INFHT3SEGWZ` = *"Palm Saturday"* (`EPISODIC`, 1275s). **EPGs schedule programmes, not break filler**, so filler is legitimately absent from the schedule and the tool was reporting correctly — it just wasn't saying so usefully. The panel now resolves titles via Xumo's public asset endpoint (one lookup per asset change, cached, best-effort) and uses `contentType` to separate routine filler from a genuine finding.

**3. Channel pairing still can't be auto-verified in Gracenote mode.** `/Sources?prgSvcId=157905` returns `<callSign>XRGFF</callSign>` plus `<URL>https://play.xumo.com/live-guide/forensic-files</URL>` and `countriesOfCoverage: CAN`. The callsign is the same one used in the XMLTV URL pattern `{xumoChannelId}_{callSign}.xml`, so it's a partial bridge — but nothing in either feed yields the Xumo *channel* id, so the pairing remains a user assertion. Worth revisiting if a channel-id ↔ prgSvcId mapping ever turns up.

### Titles on both sides — 2026-08-28

`/Schedules` returns TMS ids and no titles, so a report read as bare `EP0224…` / `XM0…` strings. Titles now come from a second `/Programs?tmsId=A,B,C` call: distinct ids only (a title airs repeatedly), chunked at 50 per request so a 14-day window can't produce an over-long URL, issued once per schedule load, and fully best-effort — losing it costs titles, never the comparison.

Two shape details worth knowing: Gracenote's `<titles>` block carries truncated `type="red"` variants alongside the real one (Forensic Files degrades to just `"Forensic"` at size 10), so the parser explicitly prefers `type="full"`; and this series returns **no `<episodeTitle>`** at all, only `<episodeInfo season number>`, so `displayTitle` falls back to `Forensic Files S13E41`.

The two lookups turn out to be complementary — Xumo's asset endpoint gives the *episode name*, Gracenote gives the *season/episode number*:

```
✓ correct asset playing · playing XM0YNWLNHUP8YD — Shoe-In For Murder
                        · expected XM0YNWLNHUP8YD (Forensic Files S13E41)
```

**Verified against production**, both modes, real browser, no stubs:

- **Gracenote**: channel `88893069` + `prgSvcId 157905` → `match`, 52/52 titles resolved, no console errors, API key absent from the DOM, CSV export correct.
- **XMLTV**: correctly flagged a deliberately mispaired channel (playback `88884008` vs XMLTV `88840011`) as `unscheduled`, resolving the playing asset to `Lone Star Shark (MOVIE, 3915s)` — not filler, so it warns rather than treating it as routine.

**The 88893069 ↔ 157905 pairing is confirmed correct.** The earlier `UNSCHEDULED` verdict on that same pair was the channel sitting in an ad break, not a mispairing — my initial read of that was wrong.

### Transition reporting fixed — 2026-08-28

Live testing surfaced noisy output: one status change followed by seven "asset change in window" lines, the same two transitions repeated at slightly different times each poll. Two distinct bugs:

1. **The transition log sat outside the "only on change" guard**, so every poll re-reported every transition still inside the ~60s playlist window.
2. **The reported time moved between polls** — 13:08:17, then :22, then :20 for the same event. Inherent to anchoring the timeline at the live edge: between polls the wall clock advances but the playlist only advances in whole segments, so the whole interpolated timeline slides by up to a segment duration.

Fixed by giving each transition a stable identity: the `#EXT-X-MEDIA-SEQUENCE` number of the new asset's first segment. Sequence numbers don't move when the window slides. The first sighting is kept as the best time estimate (fewest segments between the transition and the live-edge anchor), which also stops the drift figure jittering. Guarded by an e2e test that polls an unchanged straddling window repeatedly and asserts exactly one transition line.

The drift line now also states its own accuracy — `±1 segment; estimated from the live edge, not read from PROGRAM-DATE-TIME` — since a figure like `+503s` should not be read as second-accurate. (Originally worded `no PROGRAM-DATE-TIME in this stream`; corrected 2026-08-28, see below.)

**Not built**: the opportunistic SCTE-35 program-boundary reconciliation (decision 2 above) — now largely moot, since asset ids answer the question directly without needing program boundaries at all.

### Schedule printing + panel order — 2026-08-28

Operator asked for two things: a way to print a channel's Gracenote schedule on its own, and the EPG panel moved above the VAST/VMAP one.

**Print schedule.** Until now the schedule was only ever a means to an end — loaded, compared against the stream, and never shown. But the listing answers a question of its own: *what does the provider think this channel is airing?* Three concrete uses, all of which came up during live testing: confirming a `prgSvcId` is the channel you think it is before starting a drift run (the pairing problem has no automatic check, so eyeballing the titles is the only check there is), reading back what was meant to be on air after a run flagged something, and handing the airings to someone who hasn't got a key to paste in.

Implementation kept the same shape as everything else here: `formatScheduleListing()` and `buildScheduleCsv()` in `epg.js` are pure, DOM-free and operate on the *normalized* schedule, so XMLTV prints identically to Gracenote for free. The listing is column-aligned plain text (index, start UTC, duration, asset id, TMS id, title) with a `▶` marking the airing that covers now. Two details worth keeping:

- **Dates, not just times.** The existing log uses `HH:MM:SS` because it only ever reports "now". A 14-day window needs `YYYY-MM-DD HH:MM:SS` or the listing is ambiguous at every midnight.
- **Printing during a run reuses the loaded schedule rather than re-fetching** — same channel, same window; a second fetch would spend the user's Gracenote quota and interleave its progress lines with the live monitor log.

The three CSV builders now share one `csvEscape`/`toCsv` pair instead of each carrying its own copy of the quoting rule.

**Panel order.** The EPG panel now sits above the VAST/VMAP validator in `index.html`: schedule/drift work is the daily job, ad-response validation the occasional one. An e2e test asserts the DOM order so a later edit can't silently undo it.

### Remembering the key — 2026-08-28

The original decision was "in-memory only, never localStorage". The operator asked for the opposite: retyping a long opaque key at the start of every session was the main friction in actually using the panel, and a tool people avoid opening catches no drift.

Persisting it to `localStorage` (`scte-watch.gracenote-api-key`) with a visible **Remember in this browser** checkbox, defaulting on. Unticking is treated as "forget it", not just a preference for next time — the stored copy is removed immediately — and the opt-out is itself persisted (`scte-watch.gracenote-remember-key`) so typing a key later doesn't quietly re-enable storage. Only the key is stored; the other fields are ids and URLs that change per check anyway.

What this does and doesn't relax: the key still goes only to Gracenote, never to our own backend, never into a Lambda env var, never into the repo — the part of the original decision that was actually protecting anything. What it costs is that the key now outlives the tab, so on a shared machine, or against any XSS on this origin, the exposure window is every future visit rather than one session. That's the reason the toggle is visible and explicit rather than implicit behaviour.

Every `localStorage` access is guarded: it throws outright when storage is disabled (Safari private browsing, blocked cookies), and a browser that refuses to persist should cost the user a retype, not a broken panel. E2e-tested for surviving a reload, for unticking wiping the stored key, and for the existing "key never reaches the DOM" assertion still holding.

### "How it works" explainer — 2026-08-28

Came directly out of the operator using the panel and asking, reasonably, when the log prints a new line — does it only print when segments change, does a match stay on one line, does an ad break produce several? The behaviour was already deliberate (a status block prints only when `status | playing asset id | expected asset id` changes, transitions are deduped by media sequence) but nothing in the UI said so, and a monitor whose output you can't interpret is a monitor you don't trust.

A **How it works** button in the panel heading opens a modal covering: what it compares and why the stream is the only real answer, where the asset id comes from, why it has to poll and the ±1 segment accuracy that follows, when a new log line appears — including the non-obvious case that a schedule rollover prints a fresh `match` line even when nothing is wrong — what each verdict means, why `unscheduled` is usually an ad break, and what happens to the API key.

Built as a general mechanism rather than one hardcoded popup: `explainer-ui.js` clones whichever `<template>` a button's `data-explainer` attribute names into a shared modal, titled from the template's `data-title`, event-delegated on `document`. Another panel gets an explainer by adding a button and a template to index.html, with no JS change. Kept separate from the glossary modal on purpose — that one renders a one-sentence definition from a data map, this one renders paragraphs of authored markup, and the two overlays share a z-index, so explainer content avoids `.glossary-term` spans rather than stacking modals.

### PDT wording corrected — 2026-08-28

The operator flagged that the explainer's "these playlists carry no `#EXT-X-PROGRAM-DATE-TIME`" generalized from the Xumo channels this was built against to streams in general. Correct: many streams publish PDT, at the playlist level and against every segment.

Two things were wrong, one cosmetic and one not:

1. **The explainer and comments overstated it.** Now: it polls *in case* there's no anchor, because it can't assume one is there.
2. **The drift log line asserted `no PROGRAM-DATE-TIME in this stream` without ever checking.** Nothing in the code inspects PDT, so on a stream that does carry one the tool was stating a falsehood about that stream. Now reads `not read from PROGRAM-DATE-TIME`, which is true regardless.

**Open improvement, not done here**: `parseMediaPlaylistAssets()` could prefer a real PDT when present and fall back to live-edge interpolation otherwise, which would make the drift figure exact rather than ±1 segment on streams that publish one. `scte35.js`'s `findCueWallclocks()` already follows exactly that pattern for cue timing (authoritative `START-DATE` when present, interpolated otherwise), so there's a precedent in the codebase to copy. The estimate stays honest in the meantime because it now says how it was derived.

**Done 2026-09-10** — and it turned out to be hiding a defect rather than just an imprecision. See below.

### Colour-coded verdicts — 2026-08-28

Operator asked for the obvious thing: a `match` line should read as green and a mismatch as red, rather than every log line being the same grey.

Both the verdict banner and its log entry now take their tone from one `toneFor()` rule, so the two can't disagree about how serious something is. Green for `match`; red for a real finding — `wrong-asset`, or `unscheduled` on content that isn't break filler. Deliberately *not* red: filler in an ad break (routine, and the panel has argued since the first live run that it shouldn't read as an alarm) and `no-asset-id`/`no-schedule`, which are the tool not knowing rather than the channel being wrong. Amber keeps its existing meaning — the tool itself had trouble.

Two constraints worth recording. Colour is never the only signal: every state still names itself in words, since red/green is exactly the pair a colour-blind viewer can't distinguish. And the log tints are inline spans rather than full-width bands, because making them block-level would strip the real newlines out of the `<pre>`'s text content — which would silently weaken the transition-dedupe e2e test that reads that element line by line.


### PDT anchoring, and the boundary false alarm it was hiding — 2026-09-10

Picked up the open improvement above. Investigating it first turned up a real defect, so this landed as a bug fix with an accuracy improvement attached rather than the other way round.

**The defect.** [`comparePlaybackToSchedule()`] read the playing asset from the live edge and asked the schedule about `now`. Those are two different instants: the live edge is content the packager finished encoding some seconds ago, held back a little, and shipped through a CDN. Mid-programme the gap is invisible — same asset either way. At a programme boundary it is not. For the length of the packager latency after a rollover, the live edge still legitimately carries the OUTGOING programme while the schedule has already moved to the next one, and comparing them yields `wrong-asset` — the red alarm verdict — on a channel doing exactly the right thing. Once per boundary, on every channel, forever.

Reproduced before fixing: a 20s-latency channel 5s past a rollover, playing precisely what it should be, reported `wrong-asset`. The two regression tests pinning it fail against the old code in both directions — the correct channel must read `match`, and a genuinely wrong one must still read `wrong-asset`, so the fix can't have been "always say match".

**The fix.** `parseMediaPlaylistAssets()` now exposes `liveEdgeMs`, the instant on the content timeline that the live edge represents, and the schedule lookup uses that instead of `now`. Both sides are finally read at the same point on the timeline.

**The anchoring.** `timingSource` is `"pdt"` when the stream publishes a usable `#EXT-X-PROGRAM-DATE-TIME` and `"live-edge"` otherwise. A single tag anchors the whole window — PDT formally timestamps only the segment following it, and the rest accumulate `#EXTINF` from there; on a live channel the packager rewrites it as the window slides, so each poll gets a fresh anchor rather than a decaying one. Same shape as `findCueWallclocks()`, as the note above predicted.

Two things worth recording about the design:

- **Discontinuities break accumulation.** Durations don't compose across an `#EXT-X-DISCONTINUITY`, and an ad break — exactly what this panel watches — is where they appear. A PDT after the discontinuity re-anchors (the spec says there SHOULD be one). Without one, the **whole** playlist falls back to live-edge anchoring rather than timing part of the window and leaving the rest null: a uniformly approximate timeline is more useful than a partly-null one, and it's the behaviour these streams already had. A fixture pins the re-anchor case with a deliberate 4s gap at the splice, so a test reading the tag can't be confused with one doing the arithmetic.
- **Streams with no PDT are bit-for-bit unchanged.** `liveEdgeMs === nowMs` under the fallback, so the operator's own Xumo channels — which publish no PDT at all — behave exactly as before, *including* the boundary false positive, which can't be fixed without an anchor the stream doesn't provide. That's stated in a test rather than left implicit.

**Honesty about the numbers.** The docs previously called the accuracy "roughly a segment duration", which conflated two errors. Resolution is ±1 segment and no anchor escapes it — that's the finest grain a playlist describes. Anchor bias is the fallback assuming the live edge is `now`, which shifts every timestamp late by the packager latency and is probably the larger of the two. PDT removes the second entirely and the first not at all. The log now names which anchor a run is using, the drift line qualifies itself accordingly, and the drift CSV carries a `timing` column so a PDT-exact figure can't be read alongside a live-edge estimate as though they were the same measurement.

Verified: 304 unit + 23 e2e passing, plus a real-browser run of the rollover scenario confirming the green `match` verdict and the timing note render correctly.


### Media sequence continuity — 2026-09-10

Operator asked for media sequence as a visible data point while capturing playlists: sequential when healthy, obvious when it skips or jumps.

**Why it can't be read off one playlist.** Inside a single playlist the numbering is sequential by construction — `#EXT-X-MEDIA-SEQUENCE` labels the first segment, every later one is +1, and there is no field capable of expressing a hole. (`#EXT-X-DISCONTINUITY` breaks the *timeline*, not the numbering, and `#EXT-X-DISCONTINUITY-SEQUENCE` is an unrelated counter with a confusingly similar name.) So continuity is only ever visible as a disagreement between two consecutive polls. The panel says as much next to the new line, because "why does this need a second poll" is the obvious first question.

New `compareMediaSequence()` in `scte35.js` classifies the step between two fetches: `sequential` (advanced by no more than the previous window held — everything that rolled off, we saw), `skipped` (advanced past it, so segments came and went unobserved, with a count), `rewound`, `unchanged`, plus `first`/`unknown` for the cases with nothing to compare.

**A backwards jump used to read as healthy.** The existing `detectSequenceGap()` tested only `advanced > prevSegCount`, so a sequence going *backwards* returned `null` — the same answer as a clean stream. That's a packager restart or a failover to an origin numbering independently, and it's arguably worse than a skip: every sequence number and timestamp a client has cached is instantly meaningless. It now has its own state. `detectSequenceGap()` survives as the narrow skip-only view and delegates to the new function, with a test pinning the fact that a rewind is deliberately *not* a gap by its contract.

**Anomalies persist.** The line states the current step on every poll, and a skip or rewind also lands in a per-target tally that later clean polls don't erase — a clean poll after an anomaly reads amber, never green. An event you can only catch by staring at the right second isn't a monitor. Scoped per watched target, like the rest of the health state, since variants number themselves independently and a dropdown switch would otherwise manufacture a fake jump.

**A bug this turned up.** `startHls()` fell back to a hardcoded `() => false` liveness predicate whenever the URL had no `#EXT-X-STREAM-INF` — i.e. whenever a media playlist was handed over directly rather than through a master. That fetched once and stopped, so a live playlist loaded that way sat frozen on a single snapshot and every across-polls check (sequence continuity, staleness, cue dedupe) had nothing to work with. It now uses the same `isLiveHlsPlaylist` test as a variant reached through a master. Found while building this — the sequence line simply never advanced. Regression-tested.

Glossary gained `EXT-X-MEDIA-SEQUENCE`, `EXT-X-DISCONTINUITY` and `EXT-X-DISCONTINUITY-SEQUENCE`, the last two specifically because the two SEQUENCE tags are easy to mistake for one another.

Verified: 314 unit + 26 e2e passing, plus a real-browser run stepping a stream through healthy → skip → rewind → healthy and confirming the colour and the persisting tally at each stage.


### Segment byte scan — 2026-09-11

Came out of diagnosing a real channel that was reported as having "corrupt media packets". It didn't. ffmpeg reported `Packet corrupt` once per segment, spaced exactly one segment duration apart, because the packager restarts MPEG-TS continuity counters at 0 at the start of every segment. No `transport_error_indicator` anywhere, no sync-byte loss, every segment 188-byte aligned and internally continuous, and each one decoding clean in isolation. The media was fine; the *diagnosis* would have sent an encoder team hunting a fault that doesn't exist.

That distinction is the feature. `public/tsanalyze.js` walks real packets and separates two questions the tooling had been conflating:

- **Is the media damaged?** `transport_error_indicator`, sync-byte loss, 188-byte alignment, and continuity errors *within* a segment.
- **Do counters survive the joins?** Continuity *across* boundaries, which a single-segment scan cannot answer and which is where the reported "corruption" actually lived.

`reset` and `jump` are separate verdicts on purpose. A reset is packager configuration and harmless to players that decode each segment independently; a jump has the shape of genuine loss. One number for both would reproduce exactly the misdiagnosis that prompted this. A reset is also indistinguishable from continuous when the previous segment happens to end at CC 15 — a 1-in-16 coincidence the UI names rather than reporting a clean boundary that only looks clean. Worth knowing: the widely-used mux.dev reference stream does the same reset, so this is common packager behaviour rather than evidence of a broken vendor.

The scan also prints the PMT, which answers a question that had needed guesswork: whether a stream carries in-band SCTE-35 at all. No `stream_type 0x86` in the PMT means nothing consuming in-band cues will ever see anything.

**Client-side by default, and that was a deliberate reversal.** This started as a server endpoint, on the reasoning that `/api/fetch` exists because of CORS. But segments are megabytes, and routing them through the Lambda is egress in *and* out per click — precisely the surprise-bill risk flagged under in-band SCTE-35 below. The Stream Tester already pulls segments straight from the browser because hls.js has to, so any stream that plays in this app has segments the browser can read. `analyzeSegment()` fetches directly and falls back to `/api/segment-scan` only when CORS refuses; the output says which path it took. Three further guards: button-triggered rather than on the poll loop, a cap of 6 segments, and the Inspector's existing lowest-bandwidth-variant default, which made a real three-segment scan 0.6MB rather than 9MB.

`tsanalyze.js` is pure and DOM-free like `scte35.js`/`vast.js`/`epg.js`, but unlike them its usual host is the server — the fallback path analyzes there and returns a few hundred bytes of summary rather than base64-ing megabytes back to the client.

**This is also the first real step toward in-band SCTE-35** (Phase 4): fetching a segment and demuxing far enough to read the PMT is most of the scaffolding that item needs. The cost strategy that item demands is now partly answered by the pattern here — on demand, client-side, capped.

Tested: 21 unit tests over six synthetic TS fixtures built to exercise one boundary behaviour each (continuous / reset / jump / TEI / SCTE-35-in-PMT), plus endpoint tests asserting the analysis is returned and the raw bytes never are. One fixture bug found and fixed on the way: a "continuous" segment has to continue *each PID* from where it left off, and PAT/PMT emit once per segment while audio emits three times, so they don't all resume at the same number.

### Log boxes stop stealing the scroll — 2026-09-11

Operator was reading back through the variant and SCTE logs while polling continued and kept getting thrown back to the newest line.

One rule, applied to both: follow the tail only while the reader is already at the tail. Scroll up and the position holds however many polls arrive; scroll back to the bottom and following re-arms. The scroll position is the signal, so there's no mode to toggle and nothing to remember.

It fixed two different bugs. The SCTE log appends and was explicitly jumping to the bottom. The manifest box *replaces* its whole contents each poll, so assigning `innerHTML` was resetting the view to the **top** — the same symptom from the opposite direction.

Two details worth recording. The at-bottom test carries a 4px tolerance because `scrollHeight`/`clientHeight`/`scrollTop` go fractional under browser zoom or a HiDPI scale factor, and an exact comparison would silently never match — leaving a log permanently "scrolled up", never following again, which is a worse bug than the one being fixed. And the manifest box's window slides (a segment off the top, one onto the bottom, every poll), so a restored offset keeps the viewport steady while the lines under it drift by about a segment per poll; holding a specific line would mean anchoring on line identity, which the sliding window makes its own problem.

Not converted: the EPG drift log and the Stream Tester log still jump. Extending means promoting the helper out of `manifest-inspector.js` into a shared module.


### Variant log accumulates — 2026-09-16

Operator was watching the variant log and found only ever ~10 segments in it. Not a bug so much as the wrong design: the box showed the *current playlist*, and a live playlist only holds its window — about a minute of air — so anything that had rolled off was gone with no way to look back at it.

Now append-only, keyed on `#EXT-X-MEDIA-SEQUENCE`. New `splitMediaPlaylist()` in `scte35.js` splits a playlist into header plus numbered segments, each carrying the segment-level tags that preceded it, so a caller can ask "have I logged this one" without comparing text. Tags travel with their segment on purpose — a discontinuity or a cue tag is exactly what you scroll back to find, and it says nothing detached from the segment it applies to.

**The trap, and it made the first attempt unusable:** `#EXT-X-PROGRAM-DATE-TIME` sits before the first `#EXTINF` and looks like a header line, but it timestamps the *next* segment, so it changes on every poll as the window slides. Classifying it as header made the log print `— playlist header changed —` every few seconds, burying the actual content. The fix is to classify by RFC 8216 §4.3.2's Media Segment Tags (`SEGMENT_TAG_RE`) rather than by position relative to the first `#EXTINF`.

Three smaller decisions recorded: switching variants clears the log, because a different variant numbers its segments independently and interleaving them would be meaningless. A backwards sequence prints `— sequence restarted —` and begins a fresh run, rather than silently discarding every segment below the old high-water mark. And masters and DASH MPDs keep replace-on-change — they're single documents that get rewritten, not appended to, so there is nothing to accumulate.

Also fixed while here: **all four log boxes appended with `innerHTML +=`**, which re-serializes the entire element on every call — O(n²), fine for a box that gets replaced, visibly stalling for one that grows all session. Now `insertAdjacentHTML`.

Side benefit: the scroll-position fix from 2026-09-11 carried a caveat that a restored `scrollTop` kept the viewport steady while the *lines* drifted by a segment per poll, because the box was being replaced. Append-only removes that entirely — content only grows at the bottom, so the lines under the reader don't move. The e2e test now asserts exact `scrollTop` equality across polls.

**Cost**: the current playlist is no longer visible as a coherent snapshot, which was useful for eyeballing `TARGETDURATION` or counting the window. Would need a toggle to get back; not built.

### Stream URL history — not ours, and not reliable — 2026-09-16

Operator asked to widen the dropdown of previously-used stream URLs, then noticed entries don't survive a refresh. Worth recording because the obvious assumption is wrong twice over.

**The app has never saved URLs.** The only `localStorage` entries are the two Gracenote key ones. That dropdown is the browser's native autofill, stored in the browser profile.

**It can't be styled, and its width is always exactly the input's width.** So the only lever on "show more of the URL" is the input itself. Briefly moved the URL to its own row (69% → 91% of panel width at 1440px, +50% at 1100px), then reverted at the operator's request — buttons back to the right of the input, since a matched dropdown at `flex: 1` width was good enough and the single row reads better.

**And it's unreliable because the page has no `<form>`.** Browsers record autofill values on form submission; "Load & Play" is a plain click handler, so there is no submit event to hang a save on, and what gets remembered comes down to browser heuristics.

**Open**: app-owned URL history in `localStorage` would fix it properly — push on load, cap ~10-15, dedupe, most-recent-first, offered back via a `<datalist>` (cheap, still browser-drawn and same width limits) or a custom dropdown (full control, middle-ellipsis so both host and differing tail stay visible). Undecided mainly on one point: some playback URLs carry session tokens in the path, so remembered entries expire and can be dead on arrival, and storing them puts a token in `localStorage` — the same trade already written up for the Gracenote key.

---

## Hygiene backlog

- **Lambda redeploy pending (2026-09-11).** `/api/segment-scan` is in the repo but not in production — the deployed Lambda is behind. Two steps: `aws lambda update-function-code` with a zip that **now also contains `public/tsanalyze.js`** (omitting it throws `ERR_MODULE_NOT_FOUND` on cold start and takes `/api/fetch` and `/api/dns-chain` down with it, since they share `api-handlers.js`), and `aws apigatewayv2 create-route` for `GET /api/segment-scan`, since the HTTP API only forwards routes it knows. Full detail in CONTEXT.md's Hosting section. **Deliberately not urgent**: the segment scan fetches segments directly from the browser, so it already works live — this only adds the CORS fallback for origins that refuse cross-origin reads. Smoke-test all three endpoints afterwards, including the two that already work.
- **App-owned stream URL history.** The dropdown of previous URLs is browser autofill, not ours, and it doesn't reliably survive a refresh because the page has no `<form>` for the browser to record on. Storing recent URLs in `localStorage` ourselves would fix it. Open question before building: playback URLs carrying session tokens expire (a remembered entry is dead on arrival) and would put a token in `localStorage`. See the dated entry below.
- **No snapshot view of the current playlist.** The variant log accumulates as of 2026-09-16, which lost the ability to read the current playlist as one document (`TARGETDURATION`, window size). A toggle would restore it.
- **Log scroll fix not applied everywhere.** `preservingScroll()` lives in `manifest-inspector.js` and covers the variant and SCTE logs. The EPG drift log (`epg-ui.js`) and Stream Tester log (`stream-tester.js`) still jump to the newest line on every update. Extending means promoting the helper into a shared module — the behaviour and its 4px-tolerance reasoning are already written up in CONTEXT.md.
- **No README at repo root.** Public repo with an empty landing page; `CONTEXT.md`/`ROADMAP.md` live inside `webapp/`. Needs at least a description, screenshot, and run instructions.
- **Floating CDN dependencies, no SRI.** `index.html` loads `hls.js@1` and `dashjs@4` — floating major versions, no `integrity` attributes. A CDN-side update can change behavior with zero commits on our side, which directly undermines regression testing (tests break with no code change). Pin exact versions + add SRI hashes, or vendor locally. See Open decisions above.
- ~~**No `test` script** in `package.json`~~ — done (Phase 0): `test` and `test:e2e`.
