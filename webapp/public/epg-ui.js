// "EPG drift" panel — diffs a Gracenote schedule against the platform's
// own XMLTV feed for the same channel.
//
// Credential policy (see CONTEXT.md): this app stores no Gracenote key.
// The user supplies their own, it lives in this module's memory for the
// lifetime of the page, and it is never persisted. It does transit
// /api/fetch as part of the constructed Gracenote URL — unavoidable, since
// on-api.gracenote.com sets no CORS headers — so every error path here
// redacts it before anything reaches the DOM.

import {
  parseXmltv,
  parseGracenoteSchedule,
  parseGracenoteSourceName,
  compareSchedules,
  compareChannelNames,
  gracenoteScheduleUrl,
  gracenoteSourceUrl,
  buildComparisonCsv,
  addDays,
} from "./epg.js";
import { fetchViaProxy } from "./net.js";
import { escapeHtml, glossaryTerm } from "./glossary.js";

const $ = (id) => document.getElementById(id);
const keyInput = $("epg-key");
const prgSvcInput = $("epg-prgsvcid");
const xmltvInput = $("epg-xmltv-url");
const dateInput = $("epg-date");
const daysInput = $("epg-days");
const toleranceInput = $("epg-tolerance");
const runBtn = $("epg-run");
const downloadBtn = $("epg-download");
const statusEl = $("epg-status");
const channelEl = $("epg-channel");
const outputEl = $("epg-output");

// Default the date picker to today (UTC). <input type="date"> always
// exchanges values as YYYY-MM-DD regardless of the locale it displays in,
// which is exactly what Gracenote's startDate/endDate expect.
dateInput.value = new Date().toISOString().slice(0, 10);

// Keeps a leaked key out of the DOM if an error message happens to carry
// the request URL.
function redact(s) {
  return String(s).replace(/api_key=[^&\s"']+/gi, "api_key=***");
}

function fmtTime(ms) {
  if (ms === null || ms === undefined) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function signed(n) {
  return (n > 0 ? "+" : "") + n + "s";
}

function renderChannelConfirmation(cmp, xumoChannelId) {
  const gn = escapeHtml(cmp.gracenoteName ?? "(name unavailable)");
  const xu = escapeHtml(cmp.xumoDisplayName ?? "(name unavailable)");
  const id = escapeHtml(xumoChannelId ?? "?");
  let mark;
  let cls = "";
  if (cmp.match === true) {
    mark = "✓ same channel";
  } else if (cmp.match === false) {
    mark = "⚠ names differ — are these the same channel?";
    cls = "warn";
  } else {
    mark = "· couldn't confirm (a name was unavailable)";
  }
  channelEl.className = "status " + cls;
  channelEl.innerHTML =
    `Gracenote: <strong>${gn}</strong> &nbsp;·&nbsp; Xumo: <strong>${xu}</strong> ` +
    `(channel ${id}) &nbsp;·&nbsp; ${escapeHtml(mark)}`;
}

// Caps a long list, but says so — silently showing 50 of 200 findings
// would understate real drift.
function listSection(lines, label, items, render, limit = 50) {
  if (!items.length) return;
  lines.push("");
  lines.push(`${label} (${items.length})`);
  for (const it of items.slice(0, limit)) lines.push(render(it));
  if (items.length > limit) {
    lines.push(`  … and ${items.length - limit} more (download the CSV for the full list)`);
  }
}

function renderReport(report, warnings) {
  const s = report.summary;
  const lines = [];

  for (const w of warnings) lines.push(`⚠ ${escapeHtml(w)}`);
  if (warnings.length) lines.push("");

  lines.push("SUMMARY");
  lines.push(`  programmes         : ${s.xumoTotal} Xumo · ${s.gracenoteTotal} Gracenote`);
  lines.push(`  paired on start    : ${s.paired}`);
  lines.push(`  ${glossaryTerm("start-time drift")}   : ${s.timeDrifts}`);
  lines.push(`  ${glossaryTerm("TMS ID")} mismatches  : ${s.tmsMismatches} of ${s.tmsComparable} comparable`);
  if (s.noTmsMapping) {
    lines.push(`  ${glossaryTerm("no TMS mapping")}     : ${s.noTmsMapping} (excluded — not counted as mismatches)`);
  }
  if (s.assetComparable) {
    lines.push(
      `  asset id mismatches: ${s.assetMismatches} of ${s.assetComparable} comparable ` +
        `(Xumo programme-id vs Gracenote ${glossaryTerm("remoteId")})`
    );
  }
  lines.push(`  only in Xumo       : ${s.onlyInXumo}`);
  lines.push(`  only in Gracenote  : ${s.onlyInGracenote}`);
  lines.push(
    `  alignment          : ${s.alignmentPct === null ? "n/a (nothing comparable)" : s.alignmentPct + "%"}`
  );

  const issues = report.matched.filter((m) => m.timeDrift || m.tmsMismatch || m.assetMismatch);
  listSection(lines, "MISMATCHES", issues, (m) => {
    const what = [];
    if (m.timeDrift) what.push(`start ${signed(m.deltaSeconds)}`);
    if (m.tmsMismatch) what.push(`TMS ${escapeHtml(m.xumo.tmsId)} vs ${escapeHtml(m.gracenote.tmsId)}`);
    if (m.assetMismatch) what.push(`asset ${escapeHtml(m.xumo.programmeId)} vs ${escapeHtml(m.gracenote.remoteId)}`);
    return `  ${fmtTime(m.xumo.startMs)}  ${escapeHtml(m.xumo.title ?? "?")}\n      ${what.join(" · ")}`;
  });

  listSection(
    lines,
    "ONLY IN XUMO",
    report.onlyInXumo,
    (p) => `  ${fmtTime(p.startMs)}  ${escapeHtml(p.title ?? "?")}`
  );
  listSection(
    lines,
    "ONLY IN GRACENOTE",
    report.onlyInGracenote,
    (p) => `  ${fmtTime(p.startMs)}  ${escapeHtml(p.tmsId ?? "?")}`
  );
  listSection(
    lines,
    "NO TMS MAPPING — reported, not counted against alignment",
    report.matched.filter((m) => !m.tmsComparable),
    (m) => `  ${fmtTime(m.xumo.startMs)}  ${escapeHtml(m.xumo.title ?? "?")}`
  );

  outputEl.innerHTML = lines.join("\n");
}

// Holds the most recent comparison so the CSV button has something to
// serialize; cleared whenever a new run starts.
let lastReport = null;

downloadBtn.addEventListener("click", () => {
  if (!lastReport) return;
  const blob = new Blob([buildComparisonCsv(lastReport)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `epg_drift_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

runBtn.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  const prgSvcId = prgSvcInput.value.trim();
  const xmltvUrl = xmltvInput.value.trim();
  const startDate = dateInput.value;
  const days = Math.max(1, parseInt(daysInput.value, 10) || 2);
  const driftToleranceSeconds = Math.max(0, parseInt(toleranceInput.value, 10) || 0);

  outputEl.innerHTML = "";
  channelEl.innerHTML = "";
  channelEl.className = "status";
  statusEl.classList.remove("warn");
  lastReport = null;
  downloadBtn.disabled = true;

  if (!apiKey || !prgSvcId || !xmltvUrl || !startDate) {
    statusEl.textContent = "Need a Gracenote key, a prgSvcId, an XMLTV URL, and a start date.";
    return;
  }

  const endDate = addDays(startDate, days);
  if (!endDate) {
    statusEl.textContent = "Start date is not a valid YYYY-MM-DD date.";
    return;
  }

  runBtn.disabled = true;
  try {
    statusEl.textContent = "Fetching XMLTV…";
    const xmltvText = (await fetchViaProxy(xmltvUrl)).text;

    statusEl.textContent = "Fetching Gracenote schedule…";
    const schedText = (await fetchViaProxy(gracenoteScheduleUrl({ apiKey, prgSvcId, startDate, endDate }))).text;

    // Channel name is only a confirmation signal, so a failure here must
    // not sink the comparison itself.
    let gracenoteName = null;
    try {
      statusEl.textContent = "Fetching Gracenote channel name…";
      gracenoteName = parseGracenoteSourceName((await fetchViaProxy(gracenoteSourceUrl({ apiKey, prgSvcId }))).text);
    } catch {
      gracenoteName = null;
    }

    statusEl.textContent = "Comparing…";
    const xumo = parseXmltv(xmltvText);
    const gn = parseGracenoteSchedule(schedText);

    renderChannelConfirmation(compareChannelNames(gracenoteName, xumo.channel.displayName), xumo.channel.id);

    const report = compareSchedules(xumo.programmes, gn.programmes, { driftToleranceSeconds });
    renderReport(report, [...xumo.warnings, ...gn.warnings]);

    lastReport = report;
    downloadBtn.disabled = false;

    const s = report.summary;
    const clean = s.timeDrifts === 0 && s.tmsMismatches === 0 && s.onlyInXumo === 0 && s.onlyInGracenote === 0;
    statusEl.textContent = clean ? "No drift detected." : "Differences found — see below.";
    statusEl.classList.toggle("warn", !clean);
  } catch (e) {
    statusEl.textContent = `Error: ${redact(e.message)}`;
    statusEl.classList.add("warn");
  } finally {
    runBtn.disabled = false;
  }
});
