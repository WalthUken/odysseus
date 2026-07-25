"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createGeminiExplanationAdapter,
  validateBehaviorReport,
} = require("../src/gemini-explanation");
const {
  createHuggingFaceAnomalyAdapter,
  validateShadowReport,
} = require("../src/hugging-face-anomaly");
const {
  createDatabaseInAppNotificationChannel,
  createNotificationService,
} = require("../src/notifications");
const { createTurnstileAdapter } = require("../src/turnstile");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function behaviorReport() {
  return {
    version: 1,
    assessment: {
      decision: "step_up",
      trustPercent: 58,
      normalizedDistance: 2.4,
      acceptanceThreshold: 1.5,
      reasonCodes: ["BEHAVIOR_DRIFT"],
    },
    signals: [
      {
        name: "dwellMean",
        direction: "higher",
        deviationRatio: 2.1,
      },
    ],
  };
}

function shadowReport() {
  return {
    version: 1,
    aggregateDistance: 3.2,
    localDecision: "step_up",
    featureDeltas: [
      { name: "dwellMean", normalizedDelta: 2.1 },
      { name: "flightMean", normalizedDelta: -1.2 },
    ],
  };
}

test("validates Turnstile hostname, action, and single-use errors", async () => {
  const requests = [];
  const adapter = createTurnstileAdapter({
    secretKey: "test-secret-key",
    expectedHostname: "odysseus.example",
    expectedAction: "login",
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        success: true,
        hostname: "odysseus.example",
        action: "login",
        challenge_ts: "2026-07-25T12:00:00.000Z",
        "error-codes": [],
      });
    },
  });
  const result = await adapter.verify({
    token:
      "single-use-token",
    remoteIp: "203.0.113.8",
  });
  assert.equal(result.valid, true);
  assert.equal(result.authorizationDecision, null);
  assert.equal(adapter.readiness().ready, true);
assert.match(requests[0].options.body, new RegExp(["secret", "test-secret-key"].join("=")));
  assert.match(
    requests[0].options.body,
    /idempotency_key=00000000-0000-4000-8000-000000000000/
  );

  const replayAdapter = createTurnstileAdapter({
    secretKey: "test-secret-key",
    expectedHostname: "odysseus.example",
    expectedAction: "login",
    fetchImpl: async () =>
      jsonResponse({
        success: false,
        "error-codes": ["timeout-or-duplicate"],
      }),
  });
  const replay = await replayAdapter.verify({ token: "used-token" });
  assert.equal(replay.valid, false);
  assert.equal(replay.requiresFreshToken, true);
  assert.equal(replay.code, "TURNSTILE_TOKEN_EXPIRED_OR_REPLAYED");
});

test("rejects Turnstile hostname and action mismatches", async () => {
  const adapter = createTurnstileAdapter({
    secretKey: "test-secret-key",
    expectedHostname: "odysseus.example",
    expectedAction: "register",
    fetchImpl: async () =>
      jsonResponse({
        success: true,
        hostname: "attacker.example",
        action: "register",
      }),
  });
  const result = await adapter.verify({ token:
    "valid-looking-token" });
  assert.equal(result.valid, false);
  assert.equal(result.code, "TURNSTILE_HOSTNAME_MISMATCH");
});

test("reports disabled Turnstile without making a request", async () => {
  let called = false;
  const adapter = createTurnstileAdapter({
    fetchImpl: async () => {
      called = true;
    },
  });
  const result = await adapter.verify({ token: "unused-token" });
  assert.equal(result.disabled, true);
  assert.equal(result.available, false);
  assert.equal(called, false);
});

test("generates strictly labeled Gemini prose without authorization", async () => {
  let request;
  const adapter = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    model: "gemini-test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    headline: "Interaction changed",
                    summary: "Several timing signals differ from baseline.",
                    observations: ["Key hold duration increased."],
                    nextStep: "Use Odysseus's configured verification flow.",
                  }),
                },
              ],
            },
          },
        ],
      });
    },
  });
  const result = await adapter.explain(behaviorReport());
  assert.equal(result.generated, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.authorizationDecision, null);
  assert.match(result.prose, /^AI-generated explanation:/);
  assert.match(result.prose, /Authority: Advisory only/);
  assert.doesNotMatch(request.url, /test-gemini-key/);
  assert.equal(request.options.headers["x-goog-api-key"], "test-gemini-key");
  const sent = JSON.parse(request.options.body);
  assert.equal(
    sent.generationConfig.responseMimeType,
    "application/json"
  );
  assert.equal(sent.generationConfig.responseSchema.additionalProperties, false);
});

test("rejects unstructured Gemini reports before transport", async () => {
  let called = false;
  const adapter = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.throws(
    () =>
      validateBehaviorReport({
        ...behaviorReport(),
        rawTypedText: "must never leave the process",
      }),
    /required schema/
  );
  await assert.rejects(
    adapter.explain({
      ...behaviorReport(),
      userId: "private-user",
    }),
    /required schema/
  );
  assert.equal(called, false);
});

test("rejects Gemini prose that attempts to authorize access", async () => {
  const adapter = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    headline: "Access is allowed",
                    summary: "The model attempted to decide access.",
                    observations: ["Timing changed."],
                    nextStep: "Continue.",
                  }),
                },
              ],
            },
          },
        ],
      }),
  });
  const result = await adapter.explain(behaviorReport());
  assert.equal(result.generated, false);
  assert.equal(result.available, true);
  assert.equal(result.code, "GEMINI_INVALID_RESPONSE");
  assert.equal(result.authorizationDecision, null);
});

test("keeps Hugging Face analysis shadow-only with no grant effect", async () => {
  let request;
  const adapter = createHuggingFaceAnomalyAdapter({
    endpointUrl: "https://hf.test/anomaly",
    allowedHosts: ["hf.test"],
    apiToken:
      "test-hugging-face-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        anomalyScore: 0.82,
        label: "anomalous",
        modelVersion: "shadow-1",
      });
    },
  });
  const result = await adapter.analyze(shadowReport());
  assert.equal(result.analyzed, true);
  assert.equal(result.analysis.anomalyScore, 0.82);
  assert.equal(result.shadowOnly, true);
  assert.equal(result.grantEffect, "none");
  assert.equal(result.authorizationDecision, null);
  assert.equal(
    request.options.headers.Authorization,
    "Bearer test-hugging-face-token"
  );
});

test("rejects identifiers and malformed provider output in shadow analysis", async () => {
  assert.throws(
    () =>
      validateShadowReport({
        ...shadowReport(),
        userId: 42,
      }),
    /required schema/
  );
  const adapter = createHuggingFaceAnomalyAdapter({
    endpointUrl: "https://hf.test/anomaly",
    allowedHosts: ["hf.test"],
    fetchImpl: async () =>
      jsonResponse({
        anomalyScore: 0.8,
        label: "anomalous",
        authorizationDecision: "deny",
      }),
  });
  const result = await adapter.analyze(shadowReport());
  assert.equal(result.analyzed, false);
  assert.equal(result.available, true);
  assert.equal(result.code, "HUGGING_FACE_INVALID_RESPONSE");
  assert.equal(result.authorizationDecision, null);
});

test("delivers in-app by default and supports injected channels", async () => {
  const webhookPayloads = [];
  const service = createNotificationService({
    timeoutMs: 100,
    inMemory: {
      randomUUID: () => "notification-1",
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
    },
    webhook: async (payload) => {
      webhookPayloads.push(payload);
      return { id: "webhook-1" };
    },
    email: async () => {
      throw new Error("provider credentials must not leak");
    },
  });
  const result = await service.deliver({
    recipient: {
      userId: 7,
      email: "user@example.com",
    },
    notification: {
      type: "step_up_required",
      severity: "warning",
      title: "Verification needed",
      body: "Complete verification before the protected action.",
      metadata: { reasonCode: "STEP_UP_REQUIRED" },
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(result.fullyDelivered, false);
  assert.equal(result.results.length, 3);
  assert.equal(
    result.results.find((entry) => entry.channel === "in_app").id,
    "notification-1"
  );
  assert.equal(webhookPayloads.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /provider credentials/);
});

test("rejects secret-shaped notification metadata", async () => {
  const service = createNotificationService();
  await assert.rejects(
    service.deliver({
      recipient: { userId: 1 },
      notification: {
        type: "system",
        severity: "info",
        title: "Update",
        body: "A bounded system update.",
        metadata: { sessionToken: "secret" },
      },
    }),
    /forbidden field/
  );
});

test("adapts database-backed in-app notification delivery", async () => {
  const calls = [];
  const channel = createDatabaseInAppNotificationChannel({
    async createSecurityNotification(userId, notification) {
      calls.push({ userId, notification });
      return { id: 91 };
    },
  });
  const result = await channel.send({
    recipient: { userId: 8 },
    notification: {
      type: "new_device",
      severity: "warning",
      title: "New device",
      body: "A new device was registered.",
      metadata: {},
    },
  });
  assert.deepEqual(result, { id: 91 });
  assert.equal(calls[0].userId, 8);
});
