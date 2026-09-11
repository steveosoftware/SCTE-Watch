import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  analyzeTsSegment,
  compareSegmentBoundary,
  summarizeBoundaries,
  streamTypeName,
  TS_PACKET_SIZE,
} from "../../public/tsanalyze.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(path.join(__dirname, "../fixtures", n));

// Synthetic, built to exercise one boundary behaviour each. See
// ts-seg-a.ts's siblings: video runs CC 0..7 in A, so "continuous" starts
// at 8, "reset" restarts at 0, and "jump" starts somewhere else entirely.
const segA = fx("ts-seg-a.ts");

describe("analyzeTsSegment — structure", () => {
  test("counts 188-byte packets and reports alignment", () => {
    const r = analyzeTsSegment(segA);
    assert.equal(r.packets, segA.length / TS_PACKET_SIZE);
    assert.equal(r.aligned, true);
  });

  test("walks PAT to PMT and names the elementary streams", () => {
    const r = analyzeTsSegment(segA);
    assert.deepEqual(r.pat.programs, [{ programNumber: 1, pmtPid: 0x1000 }]);
    assert.equal(r.pmt.pcrPid, 0x0100);
    assert.deepEqual(
      r.pmt.streams.map((s) => [s.pid, s.name]),
      [
        [0x0100, "H.264"],
        [0x0101, "AAC (ADTS)"],
      ]
    );
  });

  test("identifies the video and audio PIDs from stream_type, not by convention", () => {
    // The whole point: a PID number means nothing on its own. 0x0100 is
    // video here because the PMT says stream_type 0x1b, not because 0x100
    // is "the video PID".
    const r = analyzeTsSegment(segA);
    assert.equal(r.videoPid, 0x0100);
    assert.equal(r.audioPid, 0x0101);
  });

  test("finds an in-band SCTE-35 stream when one is declared", () => {
    const r = analyzeTsSegment(fx("ts-seg-scte35.ts"));
    const scte = r.pmt.streams.find((s) => s.streamType === 0x86);
    assert.ok(scte, "stream_type 0x86 must be surfaced");
    assert.equal(scte.pid, 0x01f0);
    assert.equal(scte.name, "SCTE-35 cue");
  });

  test("its absence is how we know a stream has no in-band SCTE-35", () => {
    const r = analyzeTsSegment(segA);
    assert.ok(!r.pmt.streams.some((s) => s.streamType === 0x86));
  });

  test("an unknown stream_type is reported by number rather than guessed", () => {
    assert.match(streamTypeName(0x77), /unknown \(0x77\)/);
  });

  test("accepts a plain ArrayBuffer as well as a Uint8Array", () => {
    const ab = segA.buffer.slice(segA.byteOffset, segA.byteOffset + segA.byteLength);
    assert.equal(analyzeTsSegment(ab).packets, analyzeTsSegment(segA).packets);
  });
});

describe("analyzeTsSegment — integrity", () => {
  test("a healthy segment sets no error flags", () => {
    const r = analyzeTsSegment(segA);
    assert.equal(r.transportErrors, 0);
    assert.equal(r.syncLoss, 0);
    assert.equal(r.ccErrorsWithin, 0);
    assert.equal(r.scrambled, 0);
  });

  test("transport_error_indicator is counted — the definitive corrupt flag", () => {
    const r = analyzeTsSegment(fx("ts-seg-tei.ts"));
    assert.equal(r.transportErrors, 3);
  });

  test("a broken sync byte is counted as sync loss", () => {
    const damaged = Buffer.from(segA);
    damaged[TS_PACKET_SIZE * 2] = 0x00; // clobber one packet's sync byte
    assert.equal(analyzeTsSegment(damaged).syncLoss, 1);
  });

  test("continuity is scored WITHIN the segment only", () => {
    // Each fixture restarts its own counters; scored on its own terms,
    // every one of them is internally perfect. That separation is the
    // point — see the boundary suite below for the other half.
    for (const f of ["ts-seg-a.ts", "ts-seg-b-reset.ts", "ts-seg-b-jump.ts", "ts-seg-b-continuous.ts"]) {
      assert.equal(analyzeTsSegment(fx(f)).ccErrorsWithin, 0, f);
    }
  });

  test("a trailing partial packet is ignored rather than misread", () => {
    const ragged = Buffer.concat([segA, Buffer.alloc(50, 0x47)]);
    const r = analyzeTsSegment(ragged);
    assert.equal(r.aligned, false, "misalignment must be reported");
    assert.equal(r.packets, segA.length / TS_PACKET_SIZE, "the stub must not count as a packet");
  });

  test("empty input yields zeroes rather than throwing", () => {
    const r = analyzeTsSegment(new Uint8Array(0));
    assert.equal(r.packets, 0);
    assert.equal(r.pat, null);
  });
});

describe("compareSegmentBoundary", () => {
  const a = analyzeTsSegment(segA);

  test("counter carried across the join reads as continuous", () => {
    const rows = compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-continuous.ts")));
    const v = rows.find((r) => r.pid === 0x0100);
    assert.equal(v.lastCc, 7);
    assert.equal(v.expected, 8);
    assert.equal(v.firstCc, 8);
    assert.equal(v.state, "continuous");
  });

  test("restart at zero reads as a reset, NOT as a jump", () => {
    // The distinction the whole feature exists for: a reset is packager
    // configuration; a jump has the shape of genuine loss. Collapsing them
    // sends an operator hunting an encoder fault that isn't there.
    const rows = compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-reset.ts")));
    const v = rows.find((r) => r.pid === 0x0100);
    assert.equal(v.firstCc, 0);
    assert.equal(v.state, "reset");
  });

  test("neither continuing nor restarting reads as a jump", () => {
    const rows = compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-jump.ts")));
    const v = rows.find((r) => r.pid === 0x0100);
    assert.equal(v.state, "jump");
  });

  test("a reset is indistinguishable from continuous when the previous ended at 15", () => {
    // 1-in-16 coincidence. It must be flagged, or a demo that happens to
    // land on it reads as a clean stream.
    const prev = { pids: { 0x0100: { pid: 0x0100, packets: 5, firstCc: 11, lastCc: 15 } } };
    const curr = { pids: { 0x0100: { pid: 0x0100, packets: 5, firstCc: 0, lastCc: 4 } } };
    const [v] = compareSegmentBoundary(prev, curr);
    assert.equal(v.state, "continuous");
    assert.equal(v.coincidental, true, "must not be presented as proof of a clean boundary");
  });

  test("a PID present in only one segment is 'absent', not a failure", () => {
    const prev = { pids: { 0x0100: { pid: 0x0100, firstCc: 0, lastCc: 3 } } };
    const curr = { pids: { 0x0100: { pid: 0x0100, firstCc: 4, lastCc: 9 }, 0x0200: { pid: 0x0200, firstCc: 0, lastCc: 1 } } };
    const rows = compareSegmentBoundary(prev, curr);
    assert.equal(rows.find((r) => r.pid === 0x0200).state, "absent");
  });

  test("every PID in the segment is checked, not just video", () => {
    const rows = compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-reset.ts")));
    const pids = rows.map((r) => r.pid).sort((x, y) => x - y);
    assert.deepEqual(pids, [0x0000, 0x0100, 0x0101, 0x1000]);
  });
});

describe("summarizeBoundaries", () => {
  const a = analyzeTsSegment(segA);

  test("keeps resets and jumps in separate columns", () => {
    const s = summarizeBoundaries([
      compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-reset.ts"))),
      compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-jump.ts"))),
    ]);
    assert.ok(s.reset > 0, "resets counted");
    assert.ok(s.jump > 0, "jumps counted");
    assert.equal(s.boundaries, 2);
  });

  test("a fully continuous pair reports no resets or jumps", () => {
    const s = summarizeBoundaries([compareSegmentBoundary(a, analyzeTsSegment(fx("ts-seg-b-continuous.ts")))]);
    assert.equal(s.reset, 0);
    assert.equal(s.jump, 0);
    assert.ok(s.continuous > 0);
  });
});
