// Standalone "Validate a VAST/VMAP ad response" panel — same pattern as
// app.js's SCTE-35 string decoder: paste input, get structured output.
// Unrelated to playback/polling. Accepts either a URL (fetched through the
// same SSRF-guarded /api/fetch proxy everything else uses — ad servers
// generally don't set CORS headers either) or raw XML pasted directly.

import { detectVastVmap, parseVast, parseVmap, resolveVastChain } from "./vast.js";
import { fetchViaProxy } from "./net.js";
import { escapeHtml, glossaryTerm } from "./glossary.js";

const $ = (id) => document.getElementById(id);
const input = $("vast-input");
const btn = $("vast-btn");
const statusEl = $("vast-status");
const outputEl = $("vast-output");

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s.trim());
}

const fetchText = async (url) => (await fetchViaProxy(url)).text;

function renderAd(ad) {
  const lines = [];
  lines.push(`  ${glossaryTerm(ad.isWrapper ? "Wrapper" : "InLine")}${ad.id ? ` (id=${escapeHtml(ad.id)})` : ""}`);
  if (ad.adSystem) lines.push(`    ${glossaryTerm("AdSystem")}     : ${escapeHtml(ad.adSystem)}`);
  if (ad.adTitle) lines.push(`    title          : ${escapeHtml(ad.adTitle)}`);
  if (ad.isWrapper) {
    lines.push(`    next VAST      : ${ad.wrapperAdTagUri ? escapeHtml(ad.wrapperAdTagUri) : "(missing VASTAdTagURI — chain is broken here)"}`);
  }
  if (ad.impressions.length) {
    lines.push(`    ${glossaryTerm("Impression")}(s) : ${ad.impressions.length}`);
  }
  if (ad.errorUrls.length) {
    lines.push(`    error pixels   : ${ad.errorUrls.length}`);
  }
  if (!ad.isWrapper && !ad.creatives.length) {
    lines.push(`    (no creatives found)`);
  }
  ad.creatives.forEach((c, i) => {
    lines.push(`    creative[${i + 1}]     : ${glossaryTerm(c.type)}`);
    if (c.type !== "Linear") return;
    if (c.duration) lines.push(`      duration     : ${escapeHtml(c.duration)}`);
    if (c.clickThrough) lines.push(`      ${glossaryTerm("ClickThrough")}  : ${escapeHtml(c.clickThrough)}`);
    if (c.clickTrackingUrls.length) lines.push(`      ${glossaryTerm("ClickTracking")}  : ${c.clickTrackingUrls.length} pixel(s)`);
    if (c.mediaFiles.length) {
      lines.push(`      ${glossaryTerm("MediaFile")}(s)  :`);
      for (const mf of c.mediaFiles) {
        const dims = mf.width && mf.height ? `${escapeHtml(mf.width)}x${escapeHtml(mf.height)} ` : "";
        const rate = mf.bitrate ? `@${escapeHtml(mf.bitrate)}kbps ` : "";
        lines.push(`        - ${escapeHtml(mf.type ?? "?")} ${dims}${rate}: ${escapeHtml(mf.url)}`);
      }
    }
    const eventNames = Object.keys(c.trackingEvents);
    if (eventNames.length) {
      lines.push(`      ${glossaryTerm("TrackingEvents")}: ${eventNames.map(escapeHtml).join(", ")}`);
    }
  });
  return lines.join("\n");
}

function renderVastHops(hops, truncated) {
  const lines = [`${glossaryTerm("VAST")} — ${hops.length} hop${hops.length === 1 ? "" : "s"} in the wrapper chain`];
  hops.forEach((parsed, i) => {
    lines.push(`hop ${i + 1}${parsed.version ? ` (version ${escapeHtml(parsed.version)})` : ""}:`);
    if (!parsed.ads.length) {
      lines.push(`  (no <Ad> elements found)`);
    } else {
      for (const ad of parsed.ads) lines.push(renderAd(ad));
    }
  });
  if (truncated) lines.push(`⚠ wrapper chain did not resolve to an InLine ad within the hop limit`);
  return lines.join("\n");
}

async function renderVmap(vmap) {
  const lines = [`${glossaryTerm("VMAP")} — ${vmap.adBreaks.length} ${glossaryTerm("AdBreak")}(s)`];
  for (const [i, brk] of vmap.adBreaks.entries()) {
    const id = brk.breakId ? `  id=${escapeHtml(brk.breakId)}` : "";
    lines.push(`break[${i + 1}]  type=${escapeHtml(brk.breakType ?? "?")}  timeOffset=${escapeHtml(brk.timeOffset ?? "?")}${id}`);
    let vastText = brk.inlineVastXml;
    if (!vastText && brk.adTagUri) {
      lines.push(`  fetching ad tag: ${escapeHtml(brk.adTagUri)}`);
      try {
        vastText = await fetchText(brk.adTagUri);
      } catch (e) {
        lines.push(`  fetch error: ${escapeHtml(e.message)}`);
        continue;
      }
    }
    if (!vastText) {
      lines.push(`  (no inline VAST and no AdTagURI — empty ad break)`);
      continue;
    }
    const { hops, truncated } = await resolveVastChain(vastText, { fetchText });
    lines.push(
      renderVastHops(hops, truncated)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n")
    );
  }
  return lines.join("\n");
}

btn.addEventListener("click", async () => {
  const raw = input.value.trim();
  outputEl.innerHTML = "";
  statusEl.textContent = "";
  if (!raw) return;
  statusEl.textContent = "Validating…";
  try {
    let text = raw;
    if (looksLikeUrl(raw)) {
      statusEl.textContent = "Fetching…";
      text = await fetchText(raw);
    }
    const kind = detectVastVmap(text);
    if (kind === "vast") {
      const { hops, truncated } = await resolveVastChain(text, { fetchText });
      outputEl.innerHTML = renderVastHops(hops, truncated);
    } else if (kind === "vmap") {
      outputEl.innerHTML = await renderVmap(parseVmap(text));
    } else {
      statusEl.textContent = "Not recognized as VAST or VMAP — check the pasted URL/XML.";
      return;
    }
    statusEl.textContent = "Validated.";
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
});
