import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  analyzeTsSegment,
  extractSections,
  groupScte35Sections,
  crc32Mpeg2,
  TS_PACKET_SIZE,
} from "../../public/tsanalyze.js";
import { decodeScte35, bytesFromHex } from "../../public/scte35.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(path.join(__dirname, "../fixtures", n));
const payloads = JSON.parse(fx("scte35-payloads.json"));

// ts-seg-scte35.ts declares stream_type 0x86 on PID 0x01F0 in its PMT but
// carries no packets on it — a stream wired for in-band cues during a
// stretch with no break. Appending cue packets to it gives a segment with
// a real PAT/PMT walk in front of whatever is under test.
const SCTE_PID = 0x01f0;
const base = fx("ts-seg-scte35.ts");

// The captured splice_insert, as it arrived. Its CRC_32 does NOT verify
// (checked against the CRC-32/MPEG-2 reference value, and no single-byte
// edit repairs it) — useful in its own right, see the CRC suite.
const capturedRaw = Buffer.from(payloads.splice_insert_basic.base64, "base64");

// The same section with a correct CRC, for tests about reassembly rather
// than integrity.
function withCrc(body) {
  const out = Buffer.alloc(body.length + 4);
  body.copy(out);
  out.writeUInt32BE(crc32Mpeg2(body), body.length);
  return out;
}
const cue = withCrc(capturedRaw.subarray(0, capturedRaw.length - 4));

// A section of arbitrary size: table_id 0xFC, a section_length covering
// `bodyLen` filler bytes plus the CRC.
function bigSection(bodyLen, fill = 0x5a) {
  const body = Buffer.alloc(3 + bodyLen, fill);
  body[0] = 0xfc;
  const len = bodyLen + 4;
  body[1] = 0x30 | ((len >> 8) & 0x0f);
  body[2] = len & 0xff;
  return withCrc(body);
}

// One 188-byte packet. Unused payload is 0xFF stuffing, which is what a
// muxer pads PSI packets with — and what the reassembler must not mistake
// for another section.
function packet({ pid = SCTE_PID, pusi = false, cc = 0, payload = Buffer.alloc(0), adaptation = null }) {
  const p = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  let o = 4;
  if (adaptation) {
    p[3] = 0x30 | (cc & 0x0f);
    p[4] = adaptation.length;
    adaptation.copy(p, 5);
    o = 5 + adaptation.length;
  } else {
    p[3] = 0x10 | (cc & 0x0f);
  }
  payload.copy(p, o, 0, Math.min(payload.length, TS_PACKET_SIZE - o));
  return p;
}

// Splits a section across packets the way a muxer does: pointer_field 0 in
// the first, raw continuation bytes in the rest.
function packetize(section, startCc = 0) {
  const out = [];
  let rest = Buffer.concat([Buffer.from([0x00]), section]);
  let cc = startCc;
  let first = true;
  while (rest.length) {
    out.push(packet({ pusi: first, cc, payload: rest.subarray(0, 184) }));
    rest = rest.subarray(184);
    first = false;
    cc = (cc + 1) & 0x0f;
  }
  return out;
}

const seg = (...pkts) => Buffer.concat([base, ...pkts]);
const decodeHex = (hex) => decodeScte35(bytesFromHex(hex));

describe("crc32Mpeg2", () => {
  test("matches the CRC-32/MPEG-2 reference check value", () => {
    assert.equal(crc32Mpeg2(Buffer.from("123456789")), 0x0376e6e7);
  });

  test("a section run through including its own CRC yields 0", () => {
    assert.equal(crc32Mpeg2(cue), 0);
  });
});

describe("extractSections — the normal case", () => {
  test("a single-packet splice_info_section comes out byte-identical", () => {
    const r = extractSections(seg(...packetize(cue)), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].hex, cue.toString("hex"));
    assert.equal(r.sections[0].crcOk, true);
    assert.equal(r.incomplete, 0);
  });

  test("and feeds decodeScte35() unchanged", () => {
    // The whole premise of the pure-JS approach: section bytes from the
    // stream are exactly what the manifest path already decodes.
    const r = extractSections(seg(...packetize(cue)), SCTE_PID);
    const d = decodeHex(r.sections[0].hex);
    assert.equal(d.splice_command, "splice_insert");
    assert.equal(d.splice_event_id, "0x4800008F");
    assert.equal(d.out_of_network, true);
  });

  test("records which packet the section started in", () => {
    const r = extractSections(seg(...packetize(cue)), SCTE_PID);
    assert.equal(r.sections[0].packetIndex, base.length / TS_PACKET_SIZE);
  });

  test("ignores packets on other PIDs", () => {
    assert.equal(extractSections(seg(...packetize(cue)), 0x0100).sections.length, 0);
  });

  test("reads the payload after an adaptation field", () => {
    const pkt = packet({ pusi: true, payload: Buffer.concat([Buffer.from([0]), cue]), adaptation: Buffer.from([0x00, 0xff, 0xff]) });
    const r = extractSections(seg(pkt), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].hex, cue.toString("hex"));
  });

  test("the 0xFF stuffing after a section is not read as another one", () => {
    const r = extractSections(seg(...packetize(cue)), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.incomplete, 0);
  });
});

describe("extractSections — sections spanning packets", () => {
  test("a section longer than one packet is reassembled", () => {
    const big = bigSection(400);
    const pkts = packetize(big);
    assert.equal(pkts.length, 3, "precondition: really does span packets");
    const r = extractSections(seg(...pkts), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].hex, big.toString("hex"));
    assert.equal(r.sections[0].crcOk, true);
  });

  test("interleaved packets on other PIDs don't disturb it", () => {
    const [a, b, c] = packetize(bigSection(400));
    const video = packet({ pid: 0x0100, payload: Buffer.alloc(184, 0x00) });
    const r = extractSections(seg(a, video, b, video, c), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].crcOk, true);
  });

  test("a legally duplicated packet is dropped, not appended twice", () => {
    const big = bigSection(400);
    const [a, b, c] = packetize(big);
    const r = extractSections(seg(a, b, b, c), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].hex, big.toString("hex"));
  });

  test("a continuity break mid-section abandons it rather than splicing garbage", () => {
    // Bytes from either side of a gap would join into something that
    // parses but was never sent.
    const [a, , c] = packetize(bigSection(400));
    const r = extractSections(seg(a, c), SCTE_PID);
    assert.equal(r.sections.length, 0);
    assert.equal(r.incomplete, 1);
  });

  test("a section still open when the segment ends counts as incomplete", () => {
    const [a, b] = packetize(bigSection(400));
    const r = extractSections(seg(a, b), SCTE_PID);
    assert.equal(r.sections.length, 0);
    assert.equal(r.incomplete, 1);
  });

  test("the tail of a section begun in the previous segment is skipped", () => {
    // A continuation packet with nothing to attach it to — the start is
    // in a segment we didn't fetch.
    const [, b, c] = packetize(bigSection(400));
    const r = extractSections(seg(b, c), SCTE_PID);
    assert.equal(r.sections.length, 0);
  });

  test("pointer_field: the end of one section and the start of the next share a packet", () => {
    // Section 1 runs into the second packet; that packet's pointer_field
    // says how many leading bytes finish it before section 2 begins.
    const s1 = bigSection(200, 0x11);
    const s2 = cue;
    const firstChunk = Buffer.concat([Buffer.from([0x00]), s1.subarray(0, 183)]);
    const tail = s1.subarray(183);
    const second = Buffer.concat([Buffer.from([tail.length]), tail, s2]);
    const r = extractSections(
      seg(packet({ pusi: true, cc: 0, payload: firstChunk }), packet({ pusi: true, cc: 1, payload: second })),
      SCTE_PID
    );
    assert.deepEqual(r.sections.map((s) => s.hex), [s1.toString("hex"), s2.toString("hex")]);
    assert.equal(r.incomplete, 0);
  });

  test("two complete sections packed into one packet are both read", () => {
    const two = Buffer.concat([Buffer.from([0x00]), cue, cue]);
    const r = extractSections(seg(packet({ pusi: true, payload: two })), SCTE_PID);
    assert.equal(r.sections.length, 2);
  });
});

describe("extractSections — CRC", () => {
  test("a bad CRC is flagged, NOT dropped", () => {
    // The captured payload fails CRC as it arrived. If that's what a real
    // packager emits, discarding on CRC would make this tool blind to
    // every cue that packager sends — the opposite of useful. Report it,
    // keep it.
    const r = extractSections(seg(...packetize(capturedRaw)), SCTE_PID);
    assert.equal(r.sections.length, 1);
    assert.equal(r.sections[0].crcOk, false);
    assert.equal(r.crcErrors, 1);
    assert.equal(decodeHex(r.sections[0].hex).splice_event_id, "0x4800008F");
  });
});

describe("analyzeTsSegment — in-band SCTE-35", () => {
  test("no 0x86 stream in the PMT: scte35 is null", () => {
    assert.equal(analyzeTsSegment(fx("ts-seg-a.ts")).scte35, null);
  });

  test("0x86 declared but silent: an empty list, which is a different answer", () => {
    // "This stream can carry cues and there were none here" is not the
    // same finding as "this stream can't carry cues at all".
    const r = analyzeTsSegment(base);
    assert.deepEqual(r.scte35, { pids: [SCTE_PID], sections: [], incomplete: 0, crcErrors: 0 });
  });

  test("finds the cue on the PID the PMT declared", () => {
    const r = analyzeTsSegment(seg(...packetize(cue)));
    assert.equal(r.scte35.sections.length, 1);
    assert.equal(decodeHex(r.scte35.sections[0].hex).splice_command, "splice_insert");
  });

  test("a cue packet ahead of the PMT is still found", () => {
    const r = analyzeTsSegment(Buffer.concat([...packetize(cue), base]));
    assert.equal(r.scte35.sections.length, 1);
    assert.equal(r.scte35.sections[0].packetIndex, 0);
  });

  test("only splice_info_sections (table_id 0xFC) are reported", () => {
    const other = Buffer.from(cue);
    other[0] = 0xc0;
    const r = analyzeTsSegment(seg(...packetize(withCrc(other.subarray(0, other.length - 4)))));
    assert.equal(r.scte35.sections.length, 0);
  });

  test("survives the JSON trip the server-proxy fallback puts it through", () => {
    const r = JSON.parse(JSON.stringify(analyzeTsSegment(seg(...packetize(cue)))));
    assert.equal(decodeHex(r.scte35.sections[0].hex).splice_event_id, "0x4800008F");
  });
});

describe("groupScte35Sections", () => {
  const withCue = analyzeTsSegment(seg(...packetize(cue)));
  const withCueTwice = analyzeTsSegment(seg(...packetize(cue, 0), ...packetize(cue, 1)));
  const silent = analyzeTsSegment(base);

  test("repeats of one cue collapse into one, with where it was seen", () => {
    // Packagers re-send a cue ahead of the splice point for late joiners;
    // listing each copy would read as a burst of separate breaks.
    const g = groupScte35Sections([withCue, silent, withCueTwice]);
    assert.equal(g.length, 1);
    assert.equal(g[0].occurrences, 3);
    assert.deepEqual(g[0].segments, [0, 2]);
  });

  test("a changed field makes it a different cue", () => {
    const cancelled = Buffer.from(cue.subarray(0, cue.length - 4));
    cancelled[18] |= 0x80; // splice_event_cancel_indicator
    const g = groupScte35Sections([withCue, analyzeTsSegment(seg(...packetize(withCrc(cancelled))))]);
    assert.equal(g.length, 2);
  });

  test("segments without SCTE-35 contribute nothing", () => {
    assert.deepEqual(groupScte35Sections([silent, analyzeTsSegment(fx("ts-seg-a.ts"))]), []);
  });
});
