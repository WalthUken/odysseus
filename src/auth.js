"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const { generateOpaqueToken, sha256 } = require("./crypto");

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_HASH_PREFIX = "scrypt";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

class AuthValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "AuthValidationError";
    this.code = "AUTH_VALIDATION_ERROR";
    this.details = details;
  }
}

function normalizeUsername(username) {
  if (typeof username !== "string") {
    throw new AuthValidationError("Username must be a string.");
  }

  const normalized = username.normalize("NFKC").trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 64) {
    throw new AuthValidationError(
      "Username must contain between 3 and 64 characters.",
    );
  }

  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AuthValidationError(
      "Username may contain lowercase letters, numbers, periods, underscores, and hyphens.",
    );
  }

  return normalized;
}

function validatePassword(password) {
  if (typeof password !== "string") {
    throw new AuthValidationError("Password must be a string.");
  }

  const byteLength = Buffer.byteLength(password, "utf8");
  if (password.length < 6 || password.length > 128 || byteLength > 512) {
    throw new AuthValidationError(
      "Password must contain between 6 and 128 characters.",
    );
  }

  return password;
}

function encodePasswordHash(salt, derivedKey) {
  return [
    PASSWORD_HASH_PREFIX,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

function parsePasswordHash(encodedHash) {
  if (typeof encodedHash !== "string") {
    return null;
  }

  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_PREFIX) {
    return null;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);

  if (
    cost !== SCRYPT_COST
    || blockSize !== SCRYPT_BLOCK_SIZE
    || parallelization !== SCRYPT_PARALLELIZATION
    || !/^[A-Za-z0-9_-]+$/.test(parts[4])
    || !/^[A-Za-z0-9_-]+$/.test(parts[5])
  ) {
    return null;
  }

  const salt = Buffer.from(parts[4], "base64url");
  const derivedKey = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || derivedKey.length !== SCRYPT_KEY_LENGTH) {
    return null;
  }

  return {
    cost,
    blockSize,
    parallelization,
    salt,
    derivedKey,
  };
}

async function derivePassword(password, salt) {
  return scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derivedKey = await derivePassword(password, salt);
  return encodePasswordHash(salt, derivedKey);
}

async function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed || typeof password !== "string") {
    return false;
  }

  const candidate = await derivePassword(password, parsed.salt);
  return crypto.timingSafeEqual(candidate, parsed.derivedKey);
}

function createSessionCredentials() {
  const sessionValue = generateOpaqueToken(32);
  const csrfValue = generateOpaqueToken(32);
  const sessionDigest = sha256(sessionValue);

  return {
    token: sessionValue,
    csrfToken: csrfValue,
    tokenHash: sessionDigest,
    csrfHash: sha256(csrfValue),
  };
}

function verifyToken(rawToken, expectedHash) {
  if (
    typeof rawToken !== "string"
    || !Buffer.isBuffer(expectedHash)
    || expectedHash.length !== 32
  ) {
    return false;
  }

  const candidateHash = sha256(rawToken);
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== "string" || header.trim() === "") {
    return cookies;
  }

  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const name = segment.slice(0, separator).trim();
    const encodedValue = segment.slice(separator + 1).trim();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || name === "__proto__"
      || name === "constructor"
      || name === "prototype"
    ) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(encodedValue);
    } catch {
      cookies[name] = encodedValue;
    }
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  if (
    typeof name !== "string"
    || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
  ) {
    throw new AuthValidationError("Cookie name is invalid.");
  }
  if (typeof value !== "string") {
    throw new AuthValidationError("Cookie value must be a string.");
  }

  const parts = [`${name}=${encodeURIComponent(value)}`];
  const cookiePath = options.path === undefined ? "/" : options.path;
  if (cookiePath !== null) {
    if (
      typeof cookiePath !== "string"
      || /[\u0000-\u001F\u007F;]/.test(cookiePath)
    ) {
      throw new AuthValidationError("Cookie path is invalid.");
    }
    parts.push(`Path=${cookiePath}`);
  }

  if (options.domain !== undefined) {
    if (
      typeof options.domain !== "string"
      || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/.test(
        options.domain,
      )
    ) {
      throw new AuthValidationError("Cookie domain is invalid.");
    }
    parts.push(`Domain=${options.domain}`);
  }

  if (options.maxAge !== undefined) {
    if (!Number.isSafeInteger(options.maxAge)) {
      throw new AuthValidationError("Cookie maxAge must be an integer in seconds.");
    }
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires !== undefined) {
    const expires = options.expires instanceof Date
      ? options.expires
      : new Date(options.expires);
    if (!Number.isFinite(expires.getTime())) {
      throw new AuthValidationError("Cookie expiration is invalid.");
    }
    parts.push(`Expires=${expires.toUTCString()}`);
  }

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure === true) {
    parts.push("Secure");
  }

  const sameSite = options.sameSite ?? "Lax";
  if (sameSite !== false) {
    const normalizedSameSite = String(sameSite).toLowerCase();
    const sameSiteValues = {
      lax: "Lax",
      none: "None",
      strict: "Strict",
    };
    if (!Object.hasOwn(sameSiteValues, normalizedSameSite)) {
      throw new AuthValidationError(
        "Cookie sameSite must be Lax, Strict, None, or false.",
      );
    }
    parts.push(`SameSite=${sameSiteValues[normalizedSameSite]}`);
  }

  return parts.join("; ");
}

module.exports = {
  AuthValidationError,
  PASSWORD_HASH_PREFIX,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_LENGTH,
  SCRYPT_MAX_MEMORY,
  SCRYPT_PARALLELIZATION,
  createSessionCredentials,
  hashPassword,
  normalizeUsername,
  parsePasswordHash,
  parseCookies,
  serializeCookie,
  validatePassword,
  verifyPassword,
  verifyToken,
};
