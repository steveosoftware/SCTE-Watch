#!/usr/bin/env python3
"""
scte35watch.py - Poll an HLS master playlist and report any SCTE-35 / cue-in / cue-out markers.
                 Decodes SCTE-35 payloads to show splice command type, segmentation descriptor
                 type/id, and UPID — including "Provider Advertisement Start" signals.

Usage:
    python3 scte35watch.py <master_playlist_url> [poll_interval_seconds]

Output is written to both stdout and scte35_watch.log in the current directory.
Press Ctrl+C to stop.

Dependencies (optional but recommended for full decode):
    pip install threefive
"""

import sys
import re
import time
import base64
import struct
import subprocess
from datetime import datetime, timezone
from urllib.parse import urljoin

try:
    import threefive as _tf
    _HAS_THREEFIVE = True
except ImportError:
    _HAS_THREEFIVE = False

UA = "Mozilla/5.0"

CUE_PATTERN = re.compile(
    r"(EXT-X-CUE-OUT|EXT-X-CUE-IN|EXT-X-CUE-OUT-CONT|EXT-X-CUE|"
    r"EXT-OATCLS-SCTE35|EXT-X-SCTE35|EXT-X-DATERANGE|EXT-X-ASSET|SCTE35)",
    re.IGNORECASE,
)

# ── Segmentation type names (SCTE-35 Table 23) ────────────────────────────────
SEG_TYPE = {
    0x00: "Not Indicated",
    0x10: "Content Identification",
    0x20: "Program Start",          0x21: "Program End",
    0x22: "Program Early Termination", 0x23: "Program Breakaway",
    0x24: "Program Resumption",     0x25: "Program Runover Planned",
    0x26: "Program Runover Unplanned", 0x27: "Program Overlap Start",
    0x28: "Program Blackout Override", 0x29: "Program Join",
    0x30: "Provider Advertisement Start",   0x31: "Provider Advertisement End",
    0x32: "Distributor Advertisement Start",0x33: "Distributor Advertisement End",
    0x34: "Provider Placement Opportunity Start",
    0x35: "Provider Placement Opportunity End",
    0x36: "Distributor Placement Opportunity Start",
    0x37: "Distributor Placement Opportunity End",
    0x38: "Provider Overlay Placement Opportunity Start",
    0x39: "Provider Overlay Placement Opportunity End",
    0x3A: "Distributor Overlay Placement Opportunity Start",
    0x3B: "Distributor Overlay Placement Opportunity End",
    0x40: "Unscheduled Event Start", 0x41: "Unscheduled Event End",
    0x50: "Network Start",           0x51: "Network End",
}

UPID_TYPE = {
    0x00: "Not Used", 0x01: "User Defined", 0x02: "ISCI", 0x03: "Ad-ID",
    0x04: "UMID", 0x05: "ISAN", 0x06: "TID", 0x07: "TI",
    0x08: "ADI", 0x09: "EIDR", 0x0A: "ATSC Content ID",
    0x0B: "MPU", 0x0C: "MID", 0x0D: "ADS Info", 0x0E: "URI", 0x0F: "UUID",
}

SPLICE_CMD = {0x00: "splice_null", 0x04: "splice_schedule",
              0x05: "splice_insert", 0x06: "time_signal",
              0x07: "bandwidth_reservation", 0xFF: "private_command"}


_B64_RE  = re.compile(r'(?:CUE|SCTE35-CMD|SCTE35-OUT|VALUE)\s*=\s*"?(/D[A-Za-z0-9+/=]+)"?', re.IGNORECASE)
_HEX_RE  = re.compile(r'(?:SCTE35-OUT|SCTE35-CMD|VALUE)\s*=\s*(0x[0-9A-Fa-f]+)', re.IGNORECASE)
_BARE_B64 = re.compile(r'#EXT-OATCLS-SCTE35:\s*(/D[A-Za-z0-9+/=]+)', re.IGNORECASE)


def _extract_payload(tag_line: str) -> bytes | None:
    """Return raw SCTE-35 bytes from an HLS tag line, or None if not found."""
    m = _BARE_B64.search(tag_line)
    if m:
        try:
            return base64.b64decode(m.group(1))
        except Exception:
            return None
    m = _B64_RE.search(tag_line)
    if m:
        try:
            return base64.b64decode(m.group(1))
        except Exception:
            return None
    m = _HEX_RE.search(tag_line)
    if m:
        try:
            return bytes.fromhex(m.group(1)[2:])
        except Exception:
            return None
    return None


def _decode_minimal(raw: bytes) -> dict:
    """
    Decode the bare minimum of an SCTE-35 splice_info_section to surface:
      splice_command_type, splice_insert fields (if any), and
      segmentation_descriptor fields including UPID (if any).
    Returns a dict of human-readable strings.
    """
    info = {}
    if len(raw) < 11:
        info["error"] = "too short"
        return info
    if raw[0] != 0xFC:
        info["error"] = f"bad table_id 0x{raw[0]:02X}"
        return info

    section_length  = ((raw[1] & 0x0F) << 8) | raw[2]
    splice_cmd_len  = ((raw[9] & 0x0F) << 8) | raw[10]  # may be 0xFFF
    splice_cmd_type = raw[11] if len(raw) > 11 else 0xFF
    info["splice_command"] = SPLICE_CMD.get(splice_cmd_type, f"0x{splice_cmd_type:02X}")

    cmd_start = 11
    cmd_end   = cmd_start + 1  # at minimum

    if splice_cmd_type == 0x05 and len(raw) >= cmd_start + 14:
        splice_event_id    = struct.unpack_from(">I", raw, cmd_start + 1)[0]
        cancel_flag        = (raw[cmd_start + 5] >> 7) & 1
        info["splice_event_id"] = f"0x{splice_event_id:08X}"
        info["splice_cancel"]   = bool(cancel_flag)
        if not cancel_flag and len(raw) >= cmd_start + 14:
            flags              = raw[cmd_start + 6]
            out_of_network     = (flags >> 7) & 1
            program_splice     = (flags >> 6) & 1
            duration_flag      = (flags >> 5) & 1
            info["out_of_network"] = bool(out_of_network)
            if duration_flag and len(raw) >= cmd_start + 15:
                # 5 bytes for break_duration: auto_return(1b) + reserved(6b) + 33-bit pts
                bd_bytes = raw[cmd_start + 10: cmd_start + 15]
                pts_ticks = ((bd_bytes[0] & 0x01) << 32) | struct.unpack_from(">I", bd_bytes, 1)[0]
                info["break_duration_s"] = f"{pts_ticks / 90000:.3f}s"

    if splice_cmd_type == 0x06 and len(raw) >= cmd_start + 6:
        time_specified = (raw[cmd_start + 1] >> 7) & 1
        if time_specified and len(raw) >= cmd_start + 6:
            pts_ticks = ((raw[cmd_start + 1] & 0x01) << 32) | struct.unpack_from(">I", raw, cmd_start + 2)[0]
            info["pts_time_s"] = f"{pts_ticks / 90000:.3f}s"

    # Skip to after command: splice_info header(11 B) + cmd(splice_cmd_len B, may be 0xFFF)
    # Use section_length to bound: section bytes = raw[3 .. 3+section_length-4 (CRC)]
    descriptors = []
    if splice_cmd_len == 0xFFF:
        # length unknown — walk from known offsets using section_length
        desc_offset = 3 + section_length - 4  # rough bound; walk back
        # safer: skip cmd type (1) + try fixed cmd widths
        cmd_sizes = {0x05: 14, 0x06: 5}
        desc_offset = cmd_start + 1 + cmd_sizes.get(splice_cmd_type, 0)
    else:
        desc_offset = cmd_start + 1 + splice_cmd_len

    if desc_offset + 2 < len(raw):
        desc_loop_len = struct.unpack_from(">H", raw, desc_offset)[0]
        pos = desc_offset + 2
        end = pos + desc_loop_len
        while pos + 2 < end and pos + 2 < len(raw):
            tag      = raw[pos]
            dlength  = raw[pos + 1]
            dend     = pos + 2 + dlength
            if dend > len(raw):
                break
            d_bytes  = raw[pos + 2: dend]

            if tag == 0x02 and len(d_bytes) >= 10:  # segmentation_descriptor
                seg = {}
                # identifier (4 B) + event_id (4 B) + cancel_flag (1 b in next byte)
                seg_event_id = struct.unpack_from(">I", d_bytes, 4)[0]
                cancel        = (d_bytes[8] >> 7) & 1
                seg["segmentation_event_id"] = f"0x{seg_event_id:08X}"
                if not cancel and len(d_bytes) >= 14:
                    flags2          = d_bytes[9]
                    upid_type       = d_bytes[10]
                    upid_len        = d_bytes[11]
                    upid_bytes      = d_bytes[12: 12 + upid_len]
                    # segmentation_type_id and segment_num follow upid
                    st_offset       = 12 + upid_len
                    seg_type_id     = d_bytes[st_offset] if st_offset < len(d_bytes) else 0
                    seg["segmentation_type_id"]   = f"0x{seg_type_id:02X}"
                    seg["segmentation_type_name"] = SEG_TYPE.get(seg_type_id, "Unknown")
                    seg["upid_type"]  = UPID_TYPE.get(upid_type, f"0x{upid_type:02X}")
                    # Try to decode UPID as ASCII/URI first, else hex
                    try:
                        seg["upid"] = upid_bytes.decode("ascii").strip("\x00")
                    except Exception:
                        seg["upid"] = upid_bytes.hex().upper()
                descriptors.append(seg)
            pos = dend

    if descriptors:
        info["descriptors"] = descriptors
    return info


def _decode_threefive(raw: bytes) -> dict:
    info = {}
    try:
        cue = _tf.Cue(base64.b64encode(raw).decode())
        cue.decode()
        cmd = getattr(cue, "command", None)
        if cmd:
            info["splice_command"] = getattr(cmd, "name", str(cmd))
            if hasattr(cmd, "splice_event_id"):
                info["splice_event_id"] = f"0x{cmd.splice_event_id:08X}"
            if hasattr(cmd, "out_of_network_indicator"):
                info["out_of_network"] = cmd.out_of_network_indicator
            if hasattr(cmd, "break_duration"):
                info["break_duration_s"] = f"{cmd.break_duration:.3f}s"
            if hasattr(cmd, "pts_time") and cmd.pts_time:
                info["pts_time_s"] = f"{cmd.pts_time:.3f}s"
        descs = []
        for d in getattr(cue, "descriptors", []):
            if getattr(d, "tag", None) == 2:  # segmentation_descriptor
                seg = {}
                seg_type = getattr(d, "segmentation_type_id", None)
                if seg_type is not None:
                    seg["segmentation_type_id"]   = f"0x{seg_type:02X}"
                    seg["segmentation_type_name"] = SEG_TYPE.get(seg_type, "Unknown")
                upid = getattr(d, "segmentation_upid", None)
                if upid:
                    seg["upid"] = str(upid)
                upid_type = getattr(d, "segmentation_upid_type", None)
                if upid_type is not None:
                    seg["upid_type"] = UPID_TYPE.get(upid_type, f"0x{upid_type:02X}")
                event_id = getattr(d, "segmentation_event_id", None)
                if event_id is not None:
                    seg["segmentation_event_id"] = f"0x{event_id:08X}"
                descs.append(seg)
        if descs:
            info["descriptors"] = descs
    except Exception as e:
        info["decode_error"] = str(e)
    return info


def decode_scte35(tag_line: str) -> dict | None:
    """Extract and decode a SCTE-35 payload from an HLS marker line. Returns None if no payload."""
    raw = _extract_payload(tag_line)
    if raw is None:
        return None
    if _HAS_THREEFIVE:
        return _decode_threefive(raw)
    return _decode_minimal(raw)


def format_decoded(info: dict, prefix: str = "    ") -> list[str]:
    """Format decoded SCTE-35 info into printable lines."""
    lines = []
    cmd = info.get("splice_command", "?")
    line = f"{prefix}command      : {cmd}"
    if cmd == "splice_insert":
        line += f"  [event={info.get('splice_event_id','?')}  out_of_network={info.get('out_of_network','?')}  duration={info.get('break_duration_s','n/a')}]"
    elif cmd == "time_signal":
        line += f"  [pts={info.get('pts_time_s','?')}]"
    lines.append(line)
    err = info.get("error") or info.get("decode_error")
    if err:
        lines.append(f"{prefix}  decode err : {err}")
    for i, seg in enumerate(info.get("descriptors", []), 1):
        type_name = seg.get("segmentation_type_name", "?")
        type_id   = seg.get("segmentation_type_id", "?")
        lines.append(f"{prefix}  segmentation_descriptor[{i}]:")
        lines.append(f"{prefix}    type         : {type_name} ({type_id})")
        if "segmentation_event_id" in seg:
            lines.append(f"{prefix}    event_id     : {seg['segmentation_event_id']}")
        if "upid_type" in seg or "upid" in seg:
            lines.append(f"{prefix}    upid_type    : {seg.get('upid_type','?')}")
            lines.append(f"{prefix}    upid         : {seg.get('upid','?')}")
        type_id_int = int(seg.get("segmentation_type_id", "0x00"), 16) if seg.get("segmentation_type_id","").startswith("0x") else 0
        if type_id_int in (0x30, 0x34):
            lines.append(f"{prefix}    *** MediaTailor CAN trigger on this signal ***")
            lines.append(f"{prefix}    *** Pass upid to ADS via [scte35.segmentationUpid] ***")
    return lines

LOG_FILE = "scte35_watch.log"


def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def log(msg, fh):
    print(msg)
    fh.write(msg + "\n")
    fh.flush()


def fetch(url):
    result = subprocess.run(
        ["curl", "-s", "-L", "-g", "-A", UA, "-w", "\n%{url_effective}", url],
        capture_output=True, text=True, timeout=20,
    )
    if result.returncode != 0:
        raise RuntimeError(f"curl failed: {result.stderr.strip()}")
    *body_lines, final_url = result.stdout.splitlines()
    return "\n".join(body_lines), final_url


def parse_master(text, base_url):
    """Return (bandwidth, full_uri) list sorted ascending by bandwidth."""
    variants = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF:"):
            m = re.search(r"BANDWIDTH=(\d+)", line)
            bw = int(m.group(1)) if m else 0
            if i + 1 < len(lines) and not lines[i + 1].startswith("#"):
                uri = lines[i + 1].strip()
                variants.append((bw, urljoin(base_url, uri)))
    return sorted(variants, key=lambda x: x[0])


def watch(master_url, variant_url, interval, fh):
    last_seq = None
    fail_count = 0
    MAX_FAILS = 3

    while True:
        try:
            playlist, _ = fetch(variant_url)
            fail_count = 0
        except Exception as e:
            fail_count += 1
            log(f"[{ts()}] fetch error ({fail_count}/{MAX_FAILS}): {e}", fh)
            if fail_count >= MAX_FAILS:
                log(f"[{ts()}] Variant URL stale — re-resolving from master...", fh)
                try:
                    master_text, resolved = fetch(master_url)
                    variants = parse_master(master_text, resolved)
                    if variants:
                        _, variant_url = variants[0]
                        log(f"[{ts()}] New variant: {variant_url}", fh)
                        fail_count = 0
                    else:
                        log(f"[{ts()}] No variants found in master.", fh)
                except Exception as me:
                    log(f"[{ts()}] Master re-fetch failed: {me}", fh)
            time.sleep(interval)
            continue

        seq_match = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", playlist)
        seq = seq_match.group(1) if seq_match else "?"

        if seq != last_seq:
            last_seq = seq
            markers = [l for l in playlist.splitlines() if CUE_PATTERN.search(l)]
            if markers:
                log(f"[{ts()}] SEQ={seq}  ** CUE MARKERS FOUND **", fh)
                for marker in markers:
                    log(f"  {marker}", fh)
                    decoded = decode_scte35(marker)
                    if decoded:
                        for dline in format_decoded(decoded):
                            log(dline, fh)
                log("---", fh)
            else:
                log(f"[{ts()}] SEQ={seq}  no markers", fh)

        time.sleep(interval)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <master_playlist_url> [poll_interval_seconds]")
        sys.exit(1)

    master_url = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0

    with open(LOG_FILE, "a") as fh:
        log(f"[{ts()}] Starting SCTE-35 watch  (interval={interval}s)", fh)
        log(f"[{ts()}] Master: {master_url}", fh)

        try:
            master_text, resolved = fetch(master_url)
        except Exception as e:
            log(f"Failed to fetch master: {e}", fh)
            sys.exit(1)

        variants = parse_master(master_text, resolved)
        if not variants:
            log("No variants found in master playlist.", fh)
            sys.exit(1)

        bw, variant_url = variants[0]
        log(f"[{ts()}] Variant: {bw} bps -> {variant_url}", fh)
        log("---", fh)

        try:
            watch(master_url, variant_url, interval, fh)
        except KeyboardInterrupt:
            log(f"\n[{ts()}] Stopped.", fh)


if __name__ == "__main__":
    main()
