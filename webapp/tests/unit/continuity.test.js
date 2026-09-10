import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseMaster,
  findVariantLadderAnomalies,
  extractTargetDuration,
  detectSequenceGap,
  compareMediaSequence,
  findDiscontinuities,
  isPlaylistStale,
} from "../../public/scte35.js";

describe("parseMaster — resolution/codecs extraction", () => {
  test("captures resolution and codecs alongside bandwidth", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=836280,RESOLUTION=848x480,CODECS="mp4a.40.2,avc1.64001f"',
      "480.m3u8",
    ].join("\n");
    const [v] = parseMaster(master, "https://example.com/master.m3u8");
    assert.deepEqual(v.resolution, { width: 848, height: 480 });
    assert.equal(v.codecs, "mp4a.40.2,avc1.64001f");
  });

  test("resolution is null when absent, not a crash", () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\naudio.m3u8\n";
    const [v] = parseMaster(master, "https://example.com/master.m3u8");
    assert.equal(v.resolution, null);
  });
});

describe("findVariantLadderAnomalies", () => {
  test("flags a lower-resolution variant with higher bandwidth than its predecessor", () => {
    const variants = [
      { bandwidth: 500000, resolution: { width: 640, height: 360 }, url: "a" },
      { bandwidth: 900000, resolution: { width: 480, height: 270 }, url: "b" }, // bug: higher bw, lower res
      { bandwidth: 2000000, resolution: { width: 1280, height: 720 }, url: "c" },
    ];
    const anomalies = findVariantLadderAnomalies(variants);
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].higher.bandwidth, 900000);
    assert.equal(anomalies[0].lower.bandwidth, 500000);
  });

  test("a well-formed monotonic ladder reports no anomalies", () => {
    const variants = [
      { bandwidth: 500000, resolution: { width: 640, height: 360 } },
      { bandwidth: 900000, resolution: { width: 848, height: 480 } },
      { bandwidth: 2000000, resolution: { width: 1280, height: 720 } },
    ];
    assert.deepEqual(findVariantLadderAnomalies(variants), []);
  });

  test("variants without a resolution are skipped, not treated as 0x0", () => {
    const variants = [
      { bandwidth: 128000, resolution: null }, // audio-only
      { bandwidth: 500000, resolution: { width: 640, height: 360 } },
    ];
    assert.deepEqual(findVariantLadderAnomalies(variants), []);
  });
});

describe("extractTargetDuration", () => {
  test("parses the value", () => {
    assert.equal(extractTargetDuration("#EXTM3U\n#EXT-X-TARGETDURATION:6\n"), 6);
  });
  test("null when absent", () => {
    assert.equal(extractTargetDuration("#EXTM3U\n"), null);
  });
});

describe("detectSequenceGap", () => {
  function playlist(seq, segCount) {
    const lines = ["#EXTM3U", `#EXT-X-MEDIA-SEQUENCE:${seq}`];
    for (let i = 0; i < segCount; i++) lines.push("#EXTINF:6.000,", `seg${seq + i}.ts`);
    return lines.join("\n");
  }

  test("normal advance (seq += segments that rolled off) is not a gap", () => {
    // prev had 5 segments (seq 100-104); next poll shows seq 102 with 5
    // segments (102-106) — 3 rolled off the front, sequence advanced by 3.
    // That's exactly consistent, not a gap.
    const prev = playlist(100, 5);
    const curr = playlist(102, 5);
    assert.equal(detectSequenceGap(prev, curr), null);
  });

  test("sequence advancing by more than the previous segment count is a gap", () => {
    const prev = playlist(100, 5); // segments 100-104 (5 total)
    const curr = playlist(110, 5); // jumped to 110 — we never saw 105-109
    const gap = detectSequenceGap(prev, curr);
    assert.ok(gap);
    assert.equal(gap.missing, 5); // advanced 10, only had 5 to lose
  });

  test("returns null when either playlist has no sequence number", () => {
    assert.equal(detectSequenceGap("#EXTM3U\n", playlist(100, 3)), null);
  });
});

describe("compareMediaSequence", () => {
  function playlist(seq, segCount) {
    const lines = ["#EXTM3U", `#EXT-X-MEDIA-SEQUENCE:${seq}`];
    for (let i = 0; i < segCount; i++) lines.push("#EXTINF:6.000,", `seg${seq + i}.ts`);
    return lines.join("\n");
  }

  test("advancing by no more than the previous window is sequential", () => {
    // prev held 100-104; now at 102, so 100 and 101 rolled off — both of
    // which we had already seen. Nothing went past unobserved.
    const r = compareMediaSequence(playlist(100, 5), playlist(102, 5));
    assert.equal(r.state, "sequential");
    assert.equal(r.advanced, 2);
    assert.equal(r.missing, 0);
  });

  test("advancing by exactly the window size is still sequential, not a skip", () => {
    // The boundary case: everything we held rolled off, but we saw it all.
    const r = compareMediaSequence(playlist(100, 5), playlist(105, 5));
    assert.equal(r.state, "sequential");
    assert.equal(r.advanced, 5);
  });

  test("advancing past the window means segments came and went unseen", () => {
    const r = compareMediaSequence(playlist(100, 5), playlist(110, 5));
    assert.equal(r.state, "skipped");
    assert.equal(r.missing, 5);
    assert.equal(r.prevSeq, 100);
    assert.equal(r.currSeq, 110);
  });

  test("a sequence going BACKWARDS is reported as a rewind", () => {
    // A packager restart or a failover to an origin numbering
    // independently. Every cached timestamp and sequence is now
    // meaningless, so it must not read as healthy.
    const r = compareMediaSequence(playlist(110, 5), playlist(100, 5));
    assert.equal(r.state, "rewound");
    assert.equal(r.advanced, -10);
    assert.equal(r.missing, 0, "a rewind is a reset, not a count of lost segments");
  });

  test("an unmoved sequence is 'unchanged', which is normal between fast polls", () => {
    const r = compareMediaSequence(playlist(100, 5), playlist(100, 5));
    assert.equal(r.state, "unchanged");
    assert.equal(r.advanced, 0);
  });

  test("the first poll has nothing to compare against and says so", () => {
    const r = compareMediaSequence(null, playlist(100, 5));
    assert.equal(r.state, "first");
    assert.equal(r.currSeq, 100);
    assert.equal(r.segCount, 5);
  });

  test("a playlist with no MEDIA-SEQUENCE is 'unknown', not silently zero", () => {
    assert.equal(compareMediaSequence(playlist(100, 5), "#EXTM3U\n").state, "unknown");
    assert.equal(compareMediaSequence("#EXTM3U\n", playlist(100, 5)).state, "unknown");
  });

  test("reports the current segment count alongside the verdict", () => {
    assert.equal(compareMediaSequence(playlist(100, 5), playlist(102, 7)).segCount, 7);
  });
});

describe("detectSequenceGap delegates to compareMediaSequence", () => {
  function playlist(seq, segCount) {
    const lines = ["#EXTM3U", `#EXT-X-MEDIA-SEQUENCE:${seq}`];
    for (let i = 0; i < segCount; i++) lines.push("#EXTINF:6.000,", `seg${seq + i}.ts`);
    return lines.join("\n");
  }

  test("a rewind is NOT a gap — which is exactly why the richer view exists", () => {
    // Guards the narrow contract deliberately: callers of this function
    // want the skip alarm only. Anything wanting the full picture must
    // call compareMediaSequence, and this test is the reminder.
    assert.equal(detectSequenceGap(playlist(110, 5), playlist(100, 5)), null);
    assert.equal(compareMediaSequence(playlist(110, 5), playlist(100, 5)).state, "rewound");
  });

  test("a null previous playlist is not a gap", () => {
    assert.equal(detectSequenceGap(null, playlist(100, 5)), null);
  });
});

describe("findDiscontinuities", () => {
  test("finds the segment following each discontinuity tag", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:6.0,",
      "seg1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:6.0,",
      "seg2.ts",
    ].join("\n");
    const result = findDiscontinuities(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].beforeSegment, "seg2.ts");
  });

  test("a playlist with no discontinuities returns an empty array", () => {
    assert.deepEqual(findDiscontinuities("#EXTM3U\n#EXTINF:6.0,\nseg.ts\n"), []);
  });
});

describe("isPlaylistStale", () => {
  test("not stale within 3x target duration", () => {
    assert.equal(isPlaylistStale(10_000, 5_000, 6), false); // 5s elapsed, threshold 18s
  });
  test("stale past 3x target duration", () => {
    assert.equal(isPlaylistStale(30_000, 5_000, 6), true); // 25s elapsed, threshold 18s
  });
  test("no data yet (lastChangeAtMs null) is never flagged stale", () => {
    assert.equal(isPlaylistStale(30_000, null, 6), false);
  });
  test("no target duration means we can't judge staleness", () => {
    assert.equal(isPlaylistStale(30_000, 0, null), false);
  });
});
