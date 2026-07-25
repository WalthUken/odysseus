"use strict";

const GENERIC_RECOVERY_MESSAGE =
  "If the account is eligible, recovery instructions are available.";
const RECOVERY_CODE_COUNT_MIN = 4;
const RECOVERY_CODE_COUNT_MAX = 20;
const MAX_NOTIFICATION_LIMIT = 200;
const MAX_ADMIN_EVENT_LIMIT = 500;

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(
      `account management routes require context.${name}.`,
    );
  }
  return value;
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `account management routes require context.${name}.`,
    );
  }
  return value;
}

function validateContext(context) {
  assertObject(context?.database, "database");
  const middlewareAndHelpers = [
    "HttpError",
    "appendAudit",
    "authLimiter",
    "clearAuthenticationCookies",
    "clearDeviceCookie",
    "hashPassword",
    "isAdministrator",
    "normalizeUsername",
    "requireAuthentication",
    "requireCsrf",
    "requireRecentStrongAuthorization",
    "sameOrigin",
    "validatePassword",
    "verificationLimiter",
  ];
  for (const name of middlewareAndHelpers) {
    assertFunction(context[name], name);
  }

  const databaseMethods = [
    "completePasswordReset",
    "consumeRecoveryCode",
    "countUnreadSecurityNotifications",
    "createRecoveryRequest",
    "deleteAccount",
    "dismissSecurityNotification",
    "getAdminOverview",
    "getAdminSecurityEventAggregates",
    "getUserByUsername",
    "listSecurityNotifications",
    "markSecurityNotificationRead",
    "replaceRecoveryCodes",
    "revokeRecoveryRequests",
  ];
  for (const name of databaseMethods) {
    assertFunction(context.database[name], `database.${name}`);
  }

  assertObject(context.notificationService, "notificationService");
  assertFunction(
    context.notificationService.deliver,
    "notificationService.deliver",
  );
  if (context.proofHuman !== undefined && context.proofHuman !== null) {
    assertObject(context.proofHuman, "proofHuman");
    assertFunction(context.proofHuman.verify, "proofHuman.verify");
  }
  if (
    context.resolveRecoveryRecipient !== undefined
    && context.resolveRecoveryRecipient !== null
  ) {
    assertFunction(
      context.resolveRecoveryRecipient,
      "resolveRecoveryRecipient",
    );
  }
  if (
    context.observedIp !== undefined
    && context.observedIp !== null
  ) {
    assertFunction(context.observedIp, "observedIp");
  }
  if (
    context.humanProofRequired !== undefined
    && typeof context.humanProofRequired !== "boolean"
  ) {
    throw new TypeError("context.humanProofRequired must be a boolean.");
  }
  return context;
}

function requireBody(request, context) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new context.HttpError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body must be a JSON object.",
    );
  }
  return body;
}

function allowOnly(body, allowed, context) {
  const extras = Object.keys(body).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new context.HttpError(
      400,
      "UNEXPECTED_REQUEST_FIELDS",
      "Request body contains unsupported fields.",
    );
  }
}

function positiveInteger(value, name, maximum, context) {
  const parsed = (
    typeof value === "string" && /^[1-9]\d*$/.test(value)
  )
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || (maximum !== undefined && parsed > maximum)
  ) {
    throw new context.HttpError(
      400,
      "INVALID_INPUT",
      `${name} must be a positive integer${
        maximum === undefined ? "" : ` no greater than ${maximum}`
      }.`,
    );
  }
  return parsed;
}

function optionalLimit(value, defaultValue, maximum, context) {
  return value === undefined
    ? defaultValue
    : positiveInteger(value, "limit", maximum, context);
}

function boundedString(value, name, context, options = {}) {
  if (typeof value !== "string") {
    throw new context.HttpError(
      400,
      "INVALID_INPUT",
      `${name} must be a string.`,
    );
  }
  const normalized = options.trim === false ? value : value.trim();
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? 256;
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || (options.pattern && !options.pattern.test(normalized))
  ) {
    throw new context.HttpError(
      400,
      "INVALID_INPUT",
      `${name} is invalid.`,
    );
  }
  return normalized;
}

function audit(context, request, event) {
  return context.appendAudit(event, request);
}

function remoteIp(request, context) {
  const raw = context.observedIp
    ? context.observedIp(request)
    : request.ip || request.socket?.remoteAddress || "";
  const value = String(raw || "");
  return value.startsWith("::ffff:")
    ? value.slice(7, 71)
    : value.slice(0, 64);
}

async function checkHumanProof(body, request, context) {
  const provider = context.proofHuman;
  if (!provider) {
    if (context.humanProofRequired === true) {
      throw new context.HttpError(
        503,
        "HUMAN_PROOF_UNAVAILABLE",
        "Human verification is not configured.",
      );
    }
    return "disabled";
  }

  let readiness = {};
  if (typeof provider.readiness === "function") {
    try {
      readiness = await provider.readiness();
    } catch {
      throw new context.HttpError(
        503,
        "HUMAN_PROOF_UNAVAILABLE",
        "Human verification is temporarily unavailable.",
      );
    }
  }
  if (readiness && readiness.disabled === true) {
    if (context.humanProofRequired === true) {
      throw new context.HttpError(
        503,
        "HUMAN_PROOF_UNAVAILABLE",
        "Human verification is not configured.",
      );
    }
    return "disabled";
  }

  const token = boundedString(
    body.turnstileToken,
    "turnstileToken",
    context,
    { maximum: 2_048 },
  );
  let result;
  try {
    result = await provider.verify({
      token,
      remoteIp: remoteIp(request, context) || undefined,
    });
  } catch {
    throw new context.HttpError(
      503,
      "HUMAN_PROOF_UNAVAILABLE",
      "Human verification is temporarily unavailable.",
    );
  }
  if (!result || result.available !== true) {
    throw new context.HttpError(
      503,
      "HUMAN_PROOF_UNAVAILABLE",
      "Human verification is temporarily unavailable.",
    );
  }
  if (result.valid !== true) {
    throw new context.HttpError(
      403,
      result.code || "HUMAN_PROOF_REJECTED",
      "Human verification was not accepted.",
    );
  }
  return "passed";
}

async function findEligibleUser(username, context) {
  try {
    const normalized = context.normalizeUsername(username);
    const user = await context.database.getUserByUsername(normalized);
    return user && !user.disabledAt ? user : null;
  } catch {
    return null;
  }
}

async function notifySecurityEvent(context, userId, notification) {
  try {
    const result = await context.notificationService.deliver({
      recipient: { userId },
      notification,
      channels: ["in_app"],
    });
    return Boolean(result?.delivered || result?.fullyDelivered);
  } catch {
    return false;
  }
}

async function recoveryRecipient(user, context) {
  if (!context.resolveRecoveryRecipient) {
    return { userId: user.id };
  }
  try {
    const resolved = await context.resolveRecoveryRecipient(user);
    if (!resolved || typeof resolved !== "object") {
      return { userId: user.id };
    }
    return {
      userId: user.id,
      ...(
        typeof resolved.email === "string" && resolved.email.trim()
          ? { email: resolved.email.trim() }
          : {}
      ),
    };
  } catch {
    return { userId: user.id };
  }
}

async function deliverRecoveryToken(context, user, recovery) {
  const recipient = await recoveryRecipient(user, context);
  if (!recipient.email) {
    return false;
  }
  try {
    const result = await context.notificationService.deliver({
      recipient,
      notification: {
        type: "recovery_event",
        severity: "critical",
        title: "Odysseus password recovery",
        body: `Use this one-time Odysseus password recovery token:
          ${recovery.token}`,
        metadata: {
          purpose: "password_reset",
          expiresAt: recovery.request.expiresAt,
        },
      },
      channels: ["email"],
    });
    return Boolean(result?.delivered || result?.fullyDelivered);
  } catch {
    return false;
  }
}

function publicNotification(notification) {
  return {
    id: notification.id,
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    message: notification.body,
    createdAt: notification.createdAt,
    read: Boolean(notification.readAt),
    readAt: notification.readAt ?? null,
  };
}

function adminOptions(query, context, options = {}) {
  const result = {};
  if (query.since !== undefined) {
    const since = boundedString(query.since, "since", context, {
      maximum: 100,
    });
    const parsed = new Date(since);
    if (!Number.isFinite(parsed.getTime())) {
      throw new context.HttpError(
        400,
        "INVALID_INPUT",
        "since must be a valid timestamp.",
      );
    }
    result.since = parsed.toISOString();
  }
  if (options.includeLimit && query.limit !== undefined) {
    result.limit = positiveInteger(
      query.limit,
      "limit",
      MAX_ADMIN_EVENT_LIMIT,
      context,
    );
  }
  return result;
}

function administratorOnly(context) {
  return function requireAdministrator(request, response, next) {
    if (!context.isAdministrator(request.auth?.user)) {
      next(
        new context.HttpError(
          403,
          "ADMINISTRATOR_REQUIRED",
          "Administrator access is required.",
        ),
      );
      return;
    }
    next();
  };
}

function registerRecoveryRoutes(app, context) {
  app.post(
    "/api/account/recovery-codes",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requireBody(request, context);
      allowOnly(body, new Set(["rotate", "count"]), context);
      if (body.rotate !== true) {
        throw new context.HttpError(
          400,
          "RECOVERY_CODE_ROTATION_CONFIRMATION_REQUIRED",
          "Set rotate to true to replace existing recovery codes.",
        );
      }
      const count = body.count === undefined
        ? 10
        : positiveInteger(
          body.count,
          "count",
          RECOVERY_CODE_COUNT_MAX,
          context,
        );
      if (count < RECOVERY_CODE_COUNT_MIN) {
        throw new context.HttpError(
          400,
          "INVALID_INPUT",
          `count must be at least ${RECOVERY_CODE_COUNT_MIN}.`,
        );
      }
      const result = await context.database.replaceRecoveryCodes(
        request.auth.user.id,
        { count },
      );
      await audit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "recovery_codes.rotate",
        metadata: { count: result.count },
      });
      await notifySecurityEvent(
        context,
        request.auth.user.id,
        {
          type: "recovery_event",
          severity: "warning",
          title: "Recovery codes replaced",
          body: "New one-time account recovery codes were generated.",
          metadata: { count: result.count },
        },
      );
      response.status(201).json({
        codes: result.codes,
        count: result.count,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
      });
    },
  );

  app.post(
    "/api/auth/recovery/start",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    async (request, response) => {
      const body = requireBody(request, context);
      allowOnly(body, new Set(["username", "turnstileToken"]), context);
      const humanProof = await checkHumanProof(
        body,
        request,
        context,
      );
      const user = await findEligibleUser(body.username, context);
      if (user) {
        const recovery = await context.database.createRecoveryRequest(
          user.id,
          {
            purpose: "password_reset",
            context: {
              channel: "account_recovery",
              humanProof,
            },
          },
        );
        const delivered = await deliverRecoveryToken(
          context,
          user,
          recovery,
        );
        if (!delivered) {
          await context.database.revokeRecoveryRequests(
            user.id,
            "password_reset",
          );
        }
        await audit(context, request, {
          userId: user.id,
          eventType: "recovery.start",
          metadata: { delivered, humanProof },
        });
      } else {
        await audit(context, request, {
          eventType: "recovery.start",
          outcome: "accepted",
          reasonCode: "GENERIC_RESPONSE",
          metadata: { humanProof },
        });
      }
      response.json({
        accepted: true,
        message: GENERIC_RECOVERY_MESSAGE,
      });
    },
  );

  app.post(
    "/api/auth/recovery/reset",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    async (request, response) => {
      const body = requireBody(request, context);
      allowOnly(
        body,
        new Set([
          "username",
          "code",
          "token",
          "newPassword",
          "turnstileToken",
        ]),
        context,
      );
      const humanProof = await checkHumanProof(
        body,
        request,
        context,
      );
      const password =
        context.validatePassword(body.newPassword);
      const passwordHash = await context.hashPassword(password);
      const hasToken = (
        typeof body.token === "string" && body.token.trim().length > 0
      );
      const hasCodeInput = (
        body.username !== undefined || body.code !== undefined
      );
      if (hasToken && hasCodeInput) {
        throw new context.HttpError(
          400,
          "AMBIGUOUS_RECOVERY_CREDENTIAL",
          "Supply either a one-time token or a username and recovery code.",
        );
      }

      let user = null;
      let method = null;
      if (hasToken) {
        const token =
          boundedString(body.token, "token", context, {
          maximum: 512,
        });
        user = await context.database.completePasswordReset(
          token,
          passwordHash,
        );
        method = "token";
      } else {
        const candidate = await findEligibleUser(body.username, context);
        const codeAccepted = candidate
          ? await context.database.consumeRecoveryCode(
            candidate.id,
            body.code,
          )
          : false;
        if (candidate && codeAccepted) {
          const oneTime = await context.database.createRecoveryRequest(
            candidate.id,
            {
              purpose: "password_reset",
              context: { channel: "recovery_code" },
            },
          );
          user = await context.database.completePasswordReset(
            oneTime.token,
            passwordHash,
          );
          method = "recovery_code";
        }
      }

      if (!user) {
        await audit(context, request, {
          eventType: "recovery.reset",
          outcome: "denied",
          reasonCode: "RECOVERY_CREDENTIAL_REJECTED",
          metadata: { humanProof },
        });
        throw new context.HttpError(
          401,
          "RECOVERY_CREDENTIAL_REJECTED",
          "The recovery credential is invalid or expired.",
        );
      }
      await notifySecurityEvent(context, user.id, {
        type: "recovery_event",
        severity: "critical",
        title: "Password reset",
        body: "The account password was reset and existing sessions were revoked.",
        metadata: { method },
      });
      await audit(context, request, {
        userId: user.id,
        eventType: "recovery.reset",
        metadata: { method, humanProof },
      });
      response.json({
        reset: true,
        message: "Password reset completed. Sign in with the new password.",
      });
    },
  );
}

function registerNotificationRoutes(app, context) {
  app.get(
    "/api/notifications",
    context.requireAuthentication,
    async (request, response) => {
      const limit = optionalLimit(
        request.query.limit,
        50,
        MAX_NOTIFICATION_LIMIT,
        context,
      );
      const notifications =
        await context.database.listSecurityNotifications(
          request.auth.user.id,
          { limit },
        );
      response.json({
        notifications: notifications.map(publicNotification),
        unread: await context.database.countUnreadSecurityNotifications(
          request.auth.user.id,
        ),
      });
    },
  );

  app.post(
    "/api/notifications/:notificationId/read",
    context.sameOrigin,
    context.requireCsrf,
    context.requireAuthentication,
    async (request, response) => {
      const body = requireBody(request, context);
      allowOnly(body, new Set(), context);
      const notificationId = positiveInteger(
        request.params.notificationId,
        "notificationId",
        undefined,
        context,
      );
      const updated =
        await context.database.markSecurityNotificationRead(
          request.auth.user.id,
          notificationId,
          true,
        );
      if (!updated) {
        throw new context.HttpError(
          404,
          "NOTIFICATION_NOT_FOUND",
          "The account notification was not found.",
        );
      }
      response.json({ read: true, notificationId });
    },
  );

  app.delete(
    "/api/notifications/:notificationId",
    context.sameOrigin,
    context.requireCsrf,
    context.requireAuthentication,
    async (request, response) => {
      const notificationId = positiveInteger(
        request.params.notificationId,
        "notificationId",
        undefined,
        context,
      );
      const dismissed =
        await context.database.dismissSecurityNotification(
          request.auth.user.id,
          notificationId,
        );
      if (!dismissed) {
        throw new context.HttpError(
          404,
          "NOTIFICATION_NOT_FOUND",
          "The account notification was not found.",
        );
      }
      response.json({ dismissed: true, notificationId });
    },
  );
}

function registerAccountRoutes(app, context) {
  app.delete(
    "/api/account",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requireBody(request, context);
      allowOnly(
        body,
        new Set(["confirmation", "deleteAccount"]),
        context,
      );
      if (
        body.deleteAccount !== true
        || body.confirmation !== request.auth.user.username
      ) {
        throw new context.HttpError(
          400,
          "ACCOUNT_DELETION_CONFIRMATION_REQUIRED",
          "Account deletion requires the exact username and deleteAccount set to true.",
        );
      }
      await audit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "account.delete",
      });
      const result = await context.database.deleteAccount(
        request.auth.user.id,
      );
      if (!result) {
        throw new context.HttpError(
          404,
          "ACCOUNT_NOT_FOUND",
          "The account was not found.",
        );
      }
      context.clearAuthenticationCookies(response);
      context.clearDeviceCookie(response);
      response.json({
        deleted: true,
        deletedRecords: result.deletedRecords,
      });
    },
  );
}

function registerAdminRoutes(app, context) {
  const adminOnly = administratorOnly(context);

  app.get(
    "/api/admin/summary",
    context.requireAuthentication,
    adminOnly,
    async (request, response) => {
      const options = adminOptions(request.query, context);
      const [overview, eventAggregates] = await Promise.all([
        context.database.getAdminOverview(options),
        context.database.getAdminSecurityEventAggregates(options),
      ]);
      await audit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "admin.summary.view",
      });
      response.json({
        isAdmin: true,
        users: overview.users.total,
        sessions: overview.sessions.active,
        alerts: overview.securityNotifications.unread,
        overview,
        eventAggregates,
      });
    },
  );

  app.get(
    "/api/admin/security-events",
    context.requireAuthentication,
    adminOnly,
    async (request, response) => {
      const options = adminOptions(
        request.query,
        context,
        { includeLimit: true },
      );
      const eventAggregates =
        await context.database.getAdminSecurityEventAggregates(options);
      await audit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "admin.security_events.view",
      });
      response.json({ eventAggregates });
    },
  );
}

function registerExplanationRoute(app, context) {
  app.post(
    "/api/explanations",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    async (request) => {
      const body = requireBody(request, context);
      allowOnly(
        body,
        new Set(["profileId", "trustScore", "context"]),
        context,
      );
      await audit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "ai.explanation",
        outcome: "unavailable",
        reasonCode: "GEMINI_DISABLED",
      });
      throw new context.HttpError(
        501,
        "GEMINI_DISABLED",
        "AI explanations are not enabled.",
      );
    },
  );
}

function registerAccountManagementRoutes(app, suppliedContext) {
  if (
    !app
    || typeof app.get !== "function"
    || typeof app.post !== "function"
    || typeof app.delete !== "function"
  ) {
    throw new TypeError("An Express-compatible app is required.");
  }
  const context = validateContext(suppliedContext);
  registerRecoveryRoutes(app, context);
  registerNotificationRoutes(app, context);
  registerAccountRoutes(app, context);
  registerAdminRoutes(app, context);
  registerExplanationRoute(app, context);
  return app;
}

module.exports = {
  GENERIC_RECOVERY_MESSAGE,
  registerAccountManagementRoutes,
};
