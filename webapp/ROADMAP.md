# SCTE-WATCH — roadmap

Planning doc only — nothing here is built yet unless marked done. Update this alongside `CONTEXT.md` as items land.

## Explicitly out of scope

- **Multi-channel monitor grid** (a dashboard polling a saved list of streams concurrently) — this app is a single-stream tester/inspector, not an ops monitoring platform.
- **Stuck-in-break alerting / webhooks** (paging on a cue-out with no matching cue-in) — same reason; alerting infrastructure is out of scope.

## Open decisions (not yet made)

- **`scte35watch.py`** — the original CLI at repo root. Actively maintained, deprecated in favor of the web app, or kept as reference? Its fate affects whether it gets test coverage and whether the in-band work should reuse it (it's already Python, which is the natural host for `threefive`).
- **hls.js / dash.js delivery** — currently loaded from jsdelivr at floating major versions with no integrity hashes (see Hygiene below). Pin exact versions + SRI, or vendor the files into `public/`? Vendoring also removes a runtime external dependency, which matters for an Amplify deploy.

## Suggested sequence

Items below are grouped by what they depend on. Rough order:

1. **Phase 0 — testing foundation.** Everything else is safer with a regression net, and the fixture corpus it produces is reused by later phases.
2. **Phase 1 — client-side only.** No new infrastructure; can ship on the current `server.js` today.
3. **Phase 2 — security hardening.** Hard prerequisite for any public deploy.
4. **Phase 3 — Amplify migration.** Unblocks everything server-side.
5. **Phase 4 — server-dependent features.** ccextractor, in-band SCTE-35, VAST fetch.
6. **Blocked** — Gracenote, pending credentials.

---

## Phase 0 — Testing foundation

Nothing exists today. This comes first because the fixture corpus it builds is a dependency of nearly everything below.

- **Fixture corpus, committed to the repo.** Recorded HLS master/media playlists, DASH MPDs, and a handful of real segments — captured from actual streams, plus synthetic edge cases. **Tests must run against these fixtures, not live URLs.** Live public streams (mux.dev, akamaized.net, etc.) move their live edge, shift bitrates, and go down; any test pointed at them is non-deterministic by construction. A small local fixture server serves these during tests.
- **Live-network smoke tests as a separate, optional tier** — useful for "does this still work against the real world," but allowed to fail independently so real-world outages never redden a normal CI run.
- **Decoder eval suite**: a corpus of real SCTE-35 payloads paired with expected decoded output, as golden files. This is the regression net for `scte35.js` — the highest-value tests in the project, since decoder bugs are silent (see the `pts_adjustment` bug in Phase 1).
- **Unit tests** for pure logic (`scte35.js`, `glossary.js` escaping/linkification, `net.js`) using Node's built-in `node:test` + `assert` — no new dependency, consistent with the project being dependency-free.
  - **Must include an explicit XSS-invariant test** for `glossaryTerm()`/`linkifyTagLine()`: a payload with markup in its UPID must render inert. This is a security property that could otherwise regress silently (see CONTEXT.md).
- **End-to-end tests**: formalize the Playwright-driven check already done manually for DASH playback into a repeatable `tests/e2e/` suite — spin up the server, launch headless Chromium, load fixtures, assert on decoded fields/stats/screenshots.
- Add a `test` script to `package.json` (currently absent).
- Once green, wire into GitHub Actions on push/PR to `staging` and `main`.

---

## Phase 1 — Client-side only (no new infrastructure)

### Decoder correctness: `pts_adjustment` — **known bug**

`pts_adjustment` (bytes 4–8 of the `splice_info_section`) is documented in the header comment of `scte35.js` but **never parsed or applied**. Per spec it must be added to the PTS in the splice command to derive true presentation time. Streams passing through a splicer/transcoder that re-stamps timing carry a non-zero value — so **our reported PTS is currently wrong for those streams**, silently.

Fix this before the wallclock work below, and cover it with a golden-file test (a fixture with non-zero `pts_adjustment`).

### PTS → wallclock conversion

**What it is:** SCTE-35 expresses timing as a PTS — a 90 kHz counter with an arbitrary origin that wraps roughly every 26.5 hours. We currently surface it raw, so cues read as `pts=80384.087s`, which is not interpretable on its own. HLS's `#EXT-X-PROGRAM-DATE-TIME` anchors a segment to real wall-clock time; given that anchor, any PTS converts to an actual timestamp.

**Why it stands alone:** it makes the existing SCTE cue log human-readable — *"break at 14:23:05 UTC"* instead of a bare counter. That's worth doing regardless of whether Gracenote ever happens. It's *also* a prerequisite for Gracenote (EPG times and cue times must share a basis) and for in-band/out-of-band reconciliation, but it is not owned by either.

Scope:
- Parse `#EXT-X-PROGRAM-DATE-TIME` (not currently parsed anywhere in the codebase).
- Convert: `wallclock = anchor_time + (target_PTS − anchor_PTS) / 90000`.
- Display wallclock alongside raw PTS in the cue log — don't replace it; the raw value still matters for debugging.
- Handle the 33-bit PTS wrap (~26.5h) — a real edge case for long-running live channels.
- Degrade gracefully when a stream carries no `PROGRAM-DATE-TIME` (many don't): show raw PTS and say why wallclock is unavailable.

### DASH out-of-band SCTE-35

Closes a real hole. `manifest-inspector.js` currently hard-returns for non-HLS and the UI reads "SCTE-35 cue detection is HLS-only" — but that's *our* limitation, not DASH's.

MPDs carry SCTE-35 out-of-band via `<EventStream schemeIdUri="urn:scte:scte35:2013:xml">` (and related scheme URIs) with `<Event>` children, in two encodings:
- `<Signal><Binary>` — base64 `splice_info_section`, which feeds our **existing `decodeScte35()` completely unchanged**. This is the cheap, high-value path.
- XML-encoded signals (`<SpliceInfoSection>` as structured XML) — needs a separate small parser mapping XML elements to the same decoded shape.

Also parse `@presentationTime`/`@duration`/`@id` on `<Event>` for timing. **Lower effort than in-band SCTE-35** (below) and should land first — it removes the "HLS-only" caveat from the UI and reuses everything already built.

### Continuity & health checks

Extends the Manifest Inspector, which already polls live manifests — mostly new checks on data already being fetched:
- Media-sequence gaps (missing segments between polls)
- `#EXT-X-DISCONTINUITY` markers
- Live-edge staleness (playlist not advancing within target duration)
- Sudden bitrate/resolution drops across variants

### DRM / encryption signaling

Manifest-only detection — no decryption, no license acquisition:
- HLS: parse `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` (`METHOD`, `KEYFORMAT` → DRM system via known UUIDs, `URI`, `IV`)
- DASH: parse `<ContentProtection schemeIdUri>` + `cenc:default_KID` per `AdaptationSet`
- Key/IV rotation tracked for free via the existing poll loop (same pattern as SCTE-35 SEQ-change detection)
- Display which DRM system(s) are signaled, multi-DRM setups, rotation cadence
- **Informs, not blocks, the ccextractor / in-band features**: if this shows real Widevine/PlayReady/FairPlay, those features should warn rather than silently fail — segment bytes are genuinely encrypted and there's no generic way to obtain a content key. Clear `AES-128` is the exception: its key is normally a plain HTTPS GET, so segment decryption before ccextractor/demuxing is feasible there and worth scoping in if we build it.

---

## Phase 2 — Security hardening (prerequisite for public deploy)

### SSRF: `/api/fetch` is currently an open relay

`handleFetch()` in `server.js` accepts **any** http/https URL, follows redirects, and has no host allowlist or private-address blocking. Today this is contained only because the server binds to `127.0.0.1`. As a public Amplify Function it would let anyone who finds the endpoint make our infrastructure fetch:
- `169.254.169.254` (EC2/Lambda instance metadata — potentially credential material)
- VPC-internal services and `localhost`-bound endpoints
- Arbitrary third-party hosts, with our infrastructure as the apparent origin

Mitigations to implement:
- Block private/link-local/loopback/reserved ranges (v4 **and** v6), resolving the hostname first — don't trust the literal string.
- **Re-validate after every redirect hop** — `redirect: "follow"` defeats naive up-front allowlisting. Consider `redirect: "manual"` and walking hops explicitly.
- Consider restricting to expected content types / response size caps.
- Guard against DNS rebinding (resolve-then-connect to the resolved IP, or re-check on connect).

**Do not deploy publicly before this is done.**

### Auth / rate limiting

ccextractor-on-Lambda downloads segments and runs a native binary per invocation. Public + unauthenticated is a cost-DoS vector. Needs at minimum a rate limit; ideally some access control on the expensive endpoints.

---

## Phase 3 — AWS Amplify hosting migration

Blocks: ccextractor captions, in-band SCTE-35 (if it needs native tools), the Gracenote proxy, and likely the VAST/VMAP fetch.

`server.js` today is a persistent `http.createServer` process — that model doesn't map onto Amplify Hosting, which serves static output (our `public/` directory is a perfect fit as-is) plus optional SSR compute for specific supported frameworks. It does not run an arbitrary always-on custom server.

Everything server-side becomes an **Amplify Function** (AWS Lambda):
- `/api/fetch` (the CORS proxy, hardened per Phase 2) → a Lambda behind an API route.
- Native-tool work (ccextractor, in-band demuxing) → a Lambda with the binary bundled as a Lambda Layer (compiled for the target architecture — x86_64 or arm64/Graviton), downloading segments into `/tmp`, shelling out, returning results.
- Constraints to design around: deployment package/layer size limits, `/tmp` is ephemeral and size-capped, execution time is capped (fine for "grab 1–2 segments," not for anything long-running), and cold-start latency on infrequently-hit routes.

---

## Phase 4 — Server-dependent features

### VAST / VMAP validator

New standalone panel (same pattern as the SCTE-35 string decoder — paste input, get structured output), closing the loop from "cue detected" to "ad response validated." Paste a VAST/VMAP URL or raw XML; validate structure; show the ad pod breakdown (ad system, creative, duration, tracking pixels). URL input needs the fetch proxy (ad servers generally don't set CORS headers), so it rides on the same hardened endpoint.

### Captions via ccextractor

New endpoint: fetch a segment or two (not the whole stream), pipe through a bundled `ccextractor` binary, return extracted SRT/VTT. New panel: point at a segment URL (or "grab the current segment" from whatever's loaded in the Stream Tester), render captions as text, downloadable. Gate behind the DRM signaling check — refuse/warn rather than running on a stream signaling real DRM.

### In-band SCTE-35

Two candidate approaches:
- **fMP4**: in-band cues live in `emsg` boxes — simple enough to hand-parse in pure JS/Node (ISO-BMFF box walking), no native dependency. May not need Lambda at all if the pure-JS parse suffices.
- **MPEG-TS**: needs real PID/PES demuxing — lean on `threefive` (Python, parses both in-band and out-of-band) as a subprocess, or `tsduck`. `threefive` fits naturally given the project's Python origin.

Either path: fetch a real segment, demux, extract the `splice_info_section`, run it through the **existing** `decodeScte35()` — the binary format is identical to out-of-band, only the transport differs, so the decoder needs zero changes.

**Cost / sampling strategy — must be decided before building.** Manifest polling is a few KB per tick; repeatedly fetching *segments* to scan for in-band cues is orders of magnitude more bandwidth, plus per-invocation Lambda cost and egress. Needs an explicit strategy — on-demand only, 1-in-N sampling, or only-on-discontinuity — or this becomes a surprise bill.

**UI design question, still open**: how to show in-band and out-of-band cues together without cluttering the Manifest Inspector — likely two clearly-labeled sub-columns or a toggle within the existing SCTE-35 cues box, reusing the glossary system rather than inventing new vocabulary. Needs a real design pass once detection works.

**Natural follow-on**: a reconciliation check flagging when in-band and out-of-band disagree (an event/PTS present in one but not the other) — a real packager bug class. Depends on PTS→wallclock (Phase 1) for a common time basis. Not committed to yet.

---

## Blocked — waiting on external info

### Gracenote EPG drift detection

**Not starting** until the exact API query shape and credentials are provided.

Plan once unblocked: server-side proxy (Amplify Function) holding the API key — never shipped to the client — comparing EPG "what's on now" against the stream's own signaling (SCTE-35 `Program Start`/`Program End` descriptors, or `#EXT-X-PROGRAM-DATE-TIME`). Depends on PTS→wallclock (Phase 1) so EPG times and cue times can be compared on a common basis.

---

## Hygiene backlog

- **No README at repo root.** Public repo with an empty landing page; `CONTEXT.md`/`ROADMAP.md` live inside `webapp/`. Needs at least a description, screenshot, and run instructions.
- **Floating CDN dependencies, no SRI.** `index.html` loads `hls.js@1` and `dashjs@4` — floating major versions, no `integrity` attributes. A CDN-side update can change behavior with zero commits on our side, which directly undermines regression testing (tests break with no code change). Pin exact versions + add SRI hashes, or vendor locally. See Open decisions above.
- **No `test` script** in `package.json` (blocks CI wiring; covered in Phase 0).
