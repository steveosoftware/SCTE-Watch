// SCTE-35 splice_info_section decoder + HLS helpers.
//
// Byte layout reference (all offsets 0-indexed, big-endian):
//   0        table_id
//   1-2      section_syntax_indicator/private_indicator/reserved/section_length
//   3        protocol_version
//   4-8      encrypted_packet/encryption_algorithm/pts_adjustment (40 bits)
//   9        cw_index
//   10-12    tier (12 bits) + splice_command_length (12 bits)
//   13       splice_command_type
//   14..     splice command payload, then splice_descriptor loop, then CRC
//
// (splice_command_type sits at byte 13, not 11 — easy to get wrong by eyeballing
// the spec table, and getting it wrong makes every downstream offset garbage.)

import { escapeHtml, glossaryTerm } from "./glossary.js";

export const SEG_TYPE = {
  0x00: "Not Indicated",
  0x01: "Content Identification",
  0x10: "Program Start", 0x11: "Program End",
  0x12: "Program Early Termination", 0x13: "Program Breakaway",
  0x14: "Program Resumption", 0x15: "Program Runover Planned",
  0x16: "Program Runover Unplanned", 0x17: "Program Overlap Start",
  0x18: "Program Blackout Override", 0x19: "Program Start - In Progress",
  0x20: "Chapter Start", 0x21: "Chapter End",
  0x22: "Break Start", 0x23: "Break End",
  0x24: "Opening Credit Start", 0x25: "Opening Credit End",
  0x26: "Closing Credit Start", 0x27: "Closing Credit End",
  0x30: "Provider Advertisement Start", 0x31: "Provider Advertisement End",
  0x32: "Distributor Advertisement Start", 0x33: "Distributor Advertisement End",
  0x34: "Provider Placement Opportunity Start",
  0x35: "Provider Placement Opportunity End",
  0x36: "Distributor Placement Opportunity Start",
  0x37: "Distributor Placement Opportunity End",
  0x38: "Provider Overlay Placement Opportunity Start",
  0x39: "Provider Overlay Placement Opportunity End",
  0x3A: "Distributor Overlay Placement Opportunity Start",
  0x3B: "Distributor Overlay Placement Opportunity End",
  0x3C: "Provider Promo Start", 0x3D: "Provider Promo End",
  0x3E: "Distributor Promo Start", 0x3F: "Distributor Promo End",
  0x40: "Unscheduled Event Start", 0x41: "Unscheduled Event End",
  0x42: "Alternate Content Opportunity Start", 0x43: "Alternate Content Opportunity End",
  0x44: "Provider Ad Block Start", 0x45: "Provider Ad Block End",
  0x46: "Distributor Ad Block Start", 0x47: "Distributor Ad Block End",
  0x50: "Network Start", 0x51: "Network End",
};

export const UPID_TYPE = {
  0x00: "Not Used", 0x01: "User Defined", 0x02: "ISCI", 0x03: "Ad-ID",
  0x04: "UMID", 0x05: "ISAN (deprecated)", 0x06: "ISAN", 0x07: "TID",
  0x08: "TI", 0x09: "ADI", 0x0A: "EIDR", 0x0B: "ATSC Content ID",
  0x0C: "MPU", 0x0D: "MID", 0x0E: "ADS Info", 0x0F: "URI",
  0x10: "UUID", 0x11: "SCR",
};

export const SPLICE_CMD = {
  0x00: "splice_null", 0x04: "splice_schedule",
  0x05: "splice_insert", 0x06: "time_signal",
  0x07: "bandwidth_reservation", 0xFF: "private_command",
};

const CUE_PATTERN = /(EXT-X-CUE-OUT|EXT-X-CUE-IN|EXT-X-CUE-OUT-CONT|EXT-X-CUE|EXT-OATCLS-SCTE35|EXT-X-SCTE35|EXT-X-DATERANGE|EXT-X-ASSET|SCTE35)/i;
export { CUE_PATTERN };

const RE_BARE_B64 = /#EXT-OATCLS-SCTE35:\s*(\/D[A-Za-z0-9+/=]+)/i;
const RE_B64 = /(?:CUE|SCTE35-CMD|SCTE35-OUT|VALUE)\s*=\s*"?(\/D[A-Za-z0-9+/=]+)"?/i;
const RE_HEX = /(?:SCTE35-OUT|SCTE35-CMD|VALUE)\s*=\s*(0x[0-9A-Fa-f]+)/i;

function hex2(n) {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

export function bytesFromBase64(s) {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function bytesFromHex(s) {
  const clean = s.replace(/^0x/i, "").trim();
  if (clean.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(clean)) {
    throw new Error("invalid hex string");
  }
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(clean.substr(i * 2, 2), 16);
  return arr;
}

// Accepts a pasted SCTE-35 payload in base64 (with or without the leading
// "/D") or hex (with or without "0x") and returns raw bytes.
export function parseScteInput(raw) {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) throw new Error("empty input");
  if (/^0x/i.test(s)) return bytesFromHex(s);
  if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 2 === 0 && s.length >= 20) {
    return bytesFromHex(s);
  }
  return bytesFromBase64(s);
}

export function extractPayloadFromTagLine(line) {
  let m = RE_BARE_B64.exec(line);
  if (m) { try { return bytesFromBase64(m[1]); } catch { return null; } }
  m = RE_B64.exec(line);
  if (m) { try { return bytesFromBase64(m[1]); } catch { return null; } }
  m = RE_HEX.exec(line);
  if (m) { try { return bytesFromHex(m[1]); } catch { return null; } }
  return null;
}

function decodeUpid(bytes) {
  if (bytes.length === 0) return "";
  const printable = Array.from(bytes).every((b) => b === 0 || (b >= 0x20 && b <= 0x7e));
  if (printable) {
    return new TextDecoder("utf-8").decode(bytes).replace(/\x00+$/, "");
  }
  return Array.from(bytes).map((b) => hex2(b)).join("");
}

export function decodeScte35(bytes) {
  const info = {};
  if (!bytes || bytes.length < 14) {
    info.error = "too short";
    return info;
  }
  if (bytes[0] !== 0xfc) {
    info.error = `bad table_id 0x${hex2(bytes[0])}`;
    return info;
  }

  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const spliceCmdLen = ((bytes[11] & 0x0f) << 8) | bytes[12];
    const spliceCmdType = bytes[13];
    info.splice_command = SPLICE_CMD[spliceCmdType] ?? `0x${hex2(spliceCmdType)}`;

    const cmdStart = 14;
    let cmdEnd = cmdStart;

    if (spliceCmdType === 0x05 && bytes.length >= cmdStart + 5) {
      const eventId = dv.getUint32(cmdStart);
      const cancel = (bytes[cmdStart + 4] >> 7) & 1;
      info.splice_event_id = `0x${eventId.toString(16).padStart(8, "0").toUpperCase()}`;
      info.splice_cancel = !!cancel;
      let p = cmdStart + 5;
      if (!cancel && bytes.length > p) {
        const flags = bytes[p];
        const outOfNetwork = (flags >> 7) & 1;
        const programSplice = (flags >> 6) & 1;
        const durationFlag = (flags >> 5) & 1;
        const spliceImmediate = (flags >> 4) & 1;
        info.out_of_network = !!outOfNetwork;
        p += 1;
        if (programSplice && !spliceImmediate) {
          const timeSpecified = (bytes[p] >> 7) & 1;
          if (timeSpecified) {
            const hi = bytes[p] & 0x01;
            const lo = dv.getUint32(p + 1);
            const pts = hi * 0x100000000 + lo;
            info.pts_time_s = `${(pts / 90000).toFixed(3)}s`;
            p += 5;
          } else {
            p += 1;
          }
        } else if (!programSplice) {
          const componentCount = bytes[p];
          p += 1;
          for (let c = 0; c < componentCount; c++) {
            p += 1; // component_tag
            if (!spliceImmediate) {
              const timeSpecified = (bytes[p] >> 7) & 1;
              p += timeSpecified ? 5 : 1;
            }
          }
        }
        if (durationFlag && bytes.length >= p + 5) {
          const hi = bytes[p] & 0x01;
          const lo = dv.getUint32(p + 1);
          const ticks = hi * 0x100000000 + lo;
          info.break_duration_s = `${(ticks / 90000).toFixed(3)}s`;
          p += 5;
        }
        p += 2 + 1 + 1; // unique_program_id, avail_num, avails_expected
      }
      cmdEnd = p;
    } else if (spliceCmdType === 0x06 && bytes.length >= cmdStart + 1) {
      const timeSpecified = (bytes[cmdStart] >> 7) & 1;
      let p = cmdStart;
      if (timeSpecified && bytes.length >= cmdStart + 5) {
        const hi = bytes[cmdStart] & 0x01;
        const lo = dv.getUint32(cmdStart + 1);
        const pts = hi * 0x100000000 + lo;
        info.pts_time_s = `${(pts / 90000).toFixed(3)}s`;
        p += 5;
      } else {
        p += 1;
      }
      cmdEnd = p;
    }

    // Prefer the explicit splice_command_length to find the descriptor loop;
    // it's authoritative and sidesteps having to walk every command variant
    // by hand. 0xFFF is a legacy "length not given" sentinel — fall back to
    // however far we actually parsed in that rare case.
    const descOffset = spliceCmdLen !== 0xfff ? cmdStart + spliceCmdLen : cmdEnd;

    const descriptors = [];
    if (descOffset + 2 <= bytes.length) {
      const descLoopLen = dv.getUint16(descOffset);
      let pos = descOffset + 2;
      const end = Math.min(pos + descLoopLen, bytes.length);
      while (pos + 2 <= end) {
        const tag = bytes[pos];
        const dlen = bytes[pos + 1];
        const dend = pos + 2 + dlen;
        if (dend > bytes.length) break;
        const d = bytes.subarray(pos + 2, dend);

        if (tag === 0x02 && d.length >= 13) {
          const seg = {};
          const ddv = new DataView(d.buffer, d.byteOffset, d.byteLength);
          const segEventId = ddv.getUint32(4);
          const cancel = (d[8] >> 7) & 1;
          seg.segmentation_event_id = `0x${segEventId.toString(16).padStart(8, "0").toUpperCase()}`;
          if (!cancel && d.length > 9) {
            const flags2 = d[9];
            const programSegFlag = (flags2 >> 7) & 1;
            const durationFlag = (flags2 >> 6) & 1;
            let q = 10;
            if (!programSegFlag && q < d.length) {
              const componentCount = d[q];
              q += 1 + componentCount * 6; // component_tag(1)+reserved(7b)+pts_offset(33b)
            }
            if (durationFlag) q += 5; // segmentation_duration (40 bits)
            if (q + 2 <= d.length) {
              const upidType = d[q];
              const upidLen = d[q + 1];
              const upidBytes = d.subarray(q + 2, q + 2 + upidLen);
              const stOffset = q + 2 + upidLen;
              const segTypeId = stOffset < d.length ? d[stOffset] : 0;
              seg.segmentation_type_id = `0x${hex2(segTypeId)}`;
              seg.segmentation_type_name = SEG_TYPE[segTypeId] ?? "Unknown";
              seg.upid_type = UPID_TYPE[upidType] ?? `0x${hex2(upidType)}`;
              seg.upid = decodeUpid(upidBytes);
            }
          }
          descriptors.push(seg);
        }
        pos = dend;
      }
    }
    if (descriptors.length) info.descriptors = descriptors;
  } catch (e) {
    info.decode_error = String(e.message || e);
  }

  return info;
}

export function formatDecoded(info, prefix = "    ") {
  const lines = [];
  const cmd = info.splice_command ?? "?";
  let line = `${prefix}command      : ${glossaryTerm(cmd)}`;
  if (cmd === "splice_insert") {
    line += `  [event=${escapeHtml(info.splice_event_id ?? "?")}  out_of_network=${escapeHtml(String(info.out_of_network ?? "?"))}  duration=${escapeHtml(info.break_duration_s ?? "n/a")}]`;
  } else if (cmd === "time_signal") {
    line += `  [pts=${escapeHtml(info.pts_time_s ?? "?")}]`;
  }
  lines.push(line);

  const err = info.error ?? info.decode_error;
  if (err) lines.push(`${prefix}  decode err : ${escapeHtml(err)}`);

  (info.descriptors ?? []).forEach((seg, i) => {
    lines.push(`${prefix}  segmentation_descriptor[${i + 1}]:`);
    lines.push(`${prefix}    type         : ${glossaryTerm(seg.segmentation_type_name ?? "?")} (${escapeHtml(seg.segmentation_type_id ?? "?")})`);
    if (seg.segmentation_event_id) lines.push(`${prefix}    event_id     : ${escapeHtml(seg.segmentation_event_id)}`);
    if (seg.upid_type || seg.upid) {
      lines.push(`${prefix}    upid_type    : ${glossaryTerm(seg.upid_type ?? "?")}`);
      lines.push(`${prefix}    upid         : ${escapeHtml(seg.upid ?? "?")}`);
    }
    const typeIdInt = seg.segmentation_type_id ? parseInt(seg.segmentation_type_id, 16) : 0;
    if (typeIdInt === 0x30 || typeIdInt === 0x34) {
      lines.push(`${prefix}    *** MediaTailor CAN trigger on this signal ***`);
      lines.push(`${prefix}    *** Pass upid to ADS via [scte35.segmentationUpid] ***`);
    }
  });

  return lines;
}

// Returns [{bandwidth, url}], ascending by bandwidth.
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const m = /BANDWIDTH=(\d+)/.exec(lines[i]);
      const bandwidth = m ? parseInt(m[1], 10) : 0;
      if (i + 1 < lines.length && !lines[i + 1].startsWith("#")) {
        const uri = lines[i + 1].trim();
        variants.push({ bandwidth, url: new URL(uri, baseUrl).toString() });
      }
    }
  }
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  return variants;
}
