"use strict";

class ProviderInputError extends TypeError {
  constructor(message, code = "INVALID_PROVIDER_INPUT") {
    super(message);
    this.name = "ProviderInputError";
    this.code = code;
  }
}

class ProviderRequestError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable === true;
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
    throw new ProviderInputError(`${name} must be a plain object.`);
  }
  return value;
}

function requireExactKeys(value, allowed, name, required = allowed) {
  requirePlainObject(value, name);
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key)
  );
  if (unexpected.length || missing.length) {
    throw new ProviderInputError(
      `${name} does not match the required schema.`
    );
  }
}

function boundedString(value, name, options = {}) {
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? 256;
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
  ) {
    throw new ProviderInputError(
      `${name} must contain between ${minimum} and ${maximum} safe characters.`
    );
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new ProviderInputError(`${name} has an invalid format.`);
  }
  return value;
}

function boundedNumber(value, name, options = {}) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < (options.minimum ?? -Number.MAX_VALUE)
    || value > (options.maximum ?? Number.MAX_VALUE)
  ) {
    throw new ProviderInputError(`${name} is outside its allowed range.`);
  }
  return value;
}

async function readResponseText(response, maximumBytes) {
  const contentLength =
    response.headers
    && typeof response.headers.get === "function"
      ? Number(response.headers.get("content-length"))
      : NaN;
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ProviderRequestError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider response exceeded the configured size limit."
    );
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ProviderRequestError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Provider response exceeded the configured size limit."
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new ProviderRequestError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider response exceeded the configured size limit."
    );
  }
  return text;
}

async function fetchJson(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderRequestError(
      "PROVIDER_UNAVAILABLE",
      "No HTTP transport is available.",
      { retryable: true }
    );
  }

  const timeoutMs = Number(options.timeoutMs ?? 5_000);
  const maximumBytes = Number(options.maximumBytes ?? 256 * 1_024);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000
  ) {
    throw new TypeError("Provider timeoutMs must be between 1 and 30000.");
  }
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1_024
    || maximumBytes > 2 * 1_024 * 1_024
  ) {
    throw new TypeError(
      "Provider maximumBytes must be between 1024 and 2097152."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort("caller");
  if (callerSignal) {
    if (callerSignal.aborted) {
      abortFromCaller();
    } else {
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  try {
    const response = await fetchImpl(options.url, {
      method: options.method ?? "POST",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    if (
      !response
      || typeof response.ok !== "boolean"
      || typeof response.status !== "number"
    ) {
      throw new ProviderRequestError(
        "PROVIDER_INVALID_RESPONSE",
        "Provider returned an invalid HTTP response."
      );
    }
    if (!response.ok) {
      throw new ProviderRequestError(
        "PROVIDER_HTTP_ERROR",
        "Provider rejected the request.",
        {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        }
      );
    }

    const text = await readResponseText(response, maximumBytes);
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new ProviderRequestError(
        "PROVIDER_INVALID_JSON",
        "Provider returned malformed JSON."
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderRequestError(
        controller.signal.reason === "caller"
          ? "PROVIDER_ABORTED"
          : "PROVIDER_TIMEOUT",
        "Provider request did not complete.",
        { retryable: true }
      );
    }
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    throw new ProviderRequestError(
      "PROVIDER_UNAVAILABLE",
      "Provider request failed.",
      { retryable: true }
    );
  } finally {
    clearTimeout(timeout);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function recordProviderObservation(
  monitoring,
  provider,
  outcome,
  durationMs
) {
  if (!monitoring) {
    return;
  }
  try {
    if (monitoring.providerRequests) {
      monitoring.providerRequests.inc({ provider, outcome });
    }
    if (
      monitoring.providerDuration
      && Number.isFinite(durationMs)
    ) {
      monitoring.providerDuration.observe(
        { provider },
        durationMs / 1_000
      );
    }
  } catch (_error) {
    // Monitoring must never change provider behavior.
  }
}

function providerFailure(provider, error) {
  const timeout = error && error.code === "PROVIDER_TIMEOUT";
  const invalidResponse = new Set([
    "INVALID_PROVIDER_RESPONSE",
    "PROVIDER_INVALID_JSON",
    "PROVIDER_INVALID_RESPONSE",
    "PROVIDER_RESPONSE_TOO_LARGE",
  ]).has(error && error.code);
  const prefix = provider.toUpperCase();
  return {
    available: invalidResponse,
    provider,
    code: invalidResponse
      ? `${prefix}_INVALID_RESPONSE`
      : timeout
        ? `${prefix}_TIMEOUT`
        : `${prefix}_UNAVAILABLE`,
    retryable:
      invalidResponse ? false : Boolean(error && error.retryable),
    authorizationDecision: null,
  };
}

module.exports = {
  ProviderInputError,
  ProviderRequestError,
  boundedNumber,
  boundedString,
  fetchJson,
  isPlainObject,
  providerFailure,
  readResponseText,
  recordProviderObservation,
  requireExactKeys,
  requirePlainObject,
};
