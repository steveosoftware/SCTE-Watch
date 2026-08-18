// Walks a hostname's CNAME chain — the same raw signal an operator gets
// from running `dig`. This is DNS resolution only; naming which CDN(s) are
// actually involved happens in public/cdn-fingerprint.js (isomorphic, used
// both here indirectly and directly in the browser) — split out because a
// CNAME chain alone is an unreliable signal for real CDN chaining. Route 53
// ALIAS records (very common for CloudFront custom domains) resolve
// straight to IPs with NO visible CNAME, so this can come back empty even
// when CloudFront genuinely is in play. The HTTP `Via` response header,
// analyzed in cdn-fingerprint.js, is the more direct signal — CloudFront
// specifically appends to an existing Via header hop-by-hop, so a chained
// CloudFront-fronting-CloudFront setup shows up as two "(CloudFront)"
// entries in that one header regardless of what DNS reveals.
//
// DNS-only: no HTTP requests happen here, so this doesn't go through
// ssrf-guard.js — resolving a name to find out what it points to carries
// none of the "fetch arbitrary content on the server's behalf" risk that
// module defends against.

import dnsPromises from "node:dns/promises";

const DEFAULT_MAX_HOPS = 10;

// Walks the CNAME chain starting at `hostname`, returning
// [hostname, ...cnameTargets] in order, stopping at the first name with no
// further CNAME (i.e. the name that actually has A/AAAA records) or after
// maxHops, whichever comes first. `resolveCname` is injectable for testing
// without real DNS — defaults to the real resolver.
export async function resolveCnameChain(
  hostname,
  { resolveCname = dnsPromises.resolveCname, maxHops = DEFAULT_MAX_HOPS } = {}
) {
  const chain = [hostname];
  let current = hostname;
  for (let hop = 0; hop < maxHops; hop++) {
    let targets;
    try {
      targets = await resolveCname(current);
    } catch {
      break; // ENODATA/ENOTFOUND — no more CNAMEs, chain ends here
    }
    if (!targets || !targets.length) break;
    current = targets[0]; // CNAME chains are singular per hop by construction
    chain.push(current);
  }
  return chain;
}
