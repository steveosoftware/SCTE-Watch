// Pure request-handling logic for the two API endpoints, split out from
// server.js so it can run behind either a persistent http.createServer
// (server.js, local dev) or an AWS Lambda (lambda/handler.js, deployed) —
// same pattern as ssrf-guard.js/cdn-chain.js being split from their
// transport. Returns a plain { status, body } pair; each transport wrapper
// is responsible for serializing that into its own response shape.

import {
  fetchWithGuardedRedirects,
  readTextCapped,
  readBytesCapped,
  MAX_RESPONSE_BYTES,
  ProxyBlockedError,
} from "./ssrf-guard.js";
import { resolveCnameChain } from "./cdn-chain.js";
import { analyzeTsSegment } from "./public/tsanalyze.js";

const UA = "Mozilla/5.0";

// Curated allowlist of response headers relevant to identifying which
// CDN(s) served a response (see public/cdn-fingerprint.js) — deliberately
// not forwarding the full header set to the client.
const CDN_RELEVANT_HEADERS = [
  "via",
  "server",
  "x-cache",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "cf-ray",
  "x-served-by",
  "x-fastly-request-id",
  "x-akamai-transformed",
  "akamai-x-cache-on",
  "x-azure-ref",
  "x-msedge-ref",
  "x-llnw-edge-status",
  "x-varnish",
];

export function pickCdnHeaders(headers) {
  const out = {};
  for (const name of CDN_RELEVANT_HEADERS) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

export async function handleFetchRequest(target) {
  if (!target) return { status: 400, body: { error: "missing url param" } };

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { status: 400, body: { error: "invalid url" } };
  }
  try {
    const r = await fetchWithGuardedRedirects(parsed, { userAgent: UA });
    const text = await readTextCapped(r, MAX_RESPONSE_BYTES);
    if (!r.ok) return { status: 502, body: { error: `upstream HTTP ${r.status}` } };
    return { status: 200, body: { text, finalUrl: r.url, headers: pickCdnHeaders(r.headers) } };
  } catch (e) {
    if (e instanceof ProxyBlockedError) return { status: 400, body: { error: e.message } };
    return { status: 502, body: { error: String(e.message || e) } };
  }
}

// Fetches a media segment and returns its ANALYSIS, never its bytes.
//
// Only a fallback: the client fetches segments directly from the browser
// first, exactly as hls.js does for playback, which costs this server
// nothing. This path exists for origins whose CORS policy refuses a
// cross-origin read. Worth keeping that asymmetry in mind before calling
// it from anywhere new — a segment is megabytes, so each request here is
// real egress in and out of a Lambda, unlike every other endpoint.
//
// The response is a summary of a few hundred bytes. Returning the bytes
// themselves (base64 through JSON, ~8MB for two segments) would move the
// cost to the client for no benefit, since the analysis is pure and the
// client only needs the answer.
export async function handleSegmentScanRequest(target) {
  if (!target) return { status: 400, body: { error: "missing url param" } };

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { status: 400, body: { error: "invalid url" } };
  }
  try {
    const r = await fetchWithGuardedRedirects(parsed, { userAgent: UA });
    const bytes = await readBytesCapped(r, MAX_RESPONSE_BYTES);
    if (!r.ok) return { status: 502, body: { error: `upstream HTTP ${r.status}` } };
    return { status: 200, body: { finalUrl: r.url, analysis: analyzeTsSegment(bytes) } };
  } catch (e) {
    if (e instanceof ProxyBlockedError) return { status: 400, body: { error: e.message } };
    return { status: 502, body: { error: String(e.message || e) } };
  }
}

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export async function handleDnsChainRequest(hostname) {
  if (!hostname) return { status: 400, body: { error: "missing hostname param" } };
  if (hostname.length > 253 || !HOSTNAME_RE.test(hostname)) {
    return { status: 400, body: { error: "invalid hostname" } };
  }
  try {
    const chain = await resolveCnameChain(hostname);
    return { status: 200, body: { chain } };
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e) } };
  }
}
