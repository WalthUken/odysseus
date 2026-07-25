"use strict";

const crypto = require("node:crypto");

const {
  DomainValidationError,
  boundedJson,
  boundedString,
  requirePlainObject,
} = require("./domain-validation");

const DEVICE_DESCRIPTOR_KEYS = Object.freeze([
  "browserFamily",
  "deviceClass",
  "inputMode",
  "localeLanguage",
  "osFamily",
  "timezoneOffsetMinutes",
]);
const ENUMS = Object.freeze({
  browserFamily: new Set(["chrome", "edge", "firefox", "other", "safari"]),
  deviceClass: new Set(["desktop", "mobile", "tablet", "unknown"]),
  inputMode: new Set(["hybrid", "keyboard-pointer", "touch", "unknown"]),
  osFamily: new Set([
    "android",
    "chromeos",
    "ios",
    "linux",
    "macos",
    "other",
    "windows",
  ]),
});
const FINGERPRINT_VISITOR_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

function normalizeEnum(value, name, allowed) {
  if (typeof value !== "string") {
    throw new DomainValidationError(`${name} must be a string.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new DomainValidationError(`${name} is not an allowed coarse value.`);
  }
  return normalized;
}

function normalizeDeviceDescriptor(descriptor) {
  requirePlainObject(descriptor, "device descriptor");
  const unknown = Object.keys(descriptor).filter(
    (key) => !DEVICE_DESCRIPTOR_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new DomainValidationError(
      "Device descriptor contains unsupported fields.",
      { unsupportedFields: unknown.sort() },
    );
  }

  const timezoneOffsetMinutes = descriptor.timezoneOffsetMinutes;
  if (
    !Number.isFinite(timezoneOffsetMinutes)
    || timezoneOffsetMinutes < -720
    || timezoneOffsetMinutes > 840
  ) {
    throw new DomainValidationError(
      "timezoneOffsetMinutes must be between -720 and 840.",
    );
  }

  let localeLanguage = "und";
  if (descriptor.localeLanguage !== undefined) {
    localeLanguage = boundedString(
      descriptor.localeLanguage,
      "localeLanguage",
      {
        maximum: 8,
        pattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/,
      },
    ).toLowerCase().split("-")[0];
  }

  return Object.freeze({
    browserFamily: normalizeEnum(
      descriptor.browserFamily,
      "browserFamily",
      ENUMS.browserFamily,
    ),
    deviceClass: normalizeEnum(
      descriptor.deviceClass,
      "deviceClass",
      ENUMS.deviceClass,
    ),
    inputMode: normalizeEnum(
      descriptor.inputMode,
      "inputMode",
      ENUMS.inputMode,
    ),
    localeLanguage,
    osFamily: normalizeEnum(
      descriptor.osFamily,
      "osFamily",
      ENUMS.osFamily,
    ),
    timezoneOffsetMinutes: Math.round(timezoneOffsetMinutes / 60) * 60,
  });
}

function normalizeDeviceLabel(label) {
  return boundedString(label, "device label", { maximum: 80 });
}

function validateDigestInputs(userId, key) {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new DomainValidationError("userId must be a positive integer.");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new DomainValidationError("Fingerprint key must be a 32-byte Buffer.");
  }
}

function accountScopedFingerprintDigest(userId, descriptor, key) {
  validateDigestInputs(userId, key);
  const normalized = normalizeDeviceDescriptor(descriptor);
  const canonical = JSON.stringify(normalized);
  return crypto
    .createHmac("sha256", key)
    .update(`odysseus:device-fingerprint:v1:${userId}:`)
    .update(canonical)
    .digest();
}

function normalizeFingerprintVisitorId(visitorId, options = {}) {
  if (
    options.nullable === true
    && (visitorId === null || visitorId === undefined)
  ) {
    return null;
  }
  if (typeof visitorId !== "string") {
    throw new DomainValidationError(
      "Fingerprint visitor ID must be a string.",
    );
  }
  if (
    visitorId !== visitorId.trim()
    || !FINGERPRINT_VISITOR_ID_PATTERN.test(visitorId)
  ) {
    throw new DomainValidationError(
      "Fingerprint visitor ID must be exactly 32 hexadecimal characters.",
    );
  }
  return visitorId.toLowerCase();
}

function accountScopedClientFingerprintDigest(userId, visitorId, key) {
  validateDigestInputs(userId, key);
  const normalized = normalizeFingerprintVisitorId(visitorId);
  return crypto
    .createHmac("sha256", key)
    .update(`odysseus:client-fingerprint:v1:${userId}:`)
    .update(normalized, "ascii")
    .digest();
}

function timingSafeDigestEqual(left, right) {
  if (
    !Buffer.isBuffer(left)
    || !Buffer.isBuffer(right)
    || left.length !== right.length
  ) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function normalizeTransferMetadata(metadata) {
  return boundedJson(metadata, "transfer metadata", 4096);
}

module.exports = {
  DEVICE_DESCRIPTOR_KEYS,
  accountScopedClientFingerprintDigest,
  accountScopedFingerprintDigest,
  normalizeDeviceDescriptor,
  normalizeDeviceLabel,
  normalizeFingerprintVisitorId,
  normalizeTransferMetadata,
  timingSafeDigestEqual,
};
