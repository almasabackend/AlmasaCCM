import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

import { buildCampaignExport } from "../src/exportService.mjs";
import { buildFilteredUpload } from "../src/filterService.mjs";
import { commitImportPreview, importContactFiles, previewContactFiles } from "../src/importService.mjs";
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

test("export no longer caps campaign contacts at 1000 and uses Excel-safe CSV", async () => {
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
  assert.equal(lines.length, 1006);
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

test("all country view combines UAE and Saudi contacts", async () => {
  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971501111111",
    phone_display: "+971 50 111 1111",
    raw_phone: "0501111111",
    company_name: "UAE Co",
    contact_name: "UAE Person",
    email: "",
    source_file: "uae.xlsx",
    source_sheet: "",
    incoming_status: "subscribed"
  });
  await store.upsertImportedContact({
    country: "SA",
    phone_e164: "+966551111111",
    phone_display: "+966 55 111 1111",
    raw_phone: "0551111111",
    company_name: "KSA Co",
    contact_name: "KSA Person",
    email: "",
    source_file: "ksa.xlsx",
    source_sheet: "",
    incoming_status: "subscribed"
  });

  const summary = await store.summary("ALL");
  const exportFile = await buildCampaignExport({ store, country: "ALL", limit: 1000, format: "plain_csv" });
  const csv = exportFile.body.toString("utf8");

  assert.equal(summary.total_contacts, 2);
  assert.equal(summary.subscribed, 2);
  assert.match(csv, /\+971501111111/);
  assert.match(csv, /\+966551111111/);
});

test("custom contact groups can be created assigned and filtered", async () => {
  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971501111111",
    phone_display: "+971 50 111 1111",
    raw_phone: "0501111111",
    company_name: "Group Co",
    contact_name: "Group Person",
    email: "",
    source_file: "group.xlsx",
    source_sheet: "",
    incoming_status: "subscribed"
  });
  const [contact] = await store.listContacts({ country: "AE" });
  const group = await store.createContactGroup("AE", "Expo Leads");
  await store.addContactToGroup(contact.id, group.id);

  const groups = await store.listContactGroups("AE");
  const groupedContacts = await store.listContacts({ country: "AE", groupId: group.id });

  assert.equal(groups[0].name, "Expo Leads");
  assert.equal(groups[0].contact_count, 1);
  assert.equal(groupedContacts.length, 1);
  assert.equal(groupedContacts[0].groups, "Expo Leads");
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
  assert.equal(filtered.summary.removed_total, 1);
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
  assert.equal(filtered.summary.removed_total, 1);
  assert.equal(filtered.summary.removed_suppressed, 1);
  assert.doesNotMatch(csv, /Mixed Row/);
  assert.doesNotMatch(csv, /\+971501234567/);
});

test("contact import preview requires confirmation before database writes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-preview-"));
  const filePath = path.join(tempDir, "preview.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["Mobile", "Contact Person", "Company", "Status"]);
  worksheet.addRow(["0552605247", "Preview Person", "Preview Co", "subscribed"]);
  await workbook.xlsx.writeFile(filePath);

  const store = new MemoryStore();
  const preview = await previewContactFiles({
    files: [{ path: filePath, originalname: "preview.xlsx" }],
    country: "AE",
    store
  });

  assert.equal(preview.summary.preview_will_add, 1);
  assert.equal((await store.listContacts({ country: "AE" })).length, 0);

  await store.createRollbackSnapshot({ country: "AE", label: "Before preview import", summary: preview.summary });
  await commitImportPreview({ preview, store });

  const contacts = await store.listContacts({ country: "AE" });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone_e164, "+971552605247");
});

test("confirmed unsubscribe upload updates existing contact and rollback restores it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcg-rollback-"));
  const filePath = path.join(tempDir, "unsubscribe.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["Mobile", "Contact Person", "Company", "Status"]);
  worksheet.addRow(["0552605247", "Existing Person", "Existing Co", "unsubscribe"]);
  await workbook.xlsx.writeFile(filePath);

  const store = new MemoryStore();
  await store.upsertImportedContact({
    country: "AE",
    phone_e164: "+971552605247",
    phone_display: "+971 55 260 5247",
    raw_phone: "0552605247",
    company_name: "Existing Co",
    contact_name: "Existing Person",
    email: "",
    source_file: "old.xlsx",
    source_sheet: "",
    incoming_status: "subscribed"
  });

  const preview = await previewContactFiles({
    files: [{ path: filePath, originalname: "unsubscribe.xlsx" }],
    country: "AE",
    store
  });
  const snapshot = await store.createRollbackSnapshot({ country: "AE", label: "Before unsubscribe", summary: preview.summary });
  const result = await commitImportPreview({ preview, store });
  const [suppressed] = await store.listContacts({ country: "AE" });

  assert.equal(preview.summary.preview_will_remove, 1);
  assert.equal(result.summary.imported_unsubscribed, 1);
  assert.equal(suppressed.status, "unsubscribed");

  await store.restoreRollbackSnapshot(snapshot.id);
  const [restored] = await store.listContacts({ country: "AE" });
  assert.equal(restored.status, "subscribed");
});
