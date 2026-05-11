import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRouter } from "./src/routes.js";
import { createStore } from "./src/store.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception during app runtime:", error);
});

process.on("unhandledRejection", (reason) => {
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

const store = await createStore();
console.log(`Store initialized in ${store.kind} mode`);
app.use("/", createRouter(store));

app.listen(port, () => {
  console.log(`WhatsApp Contact Guard web app running on http://localhost:${port}`);
});
