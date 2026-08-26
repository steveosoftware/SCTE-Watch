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
  addDays,
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
  test("accepts raw seconds", () => assert.equal(parseDurationSeconds("6193"), 6193));
  test("accepts HH:MM:SS", () => assert.equal(parseDurationSeconds("1:43:13"), 6193));
  test("accepts MM:SS", () => assert.equal(parseDurationSeconds("02:30"), 150));
  test("returns null on garbage", () => assert.equal(parseDurationSeconds("soon"), null));
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
