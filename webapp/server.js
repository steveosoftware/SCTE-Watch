// Minimal static file server + same-origin proxy for playlist fetches.
//
// The proxy exists because browsers enforce CORS and most HLS
// origins/CDNs don't send Access-Control-Allow-Origin — a page can't just
// fetch() an arbitrary playlist URL directly. Fetching server-side sidesteps
// that the same way the original CLI script's `curl` call did.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithGuardedRedirects, readTextCapped, MAX_RESPONSE_BYTES, ProxyBlockedError } from "./ssrf-guard.js";
import { resolveCnameChain } from "./cdn-chain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const UA = "Mozilla/5.0";
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

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

function pickCdnHeaders(headers) {
  const out = {};
  for (const name of CDN_RELEVANT_HEADERS) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

async function handleFetch(req, res, urlObj) {
  const target = urlObj.searchParams.get("url");
  if (!target) return sendJson(res, 400, { error: "missing url param" });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { error: "invalid url" });
  }
  try {
    const r = await fetchWithGuardedRedirects(parsed, { userAgent: UA });
    const text = await readTextCapped(r, MAX_RESPONSE_BYTES);
    if (!r.ok) return sendJson(res, 502, { error: `upstream HTTP ${r.status}` });
    sendJson(res, 200, { text, finalUrl: r.url, headers: pickCdnHeaders(r.headers) });
  } catch (e) {
    if (e instanceof ProxyBlockedError) return sendJson(res, 400, { error: e.message });
    sendJson(res, 502, { error: String(e.message || e) });
  }
}

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

async function handleDnsChain(req, res, urlObj) {
  const hostname = urlObj.searchParams.get("hostname");
  if (!hostname) return sendJson(res, 400, { error: "missing hostname param" });
  if (hostname.length > 253 || !HOSTNAME_RE.test(hostname)) {
    return sendJson(res, 400, { error: "invalid hostname" });
  }
  try {
    const chain = await resolveCnameChain(hostname);
    sendJson(res, 200, { chain });
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}

async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded === "/" ? "index.html" : decoded));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

const server = http.createServer((req, res) => {
  let urlObj;
  try {
    urlObj = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (urlObj.pathname === "/api/fetch" && req.method === "GET") return handleFetch(req, res, urlObj);
  if (urlObj.pathname === "/api/dns-chain" && req.method === "GET") return handleDnsChain(req, res, urlObj);
  return serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`SCTE-35 watch app running at http://${HOST}:${PORT}`);
});
