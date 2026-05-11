const path = require("node:path");

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");

const app = express();
const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
let startupError = "";
let storeKind = "booting";

process.on("uncaughtException", (error) => {
  startupError = error && error.stack ? error.stack : String(error);
  console.error("Uncaught exception during app runtime:", error);
});

process.on("unhandledRejection", (reason) => {
  startupError = reason && reason.stack ? reason.stack : String(reason);
  console.error("Unhandled promise rejection during app runtime:", reason);
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "local-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.FORCE_HTTPS === "true"
    }
  })
);

app.get("/healthz", async (_req, res) => {
  const diagnostics = await runBasicDiagnostics();
  res.status(diagnostics.database.attempted && !diagnostics.database.ok ? 503 : 200).json(diagnostics);
});

app.get("/diagnostics", async (_req, res) => {
  const diagnostics = await runBasicDiagnostics();
  res.type("html").send(renderDiagnosticsHtml(diagnostics));
});

app.get("/", (req, res, next) => {
  if (storeKind === "booting") {
    res.redirect("/diagnostics");
    return;
  }
  next();
});

async function bootMainApp() {
  try {
    const [{ createRouter }, { createStore, MemoryStore }] = await Promise.all([
      import("./src/routes.mjs"),
      import("./src/store.mjs")
    ]);

    let store;
    try {
      store = await createStore();
    } catch (error) {
      startupError = error && error.stack ? error.stack : String(error);
      console.error("Unexpected startup error. Starting in temporary memory mode.", error);
      store = new MemoryStore();
      store.kind = "memory-startup-error";
      store.databaseError = error && error.message ? error.message : String(error);
    }

    storeKind = store.kind;
    console.log(`Store initialized in ${store.kind} mode`);
    app.use("/", createRouter(store));
  } catch (error) {
    storeKind = "entrypoint-error";
    startupError = error && error.stack ? error.stack : String(error);
    console.error("Main app failed to load. Diagnostics mode is still available.", error);
    app.get("/", (_req, res) => {
      res.status(500).type("html").send(renderDiagnosticsHtml({
        app: appSnapshot(),
        environment: safeEnvironmentSnapshot(),
        database: {
          attempted: false,
          ok: false,
          code: "APP_LOAD_FAILED",
          message: startupError,
          errno: "",
          sql_state: ""
        }
      }));
    });
  }
}

function safeEnvironmentSnapshot() {
  return {
    node_env: process.env.NODE_ENV || "",
    node_version: process.version,
    port: process.env.PORT || "",
    db_host: process.env.DB_HOST || "",
    db_port: process.env.DB_PORT || "",
    db_name: process.env.DB_NAME || "",
    db_user: process.env.DB_USER || "",
    db_password_set: Boolean(process.env.DB_PASSWORD),
    admin_password_set: Boolean(process.env.ADMIN_PASSWORD),
    session_secret_set: Boolean(process.env.SESSION_SECRET)
  };
}

function appSnapshot() {
  return {
    ok: !startupError,
    store_kind: storeKind,
    started_at: startedAt,
    database_startup_error: startupError
  };
}

async function runBasicDiagnostics() {
  const environment = safeEnvironmentSnapshot();
  const result = {
    app: appSnapshot(),
    environment,
    database: {
      attempted: Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME),
      ok: false,
      code: "",
      message: "",
      errno: "",
      sql_state: ""
    }
  };

  if (!result.database.attempted) {
    result.database.message = "DB_HOST, DB_USER, and DB_NAME are required before MySQL can be tested.";
    return result;
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 10000
    });
    await connection.execute("SELECT 1");
    result.database.ok = true;
    result.database.message = "Database connection test succeeded.";
  } catch (error) {
    result.database.ok = false;
    result.database.code = error && error.code ? error.code : "";
    result.database.message = error && error.message ? error.message : String(error);
    result.database.errno = error && error.errno ? error.errno : "";
    result.database.sql_state = error && error.sqlState ? error.sqlState : "";
  } finally {
    if (connection) await connection.end();
  }

  return result;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDiagnosticsHtml(diagnostics) {
  const envRows = Object.entries(diagnostics.environment)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value === true ? "Yes" : value === false ? "No" : value)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Deployment Diagnostics</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="login-page">
    <main class="login-panel" style="width:min(900px, 100%);">
      <h1>Deployment Diagnostics</h1>
      <p>App status: <strong>${escapeHtml(diagnostics.app.store_kind)}</strong></p>
      ${diagnostics.app.database_startup_error ? `<div class="alert danger"><pre>${escapeHtml(diagnostics.app.database_startup_error)}</pre></div>` : ""}
      <h2>Database Test</h2>
      <div class="${diagnostics.database.ok ? "alert" : "alert danger"}">${escapeHtml(diagnostics.database.message)}</div>
      <table>
        <tbody>
          <tr><th>Attempted</th><td>${diagnostics.database.attempted ? "Yes" : "No"}</td></tr>
          <tr><th>Connected</th><td>${diagnostics.database.ok ? "Yes" : "No"}</td></tr>
          <tr><th>Error code</th><td>${escapeHtml(diagnostics.database.code || "None")}</td></tr>
          <tr><th>SQL state</th><td>${escapeHtml(diagnostics.database.sql_state || "None")}</td></tr>
        </tbody>
      </table>
      <h2>Environment Snapshot</h2>
      <table><tbody>${envRows}</tbody></table>
    </main>
  </body>
</html>`;
}

app.listen(port, "0.0.0.0", () => {
  console.log(`WhatsApp Contact Guard web app running on port ${port}`);
});

bootMainApp();
