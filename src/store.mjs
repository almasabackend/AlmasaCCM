import mysql from "mysql2/promise";

const STATUS_VALUES = new Set(["subscribed", "unsubscribed", "invalid", "blocked"]);
const COUNTRY_VALUES = new Set(["AE", "SA"]);
const CONTACT_COLUMNS = [
  "id",
  "country",
  "phone_e164",
  "phone_display",
  "raw_phone",
  "company_name",
  "contact_name",
  "email",
  "source_file",
  "source_sheet",
  "status",
  "notes",
  "tags",
  "first_added_at",
  "last_updated_at",
  "unsubscribed_at"
];

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
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS contact_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country ENUM('AE', 'SA') NOT NULL DEFAULT 'AE',
        name VARCHAR(120) NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uniq_contact_group_country_name (country, name)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS contact_group_members (
        group_id INT NOT NULL,
        contact_id INT NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (group_id, contact_id),
        INDEX idx_group_members_contact (contact_id)
      )
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS rollback_snapshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country ENUM('AE', 'SA') NOT NULL DEFAULT 'AE',
        label VARCHAR(255),
        summary_json LONGTEXT,
        contacts_json LONGTEXT NOT NULL,
        groups_json LONGTEXT NOT NULL,
        group_members_json LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_rollback_snapshots_country_date (country, created_at)
      )
    `);
  }

  async summary(country) {
    const countryClause = isAllCountryCode(country) ? "" : "WHERE country = :country";
    const params = isAllCountryCode(country) ? {} : { country };
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
      ${countryClause}
      `,
      params
    );
    const [history] = await this.pool.execute(
      `SELECT MAX(imported_at) last_import FROM import_history ${countryClause}`,
      params
    );
    return normalizeSummary(rows[0], history[0]?.last_import);
  }

  async findContactByPhone(phone) {
    const [rows] = await this.pool.execute("SELECT * FROM contacts WHERE phone_e164 = :phone LIMIT 1", { phone });
    return rows[0] || null;
  }

  async listContacts({ country, search = "", status = "", missingCompany = false, missingName = false, groupId = "", limit = 1000 }) {
    const clauses = isAllCountryCode(country) ? [] : ["c.country = :country"];
    const params = isAllCountryCode(country) ? { limit: Number(limit) } : { country, limit: Number(limit) };
    if (search.trim()) {
      params.search = `%${search.trim()}%`;
      clauses.push("(c.phone_e164 LIKE :search OR c.contact_name LIKE :search OR c.company_name LIKE :search OR c.email LIKE :search OR c.status LIKE :search)");
    }
    if (status) {
      params.status = status;
      clauses.push("c.status = :status");
    }
    if (missingCompany) clauses.push("TRIM(COALESCE(c.company_name, '')) = ''");
    if (missingName) clauses.push("TRIM(COALESCE(c.contact_name, '')) = ''");
    if (groupId) {
      params.groupId = Number(groupId);
      clauses.push("gm_filter.group_id = :groupId");
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await this.pool.execute(
      `
      SELECT c.*, GROUP_CONCAT(DISTINCT cg.name ORDER BY cg.name SEPARATOR ', ') groups
      FROM contacts c
      ${groupId ? "INNER JOIN contact_group_members gm_filter ON gm_filter.contact_id = c.id" : ""}
      LEFT JOIN contact_group_members gm ON gm.contact_id = c.id
      LEFT JOIN contact_groups cg ON cg.id = gm.group_id
      ${whereSql}
      GROUP BY c.id
      ORDER BY c.last_updated_at DESC, c.id DESC
      LIMIT :limit
      `,
      params
    );
    return rows;
  }

  async listContactGroups(country) {
    const countryClause = isAllCountryCode(country) ? "" : "WHERE g.country = :country";
    const params = isAllCountryCode(country) ? {} : { country };
    const [rows] = await this.pool.execute(
      `
      SELECT g.*, COUNT(gm.contact_id) contact_count
      FROM contact_groups g
      LEFT JOIN contact_group_members gm ON gm.group_id = g.id
      ${countryClause}
      GROUP BY g.id
      ORDER BY g.name ASC
      `,
      params
    );
    return rows;
  }

  async createContactGroup(country, name) {
    const cleanName = cleanOptional(name);
    const cleanCountry = COUNTRY_VALUES.has(country) ? country : "AE";
    if (!cleanName) return null;
    await this.pool.execute(
      "INSERT IGNORE INTO contact_groups (country, name, created_at) VALUES (:country, :name, :created_at)",
      { country: cleanCountry, name: cleanName, created_at: sqlNow() }
    );
    const [rows] = await this.pool.execute("SELECT * FROM contact_groups WHERE country = :country AND name = :name LIMIT 1", { country: cleanCountry, name: cleanName });
    return rows[0] || null;
  }

  async addContactToGroup(contactId, groupId) {
    if (!groupId) return;
    await this.pool.execute(
      "INSERT IGNORE INTO contact_group_members (group_id, contact_id, created_at) VALUES (:groupId, :contactId, :created_at)",
      { groupId: Number(groupId), contactId: Number(contactId), created_at: sqlNow() }
    );
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

  async contactsForExport({ country, limit, order, status = "subscribed" }) {
    const capped = Math.max(1, Math.min(Number(limit) || 1000, 1000));
    let orderSql = "first_added_at DESC, id DESC";
    if (order === "oldest") orderSql = "first_added_at ASC, id ASC";
    if (order === "random") orderSql = "RAND()";
    const exportStatus = STATUS_VALUES.has(status) ? status : "subscribed";
    const countryClause = isAllCountryCode(country) ? "" : "country = :country AND";
    const params = isAllCountryCode(country)
      ? { status: exportStatus, limit: capped }
      : { country, status: exportStatus, limit: capped };
    const [rows] = await this.pool.execute(
      `
      SELECT * FROM contacts
      WHERE ${countryClause} status = :status
      ORDER BY ${orderSql}
      LIMIT :limit
      `,
      params
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
    const countryClause = isAllCountryCode(country) ? "" : "WHERE country = :country";
    const params = isAllCountryCode(country) ? {} : { country };
    const [rows] = await this.pool.execute(`SELECT * FROM import_history ${countryClause} ORDER BY imported_at DESC, id DESC LIMIT 200`, params);
    return rows;
  }

  async createRollbackSnapshot({ country, label = "", summary = {} }) {
    const cleanCountry = COUNTRY_VALUES.has(country) ? country : "AE";
    const [contacts] = await this.pool.execute("SELECT * FROM contacts WHERE country = :country ORDER BY id", { country: cleanCountry });
    const [groups] = await this.pool.execute("SELECT * FROM contact_groups WHERE country = :country ORDER BY id", { country: cleanCountry });
    const [groupMembers] = await this.pool.execute(
      `
      SELECT DISTINCT gm.*
      FROM contact_group_members gm
      LEFT JOIN contacts c ON c.id = gm.contact_id
      LEFT JOIN contact_groups g ON g.id = gm.group_id
      WHERE c.country = :country OR g.country = :country
      ORDER BY gm.group_id, gm.contact_id
      `,
      { country: cleanCountry }
    );
    const [result] = await this.pool.execute(
      `
      INSERT INTO rollback_snapshots (
        country, label, summary_json, contacts_json, groups_json, group_members_json, created_at
      ) VALUES (
        :country, :label, :summary_json, :contacts_json, :groups_json, :group_members_json, :created_at
      )
      `,
      {
        country: cleanCountry,
        label: cleanOptional(label) || "Before confirmed import",
        summary_json: JSON.stringify(summary || {}),
        contacts_json: JSON.stringify(contacts),
        groups_json: JSON.stringify(groups),
        group_members_json: JSON.stringify(groupMembers),
        created_at: sqlNow()
      }
    );
    return { id: result.insertId, country: cleanCountry, label, contacts_count: contacts.length };
  }

  async rollbackSnapshots(country) {
    const countryClause = isAllCountryCode(country) ? "" : "WHERE country = :country";
    const params = isAllCountryCode(country) ? {} : { country };
    const [rows] = await this.pool.execute(
      `
      SELECT id, country, label, summary_json, contacts_json, created_at
      FROM rollback_snapshots
      ${countryClause}
      ORDER BY created_at DESC, id DESC
      LIMIT 100
      `,
      params
    );
    return rows.map((row) => snapshotListRow(row));
  }

  async restoreRollbackSnapshot(id) {
    const [rows] = await this.pool.execute("SELECT * FROM rollback_snapshots WHERE id = :id LIMIT 1", { id: Number(id) });
    const snapshot = rows[0];
    if (!snapshot) return null;
    const country = snapshot.country;
    const contacts = parseJson(snapshot.contacts_json, []);
    const groups = parseJson(snapshot.groups_json, []);
    const groupMembers = parseJson(snapshot.group_members_json, []);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `
        DELETE gm FROM contact_group_members gm
        INNER JOIN contacts c ON c.id = gm.contact_id
        WHERE c.country = :country
        `,
        { country }
      );
      await conn.execute(
        `
        DELETE gm FROM contact_group_members gm
        INNER JOIN contact_groups g ON g.id = gm.group_id
        WHERE g.country = :country
        `,
        { country }
      );
      await conn.execute("DELETE FROM contacts WHERE country = :country", { country });
      await conn.execute("DELETE FROM contact_groups WHERE country = :country", { country });

      const contactSql = `INSERT INTO contacts (${CONTACT_COLUMNS.join(", ")}) VALUES (${CONTACT_COLUMNS.map((column) => `:${column}`).join(", ")})`;
      for (const contact of contacts) {
        await conn.execute(contactSql, paramsForColumns(contact, CONTACT_COLUMNS));
      }
      for (const group of groups) {
        await conn.execute(
          "INSERT INTO contact_groups (id, country, name, created_at) VALUES (:id, :country, :name, :created_at)",
          paramsForColumns(group, ["id", "country", "name", "created_at"])
        );
      }
      for (const member of groupMembers) {
        await conn.execute(
          "INSERT IGNORE INTO contact_group_members (group_id, contact_id, created_at) VALUES (:group_id, :contact_id, :created_at)",
          paramsForColumns(member, ["group_id", "contact_id", "created_at"])
        );
      }
      await conn.commit();
      return snapshotListRow(snapshot);
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
}

export class MemoryStore {
  constructor() {
    this.kind = "memory";
    this.startedAt = new Date().toISOString();
    this.contacts = [];
    this.history = [];
    this.groups = [];
    this.groupMembers = [];
    this.snapshots = [];
    this.nextId = 1;
    this.nextHistoryId = 1;
    this.nextGroupId = 1;
    this.nextSnapshotId = 1;
  }

  async summary(country) {
    const rows = this.contacts.filter((contact) => isAllCountryCode(country) || contact.country === country);
    const last = this.history.filter((item) => isAllCountryCode(country) || item.country === country).map((item) => item.imported_at).sort().at(-1);
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

  async listContacts({ country, search = "", status = "", missingCompany = false, missingName = false, groupId = "", limit = 1000 }) {
    const term = search.trim().toLowerCase();
    return this.contacts
      .filter((contact) => isAllCountryCode(country) || contact.country === country)
      .filter((contact) => !status || contact.status === status)
      .filter((contact) => !missingCompany || !contact.company_name)
      .filter((contact) => !missingName || !contact.contact_name)
      .filter((contact) => !groupId || this.groupMembers.some((member) => member.contact_id === contact.id && member.group_id === Number(groupId)))
      .map((contact) => ({
        ...contact,
        groups: this.groupMembers
          .filter((member) => member.contact_id === contact.id)
          .map((member) => this.groups.find((group) => group.id === member.group_id)?.name)
          .filter(Boolean)
          .join(", ")
      }))
      .filter((contact) => !term || ["phone_e164", "contact_name", "company_name", "email", "status"].some((key) => String(contact[key] || "").toLowerCase().includes(term)))
      .sort((a, b) => String(b.last_updated_at).localeCompare(String(a.last_updated_at)))
      .slice(0, Number(limit));
  }

  async listContactGroups(country) {
    return this.groups
      .filter((group) => isAllCountryCode(country) || group.country === country)
      .map((group) => ({
        ...group,
        contact_count: this.groupMembers.filter((member) => member.group_id === group.id).length
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createContactGroup(country, name) {
    const cleanName = cleanOptional(name);
    const cleanCountry = COUNTRY_VALUES.has(country) ? country : "AE";
    if (!cleanName) return null;
    const existing = this.groups.find((group) => group.country === cleanCountry && group.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) return existing;
    const group = { id: this.nextGroupId++, country: cleanCountry, name: cleanName, created_at: sqlNow() };
    this.groups.push(group);
    return group;
  }

  async addContactToGroup(contactId, groupId) {
    const cleanContactId = Number(contactId);
    const cleanGroupId = Number(groupId);
    if (!cleanGroupId || this.groupMembers.some((member) => member.contact_id === cleanContactId && member.group_id === cleanGroupId)) return;
    this.groupMembers.push({ contact_id: cleanContactId, group_id: cleanGroupId, created_at: sqlNow() });
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

  async contactsForExport({ country, limit, order, status = "subscribed" }) {
    const capped = Math.max(1, Math.min(Number(limit) || 1000, 1000));
    const exportStatus = STATUS_VALUES.has(status) ? status : "subscribed";
    const rows = this.contacts.filter((contact) => (isAllCountryCode(country) || contact.country === country) && contact.status === exportStatus);
    if (order === "oldest") rows.sort((a, b) => String(a.first_added_at).localeCompare(String(b.first_added_at)));
    else if (order === "random") rows.sort(() => Math.random() - 0.5);
    else rows.sort((a, b) => String(b.first_added_at).localeCompare(String(a.first_added_at)));
    return rows.slice(0, capped);
  }

  async addImportHistory(summary) {
    this.history.unshift({ id: this.nextHistoryId++, ...summary, imported_at: sqlNow() });
  }

  async importHistory(country) {
    return this.history.filter((item) => isAllCountryCode(country) || item.country === country);
  }

  async createRollbackSnapshot({ country, label = "", summary = {} }) {
    const cleanCountry = COUNTRY_VALUES.has(country) ? country : "AE";
    const contacts = cloneJson(this.contacts.filter((contact) => contact.country === cleanCountry));
    const groups = cloneJson(this.groups.filter((group) => group.country === cleanCountry));
    const groupIds = new Set(groups.map((group) => group.id));
    const contactIds = new Set(contacts.map((contact) => contact.id));
    const groupMembers = cloneJson(this.groupMembers.filter((member) => groupIds.has(member.group_id) || contactIds.has(member.contact_id)));
    const snapshot = {
      id: this.nextSnapshotId++,
      country: cleanCountry,
      label: cleanOptional(label) || "Before confirmed import",
      summary_json: JSON.stringify(summary || {}),
      contacts_json: JSON.stringify(contacts),
      groups_json: JSON.stringify(groups),
      group_members_json: JSON.stringify(groupMembers),
      created_at: sqlNow()
    };
    this.snapshots.unshift(snapshot);
    return snapshotListRow(snapshot);
  }

  async rollbackSnapshots(country) {
    return this.snapshots
      .filter((snapshot) => isAllCountryCode(country) || snapshot.country === country)
      .map((snapshot) => snapshotListRow(snapshot));
  }

  async restoreRollbackSnapshot(id) {
    const snapshot = this.snapshots.find((item) => item.id === Number(id));
    if (!snapshot) return null;
    const country = snapshot.country;
    const contacts = parseJson(snapshot.contacts_json, []);
    const groups = parseJson(snapshot.groups_json, []);
    const groupMembers = parseJson(snapshot.group_members_json, []);
    const contactIds = new Set(this.contacts.filter((contact) => contact.country === country).map((contact) => contact.id));
    const groupIds = new Set(this.groups.filter((group) => group.country === country).map((group) => group.id));
    this.groupMembers = this.groupMembers.filter((member) => !contactIds.has(member.contact_id) && !groupIds.has(member.group_id));
    this.contacts = this.contacts.filter((contact) => contact.country !== country).concat(cloneJson(contacts));
    this.groups = this.groups.filter((group) => group.country !== country).concat(cloneJson(groups));
    this.groupMembers = this.groupMembers.concat(cloneJson(groupMembers));
    this.nextId = Math.max(this.nextId, ...this.contacts.map((contact) => Number(contact.id) + 1), 1);
    this.nextGroupId = Math.max(this.nextGroupId, ...this.groups.map((group) => Number(group.id) + 1), 1);
    return snapshotListRow(snapshot);
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

function snapshotListRow(row) {
  const summary = parseJson(row.summary_json, {});
  const contacts = parseJson(row.contacts_json, []);
  return {
    id: row.id,
    country: row.country,
    label: row.label || "Before confirmed import",
    created_at: row.created_at,
    contacts_count: Array.isArray(contacts) ? contacts.length : 0,
    summary
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function paramsForColumns(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, row?.[column] ?? null]));
}

function sqlNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function isAllCountryCode(country) {
  return String(country || "").toUpperCase() === "ALL";
}

function friendlyDatabaseError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  const message = error?.message || "Unknown database connection error";
  return `${code}${message}`;
}
