import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bytesFromBase64, decodeScte35 } from "../../public/scte35.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(path.join(__dirname, "../fixtures/scte35-payloads.json"), "utf8")
);

describe("decodeScte35 — golden-file eval suite", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    test(name, () => {
      const bytes = bytesFromBase64(fixture.base64);
      const decoded = decodeScte35(bytes);
      for (const [key, expected] of Object.entries(fixture.expect)) {
        assert.deepEqual(
          decoded[key],
          expected,
          `field "${key}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(decoded[key])}`
        );
      }
    });
  }
});

describe("decodeScte35 — pts_adjustment regression", () => {
  test("adjustment shifts pts_time_s but not break_duration_s", () => {
    const base = decodeScte35(bytesFromBase64(fixtures.splice_insert_basic.base64));
    const adjusted = decodeScte35(
      bytesFromBase64(fixtures.splice_insert_with_pts_adjustment.base64)
    );
    const baseSeconds = parseFloat(base.pts_time_s);
    const adjustedSeconds = parseFloat(adjusted.pts_time_s);
    assert.equal(
      (adjustedSeconds - baseSeconds).toFixed(3),
      "10.000",
      "pts_adjustment (10.000s in the fixture) must be added to pts_time_s"
    );
    assert.equal(
      base.break_duration_s,
      adjusted.break_duration_s,
      "break_duration_s is a relative span — pts_adjustment must not touch it"
    );
  });
});
