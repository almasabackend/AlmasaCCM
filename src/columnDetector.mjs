import { cleanText, extractPhoneCandidates, normalizePhone } from "./phone.mjs";
import { normalizeHeader } from "./statusDetector.mjs";

const PHONE_HINTS = ["phone", "mobile", "number", "contact number", "whatsapp", "whatsapp number", "tel", "telephone", "contact", "phone no", "mobile no"];
const NAME_HINTS = ["name", "full name", "contact name", "contact person", "person name", "customer name", "client name", "representative", "manager name", "decision maker"];
const COMPANY_HINTS = ["company", "company name", "organization", "organisation", "business name", "client company", "customer company", "account name", "contractor", "consultant", "developer", "supplier", "firm", "establishment"];
const EMAIL_HINTS = ["email", "email address", "contact email", "work email"];

export function detectColumns(rows, countryCode = "AE") {
  const headers = Object.keys(rows[0] || {});
  const phoneColumns = [];
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (matchesHint(normalized, PHONE_HINTS) && !["contact name", "contact person"].includes(normalized)) {
      phoneColumns.push(header);
    }
  }

  for (const header of headers) {
    if (phoneColumns.includes(header)) continue;
    const sample = rows.slice(0, 80).map((row) => row[header]).filter((value) => cleanText(value));
    if (sample.length === 0) continue;
    const validCount = sample.filter((value) =>
      extractPhoneCandidates(value).some((candidate) => normalizePhone(candidate, countryCode).valid)
    ).length;
    if (validCount >= 3 || (sample.length >= 5 && validCount / sample.length >= 0.45)) {
      phoneColumns.push(header);
    }
  }

  return {
    phoneColumns,
    contactNameColumn: firstMatch(headers, NAME_HINTS),
    firstNameColumn: firstMatch(headers, ["first name", "firstname"]),
    lastNameColumn: firstMatch(headers, ["last name", "lastname", "surname"]),
    companyNameColumn: firstMatch(headers, COMPANY_HINTS),
    emailColumn: firstMatch(headers, EMAIL_HINTS)
  };
}

export function extractContactDetails(row, mapping) {
  const contactName = value(row, mapping.contactNameColumn) || [value(row, mapping.firstNameColumn), value(row, mapping.lastNameColumn)].filter(Boolean).join(" ");
  return {
    contact_name: contactName,
    company_name: value(row, mapping.companyNameColumn),
    email: value(row, mapping.emailColumn)
  };
}

function firstMatch(headers, hints) {
  return headers.find((header) => matchesHint(normalizeHeader(header), hints)) || null;
}

function matchesHint(normalized, hints) {
  return hints.some((hint) => normalized === hint || normalized.includes(hint));
}

function value(row, key) {
  if (!key) return "";
  return cleanText(row[key]);
}

