"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AuthValidationError,
  createSessionCredentials,
  hashPassword,
  normalizeUsername,
  parseCookies,
  parsePasswordHash,
  serializeCookie,
  validatePassword,
  verifyPassword,
  verifyToken,
} = require("../src/auth");

test("normalizes valid usernames and rejects unsafe ones", () => {
  assert.equal(normalizeUsername("  Odysseus.User  "), "odysseus.user");
  assert.throws(() => normalizeUsername("ab"), AuthValidationError);
  assert.throws(() => normalizeUsername("../admin"), AuthValidationError);
  assert.throws(() => normalizeUsername("user name"), AuthValidationError);
});

test("enforces the local beta password length policy", () => {
  assert.equal(validatePassword("test12"), "test12");
  assert.equal(validatePassword("Correct-Horse-42"), "Correct-Horse-42");
  assert.throws(() => validatePassword("short"), AuthValidationError);
  assert.equal(
    validatePassword("alllowercasepassword"),
    "alllowercasepassword",
  );
  assert.throws(() => validatePassword("a".repeat(129)), AuthValidationError);
});

test("hashes and verifies passwords with a unique scrypt salt", async () => {
  const fixture = "Correct-Horse-42";
  const firstHash = await hashPassword(fixture);
  const secondHash = await hashPassword(fixture);

  assert.notEqual(firstHash, secondHash);
  assert.equal(firstHash.includes(fixture), false);
  assert.ok(parsePasswordHash(firstHash));
  assert.equal(await verifyPassword(fixture, firstHash), true);
  assert.equal(await verifyPassword("Incorrect-Horse-42", firstHash), false);
  assert.equal(await verifyPassword(fixture, "invalid"), false);
});

test("creates opaque session and CSRF credentials stored as hashes", () => {
  const credentials = createSessionCredentials();

  assert.notEqual(credentials.token, credentials.csrfToken);
  assert.equal(credentials.tokenHash.length, 32);
  assert.equal(credentials.csrfHash.length, 32);
  assert.equal(verifyToken(credentials.token, credentials.tokenHash), true);
  assert.equal(verifyToken("wrong-token", credentials.tokenHash), false);
});

test("parses and serializes hardened cookies", () => {
  const serialized = serializeCookie("odysseus_session", "opaque token", {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 600,
  });

  assert.match(serialized, /^odysseus_session=opaque%20token/);
  assert.match(serialized, /Path=\//);
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /Secure/);
  assert.match(serialized, /SameSite=Strict/);
  assert.deepEqual(
    { ...parseCookies("odysseus_session=opaque%20token; theme=dark") },
    {
      odysseus_session: "opaque token",
      theme: "dark",
    },
  );
});
