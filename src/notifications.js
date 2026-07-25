"use strict";

const crypto = require("node:crypto");

const {
  ProviderInputError,
  boundedString,
  recordProviderObservation,
  requireExactKeys,
  requirePlainObject,
} = require("./provider-utils");

const NOTIFICATION_TYPES = Object.freeze([
  "behavior_drift",
  "new_device",
  "profile_changed",
  "recovery_event",
  "secure_action_denied",
  "session_event",
  "step_up_required",
  "system",
]);
const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
const FORBIDDEN_METADATA_KEY =
  /password|secret|token|cookie|credential|authorization|api.?key|private.?key|master.?key|raw|vector|keystroke/i;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function safeMetadata(value) {
  if (value === undefined) {
    return {};
  }
  requirePlainObject(value, "Notification metadata");
  const entries = Object.entries(value);
  if (entries.length > 20) {
    throw new ProviderInputError(
      "Notification metadata must contain at most 20 fields."
    );
  }
  const result = Object.create(null);
  for (const [key, item] of entries) {
    if (
      !METADATA_KEY_PATTERN.test(key)
      || FORBIDDEN_METADATA_KEY.test(key)
    ) {
      throw new ProviderInputError(
        "Notification metadata contains a forbidden field."
      );
    }
    if (typeof item === "string") {
      result[key] = boundedString(item, `metadata.${key}`, {
        minimum: 0,
        maximum: 256,
      });
    } else if (
      typeof item === "boolean"
      || (
        typeof item === "number"
        && Number.isFinite(item)
        && Math.abs(item) <= 1_000_000_000
      )
      || item === null
    ) {
      result[key] = item;
    } else {
      throw new ProviderInputError(
        "Notification metadata values must be bounded scalars."
      );
    }
  }
  return result;
}

function validateNotification(value) {
  requireExactKeys(
    value,
    ["type", "severity", "title", "body", "metadata"],
    "Notification",
    ["type", "severity", "title", "body"]
  );
  if (!NOTIFICATION_TYPES.includes(value.type)) {
    throw new ProviderInputError("Notification type is not recognized.");
  }
  if (!SEVERITIES.includes(value.severity)) {
    throw new ProviderInputError("Notification severity is not recognized.");
  }
  return {
    type: value.type,
    severity: value.severity,
    title: boundedString(value.title, "Notification title", {
      maximum: 120,
    }),
    body: boundedString(value.body, "Notification body", {
      maximum: 1_000,
    }),
    metadata: safeMetadata(value.metadata),
  };
}

function validateRecipient(value) {
  requireExactKeys(
    value,
    ["userId", "email"],
    "Notification recipient",
    ["userId"]
  );
  const userId = value.userId;
  if (
    !(
      Number.isSafeInteger(userId)
      && userId > 0
    )
    && !(
      typeof userId === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)
    )
  ) {
    throw new ProviderInputError("Notification recipient userId is invalid.");
  }
  let email;
  if (value.email !== undefined) {
    email = boundedString(value.email, "Notification recipient email", {
      maximum: 254,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    });
  }
  return { userId, email };
}

class InMemoryNotificationChannel {
  constructor(options = {}) {
    this.maximumEntries = Number(options.maximumEntries ?? 1_000);
    this.clock = options.clock ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    if (
      !Number.isSafeInteger(this.maximumEntries)
      || this.maximumEntries < 1
      || this.maximumEntries > 100_000
    ) {
      throw new TypeError(
        "In-app maximumEntries must be between 1 and 100000."
      );
    }
    this.entries = [];
  }

  async send({ recipient, notification }) {
    const record = {
      id: this.randomUUID(),
      userId: recipient.userId,
      ...notification,
      createdAt: new Date(this.clock()).toISOString(),
    };
    this.entries.push(record);
    if (this.entries.length > this.maximumEntries) {
      this.entries.splice(0, this.entries.length - this.maximumEntries);
    }
    return { id: record.id };
  }

  list(userId) {
    return this.entries
      .filter((entry) => entry.userId === userId)
      .map((entry) => ({ ...entry }));
  }

  readiness() {
    return { ready: true, provider: "in_app" };
  }
}

class DatabaseInAppNotificationChannel {
  constructor(database) {
    if (
      !database
      || typeof database.createSecurityNotification !== "function"
    ) {
      throw new TypeError(
        "Database in-app channel requires createSecurityNotification."
      );
    }
    this.database = database;
  }

  async send({ recipient, notification }) {
    if (!Number.isSafeInteger(recipient.userId) || recipient.userId < 1) {
      throw new ProviderInputError(
        "Database notifications require a numeric userId."
      );
    }
    const result = await this.database.createSecurityNotification(
      recipient.userId,
      notification
    );
    return { id: result.id };
  }

  async readiness() {
    return { ready: true, provider: "in_app" };
  }
}

function normalizeInjectedChannel(channel, name) {
  if (!channel) {
    return null;
  }
  if (typeof channel === "function") {
    return {
      send: channel,
      readiness: () => ({ ready: true, provider: name }),
    };
  }
  if (typeof channel.send !== "function") {
    throw new TypeError(`${name} notification channel must expose send.`);
  }
  return channel;
}

async function deliverWithTimeout(channel, payload, timeoutMs, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ delivered: false, reason: "timeout" }),
      timeoutMs
    );
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() =>
          channel.send(payload, { signal: controller.signal })
        )
        .then((result) => ({
          delivered: true,
          id: result && result.id ? String(result.id) : null,
        }))
        .catch(() => ({
          delivered: false,
          reason: "unavailable",
        })),
      timeout,
    ]);
    if (!outcome.delivered) {
      controller.abort();
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", abort);
    }
  }
}

class NotificationService {
  constructor(options = {}) {
    this.monitoring = options.monitoring;
    this.timeoutMs = Number(options.timeoutMs ?? 5_000);
    if (
      !Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < 10
      || this.timeoutMs > 30_000
    ) {
      throw new TypeError(
        "Notification timeoutMs must be between 10 and 30000."
      );
    }
    this.channels = {
      in_app:
        normalizeInjectedChannel(options.inApp, "in_app")
        || new InMemoryNotificationChannel(options.inMemory),
      webhook: normalizeInjectedChannel(options.webhook, "webhook"),
      email: normalizeInjectedChannel(options.email, "email"),
    };
  }

  async deliver(input, options = {}) {
    requireExactKeys(
      input,
      ["recipient", "notification", "channels"],
      "Notification delivery",
      ["recipient", "notification"]
    );
    const recipient = validateRecipient(input.recipient);
    const notification = validateNotification(input.notification);
    const requested = input.channels === undefined
      ? Object.keys(this.channels).filter((name) => this.channels[name])
      : input.channels;
    if (
      !Array.isArray(requested)
      || requested.length < 1
      || requested.some(
        (name) => !["in_app", "webhook", "email"].includes(name)
      )
      || new Set(requested).size !== requested.length
    ) {
      throw new ProviderInputError(
        "Notification channels must be unique supported channel names."
      );
    }

    const results = await Promise.all(
      requested.map(async (name) => {
        const channel = this.channels[name];
        if (!channel || (name === "email" && !recipient.email)) {
          recordProviderObservation(
            this.monitoring,
            name,
            "disabled"
          );
          return {
            channel: name,
            delivered: false,
            disabled: true,
            reason:
              name === "email" && !recipient.email
                ? "recipient_missing"
                : "channel_disabled",
          };
        }
        const outcome = await deliverWithTimeout(
          channel,
          { recipient, notification },
          this.timeoutMs,
          options.signal
        );
        recordProviderObservation(
          this.monitoring,
          name,
          outcome.delivered
            ? "success"
            : outcome.reason === "timeout"
              ? "timeout"
              : "failure"
        );
        return { channel: name, ...outcome };
      })
    );

    return {
      delivered: results.some((result) => result.delivered),
      fullyDelivered: results.every((result) => result.delivered),
      results,
    };
  }

  async readiness() {
    const checks = await Promise.all(
      Object.entries(this.channels).map(async ([name, channel]) => {
        if (!channel) {
          return {
            name,
            ready: false,
            disabled: true,
            reason: "disabled",
          };
        }
        if (typeof channel.readiness !== "function") {
          return { name, ready: true, reason: null };
        }
        try {
          const result = await channel.readiness();
          return {
            name,
            ready: result && result.ready === true,
            reason:
              result && typeof result.reason === "string"
                ? result.reason
                : null,
          };
        } catch (_error) {
          return { name, ready: false, reason: "unavailable" };
        }
      })
    );
    return {
      ready: checks.find((check) => check.name === "in_app").ready,
      provider: "notifications",
      channels: checks,
    };
  }
}

function createDatabaseInAppNotificationChannel(database) {
  return new DatabaseInAppNotificationChannel(database);
}

function createNotificationService(options) {
  return new NotificationService(options);
}

module.exports = {
  DatabaseInAppNotificationChannel,
  InMemoryNotificationChannel,
  NOTIFICATION_TYPES,
  NotificationService,
  SEVERITIES,
  createDatabaseInAppNotificationChannel,
  createNotificationService,
  deliverWithTimeout,
  safeMetadata,
  validateNotification,
  validateRecipient,
};
