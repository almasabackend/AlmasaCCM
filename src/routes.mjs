import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { COUNTRIES, countryFromCode, countryTabs, isAllCountry } from "./countries.mjs";
import { buildCampaignExport } from "./exportService.mjs";
import { buildFilteredUpload } from "./filterService.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { importContactFiles } from "./importService.mjs";
import { normalizePhone } from "./phone.mjs";
import { authenticateUser, authConfigured } from "./auth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });
const filterDownloads = new Map();

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

  router.post("/:country/contacts/manual", async (req, res, next) => {
    try {
      const targetCountry = isAllCountry(req.country.code) ? "AE" : req.country.code;
      const normalized = normalizePhone(req.body.phone, targetCountry);
      if (!normalized.valid || !normalized.e164) {
        res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent("Invalid phone number: " + normalized.reason)}`);
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
    res.render("import", { result: null });
  });

  router.post("/:country/import", upload.array("files", 10), async (req, res, next) => {
    try {
      if (isAllCountry(req.country.code)) {
        res.redirect("/AE/import");
        return;
      }
      if (!req.files?.length) {
        res.render("import", { result: { error: "Choose at least one CSV or Excel file." } });
        return;
      }
      const result = await importContactFiles({
        files: req.files,
        country: req.country.code,
        store,
        updateExisting: req.body.updateExisting === "1"
      });
      res.render("import", { result });
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
      if (!req.files?.length) {
        res.render("filter", { error: "Choose at least one CSV or Excel file.", result: null });
        return;
      }
      const filtered = await buildFilteredUpload({
        files: req.files,
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
      const history = await store.importHistory(req.country.code);
      res.render("history", { history });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:country/settings", (req, res) => {
    res.render("settings");
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
