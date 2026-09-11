import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  handleFetchRequest,
  handleDnsChainRequest,
  handleSegmentScanRequest,
  pickCdnHeaders,
} from "../../api-handlers.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fxBytes = (n) => readFileSync(path.join(__dirname, "../fixtures", n));

describe("handleFetchRequest", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("400s when url param is missing", async () => {
    const { status, body } = await handleFetchRequest(null);
    assert.equal(status, 400);
    assert.match(body.error, /missing url param/);
  });

  test("400s on an unparseable url", async () => {
    const { status, body } = await handleFetchRequest("not-a-url");
    assert.equal(status, 400);
    assert.match(body.error, /invalid url/);
  });

  test("400s and never calls fetch for a blocked (private) target", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 200, url: "", headers: { has: () => false, get: () => null }, body: null };
    };
    const { status, body } = await handleFetchRequest("http://127.0.0.1/manifest.m3u8");
    assert.equal(status, 400);
    assert.match(body.error, /private\/reserved address/);
    assert.equal(called, false);
  });

  test("200s with text/finalUrl/headers on a successful fetch", async () => {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      headers: { has: () => false, get: (k) => (k === "via" ? "1.1 abc.cloudfront.net (CloudFront)" : null) },
      body: null,
      text: async () => "#EXTM3U",
    });
    const { status, body } = await handleFetchRequest("http://8.8.8.8/master.m3u8");
    assert.equal(status, 200);
    assert.equal(body.text, "#EXTM3U");
    assert.equal(body.finalUrl, "http://8.8.8.8/master.m3u8");
    assert.deepEqual(body.headers, { via: "1.1 abc.cloudfront.net (CloudFront)" });
  });

  test("502s with the upstream status when the response isn't ok", async () => {
    globalThis.fetch = async (url) => ({
      ok: false,
      status: 500,
      url: String(url),
      headers: { has: () => false, get: () => null },
      body: null,
      text: async () => "",
    });
    const { status, body } = await handleFetchRequest("http://8.8.8.8/x");
    assert.equal(status, 502);
    assert.match(body.error, /upstream HTTP 500/);
  });
});

describe("handleSegmentScanRequest", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const serving = (buf) => async (url) => ({
    ok: true,
    status: 200,
    url: String(url),
    headers: { has: () => false, get: () => null },
    body: null,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });

  test("400s when url param is missing", async () => {
    const { status, body } = await handleSegmentScanRequest(null);
    assert.equal(status, 400);
    assert.match(body.error, /missing url param/);
  });

  test("400s on an unparseable url", async () => {
    const { status } = await handleSegmentScanRequest("not-a-url");
    assert.equal(status, 400);
  });

  test("blocks a private target, same guard as the other endpoints", async () => {
    const { status, body } = await handleSegmentScanRequest("http://169.254.169.254/latest/meta-data/");
    assert.equal(status, 400);
    assert.match(body.error, /private\/reserved/);
  });

  test("returns the ANALYSIS, never the segment bytes", async () => {
    // The bytes are megabytes; the answer is a few hundred. Shipping the
    // former through JSON would defeat the point of doing this server-side
    // at all, so guard the shape explicitly.
    globalThis.fetch = serving(fxBytes("ts-seg-a.ts"));
    const { status, body } = await handleSegmentScanRequest("http://8.8.8.8/seg.ts");
    assert.equal(status, 200);
    assert.ok(body.analysis, "analysis present");
    assert.equal(body.bytes, undefined, "raw bytes must not be returned");
    assert.equal(body.analysis.videoPid, 0x0100);
    assert.equal(body.analysis.transportErrors, 0);
    assert.equal(body.analysis.aligned, true);
  });

  test("surfaces a damaged segment's error flags", async () => {
    globalThis.fetch = serving(fxBytes("ts-seg-tei.ts"));
    const { body } = await handleSegmentScanRequest("http://8.8.8.8/seg.ts");
    assert.equal(body.analysis.transportErrors, 3);
  });

  test("502s with the upstream status when the response isn't ok", async () => {
    globalThis.fetch = async (url) => ({
      ok: false,
      status: 404,
      url: String(url),
      headers: { has: () => false, get: () => null },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const { status, body } = await handleSegmentScanRequest("http://8.8.8.8/missing.ts");
    assert.equal(status, 502);
    assert.match(body.error, /upstream HTTP 404/);
  });
});

describe("pickCdnHeaders", () => {
  test("only keeps the curated CDN-relevant headers", () => {
    const headers = new Map([
      ["via", "1.1 x.cloudfront.net"],
      ["x-random-header", "irrelevant"],
    ]);
    assert.deepEqual(pickCdnHeaders({ get: (k) => headers.get(k) }), { via: "1.1 x.cloudfront.net" });
  });
});

describe("handleDnsChainRequest", () => {
  test("400s when hostname param is missing", async () => {
    const { status, body } = await handleDnsChainRequest(null);
    assert.equal(status, 400);
    assert.match(body.error, /missing hostname param/);
  });

  test("400s on an invalid hostname", async () => {
    const { status, body } = await handleDnsChainRequest("not a hostname!");
    assert.equal(status, 400);
    assert.match(body.error, /invalid hostname/);
  });

  test("resolves a real chain for a known hostname with no CNAME", async () => {
    const { status, body } = await handleDnsChainRequest("example.com");
    assert.equal(status, 200);
    assert.deepEqual(body.chain, ["example.com"]);
  });
});
