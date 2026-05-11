import { parsePhoneNumberFromString } from "libphonenumber-js";
import { COUNTRIES, countryFromCode } from "./countries.mjs";

const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const PHONE_LIKE_RE = /(?:\+|00)?\d[\d\s().-]{6,}\d/g;

export function cleanText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).normalize("NFKC").replace(INVISIBLE_RE, "").trim();
  if (["nan", "none", "nat", "undefined", "null"].includes(text.toLowerCase())) return "";
  if (/^\d+\.0$/.test(text)) return text.slice(0, -2);
  return text;
}

export function compactPhone(value) {
  return cleanText(value).replace(/\s+/g, "").replace(/[().-]/g, "");
}

export function extractPhoneCandidates(value) {
  const text = cleanText(value);
  if (!text) return [];
  const parts = text.split(/[,;/|\n\r\t]+/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const candidates = [];

  const add = (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 7) return;
    const key = compactPhone(candidate);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate.trim());
  };

  for (const part of parts) {
    for (const match of part.matchAll(PHONE_LIKE_RE)) add(match[0]);
    for (const token of part.split(/\s+/)) add(token);
  }
  return candidates;
}

export function preparePhoneForParse(raw, countryCode = "AE") {
  const country = countryFromCode(countryCode);
  const compact = compactPhone(raw);
  const digits = compact.replace(/\D/g, "");
  if (!digits) return "";
  if (compact.startsWith("+")) return `+${digits}`;
  if (compact.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith(country.localMobilePrefix)) return `+${country.callingCode}${digits.slice(1)}`;
  if (digits.startsWith("5") && digits.length === 9) return `+${country.callingCode}${digits}`;
  if (digits.startsWith(country.callingCode)) return `+${digits}`;
  return digits;
}

export function normalizePhone(raw, countryCode = "AE") {
  const country = countryFromCode(countryCode);
  const original = cleanText(raw);
  const prepared = preparePhoneForParse(original, country.code);
  if (!prepared) {
    return { raw: original, cleaned: "", e164: null, display: null, country: country.code, valid: false, reason: "No phone number found" };
  }

  const phone = prepared.startsWith("+")
    ? parsePhoneNumberFromString(prepared)
    : parsePhoneNumberFromString(prepared, country.region);

  if (!phone || !phone.isValid()) {
    return { raw: original, cleaned: prepared, e164: null, display: null, country: country.code, valid: false, reason: "Invalid phone number" };
  }

  const detectedCountry = countryCodeFromCallingCode(phone.countryCallingCode) || phone.country || country.code;
  return {
    raw: original,
    cleaned: prepared,
    e164: phone.number,
    display: phone.formatInternational(),
    country: detectedCountry,
    valid: true,
    reason: ""
  };
}

export function countryCodeFromCallingCode(callingCode) {
  for (const country of Object.values(COUNTRIES)) {
    if (country.callingCode === String(callingCode)) return country.code;
  }
  return null;
}

export function excelSafePhone(phone) {
  return `="${phone}"`;
}

