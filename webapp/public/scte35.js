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

// PTS is a 33-bit counter (90kHz ticks) that wraps at 2^33.
const PTS_MODULO = 0x200000000;

// pts_adjustment (bytes 4-8) must be added to every absolute splice_time PTS
// in the message per spec — it's how a splicer/transcoder that re-stamps
// timing keeps downstream PTS values correct. It does NOT apply to
// break_duration, which is a relative span, not an absolute time.
function applyPtsAdjustment(rawPts, adjustmentTicks) {
  return (rawPts + adjustmentTicks) % PTS_MODULO;
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
    const ptsAdjustment = (bytes[4] & 0x01) * 0x100000000 + dv.getUint32(5);
    if (ptsAdjustment !== 0) {
      info.pts_adjustment_s = `${(ptsAdjustment / 90000).toFixed(3)}s`;
    }
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
            const pts = applyPtsAdjustment(hi * 0x100000000 + lo, ptsAdjustment);
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
        const pts = applyPtsAdjustment(hi * 0x100000000 + lo, ptsAdjustment);
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

  if (info.pts_adjustment_s) {
    lines.push(`${prefix}  pts_adjustment: ${escapeHtml(info.pts_adjustment_s)} (already applied to pts/time above)`);
  }

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

// Returns [{bandwidth, url, resolution, codecs}], ascending by bandwidth.
// resolution is {width, height} or null when the variant doesn't declare one.
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = lines[i];
      const m = /BANDWIDTH=(\d+)/.exec(attrs);
      const bandwidth = m ? parseInt(m[1], 10) : 0;
      const resMatch = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
      const resolution = resMatch
        ? { width: parseInt(resMatch[1], 10), height: parseInt(resMatch[2], 10) }
        : null;
      const codecsMatch = /CODECS="([^"]*)"/.exec(attrs);
      const codecs = codecsMatch ? codecsMatch[1] : null;
      if (i + 1 < lines.length && !lines[i + 1].startsWith("#")) {
        const uri = lines[i + 1].trim();
        variants.push({ bandwidth, url: new URL(uri, baseUrl).toString(), resolution, codecs });
      }
    }
  }
  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  return variants;
}

// Flags variant ladders where resolution doesn't increase monotonically
// with bandwidth — a real authoring bug (e.g. a nominally "1080p" rendition
// encoded at a lower bitrate than a "720p" one below it), not a transient
// condition. Only variants with a RESOLUTION attribute are considered;
// audio-only or unlabeled variants are skipped rather than treated as 0x0.
// This checks the ladder as declared in one master fetch — it does NOT
// detect a ladder changing mid-session, since the master isn't re-polled
// after the initial fetch (see ROADMAP.md).
export function findVariantLadderAnomalies(variants) {
  const withRes = variants.filter((v) => v.resolution).sort((a, b) => a.bandwidth - b.bandwidth);
  const anomalies = [];
  for (let i = 1; i < withRes.length; i++) {
    const prev = withRes[i - 1];
    const curr = withRes[i];
    const prevPixels = prev.resolution.width * prev.resolution.height;
    const currPixels = curr.resolution.width * curr.resolution.height;
    if (currPixels < prevPixels) {
      anomalies.push({
        lower: prev,
        higher: curr,
        note: `${curr.resolution.width}x${curr.resolution.height} at ${curr.bandwidth}bps is a lower resolution than ${prev.resolution.width}x${prev.resolution.height} at ${prev.bandwidth}bps despite higher bandwidth`,
      });
    }
  }
  return anomalies;
}

export function extractMediaSequence(text) {
  const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

function countSegments(text) {
  return (text.match(/^#EXTINF:/gm) || []).length;
}

export function extractTargetDuration(text) {
  const m = /#EXT-X-TARGETDURATION:(\d+)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

// Compares two consecutive fetches of the same live HLS media playlist.
// Per the HLS spec, EXT-X-MEDIA-SEQUENCE should advance by exactly the
// number of segments that fell off the front of the list since the last
// fetch — if it advanced by MORE than the segment count we actually saw,
// the server skipped segments this poller never had a chance to see.
// Returns null when there's nothing to report (no gap, or either fetch is
// missing a sequence number to compare).
export function detectSequenceGap(prevText, currText) {
  const prevSeq = extractMediaSequence(prevText);
  const currSeq = extractMediaSequence(currText);
  if (prevSeq === null || currSeq === null) return null;
  const prevSegCount = countSegments(prevText);
  const advanced = currSeq - prevSeq;
  if (advanced > prevSegCount) {
    return { prevSeq, currSeq, advanced, prevSegCount, missing: advanced - prevSegCount };
  }
  return null;
}

// Returns the segment URI immediately following each #EXT-X-DISCONTINUITY
// tag (or null if it's the last line), for display context.
export function findDiscontinuities(text) {
  const lines = text.split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-DISCONTINUITY")) {
      let nextSegment = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("#")) {
          nextSegment = lines[j].trim();
          break;
        }
      }
      results.push({ beforeSegment: nextSegment });
    }
  }
  return results;
}

// A live playlist that hasn't advanced (same MEDIA-SEQUENCE) for longer
// than a few target durations is stale — the origin has likely stalled.
// staleMs uses 3x target duration, a common tolerance in HLS monitoring
// tools to absorb normal poll/CDN jitter without false-flagging every poll
// that happens to land between segment boundaries.
export function isPlaylistStale(nowMs, lastChangeAtMs, targetDurationSeconds) {
  if (lastChangeAtMs === null || !targetDurationSeconds) return false;
  return nowMs - lastChangeAtMs > targetDurationSeconds * 3 * 1000;
}

// Finds SCTE-35 signals carried out-of-band in a DASH MPD via
// <EventStream schemeIdUri="...scte35..."><Event .../></EventStream>. Two
// encodings show up in the wild:
//   - urn:scte:scte35:2014:xml+bin — <Event> contains <Signal><Binary>
//     BASE64</Binary></Signal>: the same splice_info_section bytes as
//     out-of-band HLS, decodable by the existing decodeScte35() unchanged.
//   - urn:scte:scte35:2013:xml — <Event> contains fully XML-encoded splice
//     info (no base64 blob). NOT decoded here — flagged as xmlOnly instead
//     of silently skipped, since pretending it doesn't exist is worse than
//     an honest "not supported yet" (see ROADMAP.md).
// Detection of the EventStream itself is lenient (any schemeIdUri
// containing "scte35", case-insensitive) since real-world packagers vary;
// only the *encoding* inside an Event needs to match a known shape to
// actually decode.
//
// This is regex-based, not a real XML parser, matching how the HLS side of
// this file already works (line/pattern scanning, not a full playlist
// parser) — and it keeps this module DOM-free, so it still runs under
// plain Node for testing.
export function findDashScte35Events(mpdText) {
  const events = [];
  const streamRe = /<EventStream\b([^>]*)>([\s\S]*?)<\/EventStream>/gi;
  let streamMatch;
  while ((streamMatch = streamRe.exec(mpdText))) {
    const [, streamAttrs, streamBody] = streamMatch;
    const schemeMatch = /schemeIdUri\s*=\s*"([^"]*)"/i.exec(streamAttrs);
    const schemeIdUri = schemeMatch ? schemeMatch[1] : "";
    if (!/scte35/i.test(schemeIdUri)) continue;

    const timescaleMatch = /\btimescale\s*=\s*"(\d+)"/i.exec(streamAttrs);
    const timescale = timescaleMatch ? parseInt(timescaleMatch[1], 10) : 1;

    const eventRe = /<Event\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Event>)/gi;
    let eventMatch;
    while ((eventMatch = eventRe.exec(streamBody))) {
      const [, eventAttrs, eventBody] = eventMatch;
      const attr = (name) => {
        const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(eventAttrs);
        return m ? m[1] : null;
      };
      const presentationTimeRaw = attr("presentationTime");
      const durationRaw = attr("duration");

      const binaryMatch = eventBody
        ? /<(?:\w+:)?Binary\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Binary>/i.exec(eventBody)
        : null;

      events.push({
        schemeIdUri,
        id: attr("id"),
        presentationTimeS: presentationTimeRaw !== null ? parseFloat(presentationTimeRaw) / timescale : null,
        durationS: durationRaw !== null ? parseFloat(durationRaw) / timescale : null,
        base64: binaryMatch ? binaryMatch[1].replace(/\s+/g, "") : null,
        xmlOnly: !binaryMatch && !!eventBody && eventBody.trim().length > 0,
      });
    }
  }
  return events;
}

// Maps each cue-marker line in an HLS playlist to a real wall-clock time,
// for one line at a time. A SCTE-35 cue's own pts_time_s is a 90kHz counter
// with an arbitrary origin — not convertible to wall-clock without an
// anchor, and the manifest never gives us a PTS-to-wallclock anchor
// directly. What it DOES give us:
//   - #EXT-X-DATERANGE's START-DATE attribute — an explicit wall-clock
//     time for that cue, authoritative when present.
//   - #EXT-X-PROGRAM-DATE-TIME, which timestamps a segment's start; summing
//     #EXTINF durations from there to a cue's position interpolates that
//     cue's wall-clock time.
// Returns [{line, wallclockIso, source}] for every cue-marker line found,
// in document order — source is "daterange" (authoritative) or "timeline"
// (interpolated), or wallclockIso is null if neither is available (e.g. no
// PROGRAM-DATE-TIME anywhere earlier in this playlist).
export function findCueWallclocks(text) {
  const lines = text.split(/\r?\n/);
  const results = [];
  let anchorMs = null;
  let elapsedSinceAnchor = 0;

  for (const line of lines) {
    const pdtMatch = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(line);
    if (pdtMatch) {
      const t = Date.parse(pdtMatch[1].trim());
      if (!Number.isNaN(t)) {
        anchorMs = t;
        elapsedSinceAnchor = 0;
      }
      continue;
    }
    const extinfMatch = /^#EXTINF:([\d.]+)/.exec(line);
    if (extinfMatch) {
      elapsedSinceAnchor += parseFloat(extinfMatch[1]);
      continue;
    }
    if (CUE_PATTERN.test(line)) {
      let wallclockMs = null;
      let source = null;
      const startDateMatch = /START-DATE="([^"]+)"/.exec(line);
      if (startDateMatch) {
        const t = Date.parse(startDateMatch[1]);
        if (!Number.isNaN(t)) {
          wallclockMs = t;
          source = "daterange";
        }
      }
      if (wallclockMs === null && anchorMs !== null) {
        wallclockMs = anchorMs + elapsedSinceAnchor * 1000;
        source = "timeline";
      }
      results.push({
        line,
        wallclockIso: wallclockMs !== null ? new Date(wallclockMs).toISOString() : null,
        source,
      });
    }
  }
  return results;
}

// DRM system IDs are shared between HLS's KEYFORMAT attribute and DASH's
// ContentProtection schemeIdUri — same "Common Encryption" UUID registry
// either way, plus Apple's own non-UUID scheme for FairPlay. Keys are
// lowercase; lookups below normalize to match.
export const DRM_SYSTEM = {
  identity: "Clear / AES-128 (no DRM)",
  "com.apple.streamingkeydelivery": "FairPlay",
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "Widevine",
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95": "PlayReady",
  "urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "ClearKey (W3C Common Encryption)",
};

function lookupDrmSystem(schemeOrKeyformat) {
  return DRM_SYSTEM[(schemeOrKeyformat || "").toLowerCase()] ?? schemeOrKeyformat;
}

// Parses #EXT-X-KEY / #EXT-X-SESSION-KEY — HLS's encryption/DRM signaling.
// Detection only: METHOD, KEYFORMAT (mapped to a friendly DRM system name),
// URI, IV. Never fetches the key or attempts decryption — see ROADMAP.md
// for why that's only even theoretically possible for plain AES-128.
export function findHlsKeys(text) {
  const lines = text.split(/\r?\n/);
  const keys = [];
  for (const line of lines) {
    const m = /^#EXT-X-(KEY|SESSION-KEY):(.*)$/.exec(line);
    if (!m) continue;
    const [, tagKind, attrs] = m;
    const attr = (name) => {
      const am = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([^,]*))`, "i").exec(attrs);
      return am ? (am[1] ?? am[2] ?? null) : null;
    };
    const method = attr("METHOD");
    if (!method || method === "NONE") continue; // NONE is an explicit "not encrypted" marker
    const keyformat = attr("KEYFORMAT") ?? "identity";
    keys.push({
      tag: `EXT-X-${tagKind}`,
      method,
      keyformat,
      drmSystem: lookupDrmSystem(keyformat),
      uri: attr("URI"),
      iv: attr("IV"),
    });
  }
  return keys;
}

// Parses <ContentProtection> — DASH's encryption/DRM signaling. Appears per
// AdaptationSet; schemeIdUri identifies the DRM system, default_KID (often
// written cenc:default_KID, matched either way) gives the active key id.
export function findDashContentProtection(mpdText) {
  const results = [];
  const cpRe = /<ContentProtection\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ContentProtection>)/gi;
  let m;
  while ((m = cpRe.exec(mpdText))) {
    const [, attrs] = m;
    const attr = (name) => {
      const am = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
      return am ? am[1] : null;
    };
    const schemeIdUri = attr("schemeIdUri");
    if (!schemeIdUri) continue;
    results.push({
      schemeIdUri,
      drmSystem: lookupDrmSystem(schemeIdUri),
      defaultKid: attr("default_KID"),
    });
  }
  return results;
}

// Builds a one-line human summary plus a change-fingerprint from a list of
// {drmSystem, keyid} shaped entries (works for either findHlsKeys' output,
// mapped to {drmSystem, keyid: uri+iv}, or findDashContentProtection's,
// mapped to {drmSystem, keyid: defaultKid}) — the fingerprint is what the
// poll loop compares across fetches to detect key/IV rotation.
export function summarizeDrm(entries) {
  if (!entries.length) {
    return { text: "No encryption signaled (clear)", fingerprint: "" };
  }
  const systems = [...new Set(entries.map((e) => e.drmSystem))];
  const keyids = [...new Set(entries.map((e) => e.keyid).filter(Boolean))];
  const label = systems.length > 1 ? `Multi-DRM: ${systems.join(", ")}` : systems[0];
  const text = keyids.length ? `${label} — key: ${keyids.join(", ")}` : label;
  const fingerprint = JSON.stringify(entries.map((e) => [e.drmSystem, e.keyid]).sort());
  return { text, fingerprint };
}
