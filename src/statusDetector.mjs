import { cleanText } from "./phone.mjs";

const STATUS_COLUMN_HINTS = [
  "status",
  "subscription",
  "subscribe",
  "unsubscribe",
  "opt in",
  "opt out",
  "consent",
  "permission",
  "remarks",
  "remark",
  "notes",
  "comment",
  "comments",
  "action"
];

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribed\b/i,
  /\bunsubscribe\b/i,
  /\bunsub\b/i,
  /\bopt\s*out\b/i,
  /\bopted\s*out\b/i,
  /\bstop\b/i,
  /\bremove\b/i,
  /\bdo\s*not\s*contact\b/i,
  /\bdon'?t\s*contact\b/i,
  /\bsuppress(?:ed)?\b/i,
  /\bblacklist(?:ed)?\b/i,
  /\bblocked\b/i
];

const SUBSCRIBE_PATTERNS = [
  /\bsubscribed\b/i,
  /\bsubscribe\b/i,
  /\bopt\s*in\b/i,
  /\bopted\s*in\b/i,
  /\bactive\b/i,
  /\ballowed\b/i,
  /\bconsent(?:ed)?\b/i,
  /\byes\b/i
];

export function normalizeHeader(header) {
  return cleanText(header)
    .toLowerCase()
    .replace(/[_./-]+/g, " ")
    .replace(/[^a-z0-9+ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectSubscriptionStatus(row) {
  const entries = Object.entries(row || {});
  const prioritized = entries.filter(([key]) => isStatusColumn(key));
  const remaining = entries.filter(([key]) => !isStatusColumn(key));

  return detectFromEntries(prioritized) || detectFromEntries(remaining) || "subscribed";
}

export function isStatusColumn(header) {
  const normalized = normalizeHeader(header);
  return STATUS_COLUMN_HINTS.some((hint) => normalized === hint || normalized.includes(hint));
}

function detectFromEntries(entries) {
  for (const [, value] of entries) {
    const text = cleanText(value);
    if (!text) continue;
    if (UNSUBSCRIBE_PATTERNS.some((pattern) => pattern.test(text))) return "unsubscribed";
  }
  for (const [, value] of entries) {
    const text = cleanText(value);
    if (!text) continue;
    if (SUBSCRIBE_PATTERNS.some((pattern) => pattern.test(text))) return "subscribed";
  }
  return null;
}

