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
