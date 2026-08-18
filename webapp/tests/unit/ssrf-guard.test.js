import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isDisallowedIp,
  assertHostnameAllowed,
  fetchWithGuardedRedirects,
  readTextCapped,
  ProxyBlockedError,
} from "../../ssrf-guard.js";

describe("isDisallowedIp — IPv4", () => {
  const disallowed = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback range"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["172.16.0.1", "RFC1918 172.16/12 lower bound"],
    ["172.31.255.255", "RFC1918 172.16/12 upper bound"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["169.254.169.254", "link-local — cloud instance metadata endpoint"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT RFC6598"],
    ["100.100.0.1", "CGNAT RFC6598"],
    ["0.0.0.0", "this-network"],
  ];
  for (const [ip, why] of disallowed) {
    test(`blocks ${ip} (${why})`, () => assert.equal(isDisallowedIp(ip), true));
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1"];
  for (const ip of allowed) {
    test(`allows public address ${ip}`, () => assert.equal(isDisallowedIp(ip), false));
  }
});

describe("isDisallowedIp — IPv6", () => {
  test("blocks ::1 (loopback)", () => assert.equal(isDisallowedIp("::1"), true));
  test("blocks fe80:: (link-local)", () => assert.equal(isDisallowedIp("fe80::1"), true));
  test("blocks fc00::/7 (unique local)", () => assert.equal(isDisallowedIp("fd00::1"), true));
  test("blocks an IPv4-mapped loopback (::ffff:127.0.0.1)", () =>
    assert.equal(isDisallowedIp("::ffff:127.0.0.1"), true));
  test("blocks an IPv4-mapped IMDS address (::ffff:169.254.169.254)", () =>
    assert.equal(isDisallowedIp("::ffff:169.254.169.254"), true));
  test("allows a public IPv6 address", () => assert.equal(isDisallowedIp("2001:4860:4860::8888"), false));
});

describe("assertHostnameAllowed", () => {
  test("throws ProxyBlockedError for a disallowed IP literal", async () => {
    await assert.rejects(() => assertHostnameAllowed("127.0.0.1"), ProxyBlockedError);
  });

  test("throws for the literal cloud IMDS address", async () => {
    await assert.rejects(() => assertHostnameAllowed("169.254.169.254"), ProxyBlockedError);
  });

  test("resolves without throwing for a public IP literal (no DNS lookup needed)", async () => {
    await assertHostnameAllowed("8.8.8.8"); // must not throw
  });

  test("blocks 'localhost' via real DNS resolution", async () => {
    await assert.rejects(() => assertHostnameAllowed("localhost"), ProxyBlockedError);
  });
});

// fetchWithGuardedRedirects/readTextCapped are tested against a mocked
// global.fetch — using real *reachable* servers would either hit the
// loopback block (defeating the point) or require real network access
// (flaky/slow). Public IP literals in the test URLs mean
// assertHostnameAllowed's real logic still runs on every hop; only the
// actual network call is stubbed.
describe("fetchWithGuardedRedirects", () => {
  let originalFetch;
  let calls;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function fakeResponse({ status = 200, location = null, url }) {
    const headers = new Map(location ? [["location", location]] : []);
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      headers: { has: (k) => headers.has(k), get: (k) => headers.get(k) },
      body: null,
      text: async () => "",
    };
  }

  test("a plain 200 response is returned as-is, one fetch call", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return fakeResponse({ status: 200, url: String(url) });
    };
    const r = await fetchWithGuardedRedirects(new URL("http://8.8.8.8/manifest.m3u8"), { userAgent: "x" });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
  });

  test("follows a redirect and re-validates the new hostname", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return fakeResponse({ status: 302, location: "http://1.1.1.1/final.m3u8", url: String(url) });
      }
      return fakeResponse({ status: 200, url: String(url) });
    };
    const r = await fetchWithGuardedRedirects(new URL("http://8.8.8.8/start.m3u8"), { userAgent: "x" });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], "http://1.1.1.1/final.m3u8");
  });

  test("a redirect to a disallowed address is blocked, never followed", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return fakeResponse({ status: 302, location: "http://169.254.169.254/latest/meta-data/", url: String(url) });
    };
    await assert.rejects(
      () => fetchWithGuardedRedirects(new URL("http://8.8.8.8/start.m3u8"), { userAgent: "x" }),
      ProxyBlockedError
    );
    assert.equal(calls.length, 1, "must not have called fetch on the malicious redirect target");
  });

  test("gives up after too many redirects", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return fakeResponse({ status: 302, location: "http://8.8.8.8/loop", url: String(url) });
    };
    await assert.rejects(
      () => fetchWithGuardedRedirects(new URL("http://8.8.8.8/start"), { userAgent: "x" }),
      /too many redirects/
    );
  });
});

describe("readTextCapped", () => {
  function streamResponse(chunks) {
    let i = 0;
    return {
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) return { done: false, value: chunks[i++] };
            return { done: true, value: undefined };
          },
          cancel: async () => {},
        }),
      },
    };
  }

  test("concatenates chunks under the cap", async () => {
    const enc = new TextEncoder();
    const res = streamResponse([enc.encode("hello "), enc.encode("world")]);
    const text = await readTextCapped(res, 1000);
    assert.equal(text, "hello world");
  });

  test("throws once the cap is exceeded, without buffering everything first", async () => {
    const enc = new TextEncoder();
    const bigChunk = enc.encode("x".repeat(1000));
    const res = streamResponse([bigChunk, bigChunk, bigChunk]);
    await assert.rejects(() => readTextCapped(res, 1500), /exceeded 1500 byte limit/);
  });

  test("falls back to response.text() when there's no readable stream body", async () => {
    const res = { body: null, text: async () => "plain text" };
    assert.equal(await readTextCapped(res, 1000), "plain text");
  });
});
