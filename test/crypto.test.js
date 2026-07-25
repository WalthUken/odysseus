"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CryptoConfigurationError,
  decryptJson,
  encryptJson,
  loadMasterKey,
  parseMasterKey,
} = require("../src/crypto");

test("parses 32-byte hexadecimal, base64, and base64url master keys", () => {
  const key = crypto.randomBytes(32);

  assert.deepEqual(parseMasterKey(key.toString("hex")), key);
  assert.deepEqual(parseMasterKey(key.toString("base64")), key);
  assert.deepEqual(parseMasterKey(key.toString("base64url")), key);
  assert.throws(() => parseMasterKey("too-short"), CryptoConfigurationError);
});

test("encrypts templates with authenticated additional data", () => {
  const key = crypto.randomBytes(32);
  const template = {
    featureKeys: ["dwellMean"],
    means: { dwellMean: 101.25 },
  };
  const encrypted = encryptJson(template, key, {
    additionalData: "user-1:device-1",
  });

  assert.notEqual(
    encrypted.ciphertext.toString("utf8"),
    JSON.stringify(template),
  );
  assert.deepEqual(
    decryptJson(encrypted, key, {
      additionalData: "user-1:device-1",
    }),
    template,
  );
  assert.throws(() =>
    decryptJson(encrypted, key, {
      additionalData: "user-2:device-1",
    }),
  );
});

test("creates and reloads a development key outside source control", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-key-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "master.key");

  const first = await loadMasterKey({
    env: {},
    production: false,
    keyPath,
  });
  const second = await loadMasterKey({
    env: {},
    production: false,
    keyPath,
  });

  assert.equal(first.length, 32);
  assert.deepEqual(second, first);
});

test("requires an explicit master key in production", async () => {
  await assert.rejects(
    loadMasterKey({
      env: {},
      production: true,
    }),
    CryptoConfigurationError,
  );
});
