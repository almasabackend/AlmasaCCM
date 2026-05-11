import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import { buildCampaignExport } from "../src/exportService.mjs";
import { buildFilteredUpload } from "../src/filterService.mjs";
import { importContactFiles } from "../src/importService.mjs";
import { MemoryStore } from "../src/store.mjs";

test("imports subscribe and unsubscribe rows from Excel and suppresses exports", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-"));
  const filePath = path.join(tempDir, "contacts.xlsx");
  const rows = [
    { Mobile: "0552605247", "Contact Person": "Aisha", Company: "Acme", Email: "aisha@example.com", Status: "subscribed" },
    { Mobile: "+971 55 260 5247", "Contact Person": "Duplicate", Company: "Acme", Status: "subscribed" },
    { Mobile: "0501234567", "Contact Person": "Stopped", Company: "Stop Co", Notes: "client said unsubscribe" },
    { Mobile: "12345", "Contact Person": "Bad", Company: "Nope" }
  ];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(Object.keys(rows[0]));
  for (const row of rows) worksheet.addRow(Object.values(row));
  await workbook.xlsx.writeFile(filePath);

  const store = new MemoryStore();
  const result = await importContactFiles({
    files: [{ path: filePath, originalname: "contacts.xlsx" }],
    country: "AE",
    store
  });

  assert.equal(result.summary.new_added, 1);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.imported_unsubscribed, 1);
  assert.equal(result.summary.invalid_numbers, 1);

  const exportFile = await buildCampaignExport({ store, country: "AE", limit: 1000, format: "plain_csv" });
  const csv = exportFile.body.toString("utf8");
  assert.match(csv, /\+971552605247/);
  assert.doesNotMatch(csv, /\+971501234567/);
});

test("export caps campaign contacts at 1000 and uses Excel-safe CSV", async () => {
  const store = new MemoryStore();
  for (let index = 0; index < 1005; index += 1) {
    await store.upsertImportedContact({
      country: "AE",
      phone_e164: `+97155${String(index).padStart(7, "0")}`,
      phone_display: `+97155${String(index).padStart(7, "0")}`,
      raw_phone: "",
      company_name: "",
      contact_name: "",
      email: "",
      source_file: "test",
      source_sheet: "",
      incoming_status: "subscribed"
    });
  }

  const exportFile = await buildCampaignExport({ store, country: "AE", limit: 5000, format: "excel_safe_csv" });
  const lines = exportFile.body.toString("utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1001);
  assert.equal(lines[0].replace(/^\ufeff/, ""), "phone");
  assert.match(lines[1], /^"=""\+97155/);
});

test("exports unsubscribe list only", async () => {
  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971552605247",
    phone_display: "+971 55 260 5247",
    raw_phone: "0552605247",
    company_name: "Stop Co",
    contact_name: "Suppressed",
    email: "",
    source_file: "unsubscribe.xlsx",
    source_sheet: "",
    incoming_status: "unsubscribed"
  });
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971501234567",
    phone_display: "+971 50 123 4567",
    raw_phone: "0501234567",
    company_name: "Go Co",
    contact_name: "Allowed",
    email: "",
    source_file: "contacts.xlsx",
    source_sheet: "",
    incoming_status: "subscribed"
  });

  const exportFile = await buildCampaignExport({
    store,
    country: "AE",
    limit: 1000,
    format: "plain_csv",
    listType: "unsubscribe"
  });

  const csv = exportFile.body.toString("utf8");
  assert.match(exportFile.filename, /^whatsapp_unsubscribe_list_AE_/);
  assert.match(csv, /\+971552605247/);
  assert.doesNotMatch(csv, /\+971501234567/);
});

test("filters uploaded list against global unsubscribed contacts without importing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-filter-"));
  const filePath = path.join(tempDir, "fresh-list.xlsx");
  const rows = [
    { Mobile: "0552605247", "Contact Person": "Suppressed", Company: "Stop Co" },
    { Mobile: "0501234567", "Contact Person": "Allowed", Company: "Go Co" }
  ];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(Object.keys(rows[0]));
  for (const row of rows) worksheet.addRow(Object.values(row));
  await workbook.xlsx.writeFile(filePath);

  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971552605247",
    phone_display: "+971 55 260 5247",
    raw_phone: "0552605247",
    company_name: "Stop Co",
    contact_name: "Suppressed",
    email: "",
    source_file: "old",
    source_sheet: "",
    incoming_status: "unsubscribed"
  });

  const filtered = await buildFilteredUpload({
    files: [{ path: filePath, originalname: "fresh-list.xlsx" }],
    country: "AE",
    store,
    format: "csv"
  });

  const csv = filtered.body.toString("utf8");
  assert.equal(filtered.summary.kept, 1);
  assert.equal(filtered.summary.removed_suppressed, 1);
  assert.doesNotMatch(csv, /\+971552605247/);
  assert.match(csv, /\+971501234567/);
});

test("filter removes a whole row if any phone in that row is suppressed", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-filter-row-"));
  const filePath = path.join(tempDir, "multi-phone.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["Mobile", "Contact Person", "Company"]);
  worksheet.addRow(["0552605247 / 0501234567", "Mixed Row", "Mixed Co"]);
  await workbook.xlsx.writeFile(filePath);

  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971552605247",
    phone_display: "+971 55 260 5247",
    raw_phone: "0552605247",
    company_name: "Stop Co",
    contact_name: "Suppressed",
    email: "",
    source_file: "old",
    source_sheet: "",
    incoming_status: "unsubscribed"
  });

  const filtered = await buildFilteredUpload({
    files: [{ path: filePath, originalname: "multi-phone.xlsx" }],
    country: "AE",
    store,
    format: "csv"
  });

  const csv = filtered.body.toString("utf8");
  assert.equal(filtered.summary.kept, 0);
  assert.equal(filtered.summary.removed_suppressed, 1);
  assert.doesNotMatch(csv, /Mixed Row/);
  assert.doesNotMatch(csv, /\+971501234567/);
});
