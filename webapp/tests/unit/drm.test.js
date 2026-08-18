import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findHlsKeys, findDashContentProtection, summarizeDrm } from "../../public/scte35.js";

describe("findHlsKeys", () => {
  test("parses METHOD/KEYFORMAT/URI/IV and maps KEYFORMAT to a DRM system name", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key1",KEYFORMAT="com.apple.streamingkeydelivery",IV=0x1234',
      "#EXTINF:6.0,",
      "seg.ts",
    ].join("\n");
    const [key] = findHlsKeys(text);
    assert.equal(key.method, "SAMPLE-AES");
    assert.equal(key.drmSystem, "FairPlay");
    assert.equal(key.uri, "skd://key1");
    assert.equal(key.iv, "0x1234");
    assert.equal(key.tag, "EXT-X-KEY");
  });

  test("multi-DRM: multiple #EXT-X-KEY lines (one per system) are all captured", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://x/wv",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://x/pr",KEYFORMAT="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"',
    ].join("\n");
    const keys = findHlsKeys(text);
    assert.equal(keys.length, 2);
    assert.deepEqual(keys.map((k) => k.drmSystem), ["Widevine", "PlayReady"]);
  });

  test("no KEYFORMAT defaults to identity (clear AES-128)", () => {
    const text = '#EXT-X-KEY:METHOD=AES-128,URI="https://x/key"';
    const [key] = findHlsKeys(text);
    assert.equal(key.keyformat, "identity");
    assert.equal(key.drmSystem, "Clear / AES-128 (no DRM)");
  });

  test("METHOD=NONE is an explicit 'not encrypted' marker, not a key", () => {
    assert.deepEqual(findHlsKeys("#EXT-X-KEY:METHOD=NONE"), []);
  });

  test("EXT-X-SESSION-KEY is recognized too", () => {
    const [key] = findHlsKeys('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="x",KEYFORMAT="identity"');
    assert.equal(key.tag, "EXT-X-SESSION-KEY");
  });

  test("a manifest with no key tags returns an empty array", () => {
    assert.deepEqual(findHlsKeys("#EXTM3U\n#EXTINF:6.0,\nseg.ts\n"), []);
  });
});

describe("findDashContentProtection", () => {
  test("parses schemeIdUri and default_KID (with cenc: prefix)", () => {
    const mpd = `<AdaptationSet>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" cenc:default_KID="1234-5678"/>
    </AdaptationSet>`;
    const [cp] = findDashContentProtection(mpd);
    assert.equal(cp.drmSystem, "Widevine");
    assert.equal(cp.defaultKid, "1234-5678");
  });

  test("multiple ContentProtection elements (multi-DRM) are all captured", () => {
    const mpd = `<AdaptationSet>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" default_KID="abc"/>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" default_KID="abc"/>
    </AdaptationSet>`;
    const results = findDashContentProtection(mpd);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.drmSystem), ["Widevine", "PlayReady"]);
  });

  test("an unencrypted MPD returns an empty array", () => {
    assert.deepEqual(findDashContentProtection("<AdaptationSet></AdaptationSet>"), []);
  });
});

describe("summarizeDrm", () => {
  test("no entries → clear text, empty fingerprint", () => {
    const { text, fingerprint } = summarizeDrm([]);
    assert.equal(text, "No encryption signaled (clear)");
    assert.equal(fingerprint, "");
  });

  test("single system with a key id", () => {
    const { text } = summarizeDrm([{ drmSystem: "Widevine", keyid: "abc123" }]);
    assert.equal(text, "Widevine — key: abc123");
  });

  test("multi-DRM label lists every distinct system once", () => {
    const { text } = summarizeDrm([
      { drmSystem: "Widevine", keyid: "abc" },
      { drmSystem: "PlayReady", keyid: "abc" },
    ]);
    assert.equal(text, "Multi-DRM: Widevine, PlayReady — key: abc");
  });

  test("fingerprint changes when the key id changes (rotation detection)", () => {
    const a = summarizeDrm([{ drmSystem: "Widevine", keyid: "key1" }]);
    const b = summarizeDrm([{ drmSystem: "Widevine", keyid: "key2" }]);
    assert.notEqual(a.fingerprint, b.fingerprint);
  });

  test("fingerprint is stable when nothing changed", () => {
    const a = summarizeDrm([{ drmSystem: "Widevine", keyid: "key1" }]);
    const b = summarizeDrm([{ drmSystem: "Widevine", keyid: "key1" }]);
    assert.equal(a.fingerprint, b.fingerprint);
  });
});
