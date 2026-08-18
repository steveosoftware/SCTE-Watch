import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchViaProxy, fetchCdnChain } from "../../public/net.js";

describe("fetchViaProxy", () => {
  let originalFetch;
  let lastRequestedUrl;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(status, body) {
    globalThis.fetch = async (url) => {
      lastRequestedUrl = url;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    };
  }

  test("URL-encodes the target and hits /api/fetch", async () => {
    stubFetch(200, { text: "hello", finalUrl: "https://example.com/x" });
    await fetchViaProxy("https://example.com/a b?c=d&e=f");
    assert.equal(
      lastRequestedUrl,
      "/api/fetch?url=" + encodeURIComponent("https://example.com/a b?c=d&e=f")
    );
  });

  test("returns {text, finalUrl, headers} on success", async () => {
    stubFetch(200, { text: "manifest body", finalUrl: "https://example.com/final.m3u8" });
    const result = await fetchViaProxy("https://example.com/x.m3u8");
    assert.deepEqual(result, {
      text: "manifest body",
      finalUrl: "https://example.com/final.m3u8",
      headers: {},
    });
  });

  test("passes through CDN-relevant headers when the server includes them", async () => {
    stubFetch(200, {
      text: "manifest body",
      finalUrl: "https://example.com/final.m3u8",
      headers: { via: "1.1 abc.cloudfront.net (CloudFront)" },
    });
    const result = await fetchViaProxy("https://example.com/x.m3u8");
    assert.deepEqual(result.headers, { via: "1.1 abc.cloudfront.net (CloudFront)" });
  });

  test("throws with the server-provided error message on a proxy error", async () => {
    stubFetch(502, { error: "upstream HTTP 500" });
    await assert.rejects(() => fetchViaProxy("https://example.com/x"), /upstream HTTP 500/);
  });

  test("throws even on HTTP 200 if the body carries an error field", async () => {
    stubFetch(200, { error: "invalid url" });
    await assert.rejects(() => fetchViaProxy("not-a-url"), /invalid url/);
  });

  test("falls back to a generic HTTP-status message when the body has no error field", async () => {
    stubFetch(500, {});
    await assert.rejects(() => fetchViaProxy("https://example.com/x"), /HTTP 500/);
  });
});

describe("fetchCdnChain", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns just the raw chain array", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ chain: ["example.com", "d111.cloudfront.net"] }),
    });
    const chain = await fetchCdnChain("example.com");
    assert.deepEqual(chain, ["example.com", "d111.cloudfront.net"]);
  });

  test("throws on a server error", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid hostname" }),
    });
    await assert.rejects(() => fetchCdnChain("bad host"), /invalid hostname/);
  });
});
