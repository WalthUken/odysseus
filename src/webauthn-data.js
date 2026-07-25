"use strict";

const {
  DomainValidationError,
  boundedString,
  safeInteger,
  strictBoolean,
} = require("./domain-validation");

const ALLOWED_TRANSPORTS = new Set([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const ALLOWED_CEREMONIES = new Set(["authentication", "registration"]);

function binaryValue(value, name, maximumBytes) {
  let result;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    result = Buffer.from(value);
  } else if (
    typeof value === "string"
    && /^[A-Za-z0-9_-]+$/.test(value)
  ) {
    result = Buffer.from(value, "base64url");
  } else {
    throw new DomainValidationError(
      `${name} must be a Buffer, Uint8Array, or base64url string.`,
    );
  }

  if (result.length < 1 || result.length > maximumBytes) {
    throw new DomainValidationError(
      `${name} must contain between 1 and ${maximumBytes} bytes.`,
    );
  }
  return result;
}

function normalizeCredentialId(value) {
  return binaryValue(value, "credentialId", 1024);
}

function normalizePublicKey(value) {
  return binaryValue(value, "publicKey", 4096);
}

function normalizeAaguid(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const result = Buffer.from(value);
    if (result.length !== 16) {
      throw new DomainValidationError("AAGUID must contain exactly 16 bytes.");
    }
    return result;
  }
  if (
    typeof value === "string"
    && /^[A-Fa-f0-9]{8}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{12}$/.test(value)
  ) {
    return Buffer.from(value.replaceAll("-", ""), "hex");
  }
  throw new DomainValidationError(
    "AAGUID must be a 16-byte value or UUID string.",
  );
}

function normalizeTransports(transports = []) {
  if (!Array.isArray(transports) || transports.length > 8) {
    throw new DomainValidationError("transports must be an array of at most 8 values.");
  }
  const normalized = transports.map((transport) => {
    if (typeof transport !== "string") {
      throw new DomainValidationError("Each WebAuthn transport must be a string.");
    }
    const value = transport.trim().toLowerCase();
    if (!ALLOWED_TRANSPORTS.has(value)) {
      throw new DomainValidationError(`Unsupported WebAuthn transport "${value}".`);
    }
    return value;
  });
  return [...new Set(normalized)].sort();
}

function normalizeCredential(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError("WebAuthn credential must be an object.");
  }
  const backupEligible = strictBoolean(
    input.backupEligible,
    "backupEligible",
    false,
  );
  const backupState = strictBoolean(input.backupState, "backupState", false);
  if (backupState && !backupEligible) {
    throw new DomainValidationError(
      "backupState cannot be true when backupEligible is false.",
    );
  }

  return {
    credentialId: normalizeCredentialId(input.credentialId),
    publicKey: normalizePublicKey(input.publicKey),
    counter: safeInteger(input.counter ?? 0, "counter"),
    aaguid: normalizeAaguid(input.aaguid),
    transports: normalizeTransports(input.transports),
    userVerified: strictBoolean(input.userVerified, "userVerified", false),
    backupEligible,
    backupState,
    name: boundedString(input.name ?? "Passkey", "credential name", {
      maximum: 80,
    }),
  };
}

function normalizeCeremony(value) {
  if (typeof value !== "string") {
    throw new DomainValidationError("ceremony must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_CEREMONIES.has(normalized)) {
    throw new DomainValidationError(
      "ceremony must be authentication or registration.",
    );
  }
  return normalized;
}

function normalizeRpId(value) {
  const rpId = boundedString(value, "rpId", { maximum: 253 }).toLowerCase();
  if (
    rpId !== "localhost"
    && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      rpId,
    )
  ) {
    throw new DomainValidationError("rpId must be a valid hostname.");
  }
  return rpId;
}

function normalizeOrigin(value) {
  const input = boundedString(value, "origin", { maximum: 512 });
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new DomainValidationError("origin must be a valid URL origin.");
  }
  if (
    parsed.origin !== input.replace(/\/$/, "")
    || (
      parsed.protocol !== "https:"
      && !(parsed.protocol === "http:" && parsed.hostname === "localhost")
    )
  ) {
    throw new DomainValidationError(
      "origin must be an HTTPS origin or local development origin.",
    );
  }
  return parsed.origin;
}

module.exports = {
  ALLOWED_CEREMONIES,
  ALLOWED_TRANSPORTS,
  normalizeAaguid,
  normalizeCeremony,
  normalizeCredential,
  normalizeCredentialId,
  normalizeOrigin,
  normalizePublicKey,
  normalizeRpId,
  normalizeTransports,
};
