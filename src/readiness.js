"use strict";

const CHECK_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function milliseconds(value) {
  const current = typeof value === "function" ? value() : Date.now();
  return current instanceof Date ? current.getTime() : Number(current);
}

function normalizedCheckResult(value) {
  if (value === true) {
    return { ready: true, reason: null };
  }
  if (value === false || value === null || value === undefined) {
    return { ready: false, reason: "unavailable" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ready: false, reason: "invalid_check_result" };
  }
  const reason =
    typeof value.reason === "string" && REASON_PATTERN.test(value.reason)
      ? value.reason
      : value.ready
        ? null
        : "unavailable";
  return {
    ready: value.ready === true,
    disabled: value.disabled === true,
    reason,
  };
}

async function runWithTimeout(check, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ ready: false, reason: "timeout" });
    }, timeoutMs);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  });

  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => check({ signal: controller.signal }))
        .then(normalizedCheckResult)
        .catch(() => ({ ready: false, reason: "unavailable" })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class ReadinessRegistry {
  constructor(options = {}) {
    this.clock = options.clock ?? Date.now;
    this.defaultTimeoutMs = Number(options.timeoutMs ?? 2_000);
    if (
      !Number.isSafeInteger(this.defaultTimeoutMs)
      || this.defaultTimeoutMs < 10
      || this.defaultTimeoutMs > 30_000
    ) {
      throw new TypeError(
        "Readiness timeoutMs must be between 10 and 30000."
      );
    }
    this.checks = new Map();
  }

  register(name, check, options = {}) {
    if (!CHECK_NAME_PATTERN.test(name)) {
      throw new TypeError("Readiness check name is invalid.");
    }
    if (this.checks.has(name)) {
      throw new TypeError(`Readiness check "${name}" already exists.`);
    }
    if (typeof check !== "function") {
      throw new TypeError("Readiness check must be a function.");
    }
    const timeoutMs = Number(options.timeoutMs ?? this.defaultTimeoutMs);
    if (
      !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 10
      || timeoutMs > 30_000
    ) {
      throw new TypeError(
        "Readiness check timeoutMs must be between 10 and 30000."
      );
    }
    this.checks.set(name, {
      check,
      required: options.required !== false,
      timeoutMs,
    });
    return this;
  }

  async check() {
    const startedAt = milliseconds(this.clock);
    const results = await Promise.all(
      [...this.checks].map(async ([name, configuration]) => {
        const started = milliseconds(this.clock);
        const result = await runWithTimeout(
          configuration.check,
          configuration.timeoutMs
        );
        return {
          name,
          required: configuration.required,
          ready: result.ready,
          disabled: result.disabled === true,
          reason: result.reason,
          durationMs: Math.max(
            0,
            Math.round(milliseconds(this.clock) - started)
          ),
        };
      })
    );
    const ready = results.every(
      (result) => !result.required || result.ready
    );
    return {
      ready,
      status: ready ? "ready" : "not_ready",
      durationMs: Math.max(
        0,
        Math.round(milliseconds(this.clock) - startedAt)
      ),
      checks: results,
    };
  }
}

function createReadinessRegistry(options) {
  return new ReadinessRegistry(options);
}

module.exports = {
  ReadinessRegistry,
  createReadinessRegistry,
  normalizedCheckResult,
  runWithTimeout,
};
