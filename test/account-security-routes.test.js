"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  registerAccountSecurityRoutes,
} = require("../src/account-security-routes");

class TestHttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function marker(name) {
  const middleware = (request, response, next) => next();
  Object.defineProperty(middleware, "name", { value: name });
  return middleware;
}

function createRouteApp() {
  const routes = new Map();
  const app = { routes };
  for (const method of ["delete", "get", "post"]) {
    app[method] = (path, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
      return app;
    };
  }
  return app;
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    json(payload) {
      this.payload = payload;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
  };
}

function defaultDatabase() {
  return {
    async associateDeviceProfile() {},
    async cancelProfileTransfer() {
      return true;
    },
    async consumeProfileTransfer() {
      return null;
    },
    async consumeWebAuthnChallenge() {
      return null;
    },
    async countUnreadSecurityNotifications() {
      return 0;
    },
    async createProfileTransfer() {
      return null;
    },
    async createSecurityNotification(userId, notification) {
      return { id: 1, userId, ...notification };
    },
    async createWebAuthnChallenge() {
      return {
        challenge: "persisted-challenge-value",
        record: { id: 1 },
      };
    },
    async createWebAuthnCredential() {
      return null;
    },
    async deleteWebAuthnCredential() {
      return true;
    },
    async getDevice() {
      return null;
    },
    async getProfile() {
      return null;
    },
    async getUserById() {
      return null;
    },
    async getUserByUsername() {
      return null;
    },
    async getWebAuthnCredential() {
      return null;
    },
    async listDeviceProfileAssociations() {
      return [];
    },
    async listDevices() {
      return [];
    },
    async listProfileTransfers() {
      return [];
    },
    async listProfiles() {
      return [];
    },
    async listWebAuthnCredentials() {
      return [];
    },
    async registerDevice() {
      return null;
    },
    async revokeDevice() {
      return true;
    },
    async setProfile() {
      return null;
    },
    async updateWebAuthnCredentialUsage() {
      return null;
    },
  };
}

function createContext(overrides = {}) {
  const middleware = {
    authLimiter: marker("authLimiter"),
    requireAuthentication: marker("requireAuthentication"),
    requireCsrf: marker("requireCsrf"),
    requireRecentStrongAuthorization: marker(
      "requireRecentStrongAuthorization",
    ),
    sameOrigin: marker("sameOrigin"),
    verificationLimiter: marker("verificationLimiter"),
  };
  return {
    HttpError: TestHttpError,
    appendAudit: async () => {},
    clock: () => new Date("2026-07-25T15:00:00.000Z"),
    clearDeviceCookie: () => {},
    createAuthenticatedSession: async () => ({
      session: {
        id: 99,
        expiresAt: "2026-07-25T16:00:00.000Z",
        stepUpUntil: "2026-07-25T15:10:00.000Z",
      },
    }),
    database: defaultDatabase(),
    decodeWebAuthnClientData: () => ({
      challenge: "persisted-challenge-value",
      crossOrigin: false,
    }),
    evaluateDeviceConfidence: () => ({
      score: 50,
      state: "recognized",
    }),
    initializeCrossDeviceTransfer: (template, options) => ({
      ...template,
      transfer: {
        status: "restricted",
        requiresRecalibration: true,
        sourceDeviceId: options.sourceDeviceId,
        destinationDeviceId: options.destinationDeviceId,
      },
    }),
    normalizeUsername: (value) => value.trim().toLowerCase(),
    publicDevice: (device, currentDeviceId) => ({
      id: device.id,
      label: device.label,
      descriptor: device.descriptor,
      current: device.id === currentDeviceId,
    }),
    publicPasskey: (credential) => ({
      id: credential.id,
      credentialId: Buffer.from(credential.credentialId).toString(
        "base64url",
      ),
      counter: credential.counter,
    }),
    publicSession: (session) => ({
      expiresAt: session.expiresAt,
      stepUpUntil: session.stepUpUntil,
    }),
    publicUser: (user) => ({
      id: user.id,
      username: user.username,
    }),
    recalibrateCrossDeviceTemplate: (template) => ({
      ...template,
      transfer: {
        ...template.transfer,
        status: "active",
        requiresRecalibration: false,
      },
    }),
    requestOrigin: (request) => request.get("origin"),
    setDeviceCookie: () => {},
    templateAccessState: (template) => (
      template.transfer?.status === "restricted"
        ? {
            state: "restricted",
            allowSensitiveActions: false,
            stepUpRequired: true,
          }
        : {
            state: "active",
            allowSensitiveActions: true,
            stepUpRequired: false,
          }
    ),
    validateProfileId: (value) => {
      if (
        typeof value !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
      ) {
        throw new TestHttpError(400, "INVALID_PROFILE", "Invalid profile.");
      }
      return value;
    },
    webAuthnService: {
      rpId: "localhost",
      async createAuthenticationOptions(input) {
        return { challenge: input.challenge };
      },
      async createRegistrationOptions(input) {
        return { challenge: input.challenge };
      },
      async verifyAuthentication() {
        return {
          counter: 2,
          userVerified: true,
          backupState: false,
        };
      },
      async verifyRegistration() {
        return {
          credentialId: Buffer.from("credential"),
          publicKey: Buffer.from("public-key"),
          counter: 0,
          userVerified: true,
          backupEligible: false,
          backupState: false,
          transports: ["internal"],
          name: "Passkey",
        };
      },
    },
    ...middleware,
    ...overrides,
  };
}

function handler(app, method, path) {
  const handlers = app.routes.get(`${method} ${path}`);
  assert.ok(handlers, `Missing route ${method} ${path}`);
  return handlers.at(-1);
}

function authenticatedRequest(overrides = {}) {
  return {
    auth: {
      user: { id: 7, username: "odysseus-user" },
      session: {
        id: 12,
        behaviorVerifiedUntil: "2026-07-25T15:05:00.000Z",
      },
    },
    body: {},
    device: { id: 21 },
    get(name) {
      return name.toLowerCase() === "origin"
        ? "http://localhost:3000"
        : undefined;
    },
    params: {},
    query: {},
    ...overrides,
  };
}

test("registers only the narrowed device-security route inventory", () => {
  const app = createRouteApp();
  const context = createContext();
  registerAccountSecurityRoutes(app, context);

  assert.deepEqual([...app.routes.keys()].sort(), [
    "DELETE /api/auth/passkeys/:credentialId",
    "DELETE /api/devices/:deviceId",
    "DELETE /api/profile-transfers/:transferId",
    "GET /api/auth/passkeys",
    "GET /api/devices",
    "GET /api/profile-transfers",
    "GET /api/security/capabilities",
    "GET /api/security/summary",
    "GET /api/security/turnstile",
    "POST /api/auth/passkeys/login/options",
    "POST /api/auth/passkeys/login/verify",
    "POST /api/auth/passkeys/register/options",
    "POST /api/auth/passkeys/register/verify",
    "POST /api/devices",
    "POST /api/profile-transfers",
    "POST /api/profile-transfers/consume",
    "POST /api/profile-transfers/recalibrate",
  ]);
  assert.equal(app.routes.has("POST /api/auth/recovery/reset"), false);
  assert.equal(app.routes.has("DELETE /api/account"), false);
  assert.equal(app.routes.has("GET /api/admin/summary"), false);
  assert.equal(app.routes.has("POST /api/explanations"), false);

  const revoke = app.routes.get("DELETE /api/devices/:deviceId");
  assert.deepEqual(
    revoke.slice(0, -1).map((middleware) => middleware.name),
    [
      "sameOrigin",
      "verificationLimiter",
      "requireCsrf",
      "requireAuthentication",
      "requireRecentStrongAuthorization",
    ],
  );
  const deletePasskey = app.routes.get(
    "DELETE /api/auth/passkeys/:credentialId",
  );
  assert.equal(
    deletePasskey.at(-2).name,
    "requireRecentStrongAuthorization",
  );
});

test("does not retain dormant account lifecycle route bodies", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "account-security-routes.js"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /register(?:Recovery|Notification|Account|Admin|Explanation)Routes/,
  );
  assert.doesNotMatch(
    source,
    /sendRecoveryToken|exposeRecoveryTokens|recovery\.token/,
  );
  assert.doesNotMatch(
    source,
    /\/api\/(?:auth\/recovery|account(?:\/|")|admin|notifications|explanations)/,
  );
});

test("registers a coarse device while keeping its token and fingerprint private", async () => {
  let registrationInput;
  let cookie;
  const database = {
    ...defaultDatabase(),
    async registerDevice(userId, input) {
      assert.equal(userId, 7);
      registrationInput = input;
      return {
        token:
          "secret-device-token",
        device: {
          id: 31,
          label: input.label,
          descriptor: input.descriptor,
          fingerprintDigest: "private-digest",
          tokenExpiresAt:
            "2026-10-25T15:00:00.000Z",
        },
      };
    },
  };
  const context = createContext({
    database,
    setDeviceCookie(response, token, expiresAt) {
      cookie = { response, token, expiresAt };
    },
  });
  const app = createRouteApp();
  registerAccountSecurityRoutes(app, context);
  const response = createResponse();
  const request = authenticatedRequest({
    body: {
      label: "Work laptop",
      descriptor: {
        browserFamily: "chrome",
        deviceClass: "desktop",
      },
      clientFingerprint: "A".repeat(32),
    },
  });

  await handler(app, "POST", "/api/devices")(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(registrationInput.clientFingerprint, "A".repeat(32));
  assert.equal(cookie.token, "secret-device-token");
  assert.equal(response.payload.device.current, true);
  assert.equal(JSON.stringify(response.payload).includes("secret-device"), false);
  assert.equal(JSON.stringify(response.payload).includes("A".repeat(32)), false);
  assert.equal(JSON.stringify(response.payload).includes("private-digest"), false);
});

test("verifies and consumes registration challenges before storing credentials", async () => {
  const order = [];
  const challenge = "registration-challenge";
  const stored = {
    id: 44,
    credentialId: Buffer.from("credential"),
    counter: 0,
    userVerified: true,
    backupEligible: false,
    backupState: false,
  };
  const database = {
    ...defaultDatabase(),
    async consumeWebAuthnChallenge(value, expected) {
      order.push("consume");
      assert.equal(value, challenge);
      assert.deepEqual(expected, {
        ceremony: "registration",
        rpId: "localhost",
        origin: "http://localhost:3000",
      });
      return { userId: 7 };
    },
    async createWebAuthnCredential(userId, verified) {
      order.push("store");
      assert.equal(userId, 7);
      assert.equal(verified.userVerified, true);
      return stored;
    },
  };
  const context = createContext({
    database,
    decodeWebAuthnClientData: (credential, expectedType) => {
      assert.equal(credential.id, "credential");
      assert.equal(expectedType, "webauthn.create");
      return { challenge, crossOrigin: false };
    },
    webAuthnService: {
      ...createContext().webAuthnService,
      async verifyRegistration(input) {
        order.push("verify");
        assert.equal(input.expectedChallenge, challenge);
        return {
          credentialId: Buffer.from("credential"),
          publicKey: Buffer.from("public-key"),
          counter: 0,
          userVerified: true,
          backupEligible: false,
          backupState: false,
          transports: ["internal"],
          name: "Passkey",
        };
      },
    },
  });
  const app = createRouteApp();
  registerAccountSecurityRoutes(app, context);
  const response = createResponse();
  const request = authenticatedRequest({
    body: { credential: { id: "credential" } },
  });

  await handler(
    app,
    "POST",
    "/api/auth/passkeys/register/verify",
  )(request, response);

  assert.deepEqual(order, ["verify", "consume", "store"]);
  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.credential.id, 44);
});

test("updates a verified passkey counter before issuing a strong session", async () => {
  const order = [];
  const challenge = "authentication-challenge";
  const stored = {
    id: 51,
    userId: 9,
    credentialId: Buffer.from("credential-id"),
    publicKey: Buffer.from("public-key"),
    counter: 1,
    userVerified: true,
    backupEligible: false,
    backupState: false,
  };
  const user = { id: 9, username: "passkey-user" };
  const database = {
    ...defaultDatabase(),
    async getWebAuthnCredential(id) {
      assert.equal(id, "credential-id");
      return stored;
    },
    async consumeWebAuthnChallenge() {
      order.push("consume");
      return { userId: 9 };
    },
    async getUserById(userId) {
      assert.equal(userId, 9);
      return user;
    },
    async updateWebAuthnCredentialUsage(id, result) {
      order.push("counter");
      assert.equal(id, stored.credentialId);
      assert.equal(result.counter, 2);
      return { ...stored, counter: 2 };
    },
  };
  const context = createContext({
    database,
    createAuthenticatedSession: async (sessionUser, response, options) => {
      order.push("session");
      assert.equal(sessionUser, user);
      assert.deepEqual(options, { strongAuthentication: true });
      return {
        session: {
          id: 88,
          expiresAt: "2026-07-25T16:00:00.000Z",
          stepUpUntil: "2026-07-25T15:10:00.000Z",
        },
      };
    },
    decodeWebAuthnClientData: () => ({
      challenge,
      crossOrigin: false,
    }),
    webAuthnService: {
      ...createContext().webAuthnService,
      async verifyAuthentication(input) {
        order.push("verify");
        assert.equal(input.expectedChallenge, challenge);
        assert.equal(input.credential, stored);
        return {
          counter: 2,
          userVerified: true,
          backupState: false,
        };
      },
    },
  });
  const app = createRouteApp();
  registerAccountSecurityRoutes(app, context);
  const response = createResponse();
  const request = authenticatedRequest({
    auth: null,
    device: null,
    body: { credential: { id: "credential-id" } },
  });

  await handler(
    app,
    "POST",
    "/api/auth/passkeys/login/verify",
  )(request, response);

  assert.deepEqual(order, ["verify", "consume", "counter", "session"]);
  assert.equal(response.payload.user.username, "passkey-user");
  assert.equal(response.payload.session.stepUpUntil.includes("15:10"), true);
});

test("creates a distinct restricted destination profile on transfer consumption", async () => {
  const calls = [];
  const sourceTemplate = {
    version: 1,
    sampleCount: 5,
    marker: "source-template",
  };
  const database = {
    ...defaultDatabase(),
    async getProfile(userId, profileId) {
      assert.equal(userId, 7);
      calls.push(`get:${profileId}`);
      if (profileId === "source") {
        return {
          profileId,
          sampleCount: 5,
          template: sourceTemplate,
        };
      }
      return null;
    },
    async consumeProfileTransfer(token, targetDeviceId) {
      calls.push("consume");
      assert.equal(token, "T".repeat(32));
      assert.equal(targetDeviceId, 21);
      return {
        id: 61,
        userId: 7,
        profileId: "source",
        sourceDeviceId: 20,
        targetDeviceId: 21,
        state: "completed",
      };
    },
    async setProfile(userId, profileId, template) {
      calls.push(`set:${profileId}`);
      assert.equal(template.marker, "source-template");
      assert.equal(template.transfer.status, "restricted");
      return { profileId, sampleCount: 5 };
    },
    async associateDeviceProfile(userId, deviceId, profileId, options) {
      calls.push(`associate:${profileId}`);
      assert.equal(userId, 7);
      assert.equal(deviceId, 21);
      assert.equal(profileId, "destination");
      assert.deepEqual(options, {
        relationship: "transferred",
        sourceDeviceId: 20,
      });
    },
  };
  const context = createContext({ database });
  const app = createRouteApp();
  registerAccountSecurityRoutes(app, context);
  const response = createResponse();
  const request = authenticatedRequest({
    body: {
      token: "T".repeat(32),
      sourceProfileId: "source",
      destinationProfileId: "destination",
      targetDeviceId: 21,
      requiredSamples: 5,
    },
  });

  await handler(
    app,
    "POST",
    "/api/profile-transfers/consume",
  )(request, response);

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.accessState.state, "restricted");
  assert.equal(
    response.payload.accessState.allowSensitiveActions,
    false,
  );
  assert.deepEqual(calls, [
    "get:destination",
    "consume",
    "get:source",
    "set:destination",
    "associate:destination",
  ]);
  assert.equal(calls.includes("set:source"), false);
});

test("reports capability state without granting AI authorization", async () => {
  const context = createContext({
    geminiProvider: {
      readiness: () => ({ ready: true }),
    },
    huggingFaceProvider: {
      readiness: () => ({ ready: false, reason: "unchecked" }),
    },
    proofHuman: {
      readiness: () => ({ disabled: true, ready: false }),
    },
  });
  const app = createRouteApp();
  registerAccountSecurityRoutes(app, context);
  const response = createResponse();

  await handler(
    app,
    "GET",
    "/api/security/capabilities",
  )(authenticatedRequest(), response);

  assert.equal(response.payload.passkeys.ready, true);
  assert.equal(response.payload.providers.turnstile.disabled, true);
  assert.equal(response.payload.providers.gemini.ready, true);
  assert.deepEqual(response.payload.authorizationPolicy, {
    aiAuthoritative: false,
    providerOutputsMayGrantAccess: false,
  });
});
