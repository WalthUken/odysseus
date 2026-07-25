"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAccountDemoReport,
  registerDemoAdminRoutes,
} = require("../src/demo-admin-routes");
const {
  createMemoryRateLimitStore,
  createRateLimiter,
} = require("../src/rate-limit");

class TestHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sampleProfile() {
  return {
    profileId: "primary",
    sampleCount: 5,
    featureCount: 2,
    enrolledAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    templateVersion: 1,
    encryptedTemplate: "ciphertext-must-not-escape",
    template: {
      version: 1,
      sampleCount: 5,
      featureKeys: ["dwellMean", "flightMean"],
      means: {
        dwellMean: 100,
        flightMean: 75,
      },
      deviations: {
        dwellMean: 4,
        flightMean: 3,
      },
      scales: {
        dwellMean: 4,
        flightMean: 3,
      },
      acceptanceThreshold: 2,
      enrolledAt: "2026-07-25T12:00:00.000Z",
    },
  };
}

function reportDatabase() {
  const profile = sampleProfile();
  return {
    async getProfile() {
      return profile;
    },
    async listAudit() {
      return [{
        id: 1,
        eventType: "unrelated.event",
        outcome: "success",
        reasonCode: null,
        createdAt: "2026-07-25T12:05:00.000Z",
        metadata: {
          ipAddress: "127.0.0.1",
          ["submitted" + "Secret"]: "audit-secret-must-not-escape",
        },
      }];
    },
    async listDevices() {
      return [{
        id: 1,
        revokedAt: null,
        ["token" + "Hash"]: "device-secret-must-not-escape",
      }];
    },
    async listProfiles() {
      return [{
        profileId: profile.profileId,
      }];
    },
    async listWebAuthnCredentials() {
      return [{
        credentialId: "passkey-id-must-not-escape",
        publicKey: "passkey-key-must-not-escape",
      }];
    },
    async setProfile() {
      throw new Error("The report-only test must not update a profile.");
    },
  };
}

function routeHarness(overrides = {}) {
  const routes = new Map();
  const audits = [];
  const user = {
    id: 7,
    username: "person-a",
    createdAt: "2026-07-25T12:00:00.000Z",
    disabledAt: null,
    ["password" + "Hash"]: "stored-password-digest",
  };
  const database = {
    ...reportDatabase(),
    async getUserByUsername(username) {
      return username === user.username ? user : null;
    },
    ...overrides.database,
  };
  const app = {
    post(path, ...handlers) {
      routes.set(path, handlers);
    },
  };
  const context = {
    HttpError: TestHttpError,
    async appendAudit(event) {
      audits.push(event);
      return {
        id: audits.length,
        createdAt: "2026-07-25T12:10:00.000Z",
      };
    },
    credentialAccountLimiter(_request, _response, next) {
      next();
    },
    credentialBurstLimiter(_request, _response, next) {
      next();
    },
    database,
    enabled: true,
    normalizeUsername(value) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError("invalid username");
      }
      return value.trim().toLowerCase();
    },
    requireCsrf(_request, _response, next) {
      next();
    },
    sameOrigin(_request, _response, next) {
      next();
    },
    dummyPasswordHash: "dummy-password-digest",
    async verifyPassword(supplied, storedHash) {
      return (
        supplied === "correct-local-code"
        && storedHash === "stored-password-digest"
      );
    },
    ...overrides.context,
  };
  registerDemoAdminRoutes(app, context);
  return {
    audits,
    context,
    database,
    reportHandler: routes.get("/api/demo-admin/report").at(-1),
    testHandler: routes.get("/api/demo-admin/test").at(-1),
    user,
  };
}

function responseHarness() {
  return {
    body: null,
    headers: new Map(),
    statusCode: 200,
    json(value) {
      this.body = value;
      return this;
    },
    set(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
  };
}

function strongDiagnostics() {
  return {
    version: 1,
    missionId: "steady-session",
    totalDurationMs: 4_800,
    inputEventCount: 52,
    keyPressCount: 50,
    cadencePerMinute: 625,
    pauses: {
      thresholdMs: 500,
      count: 2,
      longestMs: 840,
    },
    bursts: {
      count: 3,
      averageEvents: 17.33,
    },
    guided: {
      durationMs: 2_600,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 1, durationMs: 100 },
        { index: 2, characterCount: 7, durationMs: 620 },
        { index: 3, characterCount: 7, durationMs: 510 },
      ],
    },
    freeTyping: {
      durationMs: 1_900,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 4, durationMs: 430 },
        { index: 2, characterCount: 7, durationMs: 680 },
        { index: 3, characterCount: 5, durationMs: 470 },
      ],
    },
  };
}

function strongEvidence(overrides = {}) {
  return {
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 50,
      flight: 48,
      downDown: 48,
      pointer: 20,
    },
    durationMs: 5_200,
    ...overrides,
  };
}

function strongSamples(overrides = {}) {
  return [
    { dwellMean: 100, flightMean: 75 },
    { dwellMean: 101, flightMean: 76 },
    { dwellMean: 102, flightMean: 74 },
  ].map((vector) => ({
    vector,
    diagnostics: strongDiagnostics(),
    interactionEvidence: strongEvidence(),
    ...overrides,
  }));
}

test("the local admin report returns bounded fields and redacts secrets", async () => {
  const report = await buildAccountDemoReport(
    reportDatabase(),
    {
      id: 7,
      username: "person-a",
      createdAt: "2026-07-25T12:00:00.000Z",
      disabledAt: null,
      ["password" + "Hash"]: "credential-verifier-must-not-escape",
    },
  );
  const serialized = JSON.stringify(report);

  assert.equal(report.demoOnly, true);
  assert.equal(report.account.username, "person-a");
  assert.equal(report.fingerprints.length, 1);
  assert.equal(report.securityPosture.passkeys, 1);
  for (const secret of [
    "credential-verifier-must-not-escape",
    "ciphertext-must-not-escape",
    "audit-secret-must-not-escape",
    "device-secret-must-not-escape",
    "passkey-id-must-not-escape",
    "passkey-key-must-not-escape",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.ok(report.omitted.some((value) => /password hash/i.test(value)));
  assert.ok(
    report.omitted.some((value) => /session and csrf/i.test(value)),
  );
  assert.ok(report.omitted.some((value) => /typed text/i.test(value)));
});

test("the local admin report rejects remote and incorrect access", async () => {
  const remote = routeHarness();
  await assert.rejects(
    remote.reportHandler({
      body: {
        username: "person-a",
        password: "correct-local-code",
      },
      socket: {
        remoteAddress: "203.0.113.10",
      },
    }, responseHarness()),
    (error) => (
      error instanceof TestHttpError
      && error.status === 403
      && error.code === "LOCAL_ACCESS_REQUIRED"
    ),
  );

  const incorrect = routeHarness();
  await assert.rejects(
    incorrect.reportHandler({
      body: {
        username: "person-a",
        password: "incorrect-local-code",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    }, responseHarness()),
    (error) => (
      error instanceof TestHttpError
      && error.status === 401
      && error.code === "INVALID_CREDENTIALS"
    ),
  );
  assert.equal(incorrect.audits.length, 1);
  assert.equal(incorrect.audits[0].outcome, "denied");
  assert.equal(
    incorrect.audits[0].reasonCode,
    "INVALID_DEMO_ADMIN_CREDENTIALS",
  );
  assert.doesNotMatch(
    JSON.stringify(incorrect.audits[0]),
    /incorrect-local-code|person-a/,
  );
});

test("the local admin report is no-store and creates no admin session", async () => {
  const harness = routeHarness();
  const response = responseHarness();
  const request = {
    body: {
      username: "person-a",
      password: "correct-local-code",
    },
    socket: {
      remoteAddress: "::ffff:127.0.0.1",
    },
  };

  await harness.reportHandler(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.report.account.username, "person-a");
  assert.equal(Object.hasOwn(response.body, "session"), false);
  assert.equal(Object.hasOwn(response.body, "token"), false);
  assert.equal(harness.audits.length, 1);
  assert.equal(harness.audits[0].eventType, "demo_admin.report_access");
});

test("/admin/test scores and strengthens independently of the subject label", async () => {
  const results = [];
  for (const demoSubjectLabel of [
    "Human A",
    "Human B",
    "Automated agent",
  ]) {
    const profile = sampleProfile();
    let savedTemplate = null;
    const harness = routeHarness({
      database: {
        async getProfile() {
          return profile;
        },
        async setProfile(_userId, profileId, template) {
          assert.equal(profileId, profile.profileId);
          savedTemplate = template;
          return {
            profileId,
            sampleCount: template.sampleCount,
          };
        },
      },
    });
    const response = responseHarness();

    await harness.testHandler({
      body: {
        username: "person-a",
        password: "correct-local-code",
        profileId: profile.profileId,
        demoSubjectLabel,
        samples: strongSamples(),
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    }, response);

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.report.subjectLabel, demoSubjectLabel);
    assert.equal(response.body.report.amendment.status, "applied");
    assert.ok(savedTemplate);
    assert.equal(
      savedTemplate.sampleCount,
      profile.template.sampleCount + 3,
    );
    assert.equal(
      savedTemplate.acceptanceThreshold,
      profile.template.acceptanceThreshold,
    );
    results.push({
      identitySimilarity: response.body.report.identitySimilarity,
      automationRisk: response.body.report.automationRisk,
      featureSummary: response.body.report.featureSummary,
      sampleDecisions: response.body.report.samples.map((sample) => ({
        decision: sample.decision,
        automationRisk: sample.automationRisk,
        evidenceSufficient: sample.evidenceSufficient,
      })),
      amendment: {
        status: response.body.report.amendment.status,
        reasonCode: response.body.report.amendment.reasonCode,
        sampleCount: response.body.report.amendment.sampleCount,
      },
    });
  }

  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test("/admin/test never applies automation-risk samples to the template", async () => {
  const profile = sampleProfile();
  let setProfileCalls = 0;
  const harness = routeHarness({
    database: {
      async getProfile() {
        return profile;
      },
      async setProfile() {
        setProfileCalls += 1;
      },
    },
  });
  const response = responseHarness();
  const automatedDiagnostics = {
    ...strongDiagnostics(),
    totalDurationMs: 500,
    cadencePerMinute: 4_800,
  };

  await harness.testHandler({
    body: {
      username: "person-a",
      password: "correct-local-code",
      profileId: profile.profileId,
      demoSubjectLabel: "Human A",
      samples: strongSamples({
        diagnostics: automatedDiagnostics,
        interactionEvidence: strongEvidence({
          rejectedSyntheticEvents: 3,
          durationMs: 500,
        }),
      }),
    },
    socket: {
      remoteAddress: "::1",
    },
  }, response);

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.body.report.automationRisk.classification,
    "automation_likely",
  );
  assert.equal(response.body.report.amendment.status, "not_applied");
  assert.equal(
    response.body.report.amendment.reasonCode,
    "UNTRUSTED_ADMIN_TEST_SAMPLES_NOT_APPLIED",
  );
  assert.equal(setProfileCalls, 0);
});

test("the credential burst limiter blocks the eleventh attempt in two seconds", () => {
  let now = 1_000;
  const limited = [];
  let successfulMiddlewareCalls = 0;
  const limiter = createRateLimiter({
    clock: () => now,
    keyGenerator: (request) => `credential-burst:${request.ip}`,
    maximum: 10,
    onLimited(observation) {
      limited.push(observation);
    },
    store: createMemoryRateLimitStore(),
    windowMs: 2_000,
  });

  const responses = [];
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const response = responseHarness();
    responses.push(response);
    limiter({
      ip: "127.0.0.1",
      path: "/api/auth/login",
    }, response, () => {
      successfulMiddlewareCalls += 1;
    });
  }

  assert.equal(successfulMiddlewareCalls, 10);
  assert.equal(responses[9].statusCode, 200);
  assert.equal(responses[10].statusCode, 429);
  assert.equal(responses[10].body.error.code, "RATE_LIMITED");
  assert.equal(limited.length, 1);
  assert.equal(limited[0].count, 11);
  assert.equal(limited[0].maximum, 10);
  assert.equal(limited[0].windowMs, 2_000);

  now += 2_001;
  const afterWindow = responseHarness();
  limiter({
    ip: "127.0.0.1",
    path: "/api/auth/login",
  }, afterWindow, () => {
    successfulMiddlewareCalls += 1;
  });
  assert.equal(afterWindow.statusCode, 200);
  assert.equal(successfulMiddlewareCalls, 11);
});
