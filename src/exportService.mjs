import ExcelJS from "exceljs";
import { excelSafePhone } from "./phone.mjs";
import { rowsToCsv } from "./csv.mjs";

export async function buildCampaignExport({ store, country, limit, order = "newest", mode = "phone_only", format = "excel_safe_csv", listType = "campaign" }) {
  const exportStatus = listType === "unsubscribe" ? "unsubscribed" : "subscribed";
  const rows = await store.contactsForExport({ country, limit, order, status: exportStatus });
  const prepared = rows.map((row) => exportRow(row, mode, format === "excel_safe_csv"));
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const extension = format === "xlsx" ? "xlsx" : "csv";
  const filenamePrefix = listType === "unsubscribe" ? "whatsapp_unsubscribe_list" : "whatsapp_campaign_contacts";
  const filename = `${filenamePrefix}_${country}_${timestamp}.${extension}`;

  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(listType === "unsubscribe" ? "Unsubscribe List" : "Campaign Contacts");
    const headers = Object.keys(prepared[0] || exportRow({}, mode, false));
    worksheet.addRow(headers);
    for (const row of prepared) worksheet.addRow(headers.map((header) => row[header] || ""));
    worksheet.getColumn(1).numFmt = "@";
    return {
      filename,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await workbook.xlsx.writeBuffer(),
      count: rows.length
    };
  }

  const columns = Object.keys(prepared[0] || exportRow({}, mode, false)).map((key) => ({ label: key, value: (row) => row[key] || "" }));
  return {
    filename,
    contentType: "text/csv; charset=utf-8",
    body: Buffer.from(`\ufeff${rowsToCsv(columns, prepared)}`, "utf8"),
    count: rows.length
  };
}

function exportRow(row, mode, excelSafe) {
  const phone = row.phone_e164 ? (excelSafe ? excelSafePhone(row.phone_e164) : row.phone_e164) : "";
  if (mode === "full") {
    return {
      phone,
      company_name: row.company_name || "",
      contact_name: row.contact_name || "",
      email: row.email || "",
      status: row.status || "",
      notes: row.notes || ""
    };
  }
  return { phone };
}
