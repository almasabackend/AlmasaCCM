import fs from "node:fs/promises";
import ExcelJS from "exceljs";

import { detectColumns } from "./columnDetector.mjs";
import { readUploadedFile, phoneCandidatesFromRow } from "./importService.mjs";
import { rowsToCsv } from "./csv.mjs";
import { excelSafePhone, normalizePhone } from "./phone.mjs";

export async function buildFilteredUpload({ files, country, store, format = "xlsx", phoneFormat = "plain" }) {
  const summary = emptySummary(files.map((file) => file.originalname).join(", "));
  const keptRows = [];
  const removedRows = [];
  const seen = new Set();

  for (const file of files) {
    const sheets = await readUploadedFile(file);
    for (const { sheetName, rows } of sheets) {
      if (!rows.length) continue;
      const mapping = detectColumns(rows, country);
      summary.total_rows += rows.length;

      for (const [index, row] of rows.entries()) {
        const candidates = phoneCandidatesFromRow(row, mapping);
        if (!candidates.length) {
          summary.rows_without_phone += 1;
          removedRows.push(reportRow({ row, file, sheetName, index, result: "No phone number found" }));
          continue;
        }

        const rowPhones = [];
        let removeWholeRow = null;
        for (const candidate of candidates) {
          summary.numbers_found += 1;
          const normalized = normalizePhone(candidate, country);
          if (!normalized.valid || !normalized.e164) {
            summary.invalid_numbers += 1;
            removeWholeRow ||= reportRow({ row, file, sheetName, index, rawPhone: candidate, result: "Invalid number", reason: normalized.reason });
            continue;
          }

          if (seen.has(normalized.e164)) {
            summary.duplicates += 1;
            removeWholeRow ||= reportRow({ row, file, sheetName, index, rawPhone: candidate, phone: normalized.e164, result: "Duplicate in uploaded file" });
            continue;
          }
          seen.add(normalized.e164);

          const existing = await store.findContactByPhone(normalized.e164);
          if (existing && ["unsubscribed", "blocked"].includes(existing.status)) {
            summary.removed_suppressed += 1;
            removeWholeRow ||= reportRow({
              row,
              file,
              sheetName,
              index,
              rawPhone: candidate,
              phone: normalized.e164,
              result: existing.status === "blocked" ? "Blocked in global database" : "Unsubscribed in global database",
              reason: "Skipped from filtered list"
            });
            continue;
          }

          rowPhones.push(normalized);
        }

        if (removeWholeRow) {
          removedRows.push(removeWholeRow);
          continue;
        }

        for (const normalized of rowPhones) {
          summary.kept += 1;
          keptRows.push(cleanRow({ row, file, sheetName, normalized, phoneFormat }));
        }
      }
    }
    await safeUnlink(file.path);
  }

  return buildDownload({ summary, keptRows, removedRows, format });
}

function buildDownload({ summary, keptRows, removedRows, format }) {
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  if (format === "csv") {
    const columns = columnsFromRows(keptRows);
    return {
      summary,
      filename: `filtered_contact_list_${timestamp}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: Buffer.from(`\ufeff${rowsToCsv(columns, keptRows)}`, "utf8")
    };
  }

  return buildXlsx({ summary, keptRows, removedRows, timestamp });
}

async function buildXlsx({ summary, keptRows, removedRows, timestamp }) {
  const workbook = new ExcelJS.Workbook();
  addWorksheet(workbook, "Filtered List", keptRows.length ? keptRows : [{ phone_e164: "", filter_result: "No contacts kept" }]);
  addWorksheet(workbook, "Removed Suppressed", removedRows.length ? removedRows : [{ filter_result: "No suppressed, duplicate, invalid, or missing-phone rows removed" }]);
  addWorksheet(workbook, "Summary", [summary]);
  return {
    summary,
    filename: `filtered_contact_list_${timestamp}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: await workbook.xlsx.writeBuffer()
  };
}

function addWorksheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name);
  const headers = columnsFromRows(rows).map((column) => column.label);
  worksheet.addRow(headers);
  for (const row of rows) worksheet.addRow(headers.map((header) => row[header] || ""));
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column) => {
    column.width = Math.min(Math.max(String(column.header || "").length + 4, 14), 34);
  });
  const phoneColumn = headers.findIndex((header) => header.includes("phone")) + 1;
  if (phoneColumn > 0) worksheet.getColumn(phoneColumn).numFmt = "@";
}

function cleanRow({ row, file, sheetName, normalized, phoneFormat }) {
  return {
    ...row,
    phone_e164: phoneFormat === "excel_safe" ? excelSafePhone(normalized.e164) : normalized.e164,
    detected_country: normalized.country,
    filter_result: "Kept",
    source_file: file.originalname,
    source_sheet: sheetName
  };
}

function reportRow({ row, file, sheetName, index, rawPhone = "", phone = "", result, reason = "" }) {
  return {
    row_number: index + 2,
    raw_phone: rawPhone,
    phone_e164: phone,
    filter_result: result,
    reason,
    source_file: file.originalname,
    source_sheet: sheetName,
    ...row
  };
}

function columnsFromRows(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen].map((key) => ({ label: key, value: (row) => row[key] || "" }));
}

function emptySummary(fileName) {
  return {
    file_name: fileName,
    total_rows: 0,
    numbers_found: 0,
    kept: 0,
    removed_suppressed: 0,
    duplicates: 0,
    invalid_numbers: 0,
    rows_without_phone: 0
  };
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Uploaded temp files are best-effort cleanup.
  }
}
