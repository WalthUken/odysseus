"use strict";

class DomainValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "DomainValidationError";
    this.code = "DOMAIN_VALIDATION_ERROR";
    this.details = details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new DomainValidationError(`${name} must be a plain object.`);
  }
  return value;
}

function boundedString(value, name, options = {}) {
  if (
    options.nullable
    && (value === null || value === undefined || value === "")
  ) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainValidationError(`${name} must be a string.`);
  }

  const normalized = options.preserveWhitespace ? value : value.trim();
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? 128;
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new DomainValidationError(
      `${name} must contain between ${minimum} and ${maximum} characters.`,
    );
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new DomainValidationError(`${name} contains unsupported control characters.`);
  }
  if (options.pattern && !options.pattern.test(normalized)) {
    throw new DomainValidationError(`${name} has an invalid format.`);
  }
  return normalized;
}

function boundedJson(value, name, maximumBytes = 4096) {
  if (value === null || value === undefined) {
    return { value: null, json: null };
  }
  if (!isPlainObject(value)) {
    throw new DomainValidationError(`${name} must be a plain object.`);
  }

  const inspect = (candidate, depth = 0) => {
    if (depth > 12) {
      throw new DomainValidationError(`${name} is nested too deeply.`);
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        inspect(item, depth + 1);
      }
      return;
    }
    if (!isPlainObject(candidate)) {
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (/(?:password|raw.?challenge|recovery.?code|secret|token)/i.test(key)) {
        throw new DomainValidationError(
          `${name} must not contain secret-bearing field "${key}".`,
        );
      }
      inspect(nested, depth + 1);
    }
  };
  inspect(value);

  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new DomainValidationError(`${name} must be JSON serializable.`, {
      cause: error.message,
    });
  }
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new DomainValidationError(
      `${name} must not exceed ${maximumBytes} bytes.`,
    );
  }
  return { value: JSON.parse(json), json };
}

function strictBoolean(value, name, defaultValue) {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new DomainValidationError(`${name} must be a boolean.`);
  }
  return value;
}

function safeInteger(value, name, options = {}) {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new DomainValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

module.exports = {
  DomainValidationError,
  boundedJson,
  boundedString,
  isPlainObject,
  requirePlainObject,
  safeInteger,
  strictBoolean,
};
