import test from "node:test";
import assert from "node:assert/strict";

import { excelSafePhone, normalizePhone } from "../src/phone.mjs";

test("normalizes UAE phone numbers", () => {
  const cases = new Map([
    ["0552605247", "+971552605247"],
    ["552605247", "+971552605247"],
    ["971552605247", "+971552605247"],
    ["00971552605247", "+971552605247"],
    ["+971 55 260 5247", "+971552605247"]
  ]);
  for (const [raw, expected] of cases) {
    const result = normalizePhone(raw, "AE");
    assert.equal(result.valid, true, result.reason);
    assert.equal(result.e164, expected);
    assert.equal(result.country, "AE");
  }
});

test("normalizes Saudi phone numbers", () => {
  const cases = new Map([
    ["0551234567", "+966551234567"],
    ["551234567", "+966551234567"],
    ["966551234567", "+966551234567"],
    ["00966551234567", "+966551234567"],
    ["+966 55 123 4567", "+966551234567"]
  ]);
  for (const [raw, expected] of cases) {
    const result = normalizePhone(raw, "SA");
    assert.equal(result.valid, true, result.reason);
    assert.equal(result.e164, expected);
    assert.equal(result.country, "SA");
  }
});

test("formats Excel-safe phone values", () => {
  assert.equal(excelSafePhone("+971552605247"), '="+971552605247"');
});

