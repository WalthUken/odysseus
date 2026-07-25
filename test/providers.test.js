"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GEMINI_API_ROOT,
  createGeminiExplanationAdapter,
  validateBehaviorReport,
  validateExplanation,
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

function interactionResponse(explanation) {
  return {
    id: "interaction-1",
    object: "interaction",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify(explanation) }],
      },
    ],
  };
}

function goodExplanation(overrides = {}) {
  return {
    headline: "Interaction changed",
    summary: "Several timing signals differ from baseline.",
    observations: ["Key hold duration increased."],
    nextStep: "Use Odysseus's configured verification flow.",
    ...overrides,
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
      return jsonResponse(interactionResponse(goodExplanation()));
    },
  });
  const result = await adapter.explain(behaviorReport());
  assert.equal(result.generated, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.authorizationDecision, null);
  assert.match(result.prose, /^AI-generated explanation:/);
  assert.match(result.prose, /Authority: Advisory only/);

  // Documented Interactions API endpoint, with the key in the header only.
  assert.equal(
    GEMINI_API_ROOT,
    "https://generativelanguage.googleapis.com/v1beta/interactions"
  );
  assert.equal(request.url, GEMINI_API_ROOT);
  assert.doesNotMatch(request.url, /test-gemini-key/);
  assert.doesNotMatch(request.url, /[?&]key=/);
  assert.equal(request.options.method ?? "POST", "POST");
  assert.equal(request.options.headers["x-goog-api-key"], "test-gemini-key");
  assert.equal(
    request.options.headers["Content-Type"],
    "application/json"
  );

  const sent = JSON.parse(request.options.body);
  assert.equal(sent.model, "gemini-test");
  assert.equal(sent.store, false);
  assert.equal(sent.background, false);
  assert.equal(typeof sent.system_instruction, "string");
  assert.match(sent.system_instruction, /do not make.*authorization/i);
  assert.equal(typeof sent.input, "string");
  assert.equal(sent.response_format.type, "text");
  assert.equal(sent.response_format.mime_type, "application/json");
  assert.equal(sent.response_format.schema.type, "object");
  assert.equal(sent.response_format.schema.additionalProperties, false);
  assert.equal("$schema" in sent.response_format.schema, false);
  assert.deepEqual(sent.response_format.schema.required, [
    "headline",
    "summary",
    "observations",
    "nextStep",
  ]);
  assert.equal(sent.generation_config.max_output_tokens, 600);
  assert.equal("temperature" in sent.generation_config, false);
  // No tools, grounding, streaming, or conversation state.
  assert.equal("tools" in sent, false);
  assert.equal("previous_interaction_id" in sent, false);

  // The outbound payload stays quantised and identifier-free.
  const forwarded = JSON.parse(sent.input);
  assert.deepEqual(Object.keys(forwarded), [
    "version",
    "assessment",
    "signals",
  ]);
  assert.doesNotMatch(sent.input, /userId|sessionId|rawTypedText/);
});

test("reads the model text from the Interactions step timeline", async () => {
  const adapter = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () =>
      jsonResponse({
        id: "interaction-2",
        object: "interaction",
        status: "completed",
        steps: [
          { type: "user_input", content: [{ type: "text", text: "ignored" }] },
          {
            type: "model_output",
            content: [
              { type: "text", text: JSON.stringify(goodExplanation()) },
            ],
          },
        ],
      }),
  });
  const result = await adapter.explain(behaviorReport());
  assert.equal(result.generated, true);
  assert.equal(result.explanation.headline, "Interaction changed");
  assert.equal(result.authorizationDecision, null);
});

test("treats blocked or empty Gemini output as a clean provider failure", async () => {
  const payloads = [
    { status: "failed", steps: [] },
    { status: "cancelled", steps: [] },
    { promptFeedback: { blockReason: "SAFETY" }, steps: [] },
    { status: "completed", steps: [] },
    { status: "completed" },
    { status: "completed", steps: [{ type: "function_call", content: [] }] },
  ];
  for (const payload of payloads) {
    const adapter = createGeminiExplanationAdapter({
      apiKey: "test-gemini-key",
      fetchImpl: async () => jsonResponse(payload),
    });
    const result = await adapter.explain(behaviorReport());
    assert.equal(result.generated, false, JSON.stringify(payload));
    assert.equal(result.available, true);
    assert.equal(result.code, "GEMINI_INVALID_RESPONSE");
    assert.equal(result.retryable, false);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.authorizationDecision, null);
    assert.equal(adapter.readiness().ready, false);
  }
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
      jsonResponse(
        interactionResponse({
          // Reversed word order used to slip past the filter entirely.
          headline: "Access granted",
          summary: "The model attempted to decide access.",
          observations: ["Timing changed."],
          nextStep: "Continue.",
        })
      ),
  });
  const result = await adapter.explain(behaviorReport());
  assert.equal(result.generated, false);
  assert.equal(result.available, true);
  assert.equal(result.code, "GEMINI_INVALID_RESPONSE");
  assert.equal(result.authorizationDecision, null);
});

test("blocks authorization language in either word order", () => {
  const blocked = [
    // Verb first.
    "Grant access to the protected action.",
    "Granted access after review.",
    "Allow access to the account.",
    "Deny access to the account.",
    "Approve access for the session.",
    "Block access for the session.",
    // Object first: the previously bypassable order.
    "Access granted.",
    "Access is granted.",
    "Access allowed.",
    "Access was denied.",
    "Access has been approved.",
    "Login approved.",
    "The sign-in was permitted.",
    // Trust and proceed phrasings.
    "This user should be trusted.",
    "The account can be trusted going forward.",
    "should be trusted",
    "Let this user proceed.",
    "Let them proceed to the protected action.",
    "Allow the user to proceed.",
    "The session may proceed.",
    // Verification waivers.
    "No further verification needed.",
    "No further verification is required.",
    "No additional checks are necessary.",
    "No verification needed.",
    "Verification is not required.",
    "Step-up is unnecessary.",
    // Bare authorization vocabulary.
    "The request is authorized.",
    "Authorisation is complete.",
    "This authorizes the action.",
  ];
  for (const text of blocked) {
    assert.throws(
      () => validateExplanation(goodExplanation({ summary: text })),
      /authorization statement/,
      `expected to be blocked: ${text}`
    );
  }

  const allowed = [
    "Several timing signals differ from baseline.",
    "Key hold duration increased compared with the stored template.",
    "Use Odysseus's configured verification flow.",
    "Complete the verification step shown on screen.",
    "Verification is required before the protected action.",
    "Typing rhythm shifted across the sampled window.",
    "The measured deviation is larger than the recorded baseline.",
  ];
  for (const text of allowed) {
    assert.doesNotThrow(
      () => validateExplanation(goodExplanation({ summary: text })),
      `expected to be allowed: ${text}`
    );
  }
});

test("applies the authorization filter to every explanation field", () => {
  const fields = [
    { headline: "Access granted" },
    { summary: "Access granted." },
    { nextStep: "Access granted." },
    { observations: ["Access granted."] },
  ];
  for (const overrides of fields) {
    assert.throws(
      () => validateExplanation(goodExplanation(overrides)),
      /authorization statement/,
      `expected to be blocked: ${JSON.stringify(overrides)}`
    );
  }
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

test("retries a retryable provider failure exactly once", async () => {
  let geminiCalls = 0;
  const gemini = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      geminiCalls += 1;
      return geminiCalls === 1
        ? jsonResponse({ error: "overloaded" }, 503)
        : jsonResponse(interactionResponse(goodExplanation()));
    },
  });
  const explained = await gemini.explain(behaviorReport());
  assert.equal(geminiCalls, 2);
  assert.equal(explained.generated, true);
  assert.equal(explained.authorizationDecision, null);

  let huggingFaceCalls = 0;
  const huggingFace = createHuggingFaceAnomalyAdapter({
    endpointUrl: "https://hf.test/anomaly",
    allowedHosts: ["hf.test"],
    fetchImpl: async () => {
      huggingFaceCalls += 1;
      return huggingFaceCalls === 1
        ? jsonResponse({ error: "loading" }, 429)
        : jsonResponse({ anomalyScore: 0.4, label: "normal" });
    },
  });
  const analyzed = await huggingFace.analyze(shadowReport());
  assert.equal(huggingFaceCalls, 2);
  assert.equal(analyzed.analyzed, true);
  assert.equal(analyzed.shadowOnly, true);
  assert.equal(analyzed.grantEffect, "none");
  assert.equal(analyzed.authorizationDecision, null);
});

test("stops after the single retry and never retries client errors", async () => {
  let rejectedCalls = 0;
  const rejecting = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      rejectedCalls += 1;
      return jsonResponse({ error: "bad request" }, 400);
    },
  });
  const rejected = await rejecting.explain(behaviorReport());
  assert.equal(rejectedCalls, 1);
  assert.equal(rejected.generated, false);
  assert.equal(rejected.code, "GEMINI_UNAVAILABLE");
  assert.equal(rejected.advisoryOnly, true);
  assert.equal(rejected.authorizationDecision, null);

  let unstableCalls = 0;
  const unstable = createGeminiExplanationAdapter({
    apiKey: "test-gemini-key",
    fetchImpl: async () => {
      unstableCalls += 1;
      return jsonResponse({ error: "overloaded" }, 503);
    },
  });
  const failed = await unstable.explain(behaviorReport());
  assert.equal(unstableCalls, 2);
  assert.equal(failed.generated, false);
  assert.equal(failed.code, "GEMINI_UNAVAILABLE");
  assert.equal(failed.retryable, true);
  assert.equal(failed.authorizationDecision, null);
});

test("configures provider timeouts from the environment", () => {
  assert.equal(
    createGeminiExplanationAdapter({
      apiKey: "test-gemini-key",
      env: {},
    }).timeoutMs,
    5_000
  );
  assert.equal(
    createGeminiExplanationAdapter({
      apiKey: "test-gemini-key",
      env: { ODYSSEUS_GEMINI_TIMEOUT_MS: "1200" },
    }).timeoutMs,
    1_200
  );
  assert.equal(
    createGeminiExplanationAdapter({
      apiKey: "test-gemini-key",
      timeoutMs: 2_000,
      env: { ODYSSEUS_GEMINI_TIMEOUT_MS: "1200" },
    }).timeoutMs,
    2_000
  );
  assert.equal(
    createHuggingFaceAnomalyAdapter({
      endpointUrl: "https://hf.test/anomaly",
      allowedHosts: ["hf.test"],
      env: {},
    }).timeoutMs,
    3_000
  );
  assert.equal(
    createHuggingFaceAnomalyAdapter({
      endpointUrl: "https://hf.test/anomaly",
      allowedHosts: ["hf.test"],
      env: { ODYSSEUS_HUGGING_FACE_TIMEOUT_MS: "900" },
    }).timeoutMs,
    900
  );
  for (const value of ["0", "-1", "30001", "not-a-number", "1.5"]) {
    assert.throws(
      () =>
        createGeminiExplanationAdapter({
          apiKey: "test-gemini-key",
          env: { ODYSSEUS_GEMINI_TIMEOUT_MS: value },
        }),
      /between 1 and 30000/,
      `expected rejection for ${value}`
    );
  }
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
