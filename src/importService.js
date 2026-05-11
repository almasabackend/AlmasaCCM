import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";

import { detectColumns, extractContactDetails } from "./columnDetector.js";
import { COUNTRIES } from "./countries.js";
import { cleanText, extractPhoneCandidates, normalizePhone } from "./phone.js";
import { detectSubscriptionStatus } from "./statusDetector.js";

export async function importContactFiles({ files, country, store, updateExisting = false }) {
  const summary = emptySummary(country, files.map((file) => file.originalname).join(", "));
  const results = [];
  const seen = new Set();

  for (const file of files) {
    const sheets = await readUploadedFile(file);
    for (const { sheetName, rows } of sheets) {
      if (!rows.length) continue;
      const mapping = detectColumns(rows, country);
      summary.total_rows += rows.length;

      for (const [index, row] of rows.entries()) {
        const candidates = phoneCandidatesFromRow(row, mapping);
        const details = extractContactDetails(row, mapping);
        const incomingStatus = detectSubscriptionStatus(row);

        for (const candidate of candidates) {
          summary.numbers_found += 1;
          const normalized = normalizePhone(candidate, country);
          if (!normalized.valid || !normalized.e164) {
            summary.invalid_numbers += 1;
            results.push(resultRow({ index, candidate, status: "Invalid number", reason: normalized.reason, file, sheetName, details }));
            continue;
          }

          if (seen.has(normalized.e164)) {
            summary.duplicates += 1;
            results.push(resultRow({ index, candidate, normalized, status: "Duplicate in uploaded file", file, sheetName, details, incomingStatus }));
            continue;
          }
          seen.add(normalized.e164);

          const targetCountry = COUNTRIES[normalized.country] ? normalized.country : country;
          const outcome = await store.upsertImportedContact(
            {
              country: targetCountry,
              phone_e164: normalized.e164,
              phone_display: normalized.display,
              raw_phone: candidate,
              company_name: details.company_name,
              contact_name: details.contact_name,
              email: details.email,
              source_file: file.originalname,
              source_sheet: sheetName,
              incoming_status: incomingStatus
            },
            { updateExisting }
          );
          applyOutcome(summary, outcome);
          results.push(resultRow({ index, candidate, normalized, status: labelForOutcome(outcome, incomingStatus), file, sheetName, details, incomingStatus, country: targetCountry }));
        }
      }
    }
    await safeUnlink(file.path);
  }

  await store.addImportHistory(summary);
  return { summary, results };
}

export async function readUploadedFile(file) {
  const extension = file.originalname.toLowerCase().split(".").pop();
  if (extension === "csv") {
    const content = await fs.readFile(file.path, "utf8");
    return [
      {
        sheetName: "CSV",
        rows: parse(content, {
          columns: true,
          skip_empty_lines: true,
          bom: true,
          relax_column_count: true,
          trim: true
        })
      }
    ];
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);
  return workbook.worksheets.map((worksheet) => ({
    sheetName: worksheet.name,
    rows: worksheetToRows(worksheet)
  }));
}

export function phoneCandidatesFromRow(row, mapping) {
  const values = mapping.phoneColumns.length
    ? mapping.phoneColumns.map((column) => row[column]).filter((value) => cleanText(value))
    : Object.values(row);
  const candidates = [];
  const seen = new Set();
  for (const value of values) {
    const extracted = extractPhoneCandidates(value);
    const usable = extracted.length ? extracted : mapping.phoneColumns.length && cleanText(value) ? [cleanText(value)] : [];
    for (const candidate of usable) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function emptySummary(country, fileName) {
  return {
    country,
    file_name: fileName,
    import_type: "contact_file",
    total_rows: 0,
    numbers_found: 0,
    new_added: 0,
    already_existing: 0,
    existing_updated: 0,
    duplicates: 0,
    unsubscribed_blocked: 0,
    invalid_numbers: 0,
    imported_unsubscribed: 0
  };
}

function applyOutcome(summary, outcome) {
  if (outcome === "new_added") summary.new_added += 1;
  else if (outcome === "existing_updated") {
    summary.already_existing += 1;
    summary.existing_updated += 1;
  } else if (outcome === "already_subscribed") summary.already_existing += 1;
  else if (outcome === "suppressed_blocked") summary.unsubscribed_blocked += 1;
  else if (["new_unsubscribed", "changed_to_unsubscribed", "already_unsubscribed"].includes(outcome)) summary.imported_unsubscribed += 1;
}

function labelForOutcome(outcome, incomingStatus) {
  const labels = {
    new_added: "New subscribed contact",
    already_subscribed: "Already subscribed",
    existing_updated: "Existing contact updated",
    suppressed_blocked: "Previously unsubscribed or blocked - kept suppressed",
    new_unsubscribed: "New unsubscribe suppression",
    changed_to_unsubscribed: "Changed to unsubscribed",
    already_unsubscribed: "Already unsubscribed"
  };
  if (incomingStatus === "unsubscribed" && outcome === "new_added") return "Imported as unsubscribed";
  return labels[outcome] || outcome;
}

function resultRow({ index, candidate, normalized, status, reason = "", file, sheetName, details = {}, incomingStatus = "", country = "" }) {
  return {
    row_number: index + 2,
    country: country || normalized?.country || "",
    phone_e164: normalized?.e164 || "",
    raw_phone: candidate,
    company_name: details.company_name || "",
    contact_name: details.contact_name || "",
    email: details.email || "",
    detected_status: incomingStatus,
    result: status,
    reason,
    source_file: file.originalname,
    source_sheet: sheetName
  };
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Uploaded temp files are best-effort cleanup.
  }
}

function worksheetToRows(worksheet) {
  const headerRow = worksheet.getRow(1);
  const headers = headerRow.values.slice(1).map((value, index) => stringifyCell(value) || `Column ${index + 1}`);
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      record[header] = stringifyCell(row.getCell(index + 1).value);
    });
    if (Object.values(record).some((value) => String(value).trim())) rows.push(record);
  });
  return rows;
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if ("text" in value) return String(value.text || "");
  if ("result" in value) return stringifyCell(value.result);
  if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
  if ("hyperlink" in value && "text" in value) return String(value.text || value.hyperlink || "");
  return String(value);
}
