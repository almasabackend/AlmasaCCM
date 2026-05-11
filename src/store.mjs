import mysql from "mysql2/promise";

const STATUS_VALUES = new Set(["subscribed", "unsubscribed", "invalid", "blocked"]);

export async function createStore() {
  if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME) {
    const store = new MySqlStore();
    try {
      await store.init();
      return store;
    } catch (error) {
      console.error("Database connection failed. Falling back to temporary memory mode.", error);
      const fallback = new MemoryStore();
      fallback.kind = "memory-db-error";
      fallback.databaseError = friendlyDatabaseError(error);
      return fallback;
    }
  }
  return new MemoryStore();
}

export class MySqlStore {
  constructor() {
    this.kind = "mysql";
    this.startedAt = new Date().toISOString();
    this.pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 10000,
      namedPlaceholders: true,
      timezone: "Z"
    });
  }

  async init() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country ENUM('AE', 'SA') NOT NULL DEFAULT 'AE',
        phone_e164 VARCHAR(32) UNIQUE NOT NULL,
        phone_display VARCHAR(64),
        raw_phone VARCHAR(128),
        company_name VARCHAR(255),
        contact_name VARCHAR(255),
        email VARCHAR(255),
        source_file VARCHAR(255),
        source_sheet VARCHAR(255),
        status ENUM('subscribed', 'unsubscribed', 'invalid', 'blocked') NOT NULL DEFAULT 'subscribed',
        notes TEXT,
        tags TEXT,
        first_added_at DATETIME NOT NULL,
        last_updated_at DATETIME NOT NULL,
        unsubscribed_at DATETIME NULL,
        INDEX idx_contacts_country_status (country, status),
        INDEX idx_contacts_company_name (company_name),
        INDEX idx_contacts_contact_name (contact_name),
        INDEX idx_contacts_email (email)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS import_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country ENUM('AE', 'SA') NOT NULL DEFAULT 'AE',
        file_name VARCHAR(255),
        import_type ENUM('contact_file', 'unsubscribe_list', 'status_update') NOT NULL DEFAULT 'contact_file',
        total_rows INT NOT NULL DEFAULT 0,
        numbers_found INT NOT NULL DEFAULT 0,
        new_added INT NOT NULL DEFAULT 0,
        already_existing INT NOT NULL DEFAULT 0,
        duplicates INT NOT NULL DEFAULT 0,
        unsubscribed_blocked INT NOT NULL DEFAULT 0,
        invalid_numbers INT NOT NULL DEFAULT 0,
        imported_unsubscribed INT NOT NULL DEFAULT 0,
        imported_at DATETIME NOT NULL,
        INDEX idx_import_history_country_date (country, imported_at)
      )
    `);
  }

  async summary(country) {
    const [rows] = await this.pool.execute(
      `
      SELECT
        COUNT(*) total_contacts,
        SUM(status = 'subscribed') subscribed,
        SUM(status = 'unsubscribed') unsubscribed,
        SUM(status = 'blocked') blocked,
        SUM(status = 'invalid') invalid,
        SUM(TRIM(COALESCE(company_name, '')) <> '') with_company,
        SUM(TRIM(COALESCE(company_name, '')) = '') missing_company,
        SUM(TRIM(COALESCE(contact_name, '')) = '') missing_contact_name
      FROM contacts
      WHERE country = :country
      `,
      { country }
    );
    const [history] = await this.pool.execute("SELECT MAX(imported_at) last_import FROM import_history WHERE country = :country", { country });
    return normalizeSummary(rows[0], history[0]?.last_import);
  }

  async findContactByPhone(phone) {
    const [rows] = await this.pool.execute("SELECT * FROM contacts WHERE phone_e164 = :phone LIMIT 1", { phone });
    return rows[0] || null;
  }

  async listContacts({ country, search = "", status = "", missingCompany = false, missingName = false, limit = 1000 }) {
    const clauses = ["country = :country"];
    const params = { country, limit: Number(limit) };
    if (search.trim()) {
      params.search = `%${search.trim()}%`;
      clauses.push("(phone_e164 LIKE :search OR contact_name LIKE :search OR company_name LIKE :search OR email LIKE :search OR status LIKE :search)");
    }
    if (status) {
      params.status = status;
      clauses.push("status = :status");
    }
    if (missingCompany) clauses.push("TRIM(COALESCE(company_name, '')) = ''");
    if (missingName) clauses.push("TRIM(COALESCE(contact_name, '')) = ''");
    const [rows] = await this.pool.execute(
      `
      SELECT * FROM contacts
      WHERE ${clauses.join(" AND ")}
      ORDER BY last_updated_at DESC, id DESC
      LIMIT :limit
      `,
      params
    );
    return rows;
  }

  async upsertImportedContact(record, { updateExisting = false } = {}) {
    const existing = await this.findContactByPhone(record.phone_e164);
    const now = sqlNow();
    const incomingStatus = record.incoming_status === "unsubscribed" ? "unsubscribed" : "subscribed";

    if (!existing) {
      await this.pool.execute(
        `
        INSERT INTO contacts (
          country, phone_e164, phone_display, raw_phone, company_name, contact_name, email,
          source_file, source_sheet, status, first_added_at, last_updated_at, unsubscribed_at
        ) VALUES (
          :country, :phone_e164, :phone_display, :raw_phone, :company_name, :contact_name, :email,
          :source_file, :source_sheet, :status, :first_added_at, :last_updated_at, :unsubscribed_at
        )
        `,
        {
          ...record,
          status: incomingStatus,
          first_added_at: now,
          last_updated_at: now,
          unsubscribed_at: incomingStatus === "unsubscribed" ? now : null
        }
      );
      return incomingStatus === "unsubscribed" ? "new_unsubscribed" : "new_added";
    }

    if (incomingStatus === "unsubscribed") {
      await this.updateContact(existing.id, {
        status: "unsubscribed",
        unsubscribed_at: existing.unsubscribed_at || now,
        ...detailsToUpdate(existing, record, updateExisting)
      });
      return existing.status === "unsubscribed" ? "already_unsubscribed" : "changed_to_unsubscribed";
    }

    if (["unsubscribed", "blocked"].includes(existing.status)) {
      const updates = detailsToUpdate(existing, record, false);
      if (Object.keys(updates).length) await this.updateContact(existing.id, updates);
      return "suppressed_blocked";
    }

    const updates = detailsToUpdate(existing, record, updateExisting);
    if (Object.keys(updates).length) {
      await this.updateContact(existing.id, updates);
      return "existing_updated";
    }
    return "already_subscribed";
  }

  async updateContact(id, fields) {
    const safeFields = sanitizeFields(fields);
    if (!Object.keys(safeFields).length) return;
    safeFields.last_updated_at = sqlNow();
    const assignments = Object.keys(safeFields).map((key) => `${key} = :${key}`).join(", ");
    await this.pool.execute(`UPDATE contacts SET ${assignments} WHERE id = :id`, { ...safeFields, id });
  }

  async deleteContact(id) {
    await this.pool.execute("DELETE FROM contacts WHERE id = :id", { id });
  }

  async contactsForExport({ country, limit, order }) {
    const capped = Math.max(1, Math.min(Number(limit) || 1000, 1000));
    let orderSql = "first_added_at DESC, id DESC";
    if (order === "oldest") orderSql = "first_added_at ASC, id ASC";
    if (order === "random") orderSql = "RAND()";
    const [rows] = await this.pool.execute(
      `
      SELECT * FROM contacts
      WHERE country = :country AND status = 'subscribed'
      ORDER BY ${orderSql}
      LIMIT :limit
      `,
      { country, limit: capped }
    );
    return rows;
  }

  async addImportHistory(summary) {
    await this.pool.execute(
      `
      INSERT INTO import_history (
        country, file_name, import_type, total_rows, numbers_found, new_added, already_existing,
        duplicates, unsubscribed_blocked, invalid_numbers, imported_unsubscribed, imported_at
      ) VALUES (
        :country, :file_name, :import_type, :total_rows, :numbers_found, :new_added, :already_existing,
        :duplicates, :unsubscribed_blocked, :invalid_numbers, :imported_unsubscribed, :imported_at
      )
      `,
      { ...summary, imported_at: sqlNow() }
    );
  }

  async importHistory(country) {
    const [rows] = await this.pool.execute("SELECT * FROM import_history WHERE country = :country ORDER BY imported_at DESC, id DESC LIMIT 200", { country });
    return rows;
  }
}

export class MemoryStore {
  constructor() {
    this.kind = "memory";
    this.startedAt = new Date().toISOString();
    this.contacts = [];
    this.history = [];
    this.nextId = 1;
    this.nextHistoryId = 1;
  }

  async summary(country) {
    const rows = this.contacts.filter((contact) => contact.country === country);
    const last = this.history.filter((item) => item.country === country).map((item) => item.imported_at).sort().at(-1);
    return normalizeSummary(
      {
        total_contacts: rows.length,
        subscribed: rows.filter((row) => row.status === "subscribed").length,
        unsubscribed: rows.filter((row) => row.status === "unsubscribed").length,
        blocked: rows.filter((row) => row.status === "blocked").length,
        invalid: rows.filter((row) => row.status === "invalid").length,
        with_company: rows.filter((row) => row.company_name).length,
        missing_company: rows.filter((row) => !row.company_name).length,
        missing_contact_name: rows.filter((row) => !row.contact_name).length
      },
      last
    );
  }

  async findContactByPhone(phone) {
    return this.contacts.find((contact) => contact.phone_e164 === phone) || null;
  }

  async listContacts({ country, search = "", status = "", missingCompany = false, missingName = false, limit = 1000 }) {
    const term = search.trim().toLowerCase();
    return this.contacts
      .filter((contact) => contact.country === country)
      .filter((contact) => !status || contact.status === status)
      .filter((contact) => !missingCompany || !contact.company_name)
      .filter((contact) => !missingName || !contact.contact_name)
      .filter((contact) => !term || ["phone_e164", "contact_name", "company_name", "email", "status"].some((key) => String(contact[key] || "").toLowerCase().includes(term)))
      .sort((a, b) => String(b.last_updated_at).localeCompare(String(a.last_updated_at)))
      .slice(0, Number(limit));
  }

  async upsertImportedContact(record, { updateExisting = false } = {}) {
    const existing = await this.findContactByPhone(record.phone_e164);
    const now = sqlNow();
    const incomingStatus = record.incoming_status === "unsubscribed" ? "unsubscribed" : "subscribed";
    if (!existing) {
      this.contacts.push({
        id: this.nextId++,
        ...record,
        status: incomingStatus,
        first_added_at: now,
        last_updated_at: now,
        unsubscribed_at: incomingStatus === "unsubscribed" ? now : null,
        notes: "",
        tags: ""
      });
      return incomingStatus === "unsubscribed" ? "new_unsubscribed" : "new_added";
    }
    if (incomingStatus === "unsubscribed") {
      const wasUnsubscribed = existing.status === "unsubscribed";
      Object.assign(existing, detailsToUpdate(existing, record, updateExisting), {
        status: "unsubscribed",
        unsubscribed_at: existing.unsubscribed_at || now,
        last_updated_at: now
      });
      return wasUnsubscribed ? "already_unsubscribed" : "changed_to_unsubscribed";
    }
    if (["unsubscribed", "blocked"].includes(existing.status)) {
      Object.assign(existing, detailsToUpdate(existing, record, false), { last_updated_at: now });
      return "suppressed_blocked";
    }
    const updates = detailsToUpdate(existing, record, updateExisting);
    if (Object.keys(updates).length) {
      Object.assign(existing, updates, { last_updated_at: now });
      return "existing_updated";
    }
    return "already_subscribed";
  }

  async updateContact(id, fields) {
    const contact = this.contacts.find((item) => item.id === Number(id));
    if (!contact) return;
    Object.assign(contact, sanitizeFields(fields), { last_updated_at: sqlNow() });
  }

  async deleteContact(id) {
    this.contacts = this.contacts.filter((contact) => contact.id !== Number(id));
  }

  async contactsForExport({ country, limit, order }) {
    const capped = Math.max(1, Math.min(Number(limit) || 1000, 1000));
    const rows = this.contacts.filter((contact) => contact.country === country && contact.status === "subscribed");
    if (order === "oldest") rows.sort((a, b) => String(a.first_added_at).localeCompare(String(b.first_added_at)));
    else if (order === "random") rows.sort(() => Math.random() - 0.5);
    else rows.sort((a, b) => String(b.first_added_at).localeCompare(String(a.first_added_at)));
    return rows.slice(0, capped);
  }

  async addImportHistory(summary) {
    this.history.unshift({ id: this.nextHistoryId++, ...summary, imported_at: sqlNow() });
  }

  async importHistory(country) {
    return this.history.filter((item) => item.country === country);
  }
}

function normalizeSummary(row = {}, lastImport) {
  const total = Number(row.total_contacts || 0);
  const subscribed = Number(row.subscribed || 0);
  return {
    total_contacts: total,
    subscribed,
    unsubscribed: Number(row.unsubscribed || 0),
    blocked: Number(row.blocked || 0),
    invalid: Number(row.invalid || 0),
    with_company: Number(row.with_company || 0),
    missing_company: Number(row.missing_company || 0),
    missing_contact_name: Number(row.missing_contact_name || 0),
    available_for_next_export: Math.min(subscribed, 1000),
    last_import: lastImport || "Never"
  };
}

function detailsToUpdate(existing, record, updateExisting) {
  const updates = {};
  for (const field of ["company_name", "contact_name", "email", "source_file", "source_sheet", "raw_phone", "phone_display"]) {
    const value = cleanOptional(record[field]);
    if (!value) continue;
    if (updateExisting || !existing[field]) updates[field] = value;
  }
  return updates;
}

function sanitizeFields(fields) {
  const allowed = new Set(["country", "phone_display", "raw_phone", "company_name", "contact_name", "email", "source_file", "source_sheet", "status", "notes", "tags", "unsubscribed_at"]);
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!allowed.has(key)) continue;
    if (key === "status" && !STATUS_VALUES.has(value)) continue;
    output[key] = value || null;
  }
  return output;
}

function cleanOptional(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (["nan", "none", "null", "undefined"].includes(text.toLowerCase())) return "";
  return text;
}

function sqlNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function friendlyDatabaseError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  const message = error?.message || "Unknown database connection error";
  return `${code}${message}`;
}
