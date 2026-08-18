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
