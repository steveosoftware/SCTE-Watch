// SSRF protections for the /api/fetch proxy. Split out from server.js so
// the pure IP-classification logic (isDisallowedIp) is unit-testable
// without spinning up a server or mocking DNS.
//
// Threat model: /api/fetch lets a client ask this server to fetch an
// arbitrary URL on its behalf (necessary — see server.js's header comment).
// Without restriction, that's an open relay: a caller could point it at
// cloud instance-metadata endpoints, other services on the same private
// network, or localhost-bound ports on this machine, using this server's
// network position instead of their own. Contained today only because the
// server binds to 127.0.0.1 by default — this hardening is a prerequisite
// for any public deployment (see ROADMAP.md Phase 2/3).
//
// Known remaining gap: this validates the resolved IP(s) *before*
// connecting, but does not pin the actual TCP connection to the validated
// address — fetch() re-resolves DNS itself when it connects. A DNS answer
// that changes between our check and fetch's own lookup (DNS rebinding)
// could still slip through. Closing that fully needs a custom low-level
// dispatcher that connects to the exact IP we validated; not implemented
// here. Documented rather than silently assumed solved.

import dns from "node:dns/promises";
import net from "node:net";

export class ProxyBlockedError extends Error {}

export function isDisallowedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, includes cloud IMDS (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, RFC6598
    if (a === 0) return true; // "this network"
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true; // loopback
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (net.isIP(v4) === 4) return isDisallowedIp(v4); // IPv4-mapped — check the embedded address
    }
    const firstHextet = parseInt(lower.split(":")[0] || "0", 16);
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // link-local, fe80::/10
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // unique local, fc00::/7
    return false;
  }
  return true; // not a recognizable IP literal — refuse rather than risk it
}

// Test-only escape hatch: our own e2e suite serves fixtures from 127.0.0.1
// and needs to fetch them through the real proxy to test it honestly. Off
// by default; must be deliberately set, and only the e2e test harness sets
// it (see tests/e2e/playback.test.js). NEVER set this in a real deployment
// — it disables the entire point of this module.
const ALLOW_PRIVATE_TARGETS = process.env.SSRF_GUARD_ALLOW_PRIVATE_TARGETS === "1";

// Resolves `hostname` and throws ProxyBlockedError if it's an IP literal
// that's disallowed, or if ANY of its resolved addresses are disallowed
// (a hostname resolving to multiple A/AAAA records only needs one bad
// address to be a viable attack).
export async function assertHostnameAllowed(hostname) {
  if (ALLOW_PRIVATE_TARGETS) return;
  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new ProxyBlockedError(`blocked: ${hostname} is a private/reserved address`);
    }
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new ProxyBlockedError(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  if (!addresses.length) {
    throw new ProxyBlockedError(`DNS lookup for ${hostname} returned no addresses`);
  }
  for (const { address } of addresses) {
    if (isDisallowedIp(address)) {
      throw new ProxyBlockedError(`blocked: ${hostname} resolves to a private/reserved address (${address})`);
    }
  }
}

const MAX_REDIRECTS = 5;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // generous for a manifest, not for an arbitrary file

// Fetches with redirects handled manually — `redirect: "follow"` would
// validate only the *first* URL and then blindly trust wherever the
// response points next, defeating the allowlist entirely. Each hop is
// re-validated the same way as the initial request.
export async function fetchWithGuardedRedirects(startUrl, { userAgent, timeoutMs = 20000 } = {}) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new ProxyBlockedError("only http/https urls are allowed");
    }
    await assertHostnameAllowed(current.hostname);
    const r = await fetch(current, {
      headers: { "User-Agent": userAgent },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.has("location")) {
      current = new URL(r.headers.get("location"), current);
      continue;
    }
    return r;
  }
  throw new ProxyBlockedError("too many redirects");
}

// Reads a response body as text, aborting once maxBytes is exceeded rather
// than buffering an unbounded (or maliciously huge) response in memory.
export async function readTextCapped(response, maxBytes) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
