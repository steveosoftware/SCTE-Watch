import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { GLOSSARY, escapeHtml, glossaryTerm, linkifyTagLine } from "../../public/glossary.js";

describe("escapeHtml", () => {
  test("escapes all five HTML-significant characters", () => {
    assert.equal(escapeHtml(`<script>&"'</script>`), "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
  });

  test("passes plain text through unchanged", () => {
    assert.equal(escapeHtml("time_signal"), "time_signal");
  });
});

describe("glossaryTerm — XSS invariant", () => {
  test("a known glossary key renders as a clickable span", () => {
    const html = glossaryTerm("time_signal");
    assert.match(html, /^<span class="glossary-term" data-term="time_signal">time_signal<\/span>$/);
  });

  test("SECURITY: attacker-controlled text that isn't a known key is never wrapped in a live element — only escaped", () => {
    // This simulates a UPID decoded straight from untrusted payload bytes
    // (see decodeUpid in scte35.js) — exactly the kind of string that
    // reaches glossaryTerm() with attacker control over its contents.
    const malicious = `<img src=x onerror=alert(1)>`;
    const html = glossaryTerm(malicious);
    assert.ok(!html.includes("<img"), "must not emit a live <img> tag");
    assert.ok(!html.includes("<span"), "must not wrap unrecognized text in any live element");
    assert.equal(html, escapeHtml(malicious), "must fall back to plain escaping");
  });

  test("SECURITY: a value that collides with a glossary key by accident is still just inert display text", () => {
    // If attacker-controlled content happens to literally equal a glossary
    // key, wrapping it in a span is still safe — the span's only child is
    // the escaped, identical text, so this can't be used to smuggle markup.
    // This test documents that assumption explicitly.
    const html = glossaryTerm("time_signal");
    assert.ok(!/[<>]/.test(html.replace(/<\/?span[^>]*>/g, "")), "span contents must contain no unescaped angle brackets");
  });

  test("every GLOSSARY key round-trips through glossaryTerm as a span with no injected markup", () => {
    for (const key of Object.keys(GLOSSARY)) {
      const html = glossaryTerm(key);
      const expected = `<span class="glossary-term" data-term="${escapeHtml(key)}">${escapeHtml(key)}</span>`;
      assert.equal(html, expected, `glossary key "${key}" did not render as expected`);
    }
  });
});

describe("linkifyTagLine", () => {
  test("linkifies a known HLS tag and escapes the untrusted attribute text that follows", () => {
    const line = `#EXT-X-DATERANGE:ID="x",SCTE35-OUT=0xFC30<script>`;
    const html = linkifyTagLine(line);
    assert.match(html, /^#<span class="glossary-term" data-term="EXT-X-DATERANGE">EXT-X-DATERANGE<\/span>/);
    assert.ok(!html.includes("<script>"), "attribute text must be escaped, not passed through raw");
    assert.ok(html.includes("&lt;script&gt;"), "the escaped form of the payload must be present");
  });

  test("longest-prefix match: EXT-X-CUE-OUT-CONT is not mistaken for EXT-X-CUE-OUT or EXT-X-CUE", () => {
    const html = linkifyTagLine("#EXT-X-CUE-OUT-CONT:12/34");
    assert.match(html, /data-term="EXT-X-CUE-OUT-CONT"/);
  });

  test("an unrecognized tag is escaped wholesale, not partially linkified", () => {
    const html = linkifyTagLine(`#EXT-X-VERSION:3`);
    assert.equal(html, escapeHtml(`#EXT-X-VERSION:3`));
  });

  test("SECURITY: a non-tag line with attacker content is never linkified, only escaped", () => {
    const html = linkifyTagLine(`<b>not a tag</b>`);
    assert.equal(html, escapeHtml(`<b>not a tag</b>`));
  });
});

describe("linkifyTagLine — EXT-X-MEDIA captions/subtitles/language", () => {
  test("links the EXT-X-MEDIA tag itself", () => {
    const html = linkifyTagLine(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs_en.m3u8"`);
    assert.match(html, /^#<span class="glossary-term" data-term="EXT-X-MEDIA">EXT-X-MEDIA<\/span>/);
  });

  test("links TYPE=SUBTITLES to its own definition, distinct from the tag", () => {
    const html = linkifyTagLine(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",URI="subs_en.m3u8"`);
    assert.match(html, /TYPE=<span class="glossary-term" data-term="SUBTITLES">SUBTITLES<\/span>/);
  });

  test("links TYPE=CLOSED-CAPTIONS and INSTREAM-ID for embedded captions", () => {
    const html = linkifyTagLine(`#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",LANGUAGE="es",INSTREAM-ID="CC1"`);
    assert.match(html, /TYPE=<span class="glossary-term" data-term="CLOSED-CAPTIONS">CLOSED-CAPTIONS<\/span>/);
    assert.match(html, /<span class="glossary-term" data-term="INSTREAM-ID">INSTREAM-ID<\/span>=&quot;CC1&quot;/);
  });

  test("links the LANGUAGE attribute name but leaves the language code itself as plain text", () => {
    const html = linkifyTagLine(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="es-419",URI="aud_es.m3u8"`);
    assert.match(html, /<span class="glossary-term" data-term="LANGUAGE">LANGUAGE<\/span>=&quot;es-419&quot;/);
    assert.ok(!html.includes('data-term="es-419"'), "the language code itself must not be wrapped as a glossary term");
  });

  test("does not confuse ASSOC-LANGUAGE with LANGUAGE", () => {
    const html = linkifyTagLine(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",ASSOC-LANGUAGE="es"`);
    assert.match(html, /<span class="glossary-term" data-term="ASSOC-LANGUAGE">ASSOC-LANGUAGE<\/span>=&quot;es&quot;/);
  });
});

describe("linkifyTagLine — DASH Role/Accessibility/lang", () => {
  test("links the Role element and its subtitle value", () => {
    const html = linkifyTagLine(`  <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>`);
    assert.match(html, /&lt;<span class="glossary-term" data-term="Role">Role<\/span>/);
    assert.match(html, /value=&quot;<span class="glossary-term" data-term="subtitle">subtitle<\/span>&quot;/);
  });

  test("links the Accessibility element for embedded captions signaling", () => {
    const html = linkifyTagLine(`  <Accessibility schemeIdUri="urn:scte:dash:cc:cea-608:2015" value="CC1=eng"/>`);
    assert.match(html, /&lt;<span class="glossary-term" data-term="Accessibility">Accessibility<\/span>/);
  });

  test("links the lang attribute name but leaves the language code as plain text", () => {
    const html = linkifyTagLine(`  <AdaptationSet contentType="text" lang="fr-CA">`);
    assert.match(html, /<span class="glossary-term" data-term="lang">lang<\/span>=&quot;fr-CA&quot;/);
    assert.ok(!html.includes('data-term="fr-CA"'), "the language code itself must not be wrapped as a glossary term");
  });

  test("SECURITY: attacker content inside a Role-like line is still just escaped, not executed", () => {
    const html = linkifyTagLine(`  <Role value="subtitle"><script>alert(1)</script>`);
    assert.ok(!html.includes("<script>"), "must not pass through a raw script tag");
    assert.ok(html.includes("&lt;script&gt;"), "the escaped form of the payload must be present");
  });
});
