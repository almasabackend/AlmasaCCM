import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { COUNTRIES, countryFromCode, countryTabs, isAllCountry } from "./countries.mjs";
import { buildCampaignExport } from "./exportService.mjs";
import { buildFilteredUpload } from "./filterService.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { commitImportPreview, previewContactFiles } from "./importService.mjs";
import { normalizePhone } from "./phone.mjs";
import { authenticateUser, authConfigured } from "./auth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, "..", "uploads");
const upload = multer({ dest: uploadDir });
const filterDownloads = new Map();
const importPreviews = new Map();

export function createRouter(store) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.locals.countries = countryTabs();
    res.locals.storeKind = store.kind;
    res.locals.adminEnabled = authConfigured();
    res.locals.currentUser = req.session.user || null;
    res.locals.path = req.path;
    next();
  });

  router.get("/login", (req, res) => res.render("login", { error: "", email: "" }));
  router.get("/healthz", async (_req, res) => {
    const diagnostics = await runDiagnostics(store);
    res.status(diagnostics.database.attempted && !diagnostics.database.ok ? 503 : 200).json(diagnostics);
  });
  router.get("/diagnostics", async (_req, res, next) => {
    try {
      const diagnostics = await runDiagnostics(store);
      res.render("diagnostics", { diagnostics, currentCountry: countryFromCode("AE") });
    } catch (error) {
      next(error);
    }
  });
  router.post("/login", (req, res) => {
    const user = authenticateUser(req.body.email, req.body.password);
    if (user) {
      req.session.authenticated = true;
      req.session.user = user;
      res.redirect("/");
      return;
    }
    res.status(401).render("login", { error: "Wrong email or password.", email: req.body.email || "" });
  });
  router.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

  router.use((req, res, next) => {
    if (!authConfigured() || req.session.authenticated) return next();
    res.redirect("/login");
  });

  router.get("/", (req, res) => res.redirect("/AE/dashboard"));

  router.use("/:country", (req, res, next) => {
    const code = String(req.params.country || "AE").toUpperCase();
    if (!COUNTRIES[code]) {
      if (req.method === "GET" || req.method === "HEAD") {
        res.redirect("/AE/dashboard");
        return;
      }
      res.status(404).send("Unsupported country");
      return;
    }
    req.country = countryFromCode(code);
    res.locals.currentCountry = req.country;
    res.locals.isCombinedCountry = isAllCountry(req.country.code);
    store.listContactGroups(req.country.code)
      .then((groups) => {
        res.locals.contactGroups = groups;
        next();
      })
      .catch(next);
  });

  router.get("/:country/dashboard", async (req, res, next) => {
    try {
      const summary = await store.summary(req.country.code);
      res.render("dashboard", { summary });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/contacts/loading", (req, res) => {
    const countryPath = `/${req.country.code}/contacts`;
    const mode = req.query.mode || "all";
    const loading = {
      targetUrl: `${countryPath}?view=all`
    };

    if (mode === "groups") {
      loading.targetUrl = `${countryPath}#contact-groups`;
    }

    if (mode === "subscribed" || mode === "unsubscribed") {
      loading.targetUrl = `${countryPath}?status=${mode}`;
    }

    if (mode === "group") {
      const groupId = String(req.query.group || "").replace(/\D/g, "");
      if (groupId) {
        loading.targetUrl = `${countryPath}?group=${groupId}`;
      }
    }

    res.render("contacts_loading", {
      ...loading
    });
  });

  router.get("/:country/contacts", async (req, res, next) => {
    try {
      const filters = {
        country: req.country.code,
        search: req.query.search || "",
        status: req.query.status || "",
        missingCompany: req.query.missingCompany === "1",
        missingName: req.query.missingName === "1",
        groupId: req.query.group || "",
        limit: 1000
      };
      const groups = res.locals.contactGroups || [];
      const contacts = await store.listContacts(filters);
      res.render("contacts", { contacts, groups, filters, groupTitle: contactGroupTitle(filters, groups), message: req.query.message || "" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/contacts/new", (req, res) => {
    res.render("manual_contact", { error: "" });
  });

  router.post("/:country/contacts/manual", async (req, res, next) => {
    try {
      const targetCountry = isAllCountry(req.country.code) ? req.body.country || "AE" : req.country.code;
      const normalized = normalizePhone(req.body.phone, targetCountry);
      if (!normalized.valid || !normalized.e164) {
        res.status(400).render("manual_contact", { error: "Invalid phone number: " + normalized.reason });
        return;
      }
      await store.upsertImportedContact(
        {
          country: targetCountry,
          phone_e164: normalized.e164,
          phone_display: normalized.display,
          raw_phone: normalized.raw,
          company_name: req.body.company_name || "",
          contact_name: req.body.contact_name || "",
          email: req.body.email || "",
          source_file: "Manual add",
          source_sheet: "",
          incoming_status: req.body.status === "unsubscribed" ? "unsubscribed" : "subscribed"
        },
        { updateExisting: false }
      );
      res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent("Contact saved.")}`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/contacts/groups", async (req, res, next) => {
    try {
      const targetCountry = isAllCountry(req.country.code) ? req.body.group_country : req.country.code;
      const group = await store.createContactGroup(targetCountry, req.body.group_name);
      const message = group ? `Group "${group.name}" saved.` : "Enter a group name.";
      res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent(message)}`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/contacts/:id", async (req, res, next) => {
    try {
      const fields = {
        company_name: req.body.company_name || "",
        contact_name: req.body.contact_name || "",
        email: req.body.email || "",
        status: req.body.status || "subscribed",
        notes: req.body.notes || ""
      };
      if (fields.status === "unsubscribed") {
        fields.unsubscribed_at = new Date().toISOString().slice(0, 19).replace("T", " ");
      }
      await store.updateContact(req.params.id, fields);
      if (req.body.group_id) await store.addContactToGroup(req.params.id, req.body.group_id);
      res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent("Contact updated.")}`);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/contacts/:id/delete", async (req, res, next) => {
    try {
      await store.deleteContact(req.params.id);
      res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent("Contact deleted.")}`);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/import", (req, res) => {
    if (isAllCountry(req.country.code)) {
      res.redirect("/AE/import");
      return;
    }
    res.render("import", { result: null, preview: null });
  });

  router.post("/:country/import", upload.array("files", 10), async (req, res, next) => {
    try {
      if (isAllCountry(req.country.code)) {
        res.redirect("/AE/import");
        return;
      }
      const files = await uploadedFilesFromRequest(req);
      if (!files.length) {
        res.render("import", { result: { error: "Choose at least one CSV or Excel file." }, preview: null });
        return;
      }
      const preview = await previewContactFiles({
        files,
        country: req.country.code,
        store,
        updateExisting: req.body.updateExisting === "1"
      });
      const token = rememberImportPreview(req.country.code, preview);
      res.render("import", { result: null, preview: { ...preview, token } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/import/confirm/:token", async (req, res, next) => {
    try {
      if (isAllCountry(req.country.code)) {
        res.redirect("/AE/import");
        return;
      }
      const preview = importPreviews.get(req.params.token);
      if (!preview || preview.country !== req.country.code) {
        res.status(410).render("import", {
          result: { error: "This import preview expired. Please upload the file again." },
          preview: null
        });
        return;
      }
      const snapshot = await store.createRollbackSnapshot({
        country: req.country.code,
        label: `Before import: ${preview.data.summary.file_name}`,
        summary: preview.data.summary
      });
      const result = await commitImportPreview({ preview: preview.data, store });
      importPreviews.delete(req.params.token);
      res.render("import", { result: { ...result, snapshot }, preview: null });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/filter", (req, res) => {
    if (isAllCountry(req.country.code)) {
      res.redirect("/AE/filter");
      return;
    }
    res.render("filter", { error: "", result: null });
  });

  router.get("/:country/filter/download/:token", (req, res) => {
    const download = filterDownloads.get(req.params.token);
    if (!download || download.country !== req.country.code) {
      res.status(404).send("Filtered file expired. Please run the filter again.");
      return;
    }
    res.setHeader("Content-Type", download.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${download.filename}"`);
    res.send(download.body);
  });

  router.post("/:country/filter", upload.array("files", 10), async (req, res, next) => {
    try {
      if (isAllCountry(req.country.code)) {
        res.redirect("/AE/filter");
        return;
      }
      const files = await uploadedFilesFromRequest(req);
      if (!files.length) {
        res.render("filter", { error: "Choose at least one CSV or Excel file.", result: null });
        return;
      }
      const filtered = await buildFilteredUpload({
        files,
        country: req.country.code,
        store,
        format: req.body.format,
        phoneFormat: req.body.phoneFormat
      });
      const token = rememberFilterDownload(req.country.code, filtered);
      res.render("filter", {
        error: "",
        result: {
          summary: filtered.summary,
          filename: filtered.filename,
          downloadUrl: `/${req.country.code}/filter/download/${token}`
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/export", async (req, res, next) => {
    try {
      const summary = await store.summary(req.country.code);
      res.render("export", { summary });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/export", async (req, res, next) => {
    try {
      const exportFile = await buildCampaignExport({
        store,
        country: req.country.code,
        limit: req.body.limit,
        order: req.body.order,
        mode: req.body.mode,
        format: req.body.format,
        listType: req.body.listType
      });
      res.setHeader("Content-Type", exportFile.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${exportFile.filename}"`);
      res.send(exportFile.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/history", async (req, res, next) => {
    try {
      const [history, snapshots] = await Promise.all([
        store.importHistory(req.country.code),
        store.rollbackSnapshots(req.country.code)
      ]);
      res.render("history", { history, snapshots, message: req.query.message || "" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/history/rollback/:id", async (req, res, next) => {
    try {
      const snapshot = await store.restoreRollbackSnapshot(req.params.id);
      const message = snapshot
        ? `Database restored to snapshot "${snapshot.label}" from ${snapshot.created_at}.`
        : "Snapshot was not found.";
      res.redirect(`/${req.country.code}/history?message=${encodeURIComponent(message)}`);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/settings", (req, res) => {
    res.render("settings");
  });

  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      res.redirect("/AE/dashboard");
      return;
    }
    next();
  });

  router.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).render("error", { error });
  });

  return router;
}

function rememberFilterDownload(country, filtered) {
  const token = crypto.randomBytes(18).toString("hex");
  filterDownloads.set(token, {
    country,
    filename: filtered.filename,
    contentType: filtered.contentType,
    body: filtered.body,
    createdAt: Date.now()
  });
  cleanupFilterDownloads();
  return token;
}

async function uploadedFilesFromRequest(req) {
  if (req.files?.length) return req.files;
  if (!Array.isArray(req.body?.uploadedFiles)) return [];
  await fs.mkdir(uploadDir, { recursive: true });
  const files = [];
  for (const file of req.body.uploadedFiles) {
    const originalname = cleanUploadName(file?.name);
    const base64 = String(file?.data || "").includes(",") ? String(file.data).split(",").pop() : String(file?.data || "");
    if (!originalname || !base64) continue;
    const extension = path.extname(originalname).toLowerCase();
    if (![".csv", ".xlsx", ".xlsm", ".xltx", ".xltm"].includes(extension)) continue;
    const filePath = path.join(uploadDir, `json-${crypto.randomBytes(12).toString("hex")}${extension}`);
    await fs.writeFile(filePath, Buffer.from(base64, "base64"));
    files.push({ path: filePath, originalname });
  }
  return files;
}

function cleanUploadName(name) {
  const clean = path.basename(String(name || "").replace(/[/\\]/g, ""));
  return clean.length > 180 ? clean.slice(-180) : clean;
}

function rememberImportPreview(country, data) {
  const token = crypto.randomBytes(18).toString("hex");
  importPreviews.set(token, {
    country,
    data,
    createdAt: Date.now()
  });
  cleanupImportPreviews();
  return token;
}

function cleanupImportPreviews() {
  const maxAgeMs = 30 * 60 * 1000;
  const now = Date.now();
  for (const [token, item] of importPreviews.entries()) {
    if (now - item.createdAt > maxAgeMs) importPreviews.delete(token);
  }
}

function cleanupFilterDownloads() {
  const maxAgeMs = 30 * 60 * 1000;
  const now = Date.now();
  for (const [token, item] of filterDownloads.entries()) {
    if (now - item.createdAt > maxAgeMs) filterDownloads.delete(token);
  }
}

function contactGroupTitle(filters, groups = []) {
  if (filters.groupId) {
    const group = groups.find((item) => String(item.id) === String(filters.groupId));
    return group ? `Group: ${group.name}` : "Contact group";
  }
  if (filters.status) return `${capitalize(filters.status)} contacts`;
  if (filters.missingCompany) return "Contacts missing company";
  if (filters.missingName) return "Contacts missing person name";
  return "All contacts";
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
