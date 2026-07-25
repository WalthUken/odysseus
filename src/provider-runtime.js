"use strict";

const {
  createGeminiExplanationAdapter,
} = require("./gemini-explanation");
const {
  createHuggingFaceAnomalyAdapter,
} = require("./hugging-face-anomaly");
const { createOdysseusMonitoring } = require("./monitoring");
const { createNotificationService } = require("./notifications");
const { createRateLimitStore } = require("./rate-limit");
const { createReadinessRegistry } = require("./readiness");
const { createTurnstileAdapter } = require("./turnstile");

function createProviderRuntime(options = {}) {
  const monitoring =
    options.monitoring ?? createOdysseusMonitoring(options.metrics);
  const rateLimitStore = createRateLimitStore(options.rateLimit);
  const turnstile = createTurnstileAdapter({
    ...(options.turnstile || {}),
    monitoring,
  });
  const gemini = createGeminiExplanationAdapter({
    ...(options.gemini || {}),
    monitoring,
  });
  const huggingFace = createHuggingFaceAnomalyAdapter({
    ...(options.huggingFace || {}),
    monitoring,
  });
  const notifications = createNotificationService({
    ...(options.notifications || {}),
    monitoring,
  });
  const readiness = createReadinessRegistry(options.readiness);
  const required = new Set(options.requiredProviders || []);
  const supportedProviders = new Set([
    "turnstile",
    "gemini",
    "hugging_face",
  ]);
  if (
    !Array.isArray(options.requiredProviders || [])
    || [...required].some((name) => !supportedProviders.has(name))
  ) {
    throw new TypeError(
      "requiredProviders contains an unsupported provider."
    );
  }

  readiness.register(
    "rate_limit",
    () => rateLimitStore.readiness(),
    { required: true }
  );
  readiness.register("turnstile", () => turnstile.readiness(), {
    required: required.has("turnstile"),
  });
  readiness.register("gemini", () => gemini.readiness(), {
    required: required.has("gemini"),
  });
  readiness.register(
    "hugging_face",
    () => huggingFace.readiness(),
    { required: required.has("hugging_face") }
  );
  readiness.register(
    "notifications",
    () => notifications.readiness(),
    { required: true }
  );

  return Object.freeze({
    gemini,
    huggingFace,
    monitoring,
    notifications,
    rateLimitStore,
    readiness,
    turnstile,
  });
}

module.exports = {
  createProviderRuntime,
};
