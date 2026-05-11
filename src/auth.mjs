import crypto from "node:crypto";

const USER_CONFIG = [
  {
    email: "udaraka@almasauae.com",
    name: "Udaraka",
    passwordEnv: "UDARAKA_PASSWORD"
  },
  {
    email: "shuaib.m@almasauae.com",
    name: "Shuaib",
    passwordEnv: "SHUAIB_PASSWORD"
  }
];

export function configuredUsers() {
  return USER_CONFIG.map((user) => ({
    ...user,
    password: process.env[user.passwordEnv] || process.env.ADMIN_PASSWORD || ""
  }));
}

export function authConfigured() {
  return configuredUsers().some((user) => Boolean(user.password));
}

export function publicUserList() {
  return configuredUsers().map((user) => ({
    email: user.email,
    name: user.name,
    password_configured: Boolean(user.password)
  }));
}

export function authenticateUser(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const suppliedPassword = String(password || "");
  const user = configuredUsers().find((candidate) => candidate.email === normalizedEmail);
  if (!user || !user.password) return null;
  if (!safeCompare(suppliedPassword, user.password)) return null;
  return {
    email: user.email,
    name: user.name
  };
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

