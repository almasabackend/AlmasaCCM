import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COUNTRIES, countryFromCode, countryTabs } from "./countries.js";
import { buildCampaignExport } from "./exportService.js";
import { importContactFiles } from "./importService.js";
import { normalizePhone } from "./phone.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });

export function createRouter(store) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.locals.countries = countryTabs();
    res.locals.storeKind = store.kind;
    res.locals.adminEnabled = Boolean(process.env.ADMIN_PASSWORD);
    res.locals.path = req.path;
    next();
  });

  router.get("/login", (req, res) => res.render("login", { error: "" }));
  router.post("/login", (req, res) => {
    if (!process.env.ADMIN_PASSWORD || req.body.password === process.env.ADMIN_PASSWORD) {
      req.session.authenticated = true;
      res.redirect("/");
      return;
    }
    res.status(401).render("login", { error: "Wrong password." });
  });
  router.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

  router.use((req, res, next) => {
    if (!process.env.ADMIN_PASSWORD || req.session.authenticated) return next();
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
    next();
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
        limit: 1000
      };
      const contacts = await store.listContacts(filters);
      res.render("contacts", { contacts, filters, message: req.query.message || "" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:country/contacts/manual", async (req, res, next) => {
    try {
      const normalized = normalizePhone(req.body.phone, req.country.code);
      if (!normalized.valid || !normalized.e164) {
        res.redirect(`/${req.country.code}/contacts?message=${encodeURIComponent("Invalid phone number: " + normalized.reason)}`);
        return;
      }
      await store.upsertImportedContact(
        {
          country: req.country.code,
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
    res.render("import", { result: null });
  });

  router.post("/:country/import", upload.array("files", 10), async (req, res, next) => {
    try {
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
        format: req.body.format
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

