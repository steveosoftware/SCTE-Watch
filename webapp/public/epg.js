// EPG drift detection — parses the two schedule sources and diffs them.
//
// Pure logic, DOM-free (regex against raw XML text, same style as vast.js
// and scte35.js's DASH parsing) so it runs under plain Node for tests
// without a jsdom dependency.
//
// The two sources:
//   - Xumo XMLTV     — standard XMLTV, <programme start stop channel>
//   - Gracenote On API v3 /Schedules — <schedule><event>, optionally with a
//     nested <broadcast><id type="remoteId"> on Xumo-stitched channels
//
// Neither feed carries the other's channel identifier, so the caller
// supplies both addresses; this module only ever compares *programmes*,
// and it pairs them on START TIME. Program IDs are deliberately NOT used
// as the join key — a title airs several times a week, so TMS IDs repeat
// within a single file (83 entries / 31 distinct on one real sample). See
// ROADMAP.md's Gracenote section for the full analysis.

// ---------------------------------------------------------------- helpers

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&"); // last, so &amp;lt; doesn't become <
}

function stripCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

// A regex parser will happily match markup-shaped text inside an XML
// comment, so comments are removed before anything else runs. (Caveat: a
// CDATA block containing a literal "<!--" would be damaged by this. No
// observed feed does that, and the alternative is a real XML parser —
// which this module deliberately avoids so it stays DOM-free for tests.)
function stripComments(s) {
  return String(s || "").replace(/<!--[\s\S]*?-->/g, "");
}

// XML permits either quote style on attribute values. The real Xumo and
// Gracenote feeds use double quotes throughout, but accepting both costs
// nothing and avoids a silent "no data" that looks like an empty schedule
// rather than a parse failure.
function attr(name, attrsStr) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrsStr || "");
  if (!m) return null;
  return unescapeXml(m[2] !== undefined ? m[2] : m[3]);
}

function firstTagText(tagName, xml) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = re.exec(xml);
  return m ? unescapeXml(stripCdata(m[1]).trim()) : null;
}

// ------------------------------------------------------------ time parsing

// XMLTV: "20260825225917 +0000" — YYYYMMDDHHMMSS with an optional offset.
// Per the XMLTV DTD the offset is optional; when absent the time is local
// to the broadcaster, which we can't resolve, so we treat it as UTC and
// flag it rather than silently guessing a zone.
export function parseXmltvTime(s) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?\s*$/.exec(String(s || ""));
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, sign, offH, offM] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  if (Number.isNaN(ms)) return null;
  if (sign) {
    const offsetMs = (Number(offH) * 60 + Number(offM)) * 60000;
    ms += sign === "+" ? -offsetMs : offsetMs;
  }
  return ms;
}

// Gracenote splits the timestamp across two attributes: a `date` on the
// parent <schedule> and a `time` on the <event>.
//
// VERIFIED against a live response (prgSvcId 157905, 2026-08-28):
// date="2026-08-28" on <schedule>, time="00:19" on <event> — HH:MM with no
// seconds component. Still deliberately tolerant (accepts HH:MM:SS, a
// trailing Z, an explicit numeric offset) and assumes UTC when no zone is
// given, consistent with /Schedules taking plain YYYY-MM-DD bounds.
export function parseGracenoteTime(dateStr, timeStr) {
  const dm = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(dateStr || ""));
  if (!dm) return null;
  const tm = /^\s*(\d{2}):(\d{2})(?::(\d{2}))?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?\s*$/.exec(String(timeStr || ""));
  if (!tm) return null;
  const [, y, mo, d] = dm;
  const [, h, mi, sec, , sign, offH, offM] = tm;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0);
  if (Number.isNaN(ms)) return null;
  if (sign) {
    const offsetMs = (Number(offH) * 60 + Number(offM)) * 60000;
    ms += sign === "+" ? -offsetMs : offsetMs;
  }
  return ms;
}

// Gracenote's `dur` attribute is an ISO 8601 duration — confirmed against a
// live response (2026-08-28): dur="PT00H28M". An earlier version of this
// only handled raw seconds and HH:MM:SS, so every real duration parsed to
// null, which nulled stopMs, which made findScheduledAt match nothing and
// presented as "no schedule covering right now" rather than as a parse
// failure. The other two forms are kept since they cost nothing.
export function parseDurationSeconds(s) {
  const v = String(s ?? "").trim();
  if (!v) return null;

  // ISO 8601: PnDTnHnMnS, any component optional (PT28M, PT1H, PT90S…)
  const iso = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(v);
  if (iso && iso.slice(1).some((g) => g !== undefined)) {
    const [, d, h, m, sec] = iso;
    return (
      (d ? parseFloat(d) * 86400 : 0) +
      (h ? parseFloat(h) * 3600 : 0) +
      (m ? parseFloat(m) * 60 : 0) +
      (sec ? parseFloat(sec) : 0)
    );
  }

  if (/^\d+$/.test(v)) return Number(v);
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!clock) return null;
  return clock[3] !== undefined
    ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    : Number(clock[1]) * 60 + Number(clock[2]);
}

// ------------------------------------------------------------ XMLTV source

// Returns {channel: {id, displayName}, programmes: [...], warnings: []}.
// Programmes are sorted by start time.
//
// The episode/series block (sub-title, series-id, episode-num, date) is
// present on series channels and absent on movie channels — treated as
// optional rather than branched on, since everything else is identical.
export function parseXmltv(rawText) {
  const text = stripComments(rawText);
  const warnings = [];

  const chMatch = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/i.exec(text);
  const channel = {
    id: chMatch ? attr("id", chMatch[1]) : null,
    displayName: chMatch ? firstTagText("display-name", chMatch[2]) : null,
  };
  const channelCount = (text.match(/<channel\b/gi) || []).length;
  if (channelCount > 1) {
    warnings.push(`XMLTV contains ${channelCount} channels; using the first (${channel.id ?? "?"})`);
  }

  const programmes = [];
  let missingTms = 0;
  let noOffset = 0;
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let m;
  while ((m = re.exec(text))) {
    const [, attrs, body] = m;
    const rawStart = attr("start", attrs);
    const startMs = parseXmltvTime(rawStart);
    const stopMs = parseXmltvTime(attr("stop", attrs));
    const tmsId = firstTagText("tms-id", body);
    if (!tmsId) missingTms += 1;
    if (rawStart && !/[+-]\d{4}\s*$/.test(rawStart)) noOffset += 1;

    programmes.push({
      startMs,
      stopMs,
      rawStart,
      channelId: attr("channel", attrs),
      title: firstTagText("title", body),
      subTitle: firstTagText("sub-title", body),
      tmsId,
      programmeId: firstTagText("programme-id", body),
      seriesId: firstTagText("series-id", body),
      episodeNum: firstTagText("episode-num", body),
    });
  }

  if (missingTms) {
    warnings.push(
      `${missingTms} of ${programmes.length} XMLTV programmes carry no <tms-id> ` +
        `(common for alternate cuts) — these are reported separately, not counted as mismatches`
    );
  }
  if (noOffset) {
    warnings.push(`${noOffset} XMLTV timestamps have no UTC offset; assuming UTC`);
  }

  programmes.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  return { channel, programmes, warnings };
}

// -------------------------------------------------------- Gracenote source

// Returns {programmes: [...], warnings: []}, sorted by start time.
//
// Handles both channel types with ONE pass rather than the two branches the
// original shell scripts used. Their `//broadcast` and `//event` XPaths
// describe the same tree — <schedule prgSvcId date> > <event time dur
// TMSId> — where stitched channels merely add a nested <broadcast><id
// type="remoteId"> inside each <event>. Matching <event> and reading the
// optional nested remoteId covers both, so there's no need to sniff the
// first entry's remoteId to pick a parsing mode.
export function parseGracenoteSchedule(rawText) {
  const text = stripComments(rawText);
  const warnings = [];
  const programmes = [];
  let unparsedTimes = 0;

  const schedRe = /<schedule\b([^>]*)>([\s\S]*?)<\/schedule>/gi;
  let sm;
  let sawSchedule = false;
  while ((sm = schedRe.exec(text))) {
    sawSchedule = true;
    const [, schedAttrs, schedBody] = sm;
    const date = attr("date", schedAttrs);
    const prgSvcId = attr("prgSvcId", schedAttrs);

    const evRe = /<event\b([^>]*?)(?:\/>|>([\s\S]*?)<\/event>)/gi;
    let em;
    while ((em = evRe.exec(schedBody))) {
      const [, evAttrs, evBody] = em;
      const time = attr("time", evAttrs);
      const startMs = parseGracenoteTime(date, time);
      if (startMs === null) unparsedTimes += 1;
      const durationS = parseDurationSeconds(attr("dur", evAttrs));

      // Stitched channels only: <broadcast><id type="remoteId">XM…</id>
      let remoteId = null;
      if (evBody) {
        const idRe = /<id\b([^>]*)>([\s\S]*?)<\/id>/gi;
        let im;
        while ((im = idRe.exec(evBody))) {
          if ((attr("type", im[1]) || "").toLowerCase() === "remoteid") {
            remoteId = unescapeXml(stripCdata(im[2]).trim());
            break;
          }
        }
      }

      programmes.push({
        startMs,
        durationS,
        stopMs: startMs !== null && durationS !== null ? startMs + durationS * 1000 : null,
        rawDate: date,
        rawTime: time,
        prgSvcId,
        tmsId: attr("TMSId", evAttrs),
        remoteId,
      });
    }
  }

  if (!sawSchedule) {
    const err = firstTagText("error", text);
    warnings.push(err ? `Gracenote returned an error: ${err}` : "No <schedule> elements found in the Gracenote response");
  }
  if (unparsedTimes) {
    warnings.push(`${unparsedTimes} Gracenote events had an unparseable date/time and can't be compared`);
  }

  programmes.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  return { programmes, warnings };
}

// /Sources?prgSvcId=… — used only for the channel-name confirmation signal.
export function parseGracenoteSourceName(text) {
  return firstTagText("name", stripComments(text));
}

// ------------------------------------------------- what's actually playing

// Xumo segment URLs carry the asset id in the path:
//   https://live-content.xumo.com/3845/content/XM08RIB78GYPVR/28846714/6_059.ts
//                                      ^^^^^^^^^^^^^^^^^^^^^
// The host varies across channels and CDN swaps (live-content.xumo.com,
// live-content.cdn.xumo.com, live-content-cf.xumo.com), so this keys on the
// path segment after /content/ rather than on any hostname. Same XM-prefixed
// namespace as XMLTV's <programme-id> and Gracenote's remoteId, which is
// what makes the comparison possible at all.
const ASSET_ID_IN_PATH = /\/content\/([A-Za-z0-9_-]+)\//;

export function extractAssetId(segmentUrl) {
  const m = ASSET_ID_IN_PATH.exec(String(segmentUrl || ""));
  if (m) return m[1];
  // Beacon-wrapped segments put the real URL in a query param and also
  // expose the asset id directly as aid=.
  const aid = /[?&]aid=([A-Za-z0-9_-]+)/.exec(String(segmentUrl || ""));
  return aid ? aid[1] : null;
}

// Walks an HLS media playlist and returns its segments with an estimated
// wall-clock time for each.
//
// These streams carry NO #EXT-X-PROGRAM-DATE-TIME (verified on real Xumo
// channels), so there's no wallclock anchor in the manifest. What we do
// have is that a live playlist's last segment is, by definition, the live
// edge — approximately "now". So the timeline is anchored at the end and
// interpolated backwards by accumulating #EXTINF durations. That's an
// estimate, not ground truth: it inherits any packager latency between a
// segment being produced and appearing in the playlist. Good enough to
// time a transition to within a segment duration, which is the resolution
// the schedule itself is meaningful at.
export function parseMediaPlaylistAssets(text, nowMs = Date.now()) {
  const lines = String(text || "").split(/\r?\n/);
  const segments = [];
  let pendingDuration = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const inf = /^#EXTINF:\s*([\d.]+)/.exec(line);
    if (inf) {
      pendingDuration = parseFloat(inf[1]);
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push({
      url: line,
      durationS: pendingDuration ?? 0,
      assetId: extractAssetId(line),
    });
    pendingDuration = null;
  }

  // Anchor the last segment's END at now, then walk backwards.
  let cursor = nowMs;
  for (let i = segments.length - 1; i >= 0; i--) {
    segments[i].endMs = cursor;
    segments[i].startMs = cursor - segments[i].durationS * 1000;
    cursor = segments[i].startMs;
  }

  // Asset changes visible inside this one window.
  const transitions = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].assetId && segments[i].assetId !== segments[i - 1].assetId) {
      transitions.push({
        fromAssetId: segments[i - 1].assetId,
        toAssetId: segments[i].assetId,
        atMs: segments[i].startMs,
      });
    }
  }

  const last = segments[segments.length - 1];
  return {
    segments,
    liveEdgeAssetId: last ? last.assetId : null,
    transitions,
    windowSeconds: segments.reduce((a, s) => a + s.durationS, 0),
  };
}

// ------------------------------------------- schedules, source-agnostic

// Both schedule sources normalize to the same shape so everything
// downstream is source-agnostic: the panel compares against Gracenote OR
// XMLTV, never both, and shouldn't care which it was handed.
export function normalizeXmltvSchedule(parsed) {
  return parsed.programmes.map((p) => ({
    startMs: p.startMs,
    stopMs: p.stopMs,
    assetId: p.programmeId,
    title: p.title,
    tmsId: p.tmsId,
    source: "xmltv",
  }));
}

export function normalizeGracenoteSchedule(parsed) {
  return parsed.programmes.map((p) => ({
    startMs: p.startMs,
    stopMs: p.stopMs,
    assetId: p.remoteId,
    title: null, // /Schedules carries no title; /Programs would, keyed by TMS id
    tmsId: p.tmsId,
    source: "gracenote",
  }));
}

// The scheduled entry covering an instant. Half-open [start, stop) so a
// boundary instant belongs to the programme starting then, not the one
// ending.
export function findScheduledAt(schedule, tMs) {
  return (
    schedule.find(
      (p) => p.startMs !== null && p.startMs <= tMs && (p.stopMs === null ? false : tMs < p.stopMs)
    ) ?? null
  );
}

// Compares what the stream is actually playing against what the schedule
// says should be playing. This is the check that matters operationally —
// two schedules agreeing with each other proves nothing about the stream.
//
// Returns {status, playingAssetId, expected, drift} where status is:
//   "match"          — right asset playing
//   "wrong-asset"    — something else is playing
//   "unscheduled"    — playing an asset the schedule doesn't cover at all
//   "no-asset-id"    — couldn't read an asset id from the segments
//   "no-schedule"    — schedule has no entry for this instant
export function comparePlaybackToSchedule(playback, schedule, nowMs = Date.now()) {
  const playingAssetId = playback.liveEdgeAssetId;
  const expected = findScheduledAt(schedule, nowMs);

  let status;
  if (!playingAssetId) status = "no-asset-id";
  else if (!expected) status = "no-schedule";
  else if (!expected.assetId) status = "no-schedule";
  else if (normalizeId(expected.assetId) === normalizeId(playingAssetId)) status = "match";
  else {
    // Is the playing asset scheduled at all, just at a different time?
    const elsewhere = schedule.find((p) => normalizeId(p.assetId) === normalizeId(playingAssetId));
    status = elsewhere ? "wrong-asset" : "unscheduled";
  }

  // If the playing asset IS scheduled, how far off is its start? Uses the
  // observed transition when this poll happened to capture one (accurate to
  // roughly a segment), otherwise falls back to comparing against the start
  // of whatever the schedule expected.
  let drift = null;
  const scheduledForPlaying = playingAssetId
    ? schedule.find((p) => normalizeId(p.assetId) === normalizeId(playingAssetId))
    : null;
  const observedStart = playback.transitions.find(
    (t) => normalizeId(t.toAssetId) === normalizeId(playingAssetId)
  );
  if (scheduledForPlaying && scheduledForPlaying.startMs !== null && observedStart) {
    drift = {
      observedStartMs: observedStart.atMs,
      scheduledStartMs: scheduledForPlaying.startMs,
      seconds: Math.round((observedStart.atMs - scheduledForPlaying.startMs) / 1000),
      basis: "observed-transition",
    };
  }

  return { status, playingAssetId, expected, scheduledForPlaying, drift };
}

// ------------------------------------------------------------- comparison

function normalizeId(v) {
  return (v ?? "").trim().toUpperCase();
}

// Pairs programmes from the two sources on start time and reports the
// differences.
//
//   pairWindowSeconds  — how far apart two programmes may start and still be
//                        considered the same slot. Generous by default; this
//                        is about *identifying* the pair, not judging it.
//   driftToleranceSeconds — how far a paired slot may drift before it counts
//                        as a start-time mismatch. Strict by default.
//
// Both lists are already sorted, so this is a linear two-pointer merge.
export function compareSchedules(xumoProgrammes, gracenoteProgrammes, options = {}) {
  const { pairWindowSeconds = 300, driftToleranceSeconds = 0 } = options;
  const pairWindowMs = pairWindowSeconds * 1000;
  const driftMs = driftToleranceSeconds * 1000;

  const a = xumoProgrammes.filter((p) => p.startMs !== null);
  const b = gracenoteProgrammes.filter((p) => p.startMs !== null);

  const matched = [];
  const onlyInXumo = [];
  const onlyInGracenote = [];

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const delta = a[i].startMs - b[j].startMs;
    if (Math.abs(delta) <= pairWindowMs) {
      const xTms = normalizeId(a[i].tmsId);
      const gTms = normalizeId(b[j].tmsId);
      const xAsset = normalizeId(a[i].programmeId);
      const gAsset = normalizeId(b[j].remoteId);
      matched.push({
        xumo: a[i],
        gracenote: b[j],
        deltaSeconds: Math.round(delta / 1000),
        timeDrift: Math.abs(delta) > driftMs,
        // A missing TMS on the Xumo side is a known data gap, not a
        // mismatch — kept out of the tmsMismatch tally entirely.
        tmsComparable: !!xTms && !!gTms,
        tmsMismatch: !!xTms && !!gTms && xTms !== gTms,
        assetComparable: !!xAsset && !!gAsset,
        assetMismatch: !!xAsset && !!gAsset && xAsset !== gAsset,
      });
      i += 1;
      j += 1;
    } else if (delta < 0) {
      onlyInXumo.push(a[i]);
      i += 1;
    } else {
      onlyInGracenote.push(b[j]);
      j += 1;
    }
  }
  while (i < a.length) onlyInXumo.push(a[i++]);
  while (j < b.length) onlyInGracenote.push(b[j++]);

  const tmsComparable = matched.filter((m) => m.tmsComparable);
  const tmsMismatches = tmsComparable.filter((m) => m.tmsMismatch);
  const assetComparable = matched.filter((m) => m.assetComparable);

  return {
    matched,
    onlyInXumo,
    onlyInGracenote,
    summary: {
      xumoTotal: xumoProgrammes.length,
      gracenoteTotal: gracenoteProgrammes.length,
      paired: matched.length,
      timeDrifts: matched.filter((m) => m.timeDrift).length,
      tmsMismatches: tmsMismatches.length,
      tmsComparable: tmsComparable.length,
      noTmsMapping: matched.filter((m) => !m.tmsComparable).length,
      assetMismatches: assetComparable.filter((m) => m.assetMismatch).length,
      assetComparable: assetComparable.length,
      onlyInXumo: onlyInXumo.length,
      onlyInGracenote: onlyInGracenote.length,
      // Denominator is deliberately the comparable pairs only — including
      // entries that never had a TMS to begin with would make a movie
      // channel look permanently misaligned. null when nothing is
      // comparable, rather than a misleading 0% or a divide-by-zero.
      alignmentPct:
        tmsComparable.length > 0
          ? Math.round(((tmsComparable.length - tmsMismatches.length) / tmsComparable.length) * 1000) / 10
          : null,
    },
  };
}

// Compares the two channel names as a confirmation signal. Neither feed
// carries the other's channel id, so pairing the wrong two channels is an
// easy mistake whose failure mode — a clean-looking ~0%-aligned report —
// looks like catastrophic drift rather than operator error. Loose match:
// case/punctuation/whitespace-insensitive containment either way.
export function compareChannelNames(gracenoteName, xumoDisplayName) {
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const g = norm(gracenoteName);
  const x = norm(xumoDisplayName);
  if (!g || !x) return { match: null, gracenoteName, xumoDisplayName };
  return {
    match: g === x || g.includes(x) || x.includes(g),
    gracenoteName,
    xumoDisplayName,
  };
}

// Builds the Gracenote request URLs. The api_key is the user's own, entered
// in the UI and never stored server-side (see CONTEXT.md's credential
// policy) — it rides through the existing /api/fetch proxy because
// on-api.gracenote.com sets no CORS headers.
export function gracenoteScheduleUrl({ apiKey, prgSvcId, startDate, endDate }) {
  const q = new URLSearchParams({
    api_key: apiKey,
    startDate,
    endDate,
    prgSvcId,
  });
  return `https://on-api.gracenote.com/v3/Schedules?${q}`;
}

export function gracenoteSourceUrl({ apiKey, prgSvcId }) {
  const q = new URLSearchParams({ api_key: apiKey, prgSvcId });
  return `https://on-api.gracenote.com/v3/Sources?${q}`;
}

// The observation log from a monitoring run — one row per poll that
// changed something, so a session can be handed to someone else as
// evidence rather than screenshotted.
export function buildObservationCsv(observations) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [
    ["observed_utc", "status", "playing_asset_id", "expected_asset_id", "expected_title", "drift_seconds", "note"],
  ];
  for (const o of observations) {
    rows.push([
      new Date(o.atMs).toISOString(),
      o.status,
      o.playingAssetId,
      o.expected ? o.expected.assetId : "",
      o.expected ? o.expected.title : "",
      o.drift ? o.drift.seconds : "",
      o.note || "",
    ]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

// Flattens a schedule-vs-schedule comparison into CSV — one row per
// programme slot, both sides side by side with a verdict.
//
// NOTE: currently unwired from the UI. The panel compares the *stream*
// against one schedule (see comparePlaybackToSchedule), which is the check
// that actually catches a mis-scheduled channel — two schedules agreeing
// with each other proves nothing about what's playing. Kept, with its
// tests, because comparing two schedule sources is still a real question
// and the operator's original shell workflow did exactly this.
export function buildComparisonCsv(report) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const iso = (ms) => (ms === null || ms === undefined ? "" : new Date(ms).toISOString());

  const rows = [
    [
      "status",
      "xumo_start_utc",
      "gracenote_start_utc",
      "delta_seconds",
      "title",
      "xumo_tms_id",
      "gracenote_tms_id",
      "xumo_asset_id",
      "gracenote_remote_id",
    ],
  ];

  for (const m of report.matched) {
    const status = !m.tmsComparable
      ? "no-tms-mapping"
      : [m.timeDrift && "time-drift", m.tmsMismatch && "tms-mismatch", m.assetMismatch && "asset-mismatch"]
          .filter(Boolean)
          .join("+") || "ok";
    rows.push([
      status,
      iso(m.xumo.startMs),
      iso(m.gracenote.startMs),
      m.deltaSeconds,
      m.xumo.title,
      m.xumo.tmsId,
      m.gracenote.tmsId,
      m.xumo.programmeId,
      m.gracenote.remoteId,
    ]);
  }
  for (const p of report.onlyInXumo) {
    rows.push(["only-in-xumo", iso(p.startMs), "", "", p.title, p.tmsId, "", p.programmeId, ""]);
  }
  for (const p of report.onlyInGracenote) {
    rows.push(["only-in-gracenote", "", iso(p.startMs), "", "", "", p.tmsId, "", p.remoteId]);
  }

  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

// Gracenote takes plain YYYY-MM-DD bounds; <input type="date"> hands us
// exactly that format regardless of the viewer's locale (see ROADMAP.md).
export function addDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
