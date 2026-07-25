"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createApp,
  parseAllowedOrigins,
  parseAdministratorUserIds,
  parseDuration,
  parseTrustProxy,
} = require("../server");
const { hashPassword } = require("../src/auth");
const { OdysseusDatabase } = require("../src/database");

const VALID_FIXTURE = "Correct-Horse-42";
const INVALID_FIXTURE = "Incorrect-Horse-42";

const enrollmentSamples = [
  { dwellMean: 100, flightMean: 75 },
  { dwellMean: 105, flightMean: 72 },
  { dwellMean: 98, flightMean: 78 },
  { dwellMean: 102, flightMean: 74 },
  { dwellMean: 101, flightMean: 76 },
];

function verificationDiagnostics() {
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

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  absorbCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    for (const value of setCookies) {
      const segments = value.split(";").map((segment) => segment.trim());
      const separator = segments[0].indexOf("=");
      if (separator < 1) {
        continue;
      }
      const name = segments[0].slice(0, separator);
      const cookieValue = segments[0].slice(separator + 1);
      const expired = segments.some(
        (segment) => segment.toLowerCase() === "max-age=0",
      );
      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }

    return setCookies;
  }

  cookieHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(route, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers = new Headers(options.headers ?? {});
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    if (mutating && options.origin !== false) {
      headers.set(
        "Origin",
        typeof options.origin === "string" ? options.origin : this.baseUrl,
      );
    }
    if (mutating && options.csrf !== false) {
      const csrf = this.cookies.get("odysseus_csrf");
      if (csrf) {
        headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      }
    }

    let body = options.body;
    if (
      body !== undefined
      && typeof body !== "string"
      && !(body instanceof Uint8Array)
    ) {
      body = JSON.stringify(body);
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body,
    });
    const setCookies = this.absorbCookies(response);
    let responseBody = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    return { response, body: responseBody, setCookies };
  }
}

async function startTestServer(context, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-api-"));
  const databasePath = path.join(directory, "odysseus.sqlite");
  const supplied = { ...options };
  const prepareDatabase = supplied.prepareDatabase;
  delete supplied.prepareDatabase;
  const masterKey = supplied.masterKey ?? crypto.randomBytes(32);
  if (typeof prepareDatabase === "function") {
    await prepareDatabase({ databasePath, directory, masterKey });
  }
  const app = await createApp({
    databasePath,
    masterKey,
    production: false,
    rateLimits: false,
    ...supplied,
  });
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => {
      resolve(listeningServer);
    });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await app.locals.closeDatabase();
    await fs.rm(directory, { recursive: true, force: true });
  });

  return {
    app,
    baseUrl,
    client: new TestClient(baseUrl),
  };
}

async function bootstrapAndRegister(client, username) {
  const bootstrap = await client.request("/api/auth/me");
  assert.equal(bootstrap.response.status, 401);
  assert.ok(client.cookies.has("odysseus_csrf"));

  const registration = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username,
      password: VALID_FIXTURE,
    },
  });
  assert.equal(registration.response.status, 201);
  return registration;
}

test("validates production timing, origin, and proxy configuration", () => {
  assert.equal(
    parseDuration(undefined, "grant", 60_000, 30_000, 120_000),
    60_000,
  );
  assert.equal(
    parseDuration("90000", "grant", 60_000, 30_000, 120_000),
    90_000,
  );
  assert.throws(() =>
    parseDuration("invalid", "grant", 60_000, 30_000, 120_000),
  );

  assert.deepEqual(
    parseAllowedOrigins(
      "https://odysseus.example, https://admin.odysseus.example/",
    ),
    [
      "https://odysseus.example",
      "https://admin.odysseus.example",
    ],
  );
  assert.throws(() => parseAllowedOrigins("ftp://odysseus.example"));
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("false"), false);
  assert.throws(() => parseTrustProxy("all"));
  assert.deepEqual(
    [...parseAdministratorUserIds("7, 11,7")],
    [7, 11],
  );
  assert.throws(() => parseAdministratorUserIds("0"));
  assert.throws(() => parseAdministratorUserIds("admin"));
});

test("binds administrator access to pre-provisioned immutable user IDs", async (context) => {
  const administratorUserIds = [];
  let originalAdministratorId;
  const { client } = await startTestServer(context, {
    adminUserIds: administratorUserIds,
    async prepareDatabase({ databasePath, masterKey }) {
      const database = new OdysseusDatabase({
        databasePath,
        masterKey,
      });
      await database.init();
      try {
        const administrator = await database.createUser({
          username: "stable-admin",
          passwordHash: await hashPassword(VALID_FIXTURE),
        });
        originalAdministratorId = administrator.id;
        administratorUserIds.push(administrator.id);
      } finally {
        await database.close();
      }
    },
  });

  await client.request("/api/auth/me");
  const login = await client.request("/api/auth/login", {
    method: "POST",
    body: {
      username: "stable-admin",
      password: VALID_FIXTURE,
    },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.id, originalAdministratorId);

  const authorized = await client.request("/api/admin/summary");
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.body.isAdmin, true);

  const deletion = await client.request("/api/account", {
    method: "DELETE",
    body: {
      confirmation: "stable-admin",
      deleteAccount: true,
    },
  });
  assert.equal(deletion.response.status, 200);

  await client.request("/api/health");
  const replacement = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username: "stable-admin",
      password: VALID_FIXTURE,
    },
  });
  assert.equal(replacement.response.status, 201);
  assert.notEqual(replacement.body.user.id, originalAdministratorId);

  const denied = await client.request("/api/admin/summary");
  assert.equal(denied.response.status, 403);
  assert.equal(
    denied.body.error.code,
    "ADMINISTRATOR_REQUIRED",
  );
});

test("rejects reclaimable administrator usernames and missing admin IDs", async () => {
  await assert.rejects(
    () => createApp({
      adminUsers: ["reserved-admin"],
      databasePath: ":memory:",
      masterKey: crypto.randomBytes(32),
      production: false,
      rateLimits: false,
    }),
    /ODYSSEUS_ADMIN_USERS is no longer supported/,
  );

  await assert.rejects(
    () => createApp({
      adminUserIds: [42],
      databasePath: ":memory:",
      masterKey: crypto.randomBytes(32),
      production: false,
      rateLimits: false,
    }),
    /Configured administrator user ID 42 does not exist/,
  );
});

test("serves the secured browser entry point and rejects unauthenticated access", async (context) => {
  const { baseUrl, client } = await startTestServer(context);
  const root = await client.request("/");

  assert.equal(root.response.status, 200);
  assert.match(
    root.body,
    /<title>Odysseus \| Account Console<\/title>/,
  );
  assert.match(root.body, /id="auth-form"/);
  assert.match(root.body, /id="enrollment-board"/);
  assert.match(root.body, /id="enrollment-free-input"/);
  assert.match(root.body, /id="verification-free-input"/);
  assert.match(root.body, /records automatically/i);
  assert.match(root.body, /does not prove who a person is/i);
  assert.doesNotMatch(root.body, /displayed dispatch exactly/i);
  assert.match(root.body, /<script src="\/challenge\.js" defer><\/script>/);
  assert.match(root.body, /<script src="\/diagnostics\.js" defer><\/script>/);
  assert.match(root.body, /<script src="\/session\.js" defer><\/script>/);
  assert.match(root.body, /<script src="\/app\.js" defer><\/script>/);
  assert.match(root.body, /id="security-report"/);
  assert.match(root.body, /id="action-status"/);
  assert.match(
    root.response.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(root.response.headers.get("x-frame-options"), "DENY");

  const challenge = await client.request("/challenge.js");
  assert.equal(challenge.response.status, 200);
  assert.match(challenge.body, /ENROLLMENT_ROUNDS/);
  assert.match(challenge.body, /VERIFICATION_ROUNDS/);

  const bootstrap = await client.request("/api/auth/me");
  assert.equal(bootstrap.response.status, 401);
  assert.equal(
    bootstrap.body.error.code,
    "AUTHENTICATION_REQUIRED",
  );
  assert.ok(client.cookies.has("odysseus_csrf"));

  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "laptop",
      samples: enrollmentSamples,
    },
  });
  assert.equal(enrollment.response.status, 401);
});

test("enforces same-origin and CSRF protections", async (context) => {
  const { client } = await startTestServer(context);
  await client.request("/api/auth/me");

  const crossOrigin = await client.request("/api/auth/register", {
    method: "POST",
    origin: "https://attacker.example",
    body: {
      username: "cross-origin-user",
      password: VALID_FIXTURE,
    },
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.body.error.code, "ORIGIN_REJECTED");

  const missingCsrf = await client.request("/api/auth/register", {
    method: "POST",
    csrf: false,
    body: {
      username: "missing-csrf-user",
      password: VALID_FIXTURE,
    },
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.body.error.code, "CSRF_REJECTED");
});

test("supports account registration, behavior grants, password step-up, audit, and logout", async (context) => {
  const { client } = await startTestServer(context);
  const registration = await bootstrapAndRegister(
    client,
    "complete-flow-user",
  );

  assert.equal(registration.body.user.username, "complete-flow-user");
  assert.equal(
    Object.hasOwn(registration.body.user, "passwordHash"),
    false,
  );
  const sessionCookie = registration.setCookies.find((value) =>
    value.startsWith("odysseus_session="),
  );
  const csrfCookie = registration.setCookies.find((value) =>
    value.startsWith("odysseus_csrf="),
  );
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Strict/);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  assert.match(csrfCookie, /SameSite=Strict/);

  const me = await client.request("/api/auth/me");
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.username, "complete-flow-user");

  const missingCsrf = await client.request("/api/enroll", {
    method: "POST",
    csrf: false,
    body: {
      profileId: "laptop",
      samples: enrollmentSamples,
    },
  });
  assert.equal(missingCsrf.response.status, 403);

  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "laptop",
      samples: enrollmentSamples,
    },
  });
  assert.equal(enrollment.response.status, 201);
  assert.equal(enrollment.body.profileId, "laptop");
  assert.equal(enrollment.body.sampleCount, 5);

  const metadata = await client.request("/api/profiles/laptop");
  assert.equal(metadata.response.status, 200);
  assert.equal(metadata.body.featureCount, 2);
  assert.equal(Object.hasOwn(metadata.body, "template"), false);

  const accepted = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "laptop",
      vector: { dwellMean: 101, flightMean: 75 },
      diagnostics: verificationDiagnostics(),
    },
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.decision, "allow");
  assert.ok(accepted.body.behaviorVerifiedUntil);
  assert.equal(accepted.body.diagnostics.keyboard.averageKeyHoldMs, 101);
  assert.equal(accepted.body.diagnostics.typing.pauses.count, 2);

  const behaviorAuthorized = await client.request(
    "/api/actions/secure-record",
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(behaviorAuthorized.response.status, 200);
  assert.equal(behaviorAuthorized.body.authorizedBy, "behavior");
  assert.match(
    behaviorAuthorized.body.record.id,
    /^ODY-ACCESS-\d{6}$/,
  );
  assert.equal(
    behaviorAuthorized.body.record.title,
    "Account security report",
  );
  assert.equal(
    behaviorAuthorized.body.record.account.username,
    "complete-flow-user",
  );
  assert.equal(
    behaviorAuthorized.body.record.authorization.method,
    "behavior",
  );
  assert.equal(behaviorAuthorized.body.record.reportVersion, 4);
  assert.equal(
    behaviorAuthorized.body.record.session.behaviorGrantActive,
    true,
  );
  assert.equal(
    behaviorAuthorized.body.record.session.stepUpActive,
    true,
  );
  assert.equal(
    behaviorAuthorized.body.record.session.deviceBound,
    false,
  );
  assert.equal(behaviorAuthorized.body.record.device, null);
  assert.equal(
    behaviorAuthorized.body.record.summary.posture,
    "Behavior matched",
  );
  assert.equal(
    behaviorAuthorized.body.record.summary.latestTrustPercent,
    accepted.body.trustPercent,
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification.profileId,
    "laptop",
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification.decision,
    "allow",
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification.grantActive,
    true,
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification
      .behaviorDiagnostics.keyboard.averageKeyHoldMs,
    101,
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification
      .behaviorDiagnostics.typing.bursts.count,
    3,
  );
  assert.equal(
    behaviorAuthorized.body.record.latestVerification
      .behaviorDiagnostics.slowWords.guided[0].label,
    "Response word 2",
  );
  assert.match(
    behaviorAuthorized.body.record.network.currentIpAddress,
    /127\.0\.0\.1|::1/,
  );
  assert.equal(
    behaviorAuthorized.body.record.network.sameAsLatestVerification,
    true,
  );
  assert.match(
    behaviorAuthorized.body.record.geminiReadiness.authorizationBoundary,
    /must not issue grants/i,
  );
  assert.ok(
    behaviorAuthorized.body.record.controls.some(
      (control) =>
        control.name === "CSRF token validation"
        && control.status === "Passed",
    ),
  );
  assert.ok(
    behaviorAuthorized.body.record.controls.some(
      (control) =>
        control.name === "Baseline bootstrap assurance"
        && control.status === "Limited",
    ),
  );
  assert.ok(
    behaviorAuthorized.body.record.limitations.some((limitation) =>
      /not proof that the enrollee is human/i.test(limitation)
    ),
  );
  assert.match(
    behaviorAuthorized.body.record.privacy.transmitted,
    /aggregate keyboard timing/i,
  );
  assert.ok(behaviorAuthorized.body.record.privacy.excluded.includes(
    "Free-typing content",
  ));
  assert.ok(behaviorAuthorized.body.record.recommendations.length >= 3);
  assert.ok(behaviorAuthorized.body.record.limitations.length >= 3);
  assert.equal(
    behaviorAuthorized.body.record.profiles[0].profileId,
    "laptop",
  );
  assert.equal(
    behaviorAuthorized.body.record.profiles[0].sampleCount,
    5,
  );
  assert.equal(
    behaviorAuthorized.body.record.profiles[0].maturity,
    "Starter baseline",
  );
  assert.ok(
    behaviorAuthorized.body.record.recentActivity.some(
      (event) => event.eventType === "secure_record.access",
    ),
  );
  assert.ok(
    behaviorAuthorized.body.record.recentActivity.some(
      (event) =>
        event.eventType === "behavior.verify"
        && event.outcome === "success"
        && event.detail.includes("% trust"),
    ),
  );
  assert.ok(
    behaviorAuthorized.body.record.recentActivity.every(
      (event) => typeof event.ipAddress === "string",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(behaviorAuthorized.body.record),
    /tokenHash|fingerprintDigest|clientFingerprint|csrf|clientX|clientY|keyCode|typedText/,
  );

  const rejected = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "laptop",
      vector: { dwellMean: 900, flightMean: 800 },
    },
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.decision, "deny");

  const grantCleared = await client.request(
    "/api/actions/secure-record",
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(grantCleared.response.status, 403);
  assert.equal(grantCleared.body.error.code, "STEP_UP_REQUIRED");

  const wrongStepUp = await client.request("/api/auth/step-up", {
    method: "POST",
    body: { password: INVALID_FIXTURE },
  });
  assert.equal(wrongStepUp.response.status, 401);
  assert.equal(wrongStepUp.body.error.code, "INVALID_CREDENTIALS");
  const sessionStillValid = await client.request("/api/auth/me");
  assert.equal(sessionStillValid.response.status, 200);

  const stepUp = await client.request("/api/auth/step-up", {
    method: "POST",
    body: { password: VALID_FIXTURE },
  });
  assert.equal(stepUp.response.status, 200);
  assert.ok(stepUp.body.stepUpUntil);

  const passwordAuthorized = await client.request(
    "/api/actions/secure-record",
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(passwordAuthorized.response.status, 200);
  assert.equal(
    passwordAuthorized.body.authorizedBy,
    "password_step_up",
  );
  assert.equal(
    passwordAuthorized.body.record.authorization.method,
    "password_step_up",
  );
  assert.equal(
    passwordAuthorized.body.record.account.username,
    "complete-flow-user",
  );

  const audit = await client.request("/api/audit?limit=100");
  assert.equal(audit.response.status, 200);
  const eventTypes = audit.body.events.map((event) => event.eventType);
  assert.ok(eventTypes.includes("auth.register"));
  assert.ok(eventTypes.includes("profile.enroll"));
  assert.ok(eventTypes.includes("behavior.verify"));
  assert.ok(eventTypes.includes("auth.step_up"));
  assert.ok(eventTypes.includes("secure_record.access"));
  const verificationEvents = audit.body.events.filter(
    (event) => event.eventType === "behavior.verify",
  );
  assert.ok(
    verificationEvents.some((event) => event.outcome === "success"),
  );
  assert.ok(
    verificationEvents.some((event) => event.outcome === "denied"),
  );
  assert.equal(JSON.stringify(audit.body).includes(VALID_FIXTURE), false);

  const rejectedCrossOriginLogout = await client.request("/api/auth/logout", {
    method: "POST",
    origin: "https://attacker.example",
    body: {},
  });
  assert.equal(rejectedCrossOriginLogout.response.status, 403);
  assert.equal(client.cookies.has("odysseus_session"), true);

  const logout = await client.request("/api/auth/logout", {
    method: "POST",
    csrf: false,
    body: {},
  });
  assert.equal(logout.response.status, 200);
  assert.equal(client.cookies.has("odysseus_session"), false);
  assert.equal(client.cookies.has("odysseus_csrf"), false);

  const repeatedLogout = await client.request("/api/auth/logout", {
    method: "POST",
    csrf: false,
    body: {},
  });
  assert.equal(repeatedLogout.response.status, 200);

  const signedOut = await client.request("/api/auth/me");
  assert.equal(signedOut.response.status, 401);

  const csrfBootstrap = await client.request("/api/health");
  assert.equal(csrfBootstrap.response.status, 200);
  assert.equal(client.cookies.has("odysseus_csrf"), true);

  const nextAccount = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username: "post-logout-user",
      password: VALID_FIXTURE,
    },
  });
  assert.equal(nextAccount.response.status, 201);
  assert.equal(nextAccount.body.user.username, "post-logout-user");
});

test("rejects behavior profile mutations without recent strong authorization", async (context) => {
  const { app, client } = await startTestServer(context);
  await bootstrapAndRegister(client, "profile-mutation-guard");

  const rawSession = decodeURIComponent(
    client.cookies.get("odysseus_session"),
  );
  const authenticated = await app.locals.database.getSessionWithUser(
    rawSession,
  );
  assert.ok(authenticated);
  await app.locals.database.setStepUpUntil(
    authenticated.session.id,
    null,
  );

  const rejectedEnrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "guarded-profile",
      samples: enrollmentSamples,
    },
  });
  assert.equal(rejectedEnrollment.response.status, 403);
  assert.equal(
    rejectedEnrollment.body.error.code,
    "STRONG_AUTHORIZATION_REQUIRED",
  );

  const stepUp = await client.request("/api/auth/step-up", {
    method: "POST",
    body: { password: VALID_FIXTURE },
  });
  assert.equal(stepUp.response.status, 200);

  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "guarded-profile",
      samples: enrollmentSamples,
    },
  });
  assert.equal(enrollment.response.status, 201);

  await app.locals.database.setStepUpUntil(
    authenticated.session.id,
    null,
  );
  const behaviorVerification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "guarded-profile",
      vector: { dwellMean: 101, flightMean: 75 },
      diagnostics: verificationDiagnostics(),
    },
  });
  assert.equal(behaviorVerification.response.status, 200);
  assert.equal(behaviorVerification.body.decision, "allow");
  assert.ok(behaviorVerification.body.behaviorVerifiedUntil);

  for (const mutation of [
    {
      route: "/api/enroll",
      method: "POST",
      body: {
        profileId: "guarded-profile",
        samples: enrollmentSamples,
      },
    },
    {
      route: "/api/profiles/guarded-profile/reset",
      method: "POST",
      body: {},
    },
    {
      route: "/api/profiles/guarded-profile",
      method: "DELETE",
      body: {},
    },
  ]) {
    const rejected = await client.request(mutation.route, {
      method: mutation.method,
      body: mutation.body,
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(
      rejected.body.error.code,
      "STRONG_AUTHORIZATION_REQUIRED",
    );
  }

  const profileStillExists = await client.request(
    "/api/profiles/guarded-profile",
  );
  assert.equal(profileStillExists.response.status, 200);
});

test("isolates behavior profiles between authenticated accounts", async (context) => {
  const { baseUrl, client: firstClient } = await startTestServer(context);
  const secondClient = new TestClient(baseUrl);
  await bootstrapAndRegister(firstClient, "first-account");
  await bootstrapAndRegister(secondClient, "second-account");

  const firstEnrollment = await firstClient.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "shared-name",
      samples: enrollmentSamples,
    },
  });
  assert.equal(firstEnrollment.response.status, 201);

  const invisible = await secondClient.request(
    "/api/profiles/shared-name",
  );
  assert.equal(invisible.response.status, 404);

  const secondEnrollment = await secondClient.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "shared-name",
      samples: enrollmentSamples.map((sample) => ({
        dwellMean: sample.dwellMean + 100,
        flightMean: sample.flightMean + 100,
      })),
    },
  });
  assert.equal(secondEnrollment.response.status, 201);

  const firstProfiles = await firstClient.request("/api/profiles");
  const secondProfiles = await secondClient.request("/api/profiles");
  assert.equal(firstProfiles.body.profiles.length, 1);
  assert.equal(secondProfiles.body.profiles.length, 1);
});

test("does not overwrite an existing baseline through enrollment", async (context) => {
  const { client } = await startTestServer(context);
  await bootstrapAndRegister(client, "baseline-preservation");

  const first = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "primary-baseline",
      samples: enrollmentSamples,
    },
  });
  assert.equal(first.response.status, 201);

  const replacement = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "primary-baseline",
      samples: enrollmentSamples.map((sample) => ({
        dwellMean: sample.dwellMean + 400,
        flightMean: sample.flightMean + 400,
      })),
    },
  });
  assert.equal(replacement.response.status, 409);
  assert.equal(
    replacement.body.error.code,
    "PROFILE_ALREADY_ENROLLED"
  );

  const stored = await client.request(
    "/api/profiles/primary-baseline"
  );
  assert.equal(stored.response.status, 200);
  assert.equal(stored.body.sampleCount, enrollmentSamples.length);
});

test("returns structured validation errors without leaking internals", async (context) => {
  const { client } = await startTestServer(context);
  await client.request("/api/auth/me");

  const weakPassword = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username: "weak-password-user",
      password: "short",
    },
  });
  assert.equal(weakPassword.response.status, 400);
  assert.equal(
    weakPassword.body.error.code,
    "AUTH_VALIDATION_ERROR",
  );

  await bootstrapAndRegister(client, "validation-user");
  const invalidProfile = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "../invalid",
      samples: enrollmentSamples,
    },
  });
  assert.equal(invalidProfile.response.status, 400);
  assert.equal(invalidProfile.body.error.code, "VALIDATION_ERROR");

  const invalidAuditCursor = await client.request(
    "/api/audit?before=not-a-date",
  );
  assert.equal(invalidAuditCursor.response.status, 400);
  assert.match(invalidAuditCursor.body.error.code, /VALIDATION/);
});

test("serves and strengthens a local account fingerprint report", async (context) => {
  const { client } = await startTestServer(context, {
    demoAdminBypass: "adminbypass",
  });
  await client.request("/api/auth/me");
  const registration = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username: "human-a-demo",
      password: "test06",
    },
  });
  assert.equal(registration.response.status, 201);

  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "human-a-report",
      samples: enrollmentSamples,
    },
  });
  assert.equal(enrollment.response.status, 201);

  const verification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "human-a-report",
      vector: { dwellMean: 101, flightMean: 75 },
      diagnostics: verificationDiagnostics(),
      interactionEvidence: {
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
      },
      demoSubjectLabel: "Human A",
    },
  });
  assert.equal(verification.response.status, 200);
  assert.equal(
    verification.body.automationAssessment.classification,
    "human_like_interaction",
  );

  const page = await client.request("/admin");
  assert.equal(page.response.status, 200);
  assert.match(page.body, /Local Report Viewer/);
  const testPage = await client.request("/admin/test");
  assert.equal(testPage.response.status, 200);
  assert.match(testPage.body, /Stronger Local Test/);

  const wrongCode = await client.request("/api/demo-admin/report", {
    method: "POST",
    body: {
      username: "human-a-demo",
      adminBypass: "wrong-admin-code",
    },
  });
  assert.equal(wrongCode.response.status, 401);

  const opened = await client.request("/api/demo-admin/report", {
    method: "POST",
    body: {
      username: "human-a-demo",
      adminBypass: "adminbypass",
    },
  });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.report.account.username, "human-a-demo");
  assert.equal(opened.body.report.fingerprints.length, 1);
  assert.equal(
    opened.body.report.fingerprints[0].reportLabel,
    "Report 1",
  );
  assert.equal(
    opened.body.report.fingerprints[0].features[0].baselineCenter,
    101.2,
  );
  assert.equal(
    opened.body.report.comparisons[0].claimedSubject,
    "Human A",
  );
  assert.equal(
    opened.body.report.comparisons[0].identitySimilarity.decision,
    "allow",
  );
  assert.doesNotMatch(
    JSON.stringify(opened.body),
    /test06|adminbypass|passwordHash|template_ciphertext/,
  );
  assert.equal(
    opened.response.headers.get("cache-control"),
    "no-store",
  );

  const strongTest = await client.request("/api/demo-admin/test", {
    method: "POST",
    body: {
      username: "human-a-demo",
      adminBypass: "adminbypass",
      profileId: "human-a-report",
      demoSubjectLabel: "Human A",
      samples: [
        { dwellMean: 100, flightMean: 75 },
        { dwellMean: 101, flightMean: 76 },
        { dwellMean: 102, flightMean: 74 },
      ].map((vector) => ({
        vector,
        diagnostics: verificationDiagnostics(),
        interactionEvidence: {
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
        },
      })),
    },
  });
  assert.equal(strongTest.response.status, 201);
  assert.match(strongTest.body.report.id, /^ODY-STRONG-\d+$/);
  assert.equal(strongTest.body.report.sampleCount, 3);
  assert.equal(
    strongTest.body.report.identitySimilarity.classification,
    "close_to_baseline",
  );
  assert.equal(
    strongTest.body.report.automationRisk.classification,
    "human_like_interaction",
  );
  assert.equal(
    strongTest.response.headers.get("cache-control"),
    "no-store",
  );

  const reopened = await client.request("/api/demo-admin/report", {
    method: "POST",
    body: {
      username: "human-a-demo",
      adminBypass: "adminbypass",
    },
  });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.body.report.strongTests.length, 1);
  assert.equal(
    reopened.body.report.strongTests[0].subjectLabel,
    "Human A",
  );
});

test("flags and blocks credential bursts before one hundred attempts", async (context) => {
  const { app, client } = await startTestServer(context, {
    rateLimits: {
      auth: {
        maximum: 100,
        windowMs: 60_000,
      },
      credentialAccount: {
        maximum: 100,
        windowMs: 60_000,
      },
      credentialBurst: {
        maximum: 5,
        windowMs: 60_000,
      },
    },
  });
  const registration = await bootstrapAndRegister(
    client,
    "credential-burst-user",
  );

  const attempts = [];
  for (let index = 0; index < 6; index += 1) {
    attempts.push(await client.request("/api/auth/login", {
      method: "POST",
      body: {
        username: "credential-burst-user",
        password: INVALID_FIXTURE,
      },
    }));
  }

  assert.equal(attempts[4].response.status, 401);
  assert.equal(attempts[5].response.status, 429);
  assert.equal(attempts[5].body.error.code, "RATE_LIMITED");

  await new Promise((resolve) => setImmediate(resolve));
  const audit = await app.locals.database.listAudit({
    userId: registration.body.user.id,
    limit: 100,
  });
  const flag = audit.find(
    (event) => event.eventType === "auth.automation_flag",
  );
  assert.equal(flag.reasonCode, "CREDENTIAL_BURST_AUTOMATION");
  assert.equal(flag.metadata.classification, "likely_automated");
  assert.equal(flag.metadata.requestCount, 6);
});
