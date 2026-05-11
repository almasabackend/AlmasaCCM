import test from "node:test";
import assert from "node:assert/strict";

import { authenticateUser, authConfigured, publicUserList } from "../src/auth.mjs";

test("authenticates only configured Almasa users", () => {
  const oldAdmin = process.env.ADMIN_PASSWORD;
  const oldUdaraka = process.env.UDARAKA_PASSWORD;
  const oldShuaib = process.env.SHUAIB_PASSWORD;

  process.env.ADMIN_PASSWORD = "";
  process.env.UDARAKA_PASSWORD = "udaraka-secret";
  process.env.SHUAIB_PASSWORD = "shuaib-secret";

  assert.equal(authConfigured(), true);
  assert.deepEqual(authenticateUser("udaraka@almasauae.com", "udaraka-secret"), {
    email: "udaraka@almasauae.com",
    name: "Udaraka"
  });
  assert.deepEqual(authenticateUser("SHUAIB.M@ALMASAUAE.COM", "shuaib-secret"), {
    email: "shuaib.m@almasauae.com",
    name: "Shuaib"
  });
  assert.equal(authenticateUser("other@almasauae.com", "udaraka-secret"), null);
  assert.equal(authenticateUser("udaraka@almasauae.com", "wrong"), null);

  process.env.ADMIN_PASSWORD = oldAdmin;
  process.env.UDARAKA_PASSWORD = oldUdaraka;
  process.env.SHUAIB_PASSWORD = oldShuaib;
});

test("reports public user password configuration without exposing passwords", () => {
  const oldAdmin = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "shared-temporary-password";

  const users = publicUserList();
  assert.equal(users.length, 2);
  assert.equal(users[0].password_configured, true);
  assert.equal("password" in users[0], false);

  process.env.ADMIN_PASSWORD = oldAdmin;
});

