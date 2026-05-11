import test from "node:test";
import assert from "node:assert/strict";

import { detectSubscriptionStatus } from "../src/statusDetector.js";

test("detects unsubscribe phrases from status-like columns", () => {
  assert.equal(detectSubscriptionStatus({ Status: "Unsubscribed" }), "unsubscribed");
  assert.equal(detectSubscriptionStatus({ Remarks: "client said STOP" }), "unsubscribed");
  assert.equal(detectSubscriptionStatus({ Notes: "please remove from list" }), "unsubscribed");
});

test("unsubscribe wins over subscribe if both appear", () => {
  assert.equal(detectSubscriptionStatus({ Status: "subscribed", Notes: "opt out requested" }), "unsubscribed");
});

test("defaults to subscribed when no status is mentioned", () => {
  assert.equal(detectSubscriptionStatus({ Name: "Aisha", Company: "Acme" }), "subscribed");
});

