// VAST/VMAP (video ad response) parsing — pure logic, DOM-free, same style
// as scte35.js's DASH parsing: regex against the raw XML text rather than
// DOMParser, so this runs under plain Node for tests without a jsdom
// dependency and stays portable to a future server-side use if one ever
// comes up.
//
// Security note: everything parsed out of a VAST/VMAP document is
// attacker-controlled to the same degree a manifest is (arguably more —
// ad tech is a notoriously hostile threat surface). vast-ui.js is
// responsible for running every extracted value through escapeHtml() and
// only ever wrapping fixed, known vocabulary (element/attribute names, not
// content) in a glossary span — this module itself does no HTML rendering
// at all, only structured extraction.

function unwrapCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return (m ? m[1] : s).trim();
}

function textOfTag(tagName, xml) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = re.exec(xml);
  return m ? unwrapCdata(m[1]) : null;
}

function allTagText(tagName, xml) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(unwrapCdata(m[1]));
  return out;
}

function attr(name, attrsStr) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrsStr || "");
  return m ? m[1] : null;
}

// "vast" | "vmap" | null, based on the *root* element — same auto-detect
// role parseMaster()/findDashScte35Events() play for HLS vs DASH. Checked
// against the start of the document, not "found anywhere," because a VMAP
// document's inline VASTAdData legitimately embeds a full nested <VAST>
// element — a substring search would misidentify that as VAST.
export function detectVastVmap(text) {
  const root = text.replace(/^\uFEFF/, "").replace(/<\?xml[^>]*\?>/i, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (/^<(?:vmap:)?VMAP\b/i.test(root)) return "vmap";
  if (/^<VAST\b/i.test(root)) return "vast";
  return null;
}

// Returns {version, ads: [{id, isWrapper, adSystem, adTitle,
// wrapperAdTagUri, errorUrls, impressions, creatives}]}. creatives is
// [{type: "Linear"|"Companion"|"NonLinear", duration, mediaFiles,
// trackingEvents, clickThrough, clickTrackingUrls}] — Companion/NonLinear
// entries carry only `type` today (detection, not full parsing; nothing
// in this app renders a companion banner).
export function parseVast(text) {
  const versionMatch = /<VAST\b[^>]*\bversion\s*=\s*"([^"]*)"/i.exec(text);
  const version = versionMatch ? versionMatch[1] : null;

  const ads = [];
  const adRe = /<Ad\b([^>]*)>([\s\S]*?)<\/Ad>/gi;
  let adMatch;
  while ((adMatch = adRe.exec(text))) {
    const [, adAttrs, adBody] = adMatch;
    const wrapperMatch = /<Wrapper\b[^>]*>([\s\S]*?)<\/Wrapper>/i.exec(adBody);
    const inlineMatch = /<InLine\b[^>]*>([\s\S]*?)<\/InLine>/i.exec(adBody);
    const isWrapper = !!wrapperMatch;
    const container = wrapperMatch ? wrapperMatch[1] : inlineMatch ? inlineMatch[1] : adBody;

    const creatives = [];
    const creativeRe = /<Creative\b[^>]*>([\s\S]*?)<\/Creative>/gi;
    let creativeMatch;
    while ((creativeMatch = creativeRe.exec(container))) {
      const creativeBody = creativeMatch[1];
      const linearMatch = /<Linear\b[^>]*>([\s\S]*?)<\/Linear>/i.exec(creativeBody);
      if (linearMatch) {
        const linearBody = linearMatch[1];
        const mediaFiles = [];
        const mfRe = /<MediaFile\b([^>]*)>([\s\S]*?)<\/MediaFile>/gi;
        let mfMatch;
        while ((mfMatch = mfRe.exec(linearBody))) {
          const [, mfAttrs, mfBody] = mfMatch;
          mediaFiles.push({
            url: unwrapCdata(mfBody),
            type: attr("type", mfAttrs),
            bitrate: attr("bitrate", mfAttrs),
            width: attr("width", mfAttrs),
            height: attr("height", mfAttrs),
          });
        }
        const trackingEvents = {};
        const teRe = /<Tracking\b([^>]*)>([\s\S]*?)<\/Tracking>/gi;
        let teMatch;
        while ((teMatch = teRe.exec(linearBody))) {
          const [, teAttrs, teBody] = teMatch;
          const event = attr("event", teAttrs) || "unknown";
          (trackingEvents[event] ??= []).push(unwrapCdata(teBody));
        }
        creatives.push({
          type: "Linear",
          duration: textOfTag("Duration", linearBody),
          mediaFiles,
          trackingEvents,
          clickThrough: textOfTag("ClickThrough", linearBody),
          clickTrackingUrls: allTagText("ClickTracking", linearBody),
        });
      } else if (/<Companion\b/i.test(creativeBody)) {
        creatives.push({ type: "Companion" });
      } else if (/<NonLinear\b/i.test(creativeBody)) {
        creatives.push({ type: "NonLinear" });
      }
    }

    ads.push({
      id: attr("id", adAttrs),
      isWrapper,
      adSystem: textOfTag("AdSystem", container),
      adTitle: textOfTag("AdTitle", container),
      wrapperAdTagUri: isWrapper ? textOfTag("VASTAdTagURI", container) : null,
      errorUrls: allTagText("Error", container),
      impressions: allTagText("Impression", container),
      creatives,
    });
  }

  return { version, ads };
}

// Returns {adBreaks: [{breakType, timeOffset, breakId, adTagUri,
// inlineVastXml}]} — adTagUri and inlineVastXml are mutually exclusive per
// the VMAP spec (an AdSource is either a reference or inline data, never
// both); exactly one will be non-null unless the break carries neither.
export function parseVmap(text) {
  const adBreaks = [];
  const breakRe = /<(?:vmap:)?AdBreak\b([^>]*)>([\s\S]*?)<\/(?:vmap:)?AdBreak>/gi;
  let m;
  while ((m = breakRe.exec(text))) {
    const [, attrs, body] = m;
    const adTagUri = textOfTag("(?:vmap:)?AdTagURI", body);
    const vastDataMatch = /<(?:vmap:)?VASTAdData\b[^>]*>([\s\S]*?)<\/(?:vmap:)?VASTAdData>/i.exec(body);

    adBreaks.push({
      breakType: attr("breakType", attrs),
      timeOffset: attr("timeOffset", attrs),
      breakId: attr("breakId", attrs),
      adTagUri: adTagUri || null,
      inlineVastXml: vastDataMatch ? vastDataMatch[1].trim() : null,
    });
  }
  return { adBreaks };
}

const DEFAULT_MAX_VAST_HOPS = 5;

// Follows a VAST Wrapper chain (Wrapper -> VASTAdTagURI -> next VAST doc,
// repeat) the same way resolveCnameChain() walks a CNAME chain — injectable
// fetchText for testing without real network, a hop cap so a
// misconfigured/malicious chain can't loop forever. Returns
// {hops: [parseVast() result, ...], truncated} — truncated is true if the
// chain didn't reach a non-Wrapper ad (or a Wrapper with no
// VASTAdTagURI/fetchText) within maxHops.
export async function resolveVastChain(initialText, { fetchText, maxHops = DEFAULT_MAX_VAST_HOPS } = {}) {
  const hops = [];
  let text = initialText;
  for (let i = 0; i < maxHops; i++) {
    const parsed = parseVast(text);
    hops.push(parsed);
    const ad = parsed.ads[0];
    if (!ad || !ad.isWrapper || !ad.wrapperAdTagUri || !fetchText) {
      return { hops, truncated: !!(ad && ad.isWrapper) };
    }
    text = await fetchText(ad.wrapperAdTagUri);
  }
  return { hops, truncated: true };
}
