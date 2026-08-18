import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { findCueWallclocks } from "../../public/scte35.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveManifest = readFileSync(
  path.join(__dirname, "../fixtures/hls-live-with-cues.m3u8"),
  "utf8"
);

describe("findCueWallclocks", () => {
  test("EXT-X-DATERANGE uses its own START-DATE (authoritative), not timeline interpolation", () => {
    const results = findCueWallclocks(liveManifest);
    const daterange = results.find((r) => r.source === "daterange");
    assert.ok(daterange, "expected a daterange-sourced result");
    assert.equal(daterange.wallclockIso, "2026-08-16T12:00:20.000Z");
  });

  test("EXT-X-CUE-OUT/CUE-IN interpolate from PROGRAM-DATE-TIME + accumulated EXTINF", () => {
    const results = findCueWallclocks(liveManifest);
    const timelineResults = results.filter((r) => r.source === "timeline");
    assert.equal(timelineResults.length, 2, "expected CUE-OUT and CUE-IN, both timeline-sourced");

    // Anchor is 12:00:00.000Z; CUE-OUT appears after 3 x 6s segments (18s elapsed).
    assert.equal(timelineResults[0].wallclockIso, "2026-08-16T12:00:18.000Z");
    assert.match(timelineResults[0].line, /EXT-X-CUE-OUT/);

    // CUE-IN appears one more 6s segment later (24s elapsed).
    assert.equal(timelineResults[1].wallclockIso, "2026-08-16T12:00:24.000Z");
    assert.match(timelineResults[1].line, /EXT-X-CUE-IN/);
  });

  test("returns 3 cue lines total, in document order", () => {
    const results = findCueWallclocks(liveManifest);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.source),
      ["daterange", "timeline", "timeline"]
    );
  });

  test("no PROGRAM-DATE-TIME anywhere → wallclockIso is null, not a guess", () => {
    const noAnchor = "#EXTM3U\n#EXTINF:6.0,\nseg.ts\n#EXT-X-CUE-OUT:30\n";
    const results = findCueWallclocks(noAnchor);
    assert.equal(results.length, 1);
    assert.equal(results[0].wallclockIso, null);
    assert.equal(results[0].source, null);
  });

  test("a manifest with no cue lines returns an empty array", () => {
    const plain = "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z\n#EXTINF:6.0,\nseg.ts\n";
    assert.deepEqual(findCueWallclocks(plain), []);
  });
});
