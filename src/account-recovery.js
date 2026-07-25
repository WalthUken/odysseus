"use strict";

const crypto = require("node:crypto");

const { DomainValidationError } = require("./domain-validation");
const { sha256 } = require("./crypto");

const RECOVERY_CODE_BYTES = 16;
const RECOVERY_CODE_COUNT_MIN = 4;
const RECOVERY_CODE_COUNT_MAX = 20;
const RECOVERY_PURPOSES = new Set(["account_recovery", "password_reset"]);

function generateRecoveryCode() {
  const compact = crypto.randomBytes(RECOVERY_CODE_BYTES)
    .toString("hex")
    .toUpperCase();
  return compact.match(/.{1,4}/g).join("-");
}

function normalizeRecoveryCode(code) {
  if (typeof code !== "string") {
    throw new DomainValidationError("Recovery code must be a string.");
  }
  const compact = code.trim().replaceAll("-", "").toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(compact)) {
    throw new DomainValidationError("Recovery code has an invalid format.");
  }
  return compact;
}

function hashRecoveryCode(code) {
  return sha256(`odysseus:recovery-code:v1:${normalizeRecoveryCode(code)}`);
}

function validateRecoveryCodeCount(count) {
  if (
    !Number.isSafeInteger(count)
    || count < RECOVERY_CODE_COUNT_MIN
    || count > RECOVERY_CODE_COUNT_MAX
  ) {
    throw new DomainValidationError(
      `Recovery code count must be between ${RECOVERY_CODE_COUNT_MIN} and ${RECOVERY_CODE_COUNT_MAX}.`,
    );
  }
  return count;
}

function normalizeRecoveryPurpose(purpose) {
  if (typeof purpose !== "string") {
    throw new DomainValidationError("Recovery purpose must be a string.");
  }
  const normalized = purpose.trim().toLowerCase();
  if (!RECOVERY_PURPOSES.has(normalized)) {
    throw new DomainValidationError("Recovery purpose is not supported.");
  }
  return normalized;
}

module.exports = {
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT_MAX,
  RECOVERY_CODE_COUNT_MIN,
  RECOVERY_PURPOSES,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeRecoveryPurpose,
  validateRecoveryCodeCount,
};
