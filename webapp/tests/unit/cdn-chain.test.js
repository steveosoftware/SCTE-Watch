import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveCnameChain } from "../../cdn-chain.js";

// Builds a fake resolveCname from a {hostname: cnameTarget} map — anything
// not in the map throws ENODATA, matching real dns.resolveCname's behavior
// at the end of a chain.
function fakeResolver(map) {
  return async (hostname) => {
    if (map[hostname]) return [map[hostname]];
    const e = new Error(`ENODATA for ${hostname}`);
    e.code = "ENODATA";
    throw e;
  };
}

describe("resolveCnameChain", () => {
  test("no CNAME at all — chain is just the hostname itself", async () => {
    const chain = await resolveCnameChain("example.com", { resolveCname: fakeResolver({}) });
    assert.deepEqual(chain, ["example.com"]);
  });

  test("single hop", async () => {
    const chain = await resolveCnameChain("myapp.example.com", {
      resolveCname: fakeResolver({ "myapp.example.com": "d111.cloudfront.net" }),
    });
    assert.deepEqual(chain, ["myapp.example.com", "d111.cloudfront.net"]);
  });

  test("chained CloudFront: two hops in a row", async () => {
    const chain = await resolveCnameChain("live.example.com", {
      resolveCname: fakeResolver({
        "live.example.com": "d111abc.cloudfront.net",
        "d111abc.cloudfront.net": "d222xyz.cloudfront.net",
      }),
    });
    assert.deepEqual(chain, ["live.example.com", "d111abc.cloudfront.net", "d222xyz.cloudfront.net"]);
  });

  test("stops at maxHops rather than looping forever on a cycle", async () => {
    const chain = await resolveCnameChain("a.com", {
      maxHops: 3,
      resolveCname: fakeResolver({ "a.com": "b.com", "b.com": "a.com" }),
    });
    assert.equal(chain.length, 4); // a.com + 3 hops
  });
});
