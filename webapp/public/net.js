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
