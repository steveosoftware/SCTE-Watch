import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseXmltvTime,
  parseGracenoteTime,
  parseDurationSeconds,
  parseXmltv,
  parseGracenoteSchedule,
  parseGracenoteSourceName,
  compareSchedules,
  compareChannelNames,
  gracenoteScheduleUrl,
  buildComparisonCsv,
  addDays,
  extractAssetId,
  parseMediaPlaylistAssets,
  findScheduledAt,
  comparePlaybackToSchedule,
  normalizeXmltvSchedule,
  normalizeGracenoteSchedule,
} from "../../public/epg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(path.join(__dirname, "../fixtures", n), "utf8");

const xmltvMovies = fx("xmltv-movies.xml");
const xmltvSeries = fx("xmltv-series.xml");
const gnStitched = fx("gracenote-schedule-stitched.xml");
const gnSimulcast = fx("gracenote-schedule-simulcast.xml");
const gnDrift = fx("gracenote-schedule-drift.xml");

describe("parseXmltvTime", () => {
  test("parses YYYYMMDDHHMMSS with a +0000 offset", () => {
    assert.equal(parseXmltvTime("20260825225917 +0000"), Date.UTC(2026, 7, 25, 22, 59, 17));
  });

  test("applies a non-zero offset (-0500 is 5h later in UTC)", () => {
    assert.equal(parseXmltvTime("20260825120000 -0500"), Date.UTC(2026, 7, 25, 17, 0, 0));
  });

  test("treats a missing offset as UTC rather than guessing a zone", () => {
    assert.equal(parseXmltvTime("20260825225917"), Date.UTC(2026, 7, 25, 22, 59, 17));
  });

  test("returns null on garbage rather than NaN", () => {
    assert.equal(parseXmltvTime("not a time"), null);
    assert.equal(parseXmltvTime(""), null);
    assert.equal(parseXmltvTime(null), null);
  });
});

describe("parseGracenoteTime", () => {
  test("combines a date attribute and a time attribute", () => {
    assert.equal(parseGracenoteTime("2026-08-25", "22:59:17"), Date.UTC(2026, 7, 25, 22, 59, 17));
  });

  test("accepts HH:MM without seconds", () => {
    assert.equal(parseGracenoteTime("2026-08-25", "22:59"), Date.UTC(2026, 7, 25, 22, 59, 0));
  });

  test("accepts a trailing Z", () => {
    assert.equal(parseGracenoteTime("2026-08-25", "22:59:17Z"), Date.UTC(2026, 7, 25, 22, 59, 17));
  });

  test("applies an explicit numeric offset", () => {
    assert.equal(parseGracenoteTime("2026-08-25", "12:00:00-05:00"), Date.UTC(2026, 7, 25, 17, 0, 0));
  });

  test("returns null when either half is missing or malformed", () => {
    assert.equal(parseGracenoteTime("2026-08-25", null), null);
    assert.equal(parseGracenoteTime(null, "22:59:17"), null);
    assert.equal(parseGracenoteTime("08/25/2026", "22:59:17"), null);
  });
});

describe("parseDurationSeconds", () => {
  // ISO 8601 is what Gracenote actually emits — confirmed against a live
  // response 2026-08-28. Handling only seconds/clock formats made every
  // real duration parse to null, which nulled stopMs and made the whole
  // schedule look empty. Regression-guarded here.
  test("accepts the ISO 8601 form Gracenote really uses", () => {
    assert.equal(parseDurationSeconds("PT00H28M"), 28 * 60);
    assert.equal(parseDurationSeconds("PT01H43M13S"), 6193);
  });

  test("accepts ISO durations with components omitted", () => {
    assert.equal(parseDurationSeconds("PT28M"), 1680);
    assert.equal(parseDurationSeconds("PT2H"), 7200);
    assert.equal(parseDurationSeconds("PT90S"), 90);
    assert.equal(parseDurationSeconds("P1DT2H"), 86400 + 7200);
  });

  test("still accepts raw seconds and clock forms", () => {
    assert.equal(parseDurationSeconds("6193"), 6193);
    assert.equal(parseDurationSeconds("1:43:13"), 6193);
    assert.equal(parseDurationSeconds("02:30"), 150);
  });

  test("returns null on garbage, including a bare P with no components", () => {
    assert.equal(parseDurationSeconds("soon"), null);
    assert.equal(parseDurationSeconds("P"), null);
    assert.equal(parseDurationSeconds(""), null);
  });
});

describe("parseGracenoteSchedule — against a REAL captured response", () => {
  const real = fx("gracenote-schedule-real.xml");

  test("parses the live response shape end to end", () => {
    const { programmes, warnings } = parseGracenoteSchedule(real);
    assert.equal(programmes.length, 4);
    assert.deepEqual(warnings, [], "a healthy response should raise no warnings");
  });

  test("resolves real times from date + HH:MM (no seconds component)", () => {
    const [first] = parseGracenoteSchedule(real).programmes;
    assert.equal(first.rawTime, "00:19");
    assert.equal(first.startMs, Date.UTC(2026, 7, 28, 0, 19, 0));
  });

  test("resolves the ISO duration and therefore a usable stopMs", () => {
    const [first] = parseGracenoteSchedule(real).programmes;
    assert.equal(first.durationS, 28 * 60);
    assert.equal(first.stopMs, Date.UTC(2026, 7, 28, 0, 47, 0));
  });

  test("stopMs must be non-null or findScheduledAt can never match anything", () => {
    // This is the exact failure that presented as "no schedule covering
    // right now" against a live channel.
    const { programmes } = parseGracenoteSchedule(real);
    assert.ok(programmes.every((p) => p.stopMs !== null), "every entry needs an end time");
    const mid = programmes[0].startMs + 60000;
    assert.ok(findScheduledAt(normalizeGracenoteSchedule({ programmes }), mid), "must resolve a covering entry");
  });

  test("extracts the nested remoteId from a real stitched channel", () => {
    const [first] = parseGracenoteSchedule(real).programmes;
    assert.equal(first.remoteId, "XM0S73JEOMUUNL");
    assert.equal(first.tmsId, "EP022439260099");
  });

  test("a real schedule drives a playback check", () => {
    const sched = normalizeGracenoteSchedule(parseGracenoteSchedule(real));
    const at = Date.UTC(2026, 7, 28, 0, 30, 0); // inside the first event
    assert.equal(
      comparePlaybackToSchedule({ liveEdgeAssetId: "XM0S73JEOMUUNL", transitions: [] }, sched, at).status,
      "match"
    );
    assert.equal(
      comparePlaybackToSchedule({ liveEdgeAssetId: "XMWRONGASSET01", transitions: [] }, sched, at).status,
      "unscheduled"
    );
  });
});

describe("parseXmltv — movie channel", () => {
  test("extracts the channel id and display name", () => {
    const { channel } = parseXmltv(xmltvMovies);
    assert.equal(channel.id, "88840011");
    assert.equal(channel.displayName, "FilmRise Horror");
  });

  test("extracts programmes with times, title and both ids", () => {
    const { programmes } = parseXmltv(xmltvMovies);
    assert.equal(programmes.length, 5);
    const [first] = programmes;
    assert.equal(first.title, "Raging Sharks");
    assert.equal(first.tmsId, "MV001824280000");
    assert.equal(first.programmeId, "XM03Z0K05Q9CN4");
    assert.equal(first.startMs, Date.UTC(2026, 7, 25, 22, 59, 17));
    assert.equal(first.stopMs, Date.UTC(2026, 7, 26, 0, 42, 30));
  });

  test("a programme with no <tms-id> parses with tmsId null, and is warned about", () => {
    const { programmes, warnings } = parseXmltv(xmltvMovies);
    const noTms = programmes.filter((p) => p.tmsId === null);
    assert.equal(noTms.length, 1);
    assert.match(noTms[0].title, /House \(1985\)/);
    // still has an asset id — it's the TMS mapping that's absent, not the entry
    assert.equal(noTms[0].programmeId, "XM0MA34LLB2ARR");
    assert.ok(warnings.some((w) => /no <tms-id>/.test(w)), "should warn about missing TMS mappings");
  });

  test("movie programmes carry no episode/series fields", () => {
    const [first] = parseXmltv(xmltvMovies).programmes;
    assert.equal(first.subTitle, null);
    assert.equal(first.seriesId, null);
    assert.equal(first.episodeNum, null);
  });

  test("programmes come back sorted by start time", () => {
    const { programmes } = parseXmltv(xmltvMovies);
    const starts = programmes.map((p) => p.startMs);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});

describe("parseXmltv — attribute quoting", () => {
  // XML allows either quote style. Real feeds use double, but a
  // single-quoted document must not silently parse to an empty schedule —
  // that failure mode reads as "nothing scheduled" rather than "couldn't
  // parse", which is far more confusing to debug.
  const singleQuoted = `<?xml version='1.0'?><tv date='2026-08-25'>
    <channel id='88840011'><display-name>FilmRise Horror</display-name></channel>
    <programme start='20260825225917 +0000' stop='20260826004230 +0000' channel='88840011'>
      <title>Raging Sharks</title><programme-id>XM03Z0K05Q9CN4</programme-id>
    </programme>
  </tv>`;

  test("single-quoted attributes parse identically to double-quoted", () => {
    const { channel, programmes } = parseXmltv(singleQuoted);
    assert.equal(channel.id, "88840011");
    assert.equal(programmes.length, 1);
    assert.equal(programmes[0].startMs, Date.UTC(2026, 7, 25, 22, 59, 17));
    assert.equal(programmes[0].programmeId, "XM03Z0K05Q9CN4");
  });

  test("a single-quoted schedule still resolves a playback check", () => {
    const at = Date.UTC(2026, 7, 25, 23, 30, 0);
    const r = comparePlaybackToSchedule(
      { liveEdgeAssetId: "XM03Z0K05Q9CN4", transitions: [] },
      normalizeXmltvSchedule(parseXmltv(singleQuoted)),
      at
    );
    assert.equal(r.status, "match", "must not degrade to no-schedule on a quoting difference");
  });
});

describe("parseXmltv — series channel", () => {
  test("extracts the optional episode/series block when present", () => {
    const { programmes } = parseXmltv(xmltvSeries);
    const [first] = programmes;
    assert.equal(first.title, "Forensic Files");
    assert.equal(first.subTitle, "Shopping Spree");
    assert.equal(first.tmsId, "EP022439260403");
    assert.equal(first.seriesId, "XM0A4OXFGAJUSX");
    assert.ok(first.episodeNum, "series entries should carry an episode number");
  });

  test("every series entry has a TMS id, so no missing-mapping warning", () => {
    const { programmes, warnings } = parseXmltv(xmltvSeries);
    assert.ok(programmes.every((p) => p.tmsId));
    assert.ok(!warnings.some((w) => /no <tms-id>/.test(w)));
  });
});

describe("parseGracenoteSchedule", () => {
  test("parses stitched channels, including the nested remoteId", () => {
    const { programmes } = parseGracenoteSchedule(gnStitched);
    assert.equal(programmes.length, 5);
    assert.equal(programmes[0].tmsId, "MV001824280000");
    assert.equal(programmes[0].remoteId, "XM03Z0K05Q9CN4");
    assert.equal(programmes[0].startMs, Date.UTC(2026, 7, 25, 22, 59, 17));
    assert.equal(programmes[0].durationS, 6193);
  });

  test("one parser handles simulcast too — same data, remoteId simply absent", () => {
    const stitched = parseGracenoteSchedule(gnStitched).programmes;
    const simulcast = parseGracenoteSchedule(gnSimulcast).programmes;
    assert.equal(simulcast.length, stitched.length);
    assert.ok(simulcast.every((p) => p.remoteId === null));
    assert.deepEqual(
      simulcast.map((p) => [p.startMs, p.tmsId]),
      stitched.map((p) => [p.startMs, p.tmsId])
    );
  });

  test("spans multiple <schedule> date blocks and sorts across them", () => {
    const { programmes } = parseGracenoteSchedule(gnStitched);
    // fixture deliberately straddles midnight: 1 entry on the 25th, 4 on the 26th
    assert.equal(programmes.filter((p) => p.rawDate === "2026-08-25").length, 1);
    assert.equal(programmes.filter((p) => p.rawDate === "2026-08-26").length, 4);
    const starts = programmes.map((p) => p.startMs);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  test("surfaces a Gracenote <error> response instead of silently returning nothing", () => {
    const { programmes, warnings } = parseGracenoteSchedule(
      "<errors><error>Value startDate(2024-02-30) is not a valid ISO date.</error></errors>"
    );
    assert.equal(programmes.length, 0);
    assert.ok(warnings.some((w) => /not a valid ISO date/.test(w)), "the upstream message should reach the user");
  });
});

describe("parseGracenoteSourceName", () => {
  test("pulls the channel name out of a /Sources response", () => {
    assert.equal(
      parseGracenoteSourceName("<sources><source><name>FilmRise Horror</name></source></sources>"),
      "FilmRise Horror"
    );
  });
});

describe("compareSchedules — clean match", () => {
  const xumo = parseXmltv(xmltvMovies).programmes;
  const gn = parseGracenoteSchedule(gnStitched).programmes;

  test("pairs every programme with nothing left over", () => {
    const { summary } = compareSchedules(xumo, gn);
    assert.equal(summary.paired, 5);
    assert.equal(summary.onlyInXumo, 0);
    assert.equal(summary.onlyInGracenote, 0);
    assert.equal(summary.timeDrifts, 0);
  });

  test("the entry with no Xumo TMS id is counted as unmapped, NOT as a mismatch", () => {
    const { summary } = compareSchedules(xumo, gn);
    assert.equal(summary.noTmsMapping, 1);
    assert.equal(summary.tmsComparable, 4);
    assert.equal(summary.tmsMismatches, 0);
  });

  test("alignment is computed over comparable pairs only, so it reads 100%", () => {
    const { summary } = compareSchedules(xumo, gn);
    // 4 comparable, 0 mismatched -> 100%, NOT 4/5 = 80%
    assert.equal(summary.alignmentPct, 100);
  });

  test("asset ids (Xumo programme-id vs Gracenote remoteId) line up", () => {
    const { summary } = compareSchedules(xumo, gn);
    assert.equal(summary.assetComparable, 5);
    assert.equal(summary.assetMismatches, 0);
  });

  test("simulcast has no remoteIds, so asset comparison is skipped rather than failed", () => {
    const { summary } = compareSchedules(xumo, parseGracenoteSchedule(gnSimulcast).programmes);
    assert.equal(summary.assetComparable, 0);
    assert.equal(summary.assetMismatches, 0);
    assert.equal(summary.tmsMismatches, 0, "TMS comparison still works without remoteIds");
  });
});

describe("compareSchedules — drift detection", () => {
  const xumo = parseXmltv(xmltvMovies).programmes;
  const gn = parseGracenoteSchedule(gnDrift).programmes;

  test("detects the 90-second start-time drift and reports its signed size", () => {
    const { matched, summary } = compareSchedules(xumo, gn);
    assert.equal(summary.timeDrifts, 1);
    const drifted = matched.find((m) => m.timeDrift);
    assert.equal(drifted.deltaSeconds, -90, "Xumo starts 90s before Gracenote");
    assert.equal(drifted.xumo.title, "Maneater");
  });

  test("detects the swapped TMS id", () => {
    const { matched, summary } = compareSchedules(xumo, gn);
    assert.equal(summary.tmsMismatches, 1);
    const bad = matched.find((m) => m.tmsMismatch);
    assert.equal(bad.xumo.tmsId, "MV000026650000");
    assert.equal(bad.gracenote.tmsId, "MV0DIFFERENT00");
  });

  test("reports the programme missing from Gracenote as only-in-Xumo", () => {
    const { onlyInXumo, summary } = compareSchedules(xumo, gn);
    assert.equal(summary.onlyInGracenote, 0);
    assert.equal(summary.onlyInXumo, 1);
    assert.match(onlyInXumo[0].title, /Living Dark/);
  });

  test("alignment drops but stays out of the unmapped entry's way", () => {
    const { summary } = compareSchedules(xumo, gn);
    // 3 comparable pairs, 1 mismatched -> 66.7%
    assert.equal(summary.tmsComparable, 3);
    assert.equal(summary.alignmentPct, 66.7);
  });

  test("driftToleranceSeconds suppresses drift below the threshold", () => {
    const { summary } = compareSchedules(xumo, gn, { driftToleranceSeconds: 120 });
    assert.equal(summary.timeDrifts, 0, "90s drift is within a 120s tolerance");
  });

  test("a too-small pair window stops the drifted entry from pairing at all", () => {
    const { summary } = compareSchedules(xumo, gn, { pairWindowSeconds: 30 });
    assert.ok(summary.onlyInXumo >= 1 && summary.onlyInGracenote >= 1);
    assert.ok(summary.paired < 4);
  });
});

describe("compareSchedules — degenerate inputs", () => {
  test("empty Gracenote side reports everything as only-in-Xumo, no divide-by-zero", () => {
    const xumo = parseXmltv(xmltvMovies).programmes;
    const { summary } = compareSchedules(xumo, []);
    assert.equal(summary.paired, 0);
    assert.equal(summary.onlyInXumo, 5);
    assert.equal(summary.alignmentPct, null, "null, not 0% or NaN, when nothing is comparable");
  });

  test("both sides empty is handled without throwing", () => {
    const { summary } = compareSchedules([], []);
    assert.equal(summary.paired, 0);
    assert.equal(summary.alignmentPct, null);
  });
});

describe("compareChannelNames", () => {
  test("exact match", () => {
    assert.equal(compareChannelNames("FilmRise Horror", "FilmRise Horror").match, true);
  });

  test("ignores case and punctuation differences", () => {
    assert.equal(compareChannelNames("FILMRISE-HORROR", "FilmRise Horror").match, true);
  });

  test("matches on containment, so a suffixed name still passes", () => {
    assert.equal(compareChannelNames("FilmRise Horror HD", "FilmRise Horror").match, true);
  });

  test("flags genuinely different channels — the mispairing this exists to catch", () => {
    assert.equal(compareChannelNames("Forensic Files", "FilmRise Horror").match, false);
  });

  test("returns null (unknown) rather than false when a name is unavailable", () => {
    assert.equal(compareChannelNames(null, "FilmRise Horror").match, null);
  });
});

describe("extractAssetId", () => {
  test("pulls the asset id out of a segment path", () => {
    assert.equal(
      extractAssetId("https://live-content.xumo.com/3845/content/XM08RIB78GYPVR/28846714/6_059.ts"),
      "XM08RIB78GYPVR"
    );
  });

  test("keys on the /content/ path, not the hostname — CDN swaps must not break it", () => {
    const id = "XM05M7E0PC09SI";
    for (const host of ["live-content.xumo.com", "live-content.cdn.xumo.com", "live-content-cf.xumo.com"]) {
      assert.equal(extractAssetId(`https://${host}/149/content/${id}/28980908/6_004.ts`), id, host);
    }
  });

  test("falls back to the aid= param on a beacon-wrapped segment", () => {
    const url =
      "https://hls-beacons.xumo.com/hlsstream/v1/beacon?url=https%3A%2F%2Flive-content.xumo.com%2F3845%2F" +
      "content%2FXM08RIB78GYPVR%2F28846714%2F6_064.ts&aid=XM08RIB78GYPVR&eventType=ASSET&cid=88884008";
    assert.equal(extractAssetId(url), "XM08RIB78GYPVR");
  });

  test("returns null when there's no asset id to find", () => {
    assert.equal(extractAssetId("https://example.com/media/seg1.ts"), null);
    assert.equal(extractAssetId(""), null);
    assert.equal(extractAssetId(null), null);
  });
});

describe("parseMediaPlaylistAssets", () => {
  const playlist = fx("hls-media-with-assets.m3u8");
  const transition = fx("hls-media-asset-transition.m3u8");
  const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

  test("reads every segment and resolves one asset id across them", () => {
    const r = parseMediaPlaylistAssets(playlist, NOW);
    assert.equal(r.segments.length, 5);
    assert.equal(r.liveEdgeAssetId, "XM08RIB78GYPVR");
    assert.ok(r.segments.every((s) => s.assetId === "XM08RIB78GYPVR"), "beacon-wrapped segment must resolve too");
  });

  test("anchors the last segment's end at now and interpolates backwards", () => {
    const r = parseMediaPlaylistAssets(playlist, NOW);
    const last = r.segments[r.segments.length - 1];
    assert.equal(last.endMs, NOW);
    assert.equal(last.startMs, NOW - 6005);
    // each earlier segment ends where the next begins
    for (let i = 1; i < r.segments.length; i++) {
      assert.equal(r.segments[i - 1].endMs, r.segments[i].startMs);
    }
  });

  test("reports the window length so a caller knows how far back it can see", () => {
    const r = parseMediaPlaylistAssets(playlist, NOW);
    assert.ok(Math.abs(r.windowSeconds - 30.025) < 0.001);
  });

  test("no transitions when the whole window is one asset", () => {
    assert.deepEqual(parseMediaPlaylistAssets(playlist, NOW).transitions, []);
  });

  test("detects an asset change inside the window and estimates when it happened", () => {
    const r = parseMediaPlaylistAssets(transition, NOW);
    assert.equal(r.liveEdgeAssetId, "XM05M7E0PC09SI");
    assert.equal(r.transitions.length, 1);
    const [t] = r.transitions;
    assert.equal(t.fromAssetId, "XM08RIB78GYPVR");
    assert.equal(t.toAssetId, "XM05M7E0PC09SI");
    // 3 segments of 6s follow the boundary, so it sits 18s before the live edge
    assert.equal(t.atMs, NOW - 18000);
  });

  test("an empty playlist yields nothing rather than throwing", () => {
    const r = parseMediaPlaylistAssets("#EXTM3U\n", NOW);
    assert.equal(r.segments.length, 0);
    assert.equal(r.liveEdgeAssetId, null);
  });
});

describe("findScheduledAt", () => {
  const sched = [
    { startMs: 1000, stopMs: 2000, assetId: "A" },
    { startMs: 2000, stopMs: 3000, assetId: "B" },
  ];
  test("finds the entry covering an instant", () => {
    assert.equal(findScheduledAt(sched, 1500).assetId, "A");
    assert.equal(findScheduledAt(sched, 2500).assetId, "B");
  });
  test("boundaries are half-open — the instant belongs to the programme starting then", () => {
    assert.equal(findScheduledAt(sched, 2000).assetId, "B");
  });
  test("returns null outside the schedule", () => {
    assert.equal(findScheduledAt(sched, 500), null);
    assert.equal(findScheduledAt(sched, 9999), null);
  });
});

describe("comparePlaybackToSchedule", () => {
  const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
  const playing = (id) => ({ liveEdgeAssetId: id, transitions: [] });

  const schedule = [
    { startMs: NOW - 3600000, stopMs: NOW - 1800000, assetId: "XMEARLIER", title: "Earlier" },
    { startMs: NOW - 1800000, stopMs: NOW + 1800000, assetId: "XMNOW", title: "Should Be Playing" },
    { startMs: NOW + 1800000, stopMs: NOW + 3600000, assetId: "XMLATER", title: "Later" },
  ];

  test("match when the right asset is playing", () => {
    const r = comparePlaybackToSchedule(playing("XMNOW"), schedule, NOW);
    assert.equal(r.status, "match");
    assert.equal(r.expected.title, "Should Be Playing");
  });

  test("wrong-asset when something else scheduled is playing instead", () => {
    const r = comparePlaybackToSchedule(playing("XMLATER"), schedule, NOW);
    assert.equal(r.status, "wrong-asset");
    assert.equal(r.expected.assetId, "XMNOW");
    assert.equal(r.scheduledForPlaying.assetId, "XMLATER", "should identify what it found instead");
  });

  test("unscheduled when the playing asset appears nowhere in the schedule", () => {
    assert.equal(comparePlaybackToSchedule(playing("XMGHOST"), schedule, NOW).status, "unscheduled");
  });

  test("no-asset-id when the playlist had no id to read", () => {
    assert.equal(comparePlaybackToSchedule(playing(null), schedule, NOW).status, "no-asset-id");
  });

  test("no-schedule when nothing is scheduled for this instant", () => {
    assert.equal(comparePlaybackToSchedule(playing("XMNOW"), schedule, NOW + 99999999).status, "no-schedule");
  });

  test("measures drift from an observed transition", () => {
    const playback = {
      liveEdgeAssetId: "XMNOW",
      // observed starting 45s later than the schedule says it should have
      transitions: [{ fromAssetId: "XMEARLIER", toAssetId: "XMNOW", atMs: NOW - 1800000 + 45000 }],
    };
    const r = comparePlaybackToSchedule(playback, schedule, NOW);
    assert.equal(r.status, "match", "right asset, just late");
    assert.equal(r.drift.seconds, 45);
    assert.equal(r.drift.basis, "observed-transition");
  });

  test("no drift figure when this poll didn't capture the transition", () => {
    assert.equal(comparePlaybackToSchedule(playing("XMNOW"), schedule, NOW).drift, null);
  });

  test("asset id comparison ignores case", () => {
    assert.equal(comparePlaybackToSchedule(playing("xmnow"), schedule, NOW).status, "match");
  });
});

describe("schedule normalizers", () => {
  test("XMLTV normalizes programme-id into the shared assetId field", () => {
    const n = normalizeXmltvSchedule(parseXmltv(xmltvMovies));
    assert.equal(n[0].assetId, "XM03Z0K05Q9CN4");
    assert.equal(n[0].title, "Raging Sharks");
    assert.equal(n[0].source, "xmltv");
  });

  test("Gracenote normalizes remoteId into the same field", () => {
    const n = normalizeGracenoteSchedule(parseGracenoteSchedule(gnStitched));
    assert.equal(n[0].assetId, "XM03Z0K05Q9CN4");
    assert.equal(n[0].source, "gracenote");
  });

  test("both sources produce the same asset timeline, so downstream is source-agnostic", () => {
    const x = normalizeXmltvSchedule(parseXmltv(xmltvMovies));
    const g = normalizeGracenoteSchedule(parseGracenoteSchedule(gnStitched));
    assert.deepEqual(
      x.map((p) => [p.startMs, p.assetId]),
      g.map((p) => [p.startMs, p.assetId])
    );
  });

  test("a playback check gives the same verdict whichever source it was handed", () => {
    const at = Date.UTC(2026, 7, 25, 23, 30, 0); // inside the first programme
    const playback = { liveEdgeAssetId: "XM03Z0K05Q9CN4", transitions: [] };
    const viaXmltv = comparePlaybackToSchedule(playback, normalizeXmltvSchedule(parseXmltv(xmltvMovies)), at);
    const viaGn = comparePlaybackToSchedule(
      playback,
      normalizeGracenoteSchedule(parseGracenoteSchedule(gnStitched)),
      at
    );
    assert.equal(viaXmltv.status, "match");
    assert.equal(viaGn.status, "match");
  });
});

describe("buildComparisonCsv", () => {
  const xumo = parseXmltv(xmltvMovies).programmes;
  const report = compareSchedules(xumo, parseGracenoteSchedule(gnDrift).programmes);
  const csv = buildComparisonCsv(report);
  const rows = csv.trim().split("\n");

  test("emits a header plus one row per programme slot from both sides", () => {
    assert.match(rows[0], /^status,xumo_start_utc,gracenote_start_utc,delta_seconds,title,/);
    // 4 paired + 1 only-in-xumo
    assert.equal(rows.length - 1, 5);
  });

  test("labels each row with its verdict", () => {
    const statuses = rows.slice(1).map((r) => r.split(",")[0]);
    assert.ok(statuses.includes("time-drift"));
    assert.ok(statuses.includes("tms-mismatch"));
    assert.ok(statuses.includes("no-tms-mapping"));
    assert.ok(statuses.includes("only-in-xumo"));
    assert.ok(statuses.includes("ok"));
  });

  test("quotes fields containing commas so the CSV can't be shifted by a title", () => {
    const tricky = buildComparisonCsv({
      matched: [
        {
          xumo: { startMs: 0, title: 'Movie, With "Commas"', tmsId: "MV1", programmeId: "XM1" },
          gracenote: { startMs: 0, tmsId: "MV1", remoteId: "XM1" },
          deltaSeconds: 0,
          tmsComparable: true,
          timeDrift: false,
          tmsMismatch: false,
          assetMismatch: false,
        },
      ],
      onlyInXumo: [],
      onlyInGracenote: [],
    });
    assert.match(tricky, /"Movie, With ""Commas"""/);
    assert.equal(tricky.trim().split("\n").length, 2, "an embedded comma must not add a row");
  });

  test("an empty comparison still produces a valid header-only CSV", () => {
    const empty = buildComparisonCsv({ matched: [], onlyInXumo: [], onlyInGracenote: [] });
    assert.equal(empty.trim().split("\n").length, 1);
  });
});

describe("gracenoteScheduleUrl / addDays", () => {
  test("builds a /Schedules URL with the user's key and window", () => {
    const url = gracenoteScheduleUrl({
      apiKey: "TESTKEY",
      prgSvcId: "156201",
      startDate: "2026-08-25",
      endDate: "2026-08-27",
    });
    assert.match(url, /^https:\/\/on-api\.gracenote\.com\/v3\/Schedules\?/);
    assert.match(url, /api_key=TESTKEY/);
    assert.match(url, /prgSvcId=156201/);
    assert.match(url, /startDate=2026-08-25/);
  });

  test("url-encodes a key containing special characters", () => {
    const url = gracenoteScheduleUrl({ apiKey: "a&b=c", prgSvcId: "1", startDate: "2026-01-01", endDate: "2026-01-02" });
    assert.ok(url.includes("api_key=a%26b%3Dc"), "an unescaped & would truncate the key");
  });

  test("addDays rolls across month and year boundaries", () => {
    assert.equal(addDays("2026-08-25", 2), "2026-08-27");
    assert.equal(addDays("2026-12-30", 2), "2027-01-01");
    assert.equal(addDays("2024-02-28", 2), "2024-03-01"); // leap year
    assert.equal(addDays("garbage", 2), null);
  });
});
