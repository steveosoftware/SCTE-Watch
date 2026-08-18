import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  identifyCdnFromHostname,
  identifyCdnFromHeaders,
  parseViaHops,
  buildCdnChain,
} from "../../public/cdn-fingerprint.js";

describe("identifyCdnFromHostname", () => {
  const cases = [
    ["d111abc.cloudfront.net", "CloudFront"],
    ["a1834.w10.akamai.net", null], // .akamai.net itself isn't in the suffix table (ambiguous/generic); real Akamai edge hosts use .akamaiedge.net etc.
    ["e123.dscb.akamaiedge.net", "Akamai"],
    ["xyz.akamaized.net", "Akamai"],
    ["j.sni.global.fastly.net", "Fastly"],
    ["something.llnwd.net", "Limelight"],
    ["example.com", null],
  ];
  for (const [host, expected] of cases) {
    test(`${host} → ${expected}`, () => assert.equal(identifyCdnFromHostname(host), expected));
  }

  test("case-insensitive", () => {
    assert.equal(identifyCdnFromHostname("D111ABC.CLOUDFRONT.NET"), "CloudFront");
  });
});

describe("identifyCdnFromHeaders", () => {
  test("CloudFront via x-amz-cf-id (the real case: no Via header at all)", () => {
    // This is exactly what a Route 53 ALIAS-fronted CloudFront distribution
    // looks like: no CNAME, and sometimes no informative Via either —
    // x-amz-cf-id/x-amz-cf-pop are the reliable tell.
    assert.equal(identifyCdnFromHeaders({ "x-amz-cf-id": "abc123==" }), "CloudFront");
  });

  test("CloudFront via x-cache", () => {
    assert.equal(identifyCdnFromHeaders({ "x-cache": "RefreshHit from cloudfront" }), "CloudFront");
  });

  test("Akamai via server header", () => {
    assert.equal(identifyCdnFromHeaders({ server: "AkamaiGHost" }), "Akamai");
  });

  test("Fastly via x-fastly-request-id", () => {
    assert.equal(identifyCdnFromHeaders({ "x-fastly-request-id": "abc" }), "Fastly");
  });

  test("Cloudflare via cf-ray", () => {
    assert.equal(identifyCdnFromHeaders({ "cf-ray": "abc-LAX" }), "Cloudflare");
  });

  test("generic Varnish is a last-resort, lower-confidence match", () => {
    assert.equal(identifyCdnFromHeaders({ via: "1.1 varnish" }), "Varnish");
  });

  test("no matching headers → null, not a guess", () => {
    assert.equal(identifyCdnFromHeaders({ "content-type": "text/plain" }), null);
  });

  test("empty/missing headers object → null", () => {
    assert.equal(identifyCdnFromHeaders({}), null);
    assert.equal(identifyCdnFromHeaders(undefined), null);
  });
});

describe("parseViaHops", () => {
  test("single named hop", () => {
    const hops = parseViaHops("1.1 abc123.cloudfront.net (CloudFront)");
    assert.equal(hops.length, 1);
    assert.equal(hops[0].cdnName, "CloudFront");
  });

  test("THE key scenario: two CloudFront hops chained in one Via header", () => {
    // This is what CloudFront-fronting-CloudFront actually produces on the
    // wire — the inner distribution's Via entry gets preserved and the
    // outer one appends its own, per RFC 7230. This is the real, direct
    // signal for the exact problem this feature exists to catch.
    const hops = parseViaHops("1.1 bbbbbb.cloudfront.net (CloudFront), 1.1 aaaaaa.cloudfront.net (CloudFront)");
    assert.equal(hops.length, 2);
    assert.deepEqual(hops.map((h) => h.cdnName), ["CloudFront", "CloudFront"]);
  });

  test("mixed chain: unnamed CDN in front of CloudFront", () => {
    const hops = parseViaHops("1.1 varnish, 1.1 abc.cloudfront.net (CloudFront)");
    assert.deepEqual(hops.map((h) => h.cdnName), ["Varnish", "CloudFront"]);
  });

  test("no Via header → empty array", () => {
    assert.deepEqual(parseViaHops(undefined), []);
    assert.deepEqual(parseViaHops(""), []);
  });
});

describe("buildCdnChain", () => {
  test("REGRESSION: DNS shows nothing (Route 53 ALIAS, no CNAME) but headers reveal CloudFront", () => {
    // This is the exact real-world case that prompted this rework: DNS
    // resolves straight to CloudFront's IPs with zero visible CNAME, so
    // dnsChain is just the bare hostname — but the actual HTTP response
    // proves it's CloudFront. Must not report "nothing detected."
    const result = buildCdnChain({
      dnsChain: ["xumo-drct-ch109-8jv1c.fast.nbcuni.com"],
      headers: { "x-cache": "RefreshHit from cloudfront", "x-amz-cf-pop": "LAX53-P6", server: "AmazonS3" },
    });
    assert.deepEqual(result.chain, ["CloudFront"]);
    assert.equal(result.source, "response-headers");
    assert.equal(result.chainedSameCdn, false);
  });

  test("chained CloudFront (the failure mode this feature exists to catch) is flagged via Via, regardless of DNS", () => {
    const result = buildCdnChain({
      dnsChain: ["live.example.com"], // no CNAME visible here either
      headers: { via: "1.1 bbbbbb.cloudfront.net (CloudFront), 1.1 aaaaaa.cloudfront.net (CloudFront)" },
    });
    assert.deepEqual(result.chain, ["CloudFront", "CloudFront"]);
    assert.equal(result.source, "via-header");
    assert.equal(result.chainedSameCdn, true);
  });

  test("REGRESSION: a generic single Via hop doesn't shadow a more specific vendor header", () => {
    // Real shape of test-streams.mux.dev's actual response: Via just says
    // "varnish" (Fastly's default, names no vendor), but X-Served-By
    // clearly identifies Fastly. A naive "Via always wins" rule would
    // report the less-useful "Varnish" here — this must report "Fastly".
    const result = buildCdnChain({
      dnsChain: ["test-streams.mux.dev", "j.sni.global.fastly.net"],
      headers: { via: "1.1 varnish", "x-served-by": "cache-bur-kbur8200046-BUR" },
    });
    assert.deepEqual(result.chain, ["Fastly"]);
    assert.equal(result.source, "response-headers");
  });

  test("a 2+ hop Via chain still wins over a single more-specific header, since proving the chain exists is the point", () => {
    const result = buildCdnChain({
      dnsChain: [],
      headers: {
        via: "1.1 aaaaaa.cloudfront.net (CloudFront), 1.1 varnish",
        "x-served-by": "cache-bur-kbur8200046-BUR", // would say "Fastly" alone, but there are 2 real hops here
      },
    });
    assert.equal(result.source, "via-header");
    assert.deepEqual(result.chain, ["CloudFront", "Varnish"]);
  });

  test("a single named Via hop is used when no other header adds more specificity", () => {
    const result = buildCdnChain({
      dnsChain: [],
      headers: { via: "1.1 x.cloudfront.net (CloudFront)" },
    });
    assert.deepEqual(result.chain, ["CloudFront"]);
  });

  test("falls back to DNS hostname naming when neither Via nor other headers identify anything", () => {
    const result = buildCdnChain({
      dnsChain: ["example.com", "j.sni.global.fastly.net"],
      headers: { "content-type": "text/plain" },
    });
    assert.deepEqual(result.chain, ["Fastly"]);
    assert.equal(result.source, "dns-hostname");
  });

  test("nothing identifies anything → empty chain, source 'none', not a crash", () => {
    const result = buildCdnChain({ dnsChain: ["example.com"], headers: {} });
    assert.deepEqual(result.chain, []);
    assert.equal(result.source, "none");
    assert.equal(result.chainedSameCdn, false);
  });

  test("two DIFFERENT CDNs chained (not the same vendor) is not flagged as chainedSameCdn", () => {
    const result = buildCdnChain({
      dnsChain: [],
      headers: { via: "1.1 x.fastly_edge (Fastly), 1.1 abc.cloudfront.net (CloudFront)" },
    });
    assert.equal(result.chainedSameCdn, false);
  });

  test("defaults (no args) don't throw", () => {
    const result = buildCdnChain();
    assert.deepEqual(result.chain, []);
  });
});
