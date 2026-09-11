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
  return result;
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
