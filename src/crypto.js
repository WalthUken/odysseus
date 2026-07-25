"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MASTER_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEFAULT_MASTER_KEY_PATH = path.join(
  __dirname,
  "..",
  "data",
  "master.key",
);

class CryptoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CryptoConfigurationError";
    this.code = "CRYPTO_CONFIGURATION_ERROR";
  }
}

async function restrictFilePermissions(filePath) {
  try {
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      return;
    }
    throw error;
  }
}

function parseMasterKey(encodedKey) {
  if (Buffer.isBuffer(encodedKey)) {
    if (encodedKey.length !== MASTER_KEY_BYTES) {
      throw new CryptoConfigurationError("Master key must contain exactly 32 bytes.");
    }
    return Buffer.from(encodedKey);
  }

  if (typeof encodedKey !== "string" || encodedKey.trim().length === 0) {
    throw new CryptoConfigurationError(
      "Master key must be a 32-byte base64, base64url, or hexadecimal value.",
    );
  }

  const value = encodedKey.trim();
  let key;

  if (/^[A-Fa-f0-9]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    key = Buffer.from(value, "base64");
  } else if (/^[A-Za-z0-9_-]{43}=?$/.test(value)) {
    key = Buffer.from(value.replace(/=$/, ""), "base64url");
  } else {
    throw new CryptoConfigurationError(
      "Master key must be a 32-byte base64, base64url, or hexadecimal value.",
    );
  }

  if (key.length !== MASTER_KEY_BYTES) {
    throw new CryptoConfigurationError("Master key must contain exactly 32 bytes.");
  }

  return key;
}

async function readKeyFile(keyPath) {
  const encodedKey = await fs.readFile(keyPath, "utf8");
  await restrictFilePermissions(keyPath);
  return parseMasterKey(encodedKey);
}

async function loadMasterKey(options = {}) {
  const env = options.env ?? process.env;
  const production = options.production ?? env.NODE_ENV === "production";
  const keyPath = path.resolve(options.keyPath ?? DEFAULT_MASTER_KEY_PATH);
  const suppliedKey = options.encodedKey ?? env.ODYSSEUS_MASTER_KEY;

  if (suppliedKey !== undefined && suppliedKey !== "") {
    return parseMasterKey(suppliedKey);
  }

  if (production) {
    throw new CryptoConfigurationError(
      "ODYSSEUS_MASTER_KEY is required when NODE_ENV is production.",
    );
  }

  try {
    return await readKeyFile(keyPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(MASTER_KEY_BYTES);

  try {
    await fs.writeFile(keyPath, `${key.toString("base64")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await restrictFilePermissions(keyPath);
    return key;
  } catch (error) {
    if (error.code === "EEXIST") {
      return readKeyFile(keyPath);
    }
    throw error;
  }
}

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw new CryptoConfigurationError("Encryption key must be a 32-byte Buffer.");
  }
}

function normalizeAdditionalData(additionalData) {
  if (additionalData === undefined || additionalData === null) {
    return null;
  }
  if (Buffer.isBuffer(additionalData)) {
    return additionalData;
  }
  if (typeof additionalData === "string") {
    return Buffer.from(additionalData, "utf8");
  }
  throw new TypeError("Additional authenticated data must be a string or Buffer.");
}

function encryptBytes(plaintext, key, options = {}) {
  requireKey(key);
  const input = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(String(plaintext), "utf8");
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  const additionalData = normalizeAdditionalData(options.additionalData);

  if (additionalData) {
    cipher.setAAD(additionalData);
  }

  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);

  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
  };
}

function decryptBytes(payload, key, options = {}) {
  requireKey(key);
  if (
    payload === null
    || typeof payload !== "object"
    || !Buffer.isBuffer(payload.ciphertext)
    || !Buffer.isBuffer(payload.iv)
    || !Buffer.isBuffer(payload.authTag)
    || payload.iv.length !== GCM_IV_BYTES
    || payload.authTag.length !== GCM_TAG_BYTES
  ) {
    throw new TypeError("Encrypted payload is invalid.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    payload.iv,
    { authTagLength: GCM_TAG_BYTES },
  );
  const additionalData = normalizeAdditionalData(options.additionalData);

  if (additionalData) {
    decipher.setAAD(additionalData);
  }
  decipher.setAuthTag(payload.authTag);

  return Buffer.concat([
    decipher.update(payload.ciphertext),
    decipher.final(),
  ]);
}

function encryptJson(value, key, options = {}) {
  return encryptBytes(JSON.stringify(value), key, options);
}

function decryptJson(payload, key, options = {}) {
  const plaintext = decryptBytes(payload, key, options).toString("utf8");
  return JSON.parse(plaintext);
}

function sha256(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    throw new TypeError("Value to hash must be a string or Buffer.");
  }
  return crypto.createHash("sha256").update(value).digest();
}

function generateOpaqueToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new TypeError("Token length must be an integer between 16 and 128 bytes.");
  }
  return crypto.randomBytes(bytes).toString("base64url");
}

function profileAdditionalData(userId, profileId) {
  return `odysseus:behavior-profile:v1:${userId}:${profileId}`;
}

module.exports = {
  CryptoConfigurationError,
  DEFAULT_MASTER_KEY_PATH,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  MASTER_KEY_BYTES,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateOpaqueToken,
  loadMasterKey,
  parseMasterKey,
  profileAdditionalData,
  restrictFilePermissions,
  sha256,
};
