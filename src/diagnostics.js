import mysql from "mysql2/promise";

export function safeEnvironmentSnapshot() {
  return {
    node_env: process.env.NODE_ENV || "",
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

export async function runDiagnostics(store) {
  const environment = safeEnvironmentSnapshot();
  const result = {
    app: {
      ok: true,
      store_kind: store.kind,
      started_at: store.startedAt || null,
      database_startup_error: store.databaseError || ""
    },
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
    result.database.code = error?.code || "";
    result.database.message = error?.message || String(error);
    result.database.errno = error?.errno || "";
    result.database.sql_state = error?.sqlState || "";
  } finally {
    if (connection) await connection.end();
  }

  return result;
}

