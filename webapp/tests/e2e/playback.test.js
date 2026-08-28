// End-to-end smoke tests: real headless browser against a real running
// server.js instance. Two tiers, deliberately separated:
//
//  - "offline / deterministic" — no live network dependency, safe to run
//    anywhere, should never be flaky.
//  - "live network" — hits real public test streams (mux.dev, akamaized.net).
//    These validate actual playback (hls.js/dash.js decoding real frames),
//    which nothing else in this suite can substitute for. They CAN fail on
//    outages/CDN changes outside our control — that's a property of what
//    they test, not a bug in the test. Keep them in test:e2e, not the
//    default `npm test`, for exactly that reason (see ROADMAP.md Phase 0).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const PORT = 8799; // distinct from the default 8787 so a dev instance can stay running
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const FIXTURE_SERVER_PORT = 8798;
const FIXTURES_DIR = path.join(__dirname, "../fixtures");

const fixtures = JSON.parse(
  readFileSync(path.join(__dirname, "../fixtures/scte35-payloads.json"), "utf8")
);

let serverProcess;
let browser;
let fixtureServer;

before(async () => {
  // Serves tests/fixtures/* over HTTP so e2e tests can exercise the real
  // /api/fetch → render pipeline against known files, without depending on
  // any third-party host — keeps this tier genuinely offline/deterministic.
  fixtureServer = http.createServer((req, res) => {
    const filePath = path.join(FIXTURES_DIR, decodeURIComponent(req.url));
    if (!filePath.startsWith(FIXTURES_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => fixtureServer.listen(FIXTURE_SERVER_PORT, "127.0.0.1", resolve));

  serverProcess = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      // Our own fixtures are served from 127.0.0.1 (FIXTURE_SERVER_PORT
      // above) — the SSRF guard correctly blocks loopback by default, so
      // this test-only server instance needs the explicit escape hatch to
      // fetch them through the real proxy. See ssrf-guard.js.
      SSRF_GUARD_ALLOW_PRIVATE_TARGETS: "1",
    },
    stdio: "pipe",
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server.js did not start within 10s")), 10000);
    serverProcess.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess.on("error", reject);
  });
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  await browser?.close();
  serverProcess?.kill();
  await new Promise((resolve) => fixtureServer?.close(resolve));
});

async function newPage() {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  return { page, consoleErrors };
}

describe("offline / deterministic", () => {
  test("SCTE-35 decoder panel renders glossary-linked output for a known payload", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#decode-input", fixtures.splice_insert_basic.base64);
    await page.click("#decode-btn");

    const outputText = await page.textContent("#decode-output");
    assert.match(outputText, /splice_insert/);
    assert.match(outputText, /0x4800008F/);
    assert.match(outputText, /60\.294s/);

    // The command name must render as an actual clickable glossary term,
    // not just appear as plain text — this is the feature under test.
    const termHtml = await page.$eval(
      '#decode-output .glossary-term[data-term="splice_insert"]',
      (el) => el.outerHTML
    );
    assert.match(termHtml, /class="glossary-term"/);

    await page.close();
  });

  test("glossary modal opens on click and shows the definition", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#decode-input", fixtures.splice_insert_basic.base64);
    await page.click("#decode-btn");
    await page.click('#decode-output .glossary-term[data-term="splice_insert"]');

    await page.waitForSelector("#glossary-modal:not([hidden])");
    const termTitle = await page.textContent("#glossary-modal-term");
    assert.equal(termTitle, "splice_insert");
    const def = await page.textContent("#glossary-modal-def");
    assert.ok(def.length > 0);

    await page.close();
  });

  test("VAST validator: pasted raw InLine XML renders glossary-linked ad details", async () => {
    const { page } = await newPage();
    const vastInline = readFileSync(path.join(FIXTURES_DIR, "vast-inline.xml"), "utf8");
    await page.goto(BASE_URL);
    await page.fill("#vast-input", vastInline);
    await page.click("#vast-btn");

    await page.waitForFunction(() => document.getElementById("vast-status")?.textContent === "Validated.");
    const outputText = await page.textContent("#vast-output");
    assert.match(outputText, /ExampleAdServer/);
    assert.match(outputText, /Example Linear Ad/);
    assert.match(outputText, /00:00:30/);
    assert.match(outputText, /creative_1280x720\.mp4/);

    const termHtml = await page.$eval('#vast-output .glossary-term[data-term="InLine"]', (el) => el.outerHTML);
    assert.match(termHtml, /class="glossary-term"/);

    await page.close();
  });

  test("VAST validator: a Wrapper URL is fetched and followed to its InLine target through the real proxy", async () => {
    const { page } = await newPage();
    // Built inline (not the unit-test fixture) so its VASTAdTagURI points
    // at this test's own fixture server rather than a fake external host —
    // this test is specifically exercising the real fetch-and-follow path.
    const wrapperXml = `<VAST version="4.0"><Ad id="1"><Wrapper><AdSystem>TestSSP</AdSystem><VASTAdTagURI><![CDATA[http://127.0.0.1:${FIXTURE_SERVER_PORT}/vast-inline.xml]]></VASTAdTagURI></Wrapper></Ad></VAST>`;
    await page.goto(BASE_URL);
    await page.fill("#vast-input", wrapperXml);
    await page.click("#vast-btn");

    await page.waitForFunction(() => document.getElementById("vast-status")?.textContent === "Validated.");
    const outputText = await page.textContent("#vast-output");
    assert.match(outputText, /2 hops/);
    assert.match(outputText, /TestSSP/);
    assert.match(outputText, /ExampleAdServer/, "must have followed the wrapper through to the real InLine ad");
    assert.ok(!/wrapper chain did not resolve/.test(outputText), "must not report truncation on a chain that actually resolved");

    await page.close();
  });

  // The EPG panel checks the STREAM against a schedule, so both sides are
  // stubbed here: a media playlist whose segment paths carry a known asset
  // id, and a schedule built around the current clock (fixtures use fixed
  // 2026-08 dates, which would never cover "now").
  function xmltvStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
    );
  }

  function xmltvAround(now, assetId) {
    return `<?xml version="1.0"?><tv date="x">
      <channel id="88884008"><display-name>Test Channel</display-name></channel>
      <programme start="${xmltvStamp(now - 1800000)}" stop="${xmltvStamp(now + 1800000)}" channel="88884008">
        <title>Scheduled Now</title><tms-id>MV000000000000</tms-id><programme-id>${assetId}</programme-id>
      </programme>
      <programme start="${xmltvStamp(now + 1800000)}" stop="${xmltvStamp(now + 3600000)}" channel="88884008">
        <title>Scheduled Later</title><tms-id>MV000000000001</tms-id><programme-id>XMLATERASSET01</programme-id>
      </programme>
    </tv>`;
  }

  function mediaPlaylist(assetId) {
    const seg = (n) => `https://live-content.xumo.com/3845/content/${assetId}/28846714/6_${n}.ts`;
    return `#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:1\n` +
      [1, 2, 3].map((n) => `#EXTINF:6.000,\n${seg(n)}`).join("\n") + "\n";
  }

  async function runEpgWatch(page, { playingAssetId, scheduledAssetId }) {
    const now = Date.now();
    await page.route("**/api/fetch**", async (route) => {
      const target = new URL(route.request().url()).searchParams.get("url") || "";
      const reply = (text) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text, finalUrl: target, headers: {} }),
        });
      if (target.includes("xmltv")) return reply(xmltvAround(now, scheduledAssetId));
      if (target.includes(".m3u8")) return reply(mediaPlaylist(playingAssetId));
      return route.continue();
    });
    await page.goto(BASE_URL);
    await page.check('input[name="epg-source"][value="xmltv"]');
    await page.fill("#epg-playback-url", "https://example.test/channel/media.m3u8");
    await page.fill("#epg-xmltv-url", "https://example.test/epg/xmltv/88884008_TEST.xml");
    await page.click("#epg-run");
    await page.waitForFunction(
      () => (document.getElementById("epg-verdict")?.textContent || "").length > 0,
      { timeout: 15000 }
    );
    await page.click("#epg-stop");
  }

  test("EPG drift: the scheduled asset playing reads as a match", async () => {
    const { page } = await newPage();
    await runEpgWatch(page, { playingAssetId: "XM08RIB78GYPVR", scheduledAssetId: "XM08RIB78GYPVR" });

    const verdict = await page.textContent("#epg-verdict");
    assert.match(verdict, /correct asset playing/);
    assert.match(verdict, /XM08RIB78GYPVR/);

    const log = await page.textContent("#epg-output");
    assert.match(log, /Test Channel/, "should name the channel it loaded the schedule for");
    assert.match(log, /match/);

    assert.match(await page.getAttribute("#epg-verdict", "class"), /ok/, "a match should read as good, not just unflagged");
    assert.match(await page.$eval("#epg-output .line-ok", (el) => el.textContent), /match/);
    assert.equal(await page.$$eval("#epg-output .line-bad", (els) => els.length), 0);

    await page.close();
  });

  test("EPG drift: a different scheduled asset playing is flagged as WRONG ASSET", async () => {
    const { page } = await newPage();
    // stream is playing the programme scheduled for LATER, not the current one
    await runEpgWatch(page, { playingAssetId: "XMLATERASSET01", scheduledAssetId: "XM08RIB78GYPVR" });

    const verdict = await page.textContent("#epg-verdict");
    assert.match(verdict, /WRONG ASSET/);
    assert.match(verdict, /XMLATERASSET01/, "should show what IS playing");
    assert.match(verdict, /XM08RIB78GYPVR/, "and what should be");

    const verdictClass = await page.getAttribute("#epg-verdict", "class");
    assert.match(verdictClass, /bad/, "a wrong asset must be visually flagged");
    assert.match(
      await page.$eval("#epg-output .line-bad", (el) => el.textContent),
      /wrong-asset/,
      "and the log line for it should carry the same tone"
    );

    await page.close();
  });

  test("EPG drift: an asset absent from the schedule reads as UNSCHEDULED", async () => {
    const { page } = await newPage();
    await runEpgWatch(page, { playingAssetId: "XMGHOSTASSET99", scheduledAssetId: "XM08RIB78GYPVR" });
    assert.match(await page.textContent("#epg-verdict"), /UNSCHEDULED/);
    await page.close();
  });

  test("EPG drift: a transition is reported ONCE, not re-reported every poll", async () => {
    const { page } = await newPage();
    const now = Date.now();
    // A window that straddles an asset change and never rolls, so the same
    // transition stays visible across every poll. Before the sequence-based
    // dedupe this re-logged the event on each poll, with a wall-clock
    // estimate that drifted by a segment each time.
    const seg = (asset, n) => `https://live-content-cf.xumo.com/149/content/${asset}/1/6_00${n}.ts`;
    const playlist =
      `#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:5000\n` +
      `#EXTINF:6.000,\n${seg("XMOLDASSET0001", 1)}\n` +
      `#EXTINF:6.000,\n${seg("XMOLDASSET0001", 2)}\n` +
      `#EXTINF:6.000,\n${seg("XM08RIB78GYPVR", 3)}\n` +
      `#EXTINF:6.000,\n${seg("XM08RIB78GYPVR", 4)}\n`;

    await page.route("**/api/fetch**", async (route) => {
      const target = new URL(route.request().url()).searchParams.get("url") || "";
      const reply = (text) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text, finalUrl: target, headers: {} }),
        });
      if (target.includes("xmltv")) return reply(xmltvAround(now, "XM08RIB78GYPVR"));
      if (target.includes(".m3u8")) return reply(playlist);
      return route.continue(); // asset lookup may 4xx; handled best-effort
    });

    await page.goto(BASE_URL);
    await page.check('input[name="epg-source"][value="xmltv"]');
    await page.fill("#epg-playback-url", "https://example.test/channel/media.m3u8");
    await page.fill("#epg-xmltv-url", "https://example.test/epg/xmltv/1_TEST.xml");
    await page.fill("#epg-interval", "1");
    await page.click("#epg-run");
    await page.waitForFunction(
      () => (document.getElementById("epg-output")?.textContent || "").includes("asset transition:"),
      { timeout: 15000 }
    );
    // let several more polls run over the same unchanged window
    await new Promise((r) => setTimeout(r, 5000));
    await page.click("#epg-stop");

    const log = await page.textContent("#epg-output");
    const lines = log.split("\n").filter((l) => l.includes("asset transition:"));
    assert.equal(lines.length, 1, `expected exactly one transition line, got:\n${lines.join("\n")}`);
    assert.match(lines[0], /XMOLDASSET0001 → XM08RIB78GYPVR/);
    assert.match(lines[0], /segment #5002/, "identified by media sequence, not by its shifting time estimate");

    await page.close();
  });

  test("EPG: Print schedule lists the airings on their own, with no playback URL", async () => {
    const { page } = await newPage();
    const now = Date.now();
    await page.route("**/api/fetch**", async (route) => {
      const target = new URL(route.request().url()).searchParams.get("url") || "";
      if (!target.includes("xmltv")) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: xmltvAround(now, "XM08RIB78GYPVR"), finalUrl: target, headers: {} }),
      });
    });

    await page.goto(BASE_URL);
    await page.check('input[name="epg-source"][value="xmltv"]');
    await page.fill("#epg-xmltv-url", "https://example.test/epg/xmltv/88884008_TEST.xml");
    // Deliberately no playback URL — printing the schedule doesn't need one.
    await page.click("#epg-print");
    await page.waitForFunction(
      () => (document.getElementById("epg-output")?.textContent || "").includes("Scheduled Later"),
      { timeout: 15000 }
    );

    const log = await page.textContent("#epg-output");
    assert.match(log, /2 programme\(s\)/);
    assert.match(log, /Scheduled Now/);
    assert.match(log, /XMLATERASSET01/, "asset ids should be listed");
    const marked = log.split("\n").filter((l) => l.startsWith("▶"));
    assert.equal(marked.length, 1, "exactly the airing covering now should be marked");
    assert.match(marked[0], /Scheduled Now/);

    assert.equal(await page.isDisabled("#epg-download-schedule"), false, "CSV becomes available once printed");
    await page.close();
  });

  test("the Stream URL input fills its row, so a long URL can be read back", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill(
      "#tester-url",
      "https://hls-cf.xumo.com/channel-hls/v3/eyJhbGciOiJIUzI1NiJ9.abcdef0123456789/88893069/master.m3u8"
    );
    const box = await page.$eval("#tester-url", (el) => ({
      width: el.clientWidth,
      row: el.parentElement.clientWidth,
      scrolls: el.scrollWidth > el.clientWidth,
    }));
    // It should be taking the room the row has spare, not sitting at the
    // browser's default input width.
    assert.ok(box.width > box.row * 0.5, `input ${box.width}px in a ${box.row}px row`);
    assert.equal(box.scrolls, false, "a full tokenized playback URL should be readable without scrolling the field");
    await page.close();
  });

  test("the EPG panel sits above the VAST/VMAP panel", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    const order = await page.$$eval("main > section.panel", (els) => els.map((e) => e.id));
    assert.ok(order.indexOf("epg-panel") < order.indexOf("vast-panel"), order.join(" → "));
    await page.close();
  });

  test("EPG drift: schedule source toggle swaps which fields are shown", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    // Gracenote is the default
    assert.equal(await page.isVisible("#epg-key"), true);
    assert.equal(await page.isVisible("#epg-xmltv-url"), false);
    await page.check('input[name="epg-source"][value="xmltv"]');
    assert.equal(await page.isVisible("#epg-key"), false);
    assert.equal(await page.isVisible("#epg-xmltv-url"), true, "one source or the other, never both");
    await page.close();
  });

  test("the Gracenote key is remembered across sessions, and unticking forgets it", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    assert.equal(await page.isChecked("#epg-remember-key"), true, "remembering is the default");
    await page.fill("#epg-key", "TEST-SECRET-KEY");

    // A fresh page on the same origin is what "next session" looks like.
    await page.goto(BASE_URL);
    assert.equal(await page.inputValue("#epg-key"), "TEST-SECRET-KEY");
    assert.equal(await page.isChecked("#epg-remember-key"), true);

    // Unticking is a forget-it instruction: the stored copy goes now.
    await page.uncheck("#epg-remember-key");
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("scte-watch.gracenote-api-key")),
      null,
      "unticking must wipe the stored key immediately"
    );

    await page.goto(BASE_URL);
    assert.equal(await page.inputValue("#epg-key"), "", "no key comes back once forgotten");
    assert.equal(await page.isChecked("#epg-remember-key"), false, "the opt-out itself is remembered");

    // Typing with the box unticked must not quietly start persisting again.
    await page.fill("#epg-key", "ANOTHER-SECRET");
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("scte-watch.gracenote-api-key")),
      null
    );

    await page.evaluate(() => window.localStorage.clear());
    await page.close();
  });

  test("\"How it works\" opens an explainer and Escape closes it", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(BASE_URL);

    assert.equal(await page.isVisible("#explainer-modal"), false, "starts closed");
    await page.click('[data-explainer="epg-explainer"]');
    assert.equal(await page.isVisible("#explainer-modal"), true);
    assert.match(await page.textContent("#explainer-modal-title"), /how it works/i);

    const body = await page.textContent("#explainer-modal-body");
    assert.match(body, /When a new line appears in the log/);
    assert.match(body, /status \| playing asset id \| expected asset id/);
    assert.match(body, /wrong-asset/);

    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#explainer-modal"), false);
    assert.equal(
      await page.textContent("#explainer-modal-body"),
      "",
      "the clone is dropped on close, so find-in-page sees one copy of the text"
    );

    // The panel underneath still works after the modal has been used.
    await page.click('[data-explainer="epg-explainer"]');
    await page.click("#explainer-modal-close");
    assert.equal(await page.isVisible("#explainer-modal"), false);
    assert.deepEqual(consoleErrors, []);

    await page.close();
  });

  test("SECURITY: the Gracenote API key never reaches the rendered page", async () => {
    const { page } = await newPage();
    const now = Date.now();
    await page.route("**/api/fetch**", async (route) => {
      const target = new URL(route.request().url()).searchParams.get("url") || "";
      const reply = (text) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text, finalUrl: target, headers: {} }),
        });
      if (target.includes("on-api.gracenote.com")) {
        // deliberately an error response, to exercise the redacting path
        return reply("<errors><error>bad request</error></errors>");
      }
      if (target.includes(".m3u8")) return reply(mediaPlaylist("XM08RIB78GYPVR"));
      return route.continue();
    });
    await page.goto(BASE_URL);
    await page.fill("#epg-playback-url", "https://example.test/channel/media.m3u8");
    await page.fill("#epg-key", "TEST-SECRET-KEY");
    await page.fill("#epg-prgsvcid", "156201");
    await page.click("#epg-run");
    await page.waitForFunction(
      () => (document.getElementById("epg-status")?.textContent || "").length > 0,
      { timeout: 15000 }
    );

    assert.ok(!(await page.content()).includes("TEST-SECRET-KEY"), "the key must not be echoed into the DOM");
    assert.equal(await page.getAttribute("#epg-key", "type"), "password");

    await page.evaluate(() => window.localStorage.clear());
    await page.close();
  });

  test("DASH out-of-band SCTE-35: EventStream signal is detected and decoded in the real UI", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#tester-url", `http://127.0.0.1:${FIXTURE_SERVER_PORT}/dash-mpd-with-scte35.xml`);
    await page.selectOption("#tester-format", "dash");
    await page.click("#tester-load");

    // Playback itself will fail (the fixture's segment URLs don't resolve
    // to real media) — irrelevant here, since the Manifest Inspector's cue
    // detection runs off its own independent fetch of the MPD text, not off
    // dash.js's playback state.
    await page.waitForFunction(
      () => (document.getElementById("manifest-scte-status")?.textContent || "").includes("found"),
      { timeout: 10000 }
    );

    const scteLog = await page.textContent("#manifest-scte-output");
    assert.match(scteLog, /EVENTSTREAM SIGNAL/);
    assert.match(scteLog, /id=1/);
    assert.match(scteLog, /presentationTime=30s/);
    assert.match(scteLog, /splice_insert/);
    assert.match(scteLog, /0x4800008F/);
    assert.match(scteLog, /id=2/);
    assert.match(scteLog, /XML-encoded signal/, "the non-Binary event must be flagged, not silently dropped");

    await page.close();
  });

  test("continuity/health check reports OK on a clean live playlist", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#tester-url", `http://127.0.0.1:${FIXTURE_SERVER_PORT}/hls-live-with-cues.m3u8`);
    await page.selectOption("#tester-format", "hls");
    await page.click("#tester-load");

    await page.waitForFunction(
      () => (document.getElementById("manifest-health")?.textContent || "").length > 0,
      { timeout: 10000 }
    );

    const healthText = await page.textContent("#manifest-health");
    assert.equal(healthText, "OK");
    const hasWarnClass = await page.$eval("#manifest-health", (el) => el.classList.contains("warn"));
    assert.equal(hasWarnClass, false);

    const drmText = await page.textContent("#manifest-drm");
    assert.equal(drmText, "No encryption signaled (clear)");

    await page.close();
  });

  test("DRM signaling: multi-DRM ContentProtection is detected in the real UI", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#tester-url", `http://127.0.0.1:${FIXTURE_SERVER_PORT}/dash-mpd-with-drm.xml`);
    await page.selectOption("#tester-format", "dash");
    await page.click("#tester-load");

    await page.waitForFunction(
      () => (document.getElementById("manifest-drm")?.textContent || "").includes("Multi-DRM"),
      { timeout: 10000 }
    );

    const drmText = await page.textContent("#manifest-drm");
    assert.match(drmText, /Widevine/);
    assert.match(drmText, /PlayReady/);
    assert.match(drmText, /1a2b3c4d-0000-0000-0000-000000000000/);

    await page.close();
  });

  test("malformed request URL returns 400, not a server crash", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}//`);
    assert.equal(res.status, 400);
    // and the server must still be alive for the next request
    const res2 = await fetch(BASE_URL);
    assert.equal(res2.status, 200);
  });
});

describe("live network (requires internet; may fail on real-world outages)", () => {
  test("HLS playback: real frames decode, stats populate", async () => {
    const { page, consoleErrors } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#tester-url", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
    await page.selectOption("#tester-format", "hls");
    await page.click("#tester-load");

    await page.waitForFunction(
      () => document.getElementById("tester-status").textContent === "playing",
      { timeout: 20000 }
    );
    await page.waitForTimeout(3000);

    const currentTime = await page.$eval("#tester-video", (v) => v.currentTime);
    const paused = await page.$eval("#tester-video", (v) => v.paused);
    assert.ok(currentTime > 0, "video currentTime should advance past 0");
    assert.equal(paused, false);

    const variantsVisible = await page.isVisible("#tester-variants");
    assert.ok(variantsVisible, "variants table should populate");

    await page.close();
  });

  test("CDN chain check: names the actual CDN from response headers, not just DNS", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    // test-streams.mux.dev's real response: Via is just generic
    // "1.1 varnish" (names no vendor) but X-Served-By: cache-bur-...
    // clearly identifies Fastly — verified manually while building this
    // feature. This specifically exercises "a generic Via hop must not
    // shadow a more specific header," the real bug found and fixed while
    // building this (unit-tested in cdn-fingerprint.test.js; this proves
    // the same logic holds against genuine network data, not just mocks).
    await page.fill("#tester-url", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
    await page.selectOption("#tester-format", "hls");
    await page.click("#tester-load");

    await page.waitForFunction(
      () => {
        const t = document.getElementById("manifest-cdn")?.textContent || "";
        return t.length > 0 && t !== "Checking CDN chain…";
      },
      { timeout: 10000 }
    );

    const cdnText = await page.textContent("#manifest-cdn");
    assert.match(cdnText, /Fastly/);
    assert.doesNotMatch(cdnText, /^Varnish$/, "must not report the generic vendor when a more specific one is available");
    assert.doesNotMatch(cdnText, /⚠/, "a single CDN hop must not be flagged");
    const hasWarnClass = await page.$eval("#manifest-cdn", (el) => el.classList.contains("warn"));
    assert.equal(hasWarnClass, false);

    await page.close();
  });

  test("DASH playback: real frames decode, stats populate", async () => {
    const { page } = await newPage();
    await page.goto(BASE_URL);
    await page.fill("#tester-url", "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd");
    await page.selectOption("#tester-format", "dash");
    await page.click("#tester-load");

    await page.waitForFunction(
      () => document.getElementById("tester-status").textContent === "playing",
      { timeout: 20000 }
    );
    await page.waitForTimeout(3000);

    const currentTime = await page.$eval("#tester-video", (v) => v.currentTime);
    const readyState = await page.$eval("#tester-video", (v) => v.readyState);
    assert.ok(currentTime > 0, "video currentTime should advance past 0");
    assert.ok(readyState >= 2, "video should have decoded enough to report readyState >= HAVE_CURRENT_DATA");

    const variantRows = await page.$$eval("#tester-variants tbody tr", (rows) => rows.length);
    assert.ok(variantRows > 0, "variants table should have rows");

    await page.close();
  });
});
