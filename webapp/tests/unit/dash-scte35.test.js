import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { findDashScte35Events, bytesFromBase64, decodeScte35 } from "../../public/scte35.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mpdWithScte35 = readFileSync(
  path.join(__dirname, "../fixtures/dash-mpd-with-scte35.xml"),
  "utf8"
);
const plainMpd = readFileSync(path.join(__dirname, "../fixtures/dash-mpd.xml"), "utf8");

describe("findDashScte35Events", () => {
  test("finds both events in the EventStream, in document order", () => {
    const events = findDashScte35Events(mpdWithScte35);
    assert.equal(events.length, 2);
  });

  test("xml+bin event: extracts base64, normalizes presentationTime/duration by timescale", () => {
    const [evt] = findDashScte35Events(mpdWithScte35);
    assert.equal(evt.id, "1");
    assert.equal(evt.presentationTimeS, 30); // 2700000 / timescale(90000)
    assert.equal(evt.durationS, 10); // 900000 / 90000
    assert.equal(evt.xmlOnly, false);
    assert.equal(
      evt.base64,
      "/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbf1s="
    );
  });

  test("xml+bin event's base64 decodes via the existing decoder unchanged", () => {
    const [evt] = findDashScte35Events(mpdWithScte35);
    const decoded = decodeScte35(bytesFromBase64(evt.base64));
    assert.equal(decoded.splice_command, "splice_insert");
    assert.equal(decoded.splice_event_id, "0x4800008F");
    assert.equal(decoded.break_duration_s, "60.294s");
  });

  test("XML-only event (no <Binary>) is flagged, not silently dropped", () => {
    const [, evt2] = findDashScte35Events(mpdWithScte35);
    assert.equal(evt2.id, "2");
    assert.equal(evt2.presentationTimeS, 60); // 5400000 / 90000
    assert.equal(evt2.durationS, null, "no duration attribute on this event");
    assert.equal(evt2.base64, null);
    assert.equal(evt2.xmlOnly, true);
  });

  test("an MPD with no SCTE-35 EventStream returns an empty array", () => {
    assert.deepEqual(findDashScte35Events(plainMpd), []);
  });

  test("an EventStream with an unrelated schemeIdUri is ignored", () => {
    const mpd = `<MPD><Period><EventStream schemeIdUri="urn:mpeg:dash:event:2012" timescale="1">
      <Event id="x" presentationTime="5">not scte</Event>
    </EventStream></Period></MPD>`;
    assert.deepEqual(findDashScte35Events(mpd), []);
  });
});
