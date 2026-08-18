import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { handleFetchRequest, handleDnsChainRequest, pickCdnHeaders } from "../../api-handlers.js";

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
