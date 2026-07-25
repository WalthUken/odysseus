"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const {
  ProviderInputError,
  fetchJson,
  providerFailure,
  recordProviderObservation,
} = require("./provider-utils");

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function normalizeAllowlist(values, name, pattern) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  if (list.length < 1 || list.length > 32) {
    throw new TypeError(`${name} requires 1 to 32 configured values.`);
  }
  return new Set(
    list.map((value) => {
      const normalized = String(value).toLowerCase();
      if (!pattern.test(normalized)) {
        throw new TypeError(`${name} contains an invalid value.`);
      }
      return normalized;
    })
  );
}

class TurnstileAdapter {
  constructor(options = {}) {
    this.secretKey =
      options.secretKey || null;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = Number(options.timeoutMs ?? 4_000);
    this.monitoring = options.monitoring;
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    this.state = this.secretKey ? "unchecked" : "disabled";

    if (this.secretKey) {
      if (
        typeof this.secretKey !== "string"
        || this.secretKey.length < 8
        || this.secretKey.length > 512
      ) {
        throw new TypeError("Turnstile secretKey is invalid.");
      }
      this.expectedHostnames = normalizeAllowlist(
        options.expectedHostnames ?? options.expectedHostname,
        "Turnstile expectedHostnames",
        HOSTNAME_PATTERN
      );
      this.expectedActions = normalizeAllowlist(
        options.expectedActions ?? options.expectedAction,
        "Turnstile expectedActions",
        ACTION_PATTERN
      );
    } else {
      this.expectedHostnames = new Set();
      this.expectedActions = new Set();
    }
  }

  readiness() {
    if (!this.secretKey) {
      return {
        ready: false,
        disabled: true,
        provider: "turnstile",
        reason: "disabled",
      };
    }
    return {
      ready: this.state === "available",
      provider: "turnstile",
      reason: this.state === "available" ? null : this.state,
    };
  }

  validateInput(input) {
    if (
      !input
      || typeof input !== "object"
      || Array.isArray(input)
    ) {
      throw new ProviderInputError(
        "Turnstile verification input must be an object."
      );
    }
    const token = input.token;
    if (
      typeof token !== "string"
      || token.length < 1
      || token.length > 2_048
    ) {
      throw new ProviderInputError(
        "Turnstile token must contain 1 to 2048 characters."
      );
    }
    if (
      input.remoteIp !== undefined
      && net.isIP(input.remoteIp) === 0
    ) {
      throw new ProviderInputError(
        "Turnstile remoteIp must be a valid IP address."
      );
    }
    return {
      token,
      remoteIp: input.remoteIp,
    };
  }

  async verify(input, options = {}) {
    const validated = this.validateInput(input);
    if (!this.secretKey) {
      recordProviderObservation(
        this.monitoring,
        "turnstile",
        "disabled"
      );
      return {
        valid: false,
        available: false,
        disabled: true,
        provider: "turnstile",
        code: "TURNSTILE_DISABLED",
        retryable: false,
        authorizationDecision: null,
      };
    }

    const payload = new URLSearchParams({
      secret: this.secretKey,
      response: validated.token,
      idempotency_key: this.randomUUID(),
    });
    if (validated.remoteIp) {
      payload.set("remoteip", validated.remoteIp);
    }

    const started = Date.now();
    try {
      const response = await fetchJson({
        fetchImpl: this.fetchImpl,
        url: SITEVERIFY_URL,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload.toString(),
        timeoutMs: this.timeoutMs,
        maximumBytes: 64 * 1_024,
        signal: options.signal,
      });
      this.state = "available";
      const errorCodes = Array.isArray(response["error-codes"])
        ? response["error-codes"]
            .filter((value) => typeof value === "string")
            .slice(0, 10)
        : [];
      if (response.success !== true) {
        const replayed = errorCodes.includes("timeout-or-duplicate");
        recordProviderObservation(
          this.monitoring,
          "turnstile",
          "failure",
          Date.now() - started
        );
        return {
          valid: false,
          available: true,
          provider: "turnstile",
          code: replayed
            ? "TURNSTILE_TOKEN_EXPIRED_OR_REPLAYED"
            : "TURNSTILE_REJECTED",
          errorCodes,
          requiresFreshToken: replayed,
          retryable: errorCodes.includes("internal-error"),
          authorizationDecision: null,
        };
      }

      const hostname =
        typeof response.hostname === "string"
          ? response.hostname.toLowerCase()
          : "";
      const action =
        typeof response.action === "string"
          ? response.action.toLowerCase()
          : "";
      if (!this.expectedHostnames.has(hostname)) {
        recordProviderObservation(
          this.monitoring,
          "turnstile",
          "invalid",
          Date.now() - started
        );
        return {
          valid: false,
          available: true,
          provider: "turnstile",
          code: "TURNSTILE_HOSTNAME_MISMATCH",
          retryable: false,
          authorizationDecision: null,
        };
      }
      if (!this.expectedActions.has(action)) {
        recordProviderObservation(
          this.monitoring,
          "turnstile",
          "invalid",
          Date.now() - started
        );
        return {
          valid: false,
          available: true,
          provider: "turnstile",
          code: "TURNSTILE_ACTION_MISMATCH",
          retryable: false,
          authorizationDecision: null,
        };
      }

      recordProviderObservation(
        this.monitoring,
        "turnstile",
        "success",
        Date.now() - started
      );
      return {
        valid: true,
        available: true,
        provider: "turnstile",
        hostname,
        action,
        challengeTimestamp:
          typeof response.challenge_ts === "string"
            ? response.challenge_ts
            : null,
        authorizationDecision: null,
      };
    } catch (error) {
      this.state =
        error.code === "PROVIDER_TIMEOUT" ? "timeout" : "unavailable";
      recordProviderObservation(
        this.monitoring,
        "turnstile",
        this.state,
        Date.now() - started
      );
      return {
        valid: false,
        ...providerFailure("turnstile", error),
      };
    }
  }
}

function createTurnstileAdapter(options) {
  return new TurnstileAdapter(options);
}

module.exports = {
  ACTION_PATTERN,
  HOSTNAME_PATTERN,
  SITEVERIFY_URL,
  TurnstileAdapter,
  createTurnstileAdapter,
};
