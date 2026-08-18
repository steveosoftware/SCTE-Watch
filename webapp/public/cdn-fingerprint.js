// Names which CDN(s) actually served a response, from two complementary
// signals — pure logic, no DOM/Node dependency, so it runs identically in
// the browser (manifest-inspector.js) and could run server-side too.
//
// Why headers, not just DNS: a hostname can point straight at a CDN's IPs
// via a Route 53 ALIAS record with zero visible CNAME (very common for
// CloudFront custom domains) — DNS alone can report "nothing here" while
// the origin is genuinely CloudFront. Response headers don't have that
// blind spot.
//
// Why the Via header specifically matters for *chaining*: per RFC 7230,
// intermediate proxies are expected to append themselves to an existing
// Via header rather than replace it. CloudFront follows this — if
// CloudFront-A's origin is CloudFront-B, B's response already carries a
// Via header naming itself, and A appends its own entry on top. The final
// response a client sees can therefore show two "(CloudFront)" entries in
// one header, which is a direct, hop-by-hop record of what actually
// happened on the wire — more reliable than DNS for this specific
// question. The known limitation: a CDN that doesn't participate in Via
// chaining (Akamai typically doesn't, by default) can sit invisibly behind
// one that does, so an unnamed hop should read as "we can't see past this
// point," not "there's nothing here."

export const HOSTNAME_CDN_SUFFIXES = [
  { suffix: ".cloudfront.net", name: "CloudFront" },
  { suffix: ".akamaiedge.net", name: "Akamai" },
  { suffix: ".akamaized.net", name: "Akamai" },
  { suffix: ".akamaitechnologies.com", name: "Akamai" },
  { suffix: ".edgekey.net", name: "Akamai" },
  { suffix: ".edgesuite.net", name: "Akamai" },
  { suffix: ".fastly.net", name: "Fastly" },
  { suffix: ".fastlylb.net", name: "Fastly" },
  { suffix: ".cloudflare.net", name: "Cloudflare" },
  { suffix: ".llnwd.net", name: "Limelight" },
  { suffix: ".edgecastcdn.net", name: "Edgecast / Verizon Media" },
  { suffix: ".azureedge.net", name: "Azure CDN" },
  { suffix: ".vo.msecnd.net", name: "Azure CDN" },
  { suffix: ".b-cdn.net", name: "Bunny CDN" },
  { suffix: ".stackpathcdn.com", name: "StackPath" },
  { suffix: ".kxcdn.com", name: "KeyCDN" },
];

export function identifyCdnFromHostname(hostname) {
  const lower = (hostname || "").toLowerCase();
  const hit = HOSTNAME_CDN_SUFFIXES.find((s) => lower.endsWith(s.suffix));
  return hit ? hit.name : null;
}

// Ordered — checked top to bottom, first match wins. Most-specific/least-
// ambiguous signals first; generic "Varnish" last, since many CDNs
// (including Fastly) are Varnish-based and it only means "there's a cache
// layer here," not which vendor.
const HEADER_CDN_SIGNATURES = [
  {
    name: "CloudFront",
    test: (h) => /cloudfront/i.test(h.via || "") || /cloudfront/i.test(h["x-cache"] || "") || !!h["x-amz-cf-id"] || !!h["x-amz-cf-pop"],
  },
  {
    name: "Akamai",
    test: (h) =>
      /akamai/i.test(h.via || "") ||
      /akamai/i.test(h.server || "") ||
      /akamai/i.test(h["x-cache"] || "") ||
      !!h["x-akamai-transformed"] ||
      !!h["akamai-x-cache-on"],
  },
  {
    name: "Fastly",
    test: (h) => /fastly/i.test(h.via || "") || !!h["x-fastly-request-id"] || /^cache-/i.test(h["x-served-by"] || ""),
  },
  {
    name: "Cloudflare",
    test: (h) => !!h["cf-ray"] || /cloudflare/i.test(h.server || ""),
  },
  {
    name: "Google Cloud CDN",
    test: (h) => /google/i.test(h.via || ""),
  },
  {
    name: "Azure Front Door / CDN",
    test: (h) => !!h["x-azure-ref"] || !!h["x-msedge-ref"],
  },
  {
    name: "Limelight",
    test: (h) => /limelight|llnw/i.test(h.server || "") || !!h["x-llnw-edge-status"],
  },
  {
    name: "Varnish",
    test: (h) => /varnish/i.test(h.via || "") || !!h["x-varnish"],
  },
];

// Returns the best-guess CDN for a set of response headers (lowercase
// keys), or null if nothing matched.
export function identifyCdnFromHeaders(headers) {
  const h = headers || {};
  const hit = HEADER_CDN_SIGNATURES.find((sig) => sig.test(h));
  return hit ? hit.name : null;
}

// Splits a Via header into its hop entries and names each one where
// possible. E.g. "1.1 abc.cloudfront.net (CloudFront), 1.1 varnish"
// → [{raw: "1.1 abc.cloudfront.net (CloudFront)", cdnName: "CloudFront"},
//    {raw: "1.1 varnish", cdnName: "Varnish"}]
export function parseViaHops(viaValue) {
  if (!viaValue) return [];
  return viaValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, cdnName: identifyCdnFromHeaders({ via: raw }) }));
}

// Combines the Via-hop chain, single-shot header identification, and DNS
// hostname hints into one best-effort chain of CDN names, in priority
// order:
//   1. A Via header with 2+ entries — direct, hop-by-hop proof that
//      chaining actually happened (the point of this whole feature).
//      Prioritized even over a more specific single-header match, because
//      *that a chain exists* matters more than how precisely each link is
//      named.
//   2. The fullest identification available for a single hop — checked
//      across ALL response headers, not just Via. A generic `Via: 1.1
//      varnish` alone under-names plenty of real CDNs (Fastly's default
//      Via is exactly that; the vendor only shows up in X-Served-By/
//      X-Fastly-Request-Id), so a single Via entry does NOT automatically
//      win over the fuller header check the way a 2+ chain does.
//   3. DNS hostname suffixes — last resort, for when neither the request
//      nor its headers revealed anything (e.g. a dead/unreachable origin).
export function buildCdnChain({ dnsChain = [], headers = {} } = {}) {
  const viaHops = parseViaHops(headers.via);
  const outerFromHeaders = identifyCdnFromHeaders(headers);
  let chain;
  let source;

  if (viaHops.length >= 2) {
    chain = viaHops.map((hop) => hop.cdnName || "unidentified hop");
    source = "via-header";
  } else if (outerFromHeaders) {
    chain = [outerFromHeaders];
    source = "response-headers";
  } else if (viaHops[0]?.cdnName) {
    chain = [viaHops[0].cdnName];
    source = "via-header";
  } else {
    const named = dnsChain.map(identifyCdnFromHostname).filter(Boolean);
    chain = named;
    source = named.length ? "dns-hostname" : "none";
  }

  const chainedSameCdn = chain.some((name, i) => i > 0 && name === chain[i - 1] && name !== "unidentified hop");

  return { chain, source, chainedSameCdn, dnsChain, viaHops };
}
