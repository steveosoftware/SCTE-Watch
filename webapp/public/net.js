export async function fetchViaProxy(url) {
  const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return { text: data.text, finalUrl: data.finalUrl, headers: data.headers || {} };
}

// Returns {chain} — the raw DNS CNAME chain for a hostname. Naming which
// CDN(s) are involved happens client-side in cdn-fingerprint.js, combining
// this with response headers from the manifest fetch (see net.js's
// fetchViaProxy) — DNS alone is an unreliable signal on its own (see
// cdn-chain.js for why).
export async function fetchCdnChain(hostname) {
  const r = await fetch(`/api/dns-chain?hostname=${encodeURIComponent(hostname)}`);
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data.chain;
}

// Analyzes one media segment, preferring a DIRECT browser fetch and only
// falling back to the server.
//
// Direct is the right default here, unlike for manifests. Segments are
// megabytes, and the Stream Tester already pulls them straight from the
// browser because hls.js has to — so any stream that plays in this app has
// segments the browser can read. Going through the proxy instead would put
// that traffic through a Lambda twice over (in and out) for every check,
// which is real egress cost to answer a question the browser could have
// answered for free.
//
// The fallback earns its place on origins whose CORS policy refuses a
// cross-origin read — a genuine property of those streams, not a bug here.
// Returns {analysis, via} so a caller can tell the operator which path was
// taken; "proxy" means the bytes crossed our server.
export async function analyzeSegment(url, analyze) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    return { analysis: analyze(buf), via: "direct", bytes: buf.length };
  } catch {
    const r = await fetch(`/api/segment-scan?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    return { analysis: data.analysis, via: "proxy", bytes: data.analysis.bytes };
  }
}
