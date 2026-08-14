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

async function handleFetch(req, res, urlObj) {
  const target = urlObj.searchParams.get("url");
  if (!target) return sendJson(res, 400, { error: "missing url param" });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { error: "invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return sendJson(res, 400, { error: "only http/https urls are allowed" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(parsed, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) return sendJson(res, 502, { error: `upstream HTTP ${r.status}` });
    sendJson(res, 200, { text, finalUrl: r.url });
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  } finally {
    clearTimeout(timer);
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
  return serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`SCTE-35 watch app running at http://${HOST}:${PORT}`);
});
