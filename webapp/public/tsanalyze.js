// MPEG-TS packet analysis — PAT/PMT parsing and continuity-counter checks.
//
// Pure and DOM-free (operates on a Uint8Array), same as scte35.js/vast.js,
// so it runs under plain Node for tests. Unlike those, its natural caller
// is the SERVER rather than the browser: a segment is megabytes, and
// shipping that to the client as base64 to analyze it there would move ~8MB
// per check through JSON to produce a few hundred bytes of answer. The
// server fetches, analyzes, and returns the summary.
//
// ---------------------------------------------------------------------
// Transport stream structure, since the field names below are terse:
//
// A transport stream is a flat run of 188-byte packets, each labelled with
// a PID naming which substream it belongs to. Video, audio, and the tables
// describing them are interleaved in that one run.
//
//   byte 0   0x47                     sync byte, always this value
//   byte 1   [TEI][PUSI][pri][PID hi] error flag, payload-start flag, PID 12-8
//   byte 2   [PID lo]                 PID 7-0  (13-bit PID total)
//   byte 3   [scr][AFC][    CC    ]   scrambling, adaptation control, CC 3-0
//
// A receiver joining cold learns the layout through two tables at fixed
// PIDs: the PAT (always PID 0) indexes programmes and names each one's PMT
// PID; the PMT lists the elementary streams and their formats. Both repeat
// every ~100ms so a late joiner isn't left waiting.
// ---------------------------------------------------------------------

export const TS_PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;
export const NULL_PID = 0x1fff;

// stream_type values from ISO 13818-1 and SCTE 35. Only the ones this tool
// is likely to meet — an unknown type is reported by number rather than
// guessed at.
const STREAM_TYPES = {
  0x02: "MPEG-2 video",
  0x03: "MPEG-1 audio",
  0x04: "MPEG-2 audio",
  0x0f: "AAC (ADTS)",
  0x1b: "H.264",
  0x24: "HEVC",
  0x81: "AC-3",
  0x86: "SCTE-35 cue",
  0x87: "E-AC-3",
};

const VIDEO_TYPES = new Set([0x02, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x81, 0x87]);

export function streamTypeName(t) {
  return STREAM_TYPES[t] ?? `unknown (0x${t.toString(16).padStart(2, "0")})`;
}

// Start of a section's payload within a packet: skip the adaptation field
// when present, then the pointer_field that precedes PSI section data.
function sectionStart(b, off, afc, pusi) {
  let p = off + 4;
  if (afc === 2 || afc === 3) p += b[p] + 1;
  if (pusi) p += b[p] + 1;
  return p;
}

// PAT: maps programme numbers to the PID carrying their PMT. Programme 0 is
// the Network Information Table, not a real programme, so it's skipped.
function parsePat(b, p) {
  const sectionLength = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
  const end = p + 3 + sectionLength - 4; // less the trailing CRC32
  const programs = [];
  for (let i = p + 8; i + 3 < end; i += 4) {
    const programNumber = (b[i] << 8) | b[i + 1];
    const pid = ((b[i + 2] & 0x1f) << 8) | b[i + 3];
    if (programNumber !== 0) programs.push({ programNumber, pmtPid: pid });
  }
  return { programs };
}

// PMT: the elementary streams making up one programme, and the PID carrying
// the programme clock reference that keeps them in sync.
function parsePmt(b, p) {
  const sectionLength = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
  const end = p + 3 + sectionLength - 4;
  const pcrPid = ((b[p + 8] & 0x1f) << 8) | b[p + 9];
  const programInfoLength = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
  const streams = [];
  let i = p + 12 + programInfoLength;
  while (i + 4 < end) {
    const streamType = b[i];
    const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
    const esInfoLength = ((b[i + 3] & 0x0f) << 8) | b[i + 4];
    streams.push({ pid, streamType, name: streamTypeName(streamType) });
    i += 5 + esInfoLength;
  }
  return { pcrPid, streams };
}

// Walks one segment and reports its structure plus any integrity problems.
//
// Continuity is scored WITHIN this segment only. Across a segment boundary
// is a separate question with a different answer — see
// compareSegmentBoundary() — and conflating the two is the single easiest
// way to report a defect that isn't there.
export function analyzeTsSegment(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = {
    bytes: b.length,
    packets: 0,
    aligned: b.length % TS_PACKET_SIZE === 0,
    syncLoss: 0,
    transportErrors: 0, // TEI set — the definitive "this packet arrived corrupt" flag
    scrambled: 0,
    discontinuityFlags: 0,
    ccErrorsWithin: 0,
    pat: null,
    pmt: null,
    videoPid: null,
    audioPid: null,
    pids: {},
  };

  const lastCc = new Map();
  let pmtPid = null;

  for (let off = 0; off + TS_PACKET_SIZE <= b.length; off += TS_PACKET_SIZE) {
    result.packets += 1;
    if (b[off] !== SYNC_BYTE) {
      result.syncLoss += 1;
      continue;
    }
    const b1 = b[off + 1];
    const b3 = b[off + 3];
    const pid = ((b1 & 0x1f) << 8) | b[off + 2];
    const pusi = (b1 & 0x40) !== 0;
    const afc = (b3 & 0x30) >> 4;
    const cc = b3 & 0x0f;

    if (b1 & 0x80) result.transportErrors += 1;
    if (b3 & 0xc0) result.scrambled += 1;

    // Null packets are pure padding for constant-rate links; their CC
    // carries no meaning, and counting it produces thousands of phantom
    // errors on any stream that uses them.
    if (pid === NULL_PID) continue;

    const entry = (result.pids[pid] ??= { pid, packets: 0, firstCc: cc, lastCc: cc, ccErrors: 0 });
    entry.packets += 1;
    entry.lastCc = cc;

    // An adaptation field can flag a deliberate timeline break, in which
    // case a CC jump is legitimate rather than a fault.
    let discontinuity = false;
    if ((afc === 2 || afc === 3) && b[off + 4] > 0) {
      discontinuity = (b[off + 5] & 0x80) !== 0;
      if (discontinuity) result.discontinuityFlags += 1;
    }

    // CC increments only on packets carrying payload; an adaptation-only
    // packet repeats the previous value. A single duplicated packet is
    // also legal. Both exceptions have to be honoured or the scan invents
    // errors.
    const hasPayload = afc === 1 || afc === 3;
    const prev = lastCc.get(pid);
    if (prev !== undefined && !discontinuity) {
      const expected = hasPayload ? (prev + 1) & 0x0f : prev;
      if (cc !== expected && !(hasPayload && cc === prev)) {
        entry.ccErrors += 1;
        result.ccErrorsWithin += 1;
      }
    }
    lastCc.set(pid, cc);

    if (!pusi) continue;
    if (pid === 0x0000 && !result.pat) {
      result.pat = parsePat(b, sectionStart(b, off, afc, pusi));
      pmtPid = result.pat.programs[0]?.pmtPid ?? null;
    } else if (pmtPid !== null && pid === pmtPid && !result.pmt) {
      result.pmt = parsePmt(b, sectionStart(b, off, afc, pusi));
    }
  }

  if (result.pmt) {
    for (const s of result.pmt.streams) {
      if (result.videoPid === null && VIDEO_TYPES.has(s.streamType)) result.videoPid = s.pid;
      if (result.audioPid === null && AUDIO_TYPES.has(s.streamType)) result.audioPid = s.pid;
      const e = result.pids[s.pid];
      if (e) {
        e.streamType = s.streamType;
        e.name = s.name;
      }
    }
  }

  // In-band SCTE-35: a second pass over just the PIDs the PMT declared as
  // stream_type 0x86. A separate pass rather than folded into the loop
  // above so a cue packet that precedes the PMT in the segment is still
  // read — the PID is only known once the PMT has been seen.
  result.scte35 = null;
  if (result.pmt) {
    const pids = result.pmt.streams.filter((s) => s.streamType === SCTE35_STREAM_TYPE).map((s) => s.pid);
    if (pids.length) {
      result.scte35 = { pids, sections: [], incomplete: 0, crcErrors: 0 };
      for (const pid of pids) {
        const r = extractSections(b, pid);
        result.scte35.sections.push(...r.sections.filter((x) => x.tableId === SCTE35_TABLE_ID));
        result.scte35.incomplete += r.incomplete;
        result.scte35.crcErrors += r.crcErrors;
      }
      result.scte35.sections.sort((x, y) => x.packetIndex - y.packetIndex);
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// PSI section reassembly — what in-band SCTE-35 actually needs.
//
// SCTE-35 in a transport stream is SECTION-carried, like the PAT and PMT,
// not PES-carried like video and audio. That is why this is ~a page of code
// rather than a demuxer: no PES headers, no PTS reassembly, just
//
//   pointer_field (PUSI packets only) — bytes until the next section starts;
//                                       anything before that point is the
//                                       TAIL of the previous section
//   table_id                          — 0xFC for splice_info_section
//   section_length (12 bits)          — bytes remaining after this field
//   ... section body ..., CRC_32
//
// A splice_info_section is nearly always under 184 bytes and so sits whole
// inside one packet, but nothing in the standard guarantees that, and a
// section that spans packets is reassembled here rather than silently lost.
// ---------------------------------------------------------------------

export const SCTE35_STREAM_TYPE = 0x86;
export const SCTE35_TABLE_ID = 0xfc;

// CRC-32/MPEG-2: polynomial 0x04C11DB7, init 0xFFFFFFFF, no reflection, no
// final XOR. Run over a whole section INCLUDING its trailing CRC the result
// is 0, which is the check. Table built lazily — the analyzer is often
// used without ever meeting a section.
let crcTable = null;
export function crc32Mpeg2(b, start = 0, end = b.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

function toHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Reassembles every complete PSI section carried on one PID.
//
// Returns sections as HEX rather than byte arrays on purpose: this module
// also runs server-side behind /api/segment-scan, and its result crosses
// the wire as JSON, where a Uint8Array serializes as {"0":252,"1":48,...}.
// Hex survives the trip and scte35.js's bytesFromHex() reads it back.
//
// `packetIndex` is the packet the section STARTED in — the order of cues
// within a segment, and a stable key for telling repeats apart.
//
// A section is abandoned rather than stitched across a continuity break:
// bytes from either side of lost packets would join into something that
// parses but isn't what was sent. `incomplete` counts those, plus any
// section still open when the segment ends (one split across a segment
// boundary — legal, rare, and unrecoverable from a single segment).
export function extractSections(bytes, pid) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sections = [];
  let incomplete = 0;
  let crcErrors = 0;
  let pending = null; // { bytes: number[], packetIndex }
  let lastCc = null;

  // Emits every complete section at the head of `pending`; leaves a
  // partial one in place. 0xFF where a table_id should be is stuffing —
  // the rest of the packet is padding, not another section.
  const drain = () => {
    while (pending && pending.bytes.length >= 3) {
      const pb = pending.bytes;
      if (pb[0] === 0xff) {
        pending = null;
        return;
      }
      const total = 3 + (((pb[1] & 0x0f) << 8) | pb[2]);
      if (pb.length < total) return;
      const sec = Uint8Array.from(pb.slice(0, total));
      // Sections without section_syntax_indicator may omit the CRC, but
      // splice_info_section always carries one, as do PAT and PMT.
      const crcOk = total >= 7 ? crc32Mpeg2(sec, 0, total) === 0 : false;
      if (!crcOk) crcErrors += 1;
      sections.push({ tableId: sec[0], packetIndex: pending.packetIndex, length: total, crcOk, hex: toHex(sec) });
      const rest = pb.slice(total);
      pending = rest.length ? { bytes: rest, packetIndex: pending.packetIndex } : null;
    }
  };

  for (let off = 0, idx = 0; off + TS_PACKET_SIZE <= b.length; off += TS_PACKET_SIZE, idx++) {
    if (b[off] !== SYNC_BYTE) continue;
    if ((((b[off + 1] & 0x1f) << 8) | b[off + 2]) !== pid) continue;
    const pusi = (b[off + 1] & 0x40) !== 0;
    const afc = (b[off + 3] & 0x30) >> 4;
    const cc = b[off + 3] & 0x0f;
    if (afc === 0 || afc === 2) continue; // no payload; CC doesn't advance either

    // Same rules as the integrity scan: a repeated CC is a legal duplicate
    // packet (drop it — its bytes are already in `pending`), anything else
    // out of order means packets went missing.
    if (lastCc !== null) {
      if (cc === lastCc) continue;
      if (cc !== ((lastCc + 1) & 0x0f) && pending) {
        incomplete += 1;
        pending = null;
      }
    }
    lastCc = cc;

    let p = off + 4;
    if (afc === 3) p += b[p] + 1;
    const end = off + TS_PACKET_SIZE;
    if (p >= end) continue;

    if (pusi) {
      const pointer = b[p];
      const tailEnd = Math.min(p + 1 + pointer, end);
      if (pending) {
        for (let i = p + 1; i < tailEnd; i++) pending.bytes.push(b[i]);
        drain();
        // Whatever the pointer_field skipped should have finished the old
        // section exactly. If it's still open, its length lied.
        if (pending) {
          incomplete += 1;
          pending = null;
        }
      }
      pending = { bytes: Array.from(b.subarray(tailEnd, end)), packetIndex: idx };
    } else if (pending) {
      for (let i = p; i < end; i++) pending.bytes.push(b[i]);
    }
    // A non-PUSI packet with nothing pending is the middle of a section
    // that began before this segment did — nothing to attach it to.
    drain();
  }
  if (pending) incomplete += 1;
  return { sections, incomplete, crcErrors };
}

// Collapses the sections from a multi-segment scan into distinct cues.
//
// Packagers repeat a splice_info_section several times ahead of the splice
// point so a player joining late still sees it, which means the same cue
// appears in consecutive segments and often several times in one. Listing
// every copy would read as a burst of separate breaks. Identical bytes are
// one cue; `occurrences` and `segments` say where it was seen.
//
// Keyed on the full section, so a cue re-sent with a changed field (a
// splice_insert later cancelled, a pts_adjustment that moved) is correctly
// reported as distinct.
export function groupScte35Sections(scans) {
  const byHex = new Map();
  scans.forEach((scan, segIdx) => {
    for (const s of scan?.scte35?.sections ?? []) {
      let g = byHex.get(s.hex);
      if (!g) {
        g = { hex: s.hex, crcOk: s.crcOk, occurrences: 0, segments: [] };
        byHex.set(s.hex, g);
      }
      g.occurrences += 1;
      if (!g.segments.includes(segIdx)) g.segments.push(segIdx);
    }
  });
  return [...byHex.values()];
}

// Compares the continuity counters of two CONSECUTIVE segments.
//
// This is the check that matters for HLS and the one a single-segment scan
// cannot answer. Within a segment the numbering is unbroken by
// construction; the interesting question is whether the packager carries
// the counter across the join or restarts it.
//
// Per PID: "continuous" when the second segment picks up where the first
// left off, "reset" when it restarts at 0, "jump" for anything else (the
// shape real packet loss would take), and "absent" when the PID isn't in
// both.
//
// Note a reset is INDISTINGUISHABLE from continuous when the previous
// segment happens to end at 15, since the next expected value is then 0 —
// a 1-in-16 coincidence. `coincidental` marks those so a caller doesn't
// report a clean boundary that only looks clean.
export function compareSegmentBoundary(prev, curr) {
  const pids = new Set([...Object.keys(prev.pids), ...Object.keys(curr.pids)].map(Number));
  const rows = [];
  for (const pid of [...pids].sort((a, b) => a - b)) {
    const a = prev.pids[pid];
    const b = curr.pids[pid];
    if (!a || !b) {
      rows.push({ pid, state: "absent", name: (a ?? b)?.name });
      continue;
    }
    const expected = (a.lastCc + 1) & 0x0f;
    let state;
    if (b.firstCc === expected) state = "continuous";
    else if (b.firstCc === 0) state = "reset";
    else state = "jump";
    rows.push({
      pid,
      name: b.name ?? a.name,
      lastCc: a.lastCc,
      expected,
      firstCc: b.firstCc,
      state,
      coincidental: state === "continuous" && expected === 0,
      packets: b.packets,
    });
  }
  return rows;
}

// Rolls a set of per-boundary comparisons into one verdict.
//
// "reset" is deliberately NOT folded in with "jump": a reset is packager
// configuration and harmless to HLS players that decode each segment
// independently, while a jump has the shape of genuine loss. Reporting
// them as one number would tell an operator to go hunting for an encoder
// fault that doesn't exist — the exact misdiagnosis this whole feature
// exists to prevent.
export function summarizeBoundaries(boundaries) {
  let reset = 0;
  let jump = 0;
  let continuous = 0;
  let coincidental = 0;
  for (const rows of boundaries) {
    for (const r of rows) {
      if (r.state === "reset") reset += 1;
      else if (r.state === "jump") jump += 1;
      else if (r.state === "continuous") {
        continuous += 1;
        if (r.coincidental) coincidental += 1;
      }
    }
  }
  return { reset, jump, continuous, coincidental, boundaries: boundaries.length };
}
