"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GENERIC_RECOVERY_MESSAGE,
  registerAccountManagementRoutes,
} = require("../src/account-management-routes");

class TestHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class FakeApp {
  constructor() {
    this.routes = new Map();
  }

  register(method, route, handlers) {
    this.routes.set(`${method} ${route}`, handlers);
  }

  get(route, ...handlers) {
    this.register("GET", route, handlers);
  }

  post(route, ...handlers) {
    this.register("POST", route, handlers);
  }

  delete(route, ...handlers) {
    this.register("DELETE", route, handlers);
  }

  handlers(method, route) {
    const handlers = this.routes.get(`${method} ${route}`);
    assert.ok(handlers, `${method} ${route} was not registered`);
    return handlers;
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function middleware(_request, _response, next) {
  if (typeof next === "function") next();
}

function makeContext(overrides = {}) {
  const calls = {
    audits: [],
    deliveries: [],
    deletedCookies: [],
  };
  const database = {
    async completePasswordReset() {
      return null;
    },
    async consumeRecoveryCode() {
      return false;
    },
    async countUnreadSecurityNotifications() {
      return 0;
    },
    async createRecoveryRequest(userId) {
      return {
        token:
          "one-time-token-with-enough-characters",
        request: {
          userId,
          purpose: "password_reset",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      };
    },
    async deleteAccount(userId) {
      return {
        deleted: true,
        userId,
        deletedRecords: { sessions: 1 },
      };
    },
    async dismissSecurityNotification() {
      return true;
    },
    async getAdminOverview() {
      return {
        users: { total: 4 },
        sessions: { active: 2 },
        securityNotifications: { unread: 1 },
      };
    },
    async getAdminSecurityEventAggregates() {
      return [];
    },
    async getUserByUsername() {
      return null;
    },
    async listSecurityNotifications() {
      return [];
    },
    async markSecurityNotificationRead() {
      return true;
    },
    async replaceRecoveryCodes(_userId, options) {
      return {
        codes: ["AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111"],
        count: options.count,
        createdAt: "2026-07-25T00:00:00.000Z",
        expiresAt: null,
      };
    },
    async revokeRecoveryRequests() {
      return 1;
    },
    ...(overrides.database || {}),
  };
  const context = {
    HttpError: TestHttpError,
    appendAudit: async (event) => {
      calls.audits.push(event);
      return event;
    },
    authLimiter: middleware,
    clearAuthenticationCookies: () => {
      calls.deletedCookies.push("authentication");
    },
    clearDeviceCookie: () => {
      calls.deletedCookies.push("device");
    },
    database,
    hashPassword: async (password) => `hash:${password}`,
    isAdministrator: (user) => user?.isAdmin === true,
    normalizeUsername: (username) => {
      if (typeof username !== "string" || username.trim().length < 3) {
        throw new Error("invalid username");
      }
      return username.trim().toLowerCase();
    },
    notificationService: {
      async deliver(input) {
        calls.deliveries.push(input);
        return { delivered: true };
      },
    },
    requireAuthentication: middleware,
    requireCsrf: middleware,
    requireRecentStrongAuthorization: middleware,
    sameOrigin: middleware,
    validatePassword: (password) => {
      if (typeof password !== "string" || password.length < 6) {
        throw new TestHttpError(
          400,
          "INVALID_PASSWORD",
          "Password is invalid.",
        );
      }
      return password;
    },
    verificationLimiter: middleware,
    ...overrides,
    database,
  };
  if (overrides.notificationService) {
    context.notificationService = overrides.notificationService;
  }
  return { calls, context };
}

function finalHandler(app, method, route) {
  return app.handlers(method, route).at(-1);
}

test("registers the precise frontend and management endpoints", () => {
  const app = new FakeApp();
  const { context } = makeContext();

  assert.equal(registerAccountManagementRoutes(app, context), app);
  assert.deepEqual(
    [...app.routes.keys()].sort(),
    [
      "DELETE /api/account",
      "DELETE /api/notifications/:notificationId",
      "GET /api/admin/security-events",
      "GET /api/admin/summary",
      "GET /api/notifications",
      "POST /api/account/recovery-codes",
      "POST /api/auth/recovery/reset",
      "POST /api/auth/recovery/start",
      "POST /api/explanations",
      "POST /api/notifications/:notificationId/read",
    ],
  );
});

test("requires a complete injected security contract", () => {
  assert.throws(
    () => registerAccountManagementRoutes(new FakeApp(), {}),
    /context\.database/,
  );
  const { context } = makeContext();
  delete context.requireCsrf;
  assert.throws(
    () => registerAccountManagementRoutes(new FakeApp(), context),
    /context\.requireCsrf/,
  );
});

test("rotates recovery codes without copying codes into audit or notices", async () => {
  const app = new FakeApp();
  const { calls, context } = makeContext();
  registerAccountManagementRoutes(app, context);
  const handlers = app.handlers(
    "POST",
    "/api/account/recovery-codes",
  );

  assert.deepEqual(
    handlers.slice(0, -1),
    [
      context.sameOrigin,
      context.authLimiter,
      context.requireCsrf,
      context.requireAuthentication,
      context.requireRecentStrongAuthorization,
    ],
  );
  const response = responseRecorder();
  await handlers.at(-1)(
    {
      auth: {
        user: { id: 7, username: "odysseus_test" },
        session: { id: 12 },
      },
      body: { rotate: true, count: 4 },
    },
    response,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.codes.length, 1);
  assert.equal(calls.audits[0].metadata.count, 4);
  assert.doesNotMatch(
    JSON.stringify(calls.audits),
    /AAAA-BBBB/,
  );
  assert.doesNotMatch(
    JSON.stringify(calls.deliveries),
    /AAAA-BBBB/,
  );
});

test("returns the same generic recovery-start response without exposing tokens", async () => {
  const app = new FakeApp();
  const { calls, context } = makeContext({
    database: {
      async getUserByUsername(username) {
        return username === "known_user"
          ? { id: 4, username, disabledAt: null }
          : null;
      },
    },
    resolveRecoveryRecipient: async () => ({
      email: "test@example.com",
    }),
  });
  registerAccountManagementRoutes(app, context);
  const handler = finalHandler(
    app,
    "POST",
    "/api/auth/recovery/start",
  );
  const knownResponse = responseRecorder();
  const unknownResponse = responseRecorder();

  await handler(
    {
      body: { username: "known_user" },
      ip: "127.0.0.1",
    },
    knownResponse,
  );
  await handler(
    {
      body: { username: "unknown_user" },
      ip: "127.0.0.1",
    },
    unknownResponse,
  );

  assert.deepEqual(knownResponse.payload, unknownResponse.payload);
  assert.deepEqual(knownResponse.payload, {
    accepted: true,
    message: GENERIC_RECOVERY_MESSAGE,
  });
  assert.doesNotMatch(
    JSON.stringify(knownResponse.payload),
    /one-time-token/,
  );
  assert.deepEqual(calls.deliveries[0].channels, ["email"]);
  assert.match(
    calls.deliveries[0].notification.body,
    /one-time-token/,
  );
  assert.doesNotMatch(
    JSON.stringify(calls.audits),
    /known_user|unknown_user|one-time-token/,
  );
});

test("revokes an undeliverable recovery request and stays generic", async () => {
  const revoked = [];
  const app = new FakeApp();
  const { calls, context } = makeContext({
    database: {
      async getUserByUsername() {
        return {
          id: 4,
          username: "known_user",
          disabledAt: null,
        };
      },
      async revokeRecoveryRequests(userId, purpose) {
        revoked.push([userId, purpose]);
        return 1;
      },
    },
  });
  registerAccountManagementRoutes(app, context);
  const response = responseRecorder();

  await finalHandler(
    app,
    "POST",
    "/api/auth/recovery/start",
  )(
    {
      body: { username: "known_user" },
      ip: "127.0.0.1",
    },
    response,
  );

  assert.deepEqual(response.payload, {
    accepted: true,
    message: GENERIC_RECOVERY_MESSAGE,
  });
  assert.deepEqual(revoked, [[4, "password_reset"]]);
  assert.deepEqual(calls.deliveries, []);
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /one-time-token/,
  );
  assert.doesNotMatch(
    JSON.stringify(calls.audits),
    /one-time-token/,
  );
});

test("verifies configured human proof before recovery lookup", async () => {
  const events = [];
  const proofHuman = {
    async readiness() {
      return { ready: true, disabled: false };
    },
    async verify(input) {
      events.push(["proof", input]);
      return { available: true, valid: true };
    },
  };
  const { context } = makeContext({
    proofHuman,
    database: {
      async getUserByUsername() {
        events.push(["lookup"]);
        return null;
      },
    },
  });
  const app = new FakeApp();
  registerAccountManagementRoutes(app, context);

  await finalHandler(app, "POST", "/api/auth/recovery/start")(
    {
      body: {
        username: "unknown_user",
        turnstileToken: "verified-token",
      },
      ip: "127.0.0.1",
    },
    responseRecorder(),
  );

  assert.equal(events[0][0], "proof");
  assert.equal(events[1][0], "lookup");
  assert.equal(events[0][1].token, "verified-token");
});

test("resets a password with a consumed recovery code and revokes sessions", async () => {
  const resetCalls = [];
  const { calls, context } = makeContext({
    database: {
      async getUserByUsername(username) {
        return { id: 8, username, disabledAt: null };
      },
      async consumeRecoveryCode(userId, code) {
        resetCalls.push(["code", userId, code]);
        return true;
      },
      async createRecoveryRequest(userId) {
        resetCalls.push(["request", userId]);
        return {
          token:
            "internal-reset-token-long-enough",
          request: {
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        };
      },
      async completePasswordReset(token, passwordHash) {
        resetCalls.push(["reset", token, passwordHash]);
        return { id: 8, username: "odysseus_test" };
      },
    },
  });
  const app = new FakeApp();
  registerAccountManagementRoutes(app, context);
  const response = responseRecorder();

  await finalHandler(app, "POST", "/api/auth/recovery/reset")(
    {
      body: {
        username: "odysseus_test",
        code: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111",
        newPassword: "abc123",
      },
    },
    response,
  );

  assert.equal(response.payload.reset, true);
  assert.deepEqual(resetCalls, [
    [
      "code",
      8,
      "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111",
    ],
    ["request", 8],
    [
      "reset",
      "internal-reset-token-long-enough",
      "hash:abc123",
    ],
  ]);
  assert.doesNotMatch(
    JSON.stringify(calls.audits),
    /abc123|AAAA-BBBB|internal-reset-token/,
  );
  assert.doesNotMatch(
    JSON.stringify(calls.deliveries),
    /abc123|AAAA-BBBB|internal-reset-token/,
  );
});

test("accepts a one-time reset token once without requiring a username", async () => {
  const received = [];
  const { context } = makeContext({
    database: {
      async completePasswordReset(token, passwordHash) {
        received.push({ token, passwordHash });
        return { id: 3, username: "token_user" };
      },
    },
  });
  const app = new FakeApp();
  registerAccountManagementRoutes(app, context);
  const response = responseRecorder();

  await finalHandler(app, "POST", "/api/auth/recovery/reset")(
    {
      body: {
        token:
          "one-time-reset-token-long-enough",
        newPassword: "abc123",
      },
    },
    response,
  );

  assert.equal(response.payload.reset, true);
  assert.deepEqual(received, [{
    token:
      "one-time-reset-token-long-enough",
    passwordHash: "hash:abc123",
  }]);
});

test("lists safe notifications and supports read and dismiss actions", async () => {
  const actions = [];
  const { context } = makeContext({
    database: {
      async listSecurityNotifications() {
        return [{
          id: 17,
          userId: 9,
          type: "session_event",
          severity: "warning",
          title: "Session changed",
          body: "A session setting changed",
          metadata: { internal: "not public" },
          createdAt: "2026-07-25T00:00:00.000Z",
          readAt: null,
        }];
      },
      async countUnreadSecurityNotifications() {
        return 1;
      },
      async markSecurityNotificationRead(userId, id, read) {
        actions.push(["read", userId, id, read]);
        return true;
      },
      async dismissSecurityNotification(userId, id) {
        actions.push(["dismiss", userId, id]);
        return true;
      },
    },
  });
  const app = new FakeApp();
  registerAccountManagementRoutes(app, context);
  const request = {
    auth: { user: { id: 9 }, session: { id: 5 } },
    query: {},
  };
  const listResponse = responseRecorder();

  await finalHandler(app, "GET", "/api/notifications")(
    request,
    listResponse,
  );
  assert.equal(listResponse.payload.unread, 1);
  assert.deepEqual(listResponse.payload.notifications[0], {
    id: 17,
    type: "session_event",
    severity: "warning",
    title: "Session changed",
    message: "A session setting changed",
    createdAt: "2026-07-25T00:00:00.000Z",
    read: false,
    readAt: null,
  });
  assert.equal(
    Object.hasOwn(listResponse.payload.notifications[0], "metadata"),
    false,
  );

  await finalHandler(
    app,
    "POST",
    "/api/notifications/:notificationId/read",
  )(
    {
      ...request,
      body: {},
      params: { notificationId: "17" },
    },
    responseRecorder(),
  );
  await finalHandler(
    app,
    "DELETE",
    "/api/notifications/:notificationId",
  )(
    {
      ...request,
      params: { notificationId: "17" },
    },
    responseRecorder(),
  );
  assert.deepEqual(actions, [
    ["read", 9, 17, true],
    ["dismiss", 9, 17],
  ]);
});

test("requires exact confirmation and strong middleware before deletion", async () => {
  const app = new FakeApp();
  const { calls, context } = makeContext();
  registerAccountManagementRoutes(app, context);
  const handlers = app.handlers("DELETE", "/api/account");

  assert.deepEqual(
    handlers.slice(0, -1),
    [
      context.sameOrigin,
      context.authLimiter,
      context.requireCsrf,
      context.requireAuthentication,
      context.requireRecentStrongAuthorization,
    ],
  );
  const request = {
    auth: {
      user: { id: 5, username: "delete_test" },
      session: { id: 6 },
    },
    body: {
      confirmation: "wrong_user",
      deleteAccount: true,
    },
  };
  await assert.rejects(
    handlers.at(-1)(request, responseRecorder()),
    (error) => (
      error.status === 400
      && error.code === "ACCOUNT_DELETION_CONFIRMATION_REQUIRED"
    ),
  );

  request.body.confirmation = "delete_test";
  const response = responseRecorder();
  await handlers.at(-1)(request, response);
  assert.equal(response.payload.deleted, true);
  assert.deepEqual(calls.deletedCookies, [
    "authentication",
    "device",
  ]);
  assert.equal(calls.audits.at(-1).eventType, "account.delete");
});

test("blocks non-administrators and returns aggregates to administrators", async () => {
  const { calls, context } = makeContext({
    database: {
      async getAdminOverview(options) {
        assert.equal(
          options.since,
          "2026-07-01T00:00:00.000Z",
        );
        return {
          users: { total: 12 },
          sessions: { active: 3 },
          securityNotifications: { unread: 2 },
        };
      },
      async getAdminSecurityEventAggregates() {
        return [{
          day: "2026-07-25",
          eventType: "auth.login",
          outcome: "success",
          count: 4,
        }];
      },
    },
  });
  const app = new FakeApp();
  registerAccountManagementRoutes(app, context);
  const handlers = app.handlers("GET", "/api/admin/summary");
  let denied;

  handlers[1](
    { auth: { user: { isAdmin: false } } },
    responseRecorder(),
    (error) => {
      denied = error;
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "ADMINISTRATOR_REQUIRED");

  const response = responseRecorder();
  await handlers.at(-1)(
    {
      auth: {
        user: { id: 1, isAdmin: true },
        session: { id: 2 },
      },
      query: { since: "2026-07-01" },
    },
    response,
  );
  assert.equal(response.payload.isAdmin, true);
  assert.equal(response.payload.users, 12);
  assert.equal(response.payload.sessions, 3);
  assert.equal(response.payload.alerts, 2);
  assert.equal(response.payload.eventAggregates[0].count, 4);
  assert.equal(calls.audits.at(-1).eventType, "admin.summary.view");
});

test("returns a deliberate provider-disabled response without accepting raw data", async () => {
  const app = new FakeApp();
  const { calls, context } = makeContext();
  registerAccountManagementRoutes(app, context);
  const handler = finalHandler(app, "POST", "/api/explanations");
  const request = {
    auth: {
      user: { id: 2 },
      session: { id: 3 },
    },
    body: {
      profileId: "profile_test",
      trustScore: 72,
      context: "account_security_summary",
    },
  };

  await assert.rejects(
    handler(request),
    (error) => (
      error.status === 501
      && error.code === "GEMINI_DISABLED"
    ),
  );
  assert.equal(calls.audits[0].reasonCode, "GEMINI_DISABLED");
  assert.doesNotMatch(
    JSON.stringify(calls.audits),
    /profile_test|72/,
  );

  request.body.rawSignals = [1, 2, 3];
  await assert.rejects(
    handler(request),
    (error) => (
      error.status === 400
      && error.code === "UNEXPECTED_REQUEST_FIELDS"
    ),
  );
});
