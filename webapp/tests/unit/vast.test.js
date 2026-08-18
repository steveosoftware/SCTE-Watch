import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detectVastVmap, parseVast, parseVmap, resolveVastChain } from "../../public/vast.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vastInline = readFileSync(path.join(__dirname, "../fixtures/vast-inline.xml"), "utf8");
const vastWrapper = readFileSync(path.join(__dirname, "../fixtures/vast-wrapper.xml"), "utf8");
const vmapFixture = readFileSync(path.join(__dirname, "../fixtures/vmap.xml"), "utf8");

describe("detectVastVmap", () => {
  test("recognizes a VAST document", () => assert.equal(detectVastVmap(vastInline), "vast"));
  test("recognizes a VMAP document", () => assert.equal(detectVastVmap(vmapFixture), "vmap"));
  test("returns null for unrelated XML", () => assert.equal(detectVastVmap("<MPD></MPD>"), null));
});

describe("parseVast — InLine linear ad", () => {
  test("extracts AdSystem/AdTitle/Impression", () => {
    const { ads } = parseVast(vastInline);
    assert.equal(ads.length, 1);
    const [ad] = ads;
    assert.equal(ad.isWrapper, false);
    assert.equal(ad.adSystem, "ExampleAdServer");
    assert.equal(ad.adTitle, "Example Linear Ad");
    assert.deepEqual(ad.impressions, ["https://track.example.com/impression?id=20001"]);
  });

  test("extracts the Linear creative's duration, click, and media files", () => {
    const { ads } = parseVast(vastInline);
    const [creative] = ads[0].creatives;
    assert.equal(creative.type, "Linear");
    assert.equal(creative.duration, "00:00:30");
    assert.equal(creative.clickThrough, "https://advertiser.example.com/landing");
    assert.equal(creative.clickTrackingUrls.length, 1);
    assert.equal(creative.mediaFiles.length, 2);
    assert.equal(creative.mediaFiles[0].width, "1280");
    assert.equal(creative.mediaFiles[0].height, "720");
    assert.equal(creative.mediaFiles[0].url, "https://cdn.example.com/creative_1280x720.mp4");
  });

  test("extracts tracking events keyed by event name", () => {
    const { ads } = parseVast(vastInline);
    const { trackingEvents } = ads[0].creatives[0];
    assert.deepEqual(Object.keys(trackingEvents).sort(), ["complete", "firstQuartile", "midpoint", "start"]);
    assert.equal(trackingEvents.start[0], "https://track.example.com/start");
  });
});

describe("parseVast — Wrapper", () => {
  test("flags isWrapper and extracts the VASTAdTagURI to follow", () => {
    const { ads } = parseVast(vastWrapper);
    assert.equal(ads[0].isWrapper, true);
    assert.equal(ads[0].adSystem, "ExampleSSP");
    assert.equal(ads[0].wrapperAdTagUri, "https://ssp.example.com/vast?id=10001");
    assert.equal(ads[0].creatives.length, 0);
  });
});

describe("resolveVastChain", () => {
  test("a plain InLine document resolves in a single hop", async () => {
    const { hops, truncated } = await resolveVastChain(vastInline);
    assert.equal(hops.length, 1);
    assert.equal(truncated, false);
  });

  test("follows a Wrapper to its InLine target via injectable fetchText", async () => {
    const fetchText = async (url) => {
      assert.equal(url, "https://ssp.example.com/vast?id=10001");
      return vastInline;
    };
    const { hops, truncated } = await resolveVastChain(vastWrapper, { fetchText });
    assert.equal(hops.length, 2);
    assert.equal(hops[0].ads[0].isWrapper, true);
    assert.equal(hops[1].ads[0].isWrapper, false);
    assert.equal(hops[1].ads[0].adSystem, "ExampleAdServer");
    assert.equal(truncated, false);
  });

  test("a Wrapper with no fetchText available stops after one hop, flagged truncated", async () => {
    const { hops, truncated } = await resolveVastChain(vastWrapper);
    assert.equal(hops.length, 1);
    assert.equal(truncated, true);
  });

  test("stops at maxHops rather than following a wrapper loop forever", async () => {
    const fetchText = async () => vastWrapper; // wrapper that always points to itself
    const { hops, truncated } = await resolveVastChain(vastWrapper, { fetchText, maxHops: 3 });
    assert.equal(hops.length, 3);
    assert.equal(truncated, true);
  });
});

describe("parseVmap", () => {
  test("finds both ad breaks with their type/timeOffset/id", () => {
    const { adBreaks } = parseVmap(vmapFixture);
    assert.equal(adBreaks.length, 2);
    assert.equal(adBreaks[0].breakType, "linear");
    assert.equal(adBreaks[0].timeOffset, "start");
    assert.equal(adBreaks[0].breakId, "preroll-1");
    assert.equal(adBreaks[1].timeOffset, "00:05:00.000");
  });

  test("a break with an AdTagURI reference has adTagUri set, inlineVastXml null", () => {
    const { adBreaks } = parseVmap(vmapFixture);
    assert.equal(adBreaks[0].adTagUri, "https://ssp.example.com/vast?pod=preroll");
    assert.equal(adBreaks[0].inlineVastXml, null);
  });

  test("a break with inline VASTAdData has inlineVastXml set, adTagUri null, and it parses as valid VAST", () => {
    const { adBreaks } = parseVmap(vmapFixture);
    assert.equal(adBreaks[1].adTagUri, null);
    assert.ok(adBreaks[1].inlineVastXml.includes("<VAST"));
    const { ads } = parseVast(adBreaks[1].inlineVastXml);
    assert.equal(ads[0].adTitle, "Midroll Inline Ad");
    assert.equal(ads[0].creatives[0].duration, "00:00:15");
  });
});
