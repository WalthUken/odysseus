"use strict";

const path = require("node:path");
const express = require("express");

const {
  AuthValidationError,
  createSessionCredentials,
  hashPassword,
  normalizeUsername,
  parseCookies,
  serializeCookie,
  validatePassword,
  verifyPassword,
  verifyToken,
} = require("./src/auth");
const {
  registerAccountSecurityRoutes,
} = require("./src/account-security-routes");
const {
  registerAccountManagementRoutes,
} = require("./src/account-management-routes");
const {
  ValidationError,
  createTemplate,
  evaluateVector,
  scaledManhattanDistance,
  validateProfileId,
} = require("./src/behavior");
const { sha256 } = require("./src/crypto");
const {
  buildBehaviorDiagnostics,
  validateTypingDiagnostics,
} = require("./src/diagnostics");
const {
  OdysseusDatabase,
  DEFAULT_DATABASE_PATH,
  DatabaseConflictError,
  DatabaseValidationError,
  SCHEMA_VERSION,
} = require("./src/database");
const {
  DomainValidationError,
} = require("./src/domain-validation");
const {
  evaluateDeviceConfidence,
} = require("./src/device-confidence");
const {
  createSameOriginGuard,
  createSecurityHeaders,
} = require("./src/http-security");
const {
  createDatabaseInAppNotificationChannel,
} = require("./src/notifications");
const {
  createProviderRuntime,
} = require("./src/provider-runtime");
const { createRateLimiter } = require("./src/rate-limit");
const {
  evolveTemplate,
  initializeCrossDeviceTransfer,
  recalibrateCrossDeviceTemplate,
  templateAccessState,
} = require("./src/template-evolution");
const {
  WebAuthnConfigurationError,
  WebAuthnVerificationError,
  createWebAuthnService,
  decodeClientData,
} = require("./src/webauthn-service");
const { VERIFICATION_ROUNDS } = require("./public/challenge");
const packageMetadata = require("./package.json");

const SESSION_COOKIE = "odysseus_session";
const CSRF_COOKIE = "odysseus_csrf";
const DEVICE_COOKIE = "odysseus_device";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_STEP_UP_GRANT_MS = 10 * 60 * 1_000;
const DEFAULT_BEHAVIOR_GRANT_MS = 5 * 60 * 1_000;
const DEFAULT_DEVICE_COOKIE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DUMMY_LOGIN_VALUE = "Odysseus-Dummy-Login-Password-1!";

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class NotFoundError extends HttpError {
  constructor(message, code = "PROFILE_NOT_FOUND") {
    super(404, code, message);
    this.name = "NotFoundError";
  }
}

function requireObjectBody(body) {
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
  ) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  return body;
}

function currentDate(clock) {
  const value = typeof clock === "function" ? clock() : Date.now();
  const date = value instanceof Date ? new Date(value) : new Date(Number(value));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("clock must return a Date or millisecond timestamp.");
  }
  return date;
}

function parseDuration(value, name, defaultValue, minimum, maximum) {
  const duration = value === undefined || value === null || value === ""
    ? defaultValue
    : Number(value);
  if (
    !Number.isSafeInteger(duration)
    || duration < minimum
    || duration > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum} milliseconds.`
    );
  }
  return duration;
}

function parseAllowedOrigins(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const values = Array.isArray(value) ? value : String(value).split(",");
  const origins = values
    .map((origin) => String(origin).trim())
    .filter(Boolean)
    .map((origin) => {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`Invalid allowed origin: ${origin}`);
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Allowed origin must use HTTP or HTTPS: ${origin}`);
      }
      return parsed.origin;
    });

  if (origins.length === 0) {
    return undefined;
  }
  return [...new Set(origins)];
}

function parseCsvSet(value) {
  if (value === undefined || value === null || value === "") {
    return new Set();
  }
  const entries = Array.isArray(value) ? value : String(value).split(",");
  return new Set(
    entries
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseAdministratorUserIds(value) {
  if (value === undefined || value === null || value === "") {
    return new Set();
  }
  const entries = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : String(value).split(",");
  if (entries.length > 1_000) {
    throw new Error(
      "ODYSSEUS_ADMIN_USER_IDS may contain at most 1000 user IDs.",
    );
  }

  const ids = new Set();
  for (const entry of entries) {
    const text = typeof entry === "string" ? entry.trim() : entry;
    const id = typeof text === "number"
      ? text
      : (
          typeof text === "string" && /^[1-9]\d*$/.test(text)
            ? Number(text)
            : Number.NaN
        );
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error(
        "ODYSSEUS_ADMIN_USER_IDS must contain only positive integer user IDs.",
      );
    }
    ids.add(id);
  }
  return ids;
}

function hasConfiguredValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value instanceof Set) {
    return value.size > 0;
  }
  return String(value).trim().length > 0;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("Boolean configuration must be true or false.");
}

async function createConfiguredRedisClient(options = {}) {
  if (options.client) {
    return { client: options.client, owned: false };
  }
  if (!options.url) {
    return { client: null, owned: false };
  }
  const { createClient } = require("redis");
  const client = createClient({ url: options.url });
  client.on("error", (error) => {
    if (typeof options.onError === "function") {
      options.onError(error);
    }
  });
  await client.connect();
  return { client, owned: true };
}

async function closeRedisClient(client) {
  if (!client) {
    return;
  }
  if (client.isOpen && typeof client.quit === "function") {
    await client.quit();
  }
}

function parseTrustProxy(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === false || String(value).toLowerCase() === "false") {
    return false;
  }
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 10) {
    throw new Error(
      "ODYSSEUS_TRUST_PROXY must be false or an integer from 0 through 10."
    );
  }
  return hops;
}

function isFuture(value, now) {
  if (!value) {
    return false;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicSession(session, now) {
  return {
    expiresAt: session.expiresAt,
    stepUpUntil: session.stepUpUntil || null,
    behaviorVerifiedUntil: session.behaviorVerifiedUntil || null,
    stepUpActive: isFuture(session.stepUpUntil, now),
    behaviorVerified: isFuture(session.behaviorVerifiedUntil, now),
  };
}

function profileMetadata(profile) {
  const { template, encryptedTemplate, ...metadata } = profile;
  return metadata;
}

function publicDevice(device, currentDeviceId) {
  return {
    id: device.id,
    label: device.label,
    descriptor: device.descriptor,
    tokenExpiresAt:
      device.tokenExpiresAt,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    current: device.id === currentDeviceId,
  };
}

function publicPasskey(credential) {
  return {
    id: credential.id,
    credentialId: credential.credentialId.toString("base64url"),
    name: credential.name,
    transports: credential.transports,
    userVerified: credential.userVerified,
    backupEligible: credential.backupEligible,
    backupState: credential.backupState,
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt,
  };
}

function publicNotification(notification) {
  return {
    id: notification.id,
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    message: notification.body,
    metadata: notification.metadata,
    createdAt: notification.createdAt,
    read: Boolean(notification.readAt),
    readAt: notification.readAt,
  };
}

function requestOrigin(request) {
  const value = request.get("origin");
  if (typeof value !== "string" || value.length > 512) {
    throw new HttpError(
      400,
      "ORIGIN_REQUIRED",
      "This security operation requires an explicit browser origin.",
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(
      400,
      "INVALID_ORIGIN",
      "The browser origin is invalid.",
    );
  }
  if (parsed.origin !== value.replace(/\/$/, "")) {
    throw new HttpError(
      400,
      "INVALID_ORIGIN",
      "The browser origin must not include a path.",
    );
  }
  return parsed.origin;
}

function readableAuthorizationMethod(value) {
  if (value === "behavior") {
    return "Behavior grant";
  }
  if (value === "password_step_up") {
    return "Password step-up grant";
  }
  return value ? String(value) : null;
}

function observedIp(request) {
  const value = String(
    request.ip || request.socket?.remoteAddress || "Unavailable"
  );
  return value.startsWith("::ffff:") ? value.slice(7, 71) : value.slice(0, 64);
}

function monitoringRoute(pathname) {
  if (pathname === "/api/health" || pathname === "/api/ready") {
    return "health";
  }
  if (pathname.startsWith("/api/auth")) {
    return "auth";
  }
  if (pathname.startsWith("/api/profiles")) {
    return "profile";
  }
  if (pathname === "/api/enroll") {
    return "enroll";
  }
  if (pathname === "/api/verify") {
    return "verify";
  }
  if (pathname === "/api/audit") {
    return "audit";
  }
  if (pathname.startsWith("/api/actions")) {
    return "secure_action";
  }
  if (pathname.startsWith("/api")) {
    return "other";
  }
  return "static";
}

function monitoringStatus(statusCode) {
  if (statusCode >= 200 && statusCode < 300) {
    return "2xx";
  }
  if (statusCode >= 300 && statusCode < 400) {
    return "3xx";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "4xx";
  }
  if (statusCode >= 500 && statusCode < 600) {
    return "5xx";
  }
  return "other";
}

function makeCookieOptions(production, maxAge) {
  return {
    path: "/",
    sameSite: "Strict",
    secure: production,
    maxAge: Math.max(0, Math.floor(maxAge / 1_000)),
  };
}

function appendCookies(response, cookies) {
  response.append("Set-Cookie", cookies);
}

function createLimiter(configuration, defaults, clock) {
  if (configuration === false) {
    return (request, response, next) => next();
  }
  return createRateLimiter({
    ...defaults,
    ...(configuration || {}),
    clock,
  });
}

function isUsernameConflict(error) {
  const code = String(error && error.code ? error.code : "");
  const message = String(error && error.message ? error.message : "");
  return (
    code.includes("CONSTRAINT")
    || code === "USERNAME_TAKEN"
    || /unique.*username|username.*unique/i.test(message)
  );
}

async function getProfileOrThrow(database, userId, profileId) {
  const profile = await database.getProfile(userId, profileId);
  if (!profile) {
    throw new NotFoundError(`Profile "${profileId}" is not enrolled.`);
  }
  return profile;
}

async function createApp(options = {}) {
  const environment = options.env ?? process.env;
  const clock = options.clock ?? Date.now;
  const production =
    options.production ?? environment.NODE_ENV === "production";
  const legacyAdministratorUsers = (
    options.adminUsers ?? environment.ODYSSEUS_ADMIN_USERS
  );
  if (hasConfiguredValue(legacyAdministratorUsers)) {
    throw new Error(
      "ODYSSEUS_ADMIN_USERS is no longer supported because usernames are reclaimable. Use ODYSSEUS_ADMIN_USER_IDS with pre-provisioned account IDs.",
    );
  }
  const administratorUserIds = parseAdministratorUserIds(
    options.adminUserIds ?? environment.ODYSSEUS_ADMIN_USER_IDS,
  );
  const exposeRecoveryTokens = (
    !production
    && parseBoolean(
      options.exposeRecoveryTokens
      ?? environment.ODYSSEUS_EXPOSE_RECOVERY_TOKENS,
      false,
    )
  );
  const metricsToken =
    options.metricsToken ?? environment.ODYSSEUS_METRICS_TOKEN ?? "";
  const turnstileSiteKey =
    options.turnstileSiteKey
    ?? environment.ODYSSEUS_TURNSTILE_SITE_KEY
    ?? "";
  const turnstileHostnames = [
    ...parseCsvSet(
      options.turnstileHostnames
      ?? environment.ODYSSEUS_TURNSTILE_HOSTNAMES,
    ),
  ];
  const turnstileActions = [
    ...parseCsvSet(
      options.turnstileActions
      ?? environment.ODYSSEUS_TURNSTILE_ACTIONS,
    ),
  ];
  if (
    metricsToken
    && (
      typeof metricsToken !== "string"
      || metricsToken.length < 20
      || metricsToken.length > 512
    )
  ) {
    throw new Error(
      "ODYSSEUS_METRICS_TOKEN must contain between 20 and 512 characters.",
    );
  }
  const sessionTtlMs = parseDuration(
    options.sessionTtlMs,
    "sessionTtlMs",
    DEFAULT_SESSION_TTL_MS,
    5 * 60 * 1_000,
    90 * 24 * 60 * 60 * 1_000
  );
  const stepUpGrantMs = parseDuration(
    options.stepUpGrantMs,
    "stepUpGrantMs",
    DEFAULT_STEP_UP_GRANT_MS,
    30 * 1_000,
    24 * 60 * 60 * 1_000
  );
  const behaviorGrantMs = parseDuration(
    options.behaviorGrantMs,
    "behaviorGrantMs",
    DEFAULT_BEHAVIOR_GRANT_MS,
    30 * 1_000,
    24 * 60 * 60 * 1_000
  );
  const deviceCookieTtlMs = parseDuration(
    options.deviceCookieTtlMs
      ?? environment.ODYSSEUS_DEVICE_COOKIE_TTL_MS,
    "deviceCookieTtlMs",
    DEFAULT_DEVICE_COOKIE_TTL_MS,
    24 * 60 * 60 * 1_000,
    730 * 24 * 60 * 60 * 1_000,
  );
  const configuredWebAuthnOrigins = (
    options.webAuthnOrigins
    ?? parseAllowedOrigins(environment.ODYSSEUS_WEBAUTHN_ORIGINS)
    ?? ["http://localhost:3000"]
  );
  const webAuthnService = (
    options.webAuthnService
    ?? createWebAuthnService({
      rpId: options.webAuthnRpId
        ?? environment.ODYSSEUS_WEBAUTHN_RP_ID
        ?? "localhost",
      rpName: options.webAuthnRpName
        ?? environment.ODYSSEUS_WEBAUTHN_RP_NAME
        ?? "Odysseus",
      expectedOrigins: configuredWebAuthnOrigins,
    })
  );

  const database =
    options.database
    || new OdysseusDatabase({
      databasePath:
        options.databasePath
        ?? options.storePath
        ?? environment.ODYSSEUS_DATABASE_PATH
        ?? DEFAULT_DATABASE_PATH,
      masterKey: options.masterKey,
      masterKeyPath: options.masterKeyPath,
      env: environment,
    });
  let ownedRedisClient = null;
  await database.init();
  try {
    for (const administratorUserId of administratorUserIds) {
      const administrator = await database.getUserById(
        administratorUserId,
      );
      if (!administrator) {
        throw new Error(
          `Configured administrator user ID ${administratorUserId} does not exist. Provision the account before enabling administrator access.`,
        );
      }
    }
    await database.purgeExpiredSessions(currentDate(clock));
    const redisConnection = options.providerRuntime
      ? { client: null, owned: false }
      : await createConfiguredRedisClient({
        client: options.redisClient,
        url: options.redisUrl ?? environment.ODYSSEUS_REDIS_URL,
        onError: options.onRedisError,
      });
    if (redisConnection.owned) {
      ownedRedisClient = redisConnection.client;
    }
    const providerRuntime = options.providerRuntime
      ?? createProviderRuntime({
        monitoring: options.monitoring,
        rateLimit: {
          store: options.rateLimitStore,
          redisClient: redisConnection.client,
          prefix:
            options.redisPrefix
            ?? environment.ODYSSEUS_REDIS_KEY_PREFIX
            ?? "odysseus:rate-limit",
        },
        turnstile: {
          secretKey:
            options.turnstileSecretKey
            ?? environment.ODYSSEUS_TURNSTILE_SECRET_KEY,
          expectedHostnames: turnstileHostnames,
          expectedActions: turnstileActions,
          fetchImpl: options.fetchImpl,
        },
        gemini: {},
        huggingFace: {
          endpointUrl:
            options.huggingFaceEndpoint
            ?? environment.ODYSSEUS_HUGGING_FACE_ENDPOINT,
          apiToken:
            options.huggingFaceToken
            ?? environment.ODYSSEUS_HUGGING_FACE_TOKEN,
          allowedHosts: [
            ...parseCsvSet(
              options.huggingFaceAllowedHosts
              ?? environment.ODYSSEUS_HUGGING_FACE_ALLOWED_HOSTS,
            ),
          ],
          fetchImpl: options.fetchImpl,
        },
        notifications: {
          inApp: createDatabaseInAppNotificationChannel(database),
          webhook: options.webhookNotificationChannel,
          email: options.emailNotificationChannel,
        },
        requiredProviders: [
          ...parseCsvSet(
            options.requiredProviders
            ?? environment.ODYSSEUS_REQUIRED_PROVIDERS,
          ),
        ].filter((name) => name !== "gemini"),
      });
    const turnstileConfigured = (
      providerRuntime.turnstile
      && typeof providerRuntime.turnstile.readiness === "function"
      && providerRuntime.turnstile.readiness().disabled !== true
    );
    if (turnstileConfigured !== Boolean(turnstileSiteKey)) {
      throw new Error(
        "Turnstile site and secret keys must be configured together.",
      );
    }
    if (turnstileConfigured && turnstileActions.length !== 1) {
      throw new Error(
        "Exactly one Turnstile action is required for the browser widget.",
      );
    }
    providerRuntime.readiness.register(
      "database",
      async () => {
        await database.getApplicationMetadata("runtime.readiness");
        return { ready: true };
      },
      { required: true },
    );

    const dummyPasswordHash =
      options.dummyPasswordHash ?? await hashPassword(DUMMY_LOGIN_VALUE);
    const app = express();
    app.disable("x-powered-by");
    if (options.trustProxy !== undefined) {
      app.set("trust proxy", options.trustProxy);
    }
    app.locals.database = database;
    app.locals.providers = providerRuntime;
    app.locals.webAuthnService = webAuthnService;
    let resourcesClosed = false;
    app.locals.closeDatabase = async () => {
      if (resourcesClosed) {
        return;
      }
      resourcesClosed = true;
      await Promise.allSettled([
        database.close(),
        closeRedisClient(ownedRedisClient),
      ]);
    };

  const sameOrigin = createSameOriginGuard({
    allowedOrigins: options.allowedOrigins ?? options.allowedOrigin,
  });
  const authLimiter = createLimiter(
    options.rateLimits && options.rateLimits.auth,
    {
      windowMs: 15 * 60 * 1_000,
      maximum: 20,
      store: providerRuntime.rateLimitStore,
      keyGenerator: (request) => request.ip,
      message: "Too many authentication attempts. Try again later.",
    },
    clock
  );
  const verificationLimiter = createLimiter(
    options.rateLimits && options.rateLimits.verification,
    {
      windowMs: 60_000,
      maximum: 30,
      store: providerRuntime.rateLimitStore,
      keyGenerator: (request) =>
        request.auth
          ? `user:${request.auth.user.id}`
          : `ip:${request.ip}`,
      message: "Too many verification attempts. Try again shortly.",
    },
    clock
  );

  app.use(createSecurityHeaders({ production }));
  app.use((request, response, next) => {
    const startedAt = Date.now();
    response.once("finish", () => {
      const method = request.method.toUpperCase();
      const route = monitoringRoute(request.path);
      const status = monitoringStatus(response.statusCode);
      providerRuntime.monitoring.httpRequests.inc({
        method,
        route,
        status,
      });
      providerRuntime.monitoring.requestDuration.observe(
        { method, route },
        Math.max(0, Date.now() - startedAt) / 1_000,
      );
    });
    next();
  });
  app.use(express.json({
    limit: "100kb",
    strict: true,
    type: "application/json",
  }));

  function setCsrfCookie(response, csrfToken, ttlMs = sessionTtlMs) {
    appendCookies(response, [
      serializeCookie(CSRF_COOKIE, csrfToken, {
        ...makeCookieOptions(production, ttlMs),
        httpOnly: false,
      }),
    ]);
  }

  function setAuthenticationCookies(response, credentials) {
    const ttlMs = credentials.session && credentials.session.expiresAt
      ? Math.max(
          0,
          new Date(credentials.session.expiresAt).getTime()
            - currentDate(clock).getTime()
        )
      : sessionTtlMs;
    const common = makeCookieOptions(production, ttlMs);
    appendCookies(response, [
      serializeCookie(SESSION_COOKIE, credentials.token, {
        ...common,
        httpOnly: true,
      }),
      serializeCookie(CSRF_COOKIE, credentials.csrfToken, {
        ...common,
        httpOnly: false,
      }),
    ]);
  }

  function setDeviceCookie(response, token, expiresAt) {
    const expiresAtMs = new Date(expiresAt).getTime();
    const ttlMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - currentDate(clock).getTime())
      : deviceCookieTtlMs;
    appendCookies(response, [
      serializeCookie(DEVICE_COOKIE, token, {
        ...makeCookieOptions(production, ttlMs),
        expires: Number.isFinite(expiresAtMs)
          ? new Date(expiresAtMs)
          : undefined,
        httpOnly: true,
      }),
    ]);
  }

  function clearDeviceCookie(response) {
    appendCookies(response, [
      serializeCookie(DEVICE_COOKIE, "", {
        ...makeCookieOptions(production, 0),
        expires: new Date(0),
        httpOnly: true,
      }),
    ]);
  }

  function clearAuthenticationCookies(response) {
    const expired = {
      ...makeCookieOptions(production, 0),
      expires: new Date(0),
    };
    appendCookies(response, [
      serializeCookie(SESSION_COOKIE, "", {
        ...expired,
        httpOnly: true,
      }),
      serializeCookie(CSRF_COOKIE, "", {
        ...expired,
        httpOnly: false,
      }),
    ]);
  }

  function clearSessionCookie(response) {
    appendCookies(response, [
      serializeCookie(SESSION_COOKIE, "", {
        ...makeCookieOptions(production, 0),
        expires: new Date(0),
        httpOnly: true,
      }),
    ]);
  }

  async function attachAuthentication(request, response, next) {
    try {
      request.cookies = parseCookies(request.get("cookie"));
      request.auth = null;
      request.device = null;
      const sessionCookieValue = request.cookies[SESSION_COOKIE];
      if (!sessionCookieValue) {
        next();
        return;
      }

      const context = await database.getSessionWithUser(sessionCookieValue);
      if (!context || context.user.disabledAt) {
        clearSessionCookie(response);
        next();
        return;
      }

      request.auth = {
        session: context.session,
        user: context.user,
      };
      await database.touchSession(context.session.id);
      const deviceToken =
        request.cookies[DEVICE_COOKIE];
      if (deviceToken) {
        const device = await database.getDeviceByToken(deviceToken);
        if (device && device.userId === context.user.id) {
          request.device = device;
          await database.touchDevice(context.user.id, device.id);
        } else {
          clearDeviceCookie(response);
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  function issueAnonymousCsrf(request, response, next) {
    if (
      (request.method === "GET" || request.method === "HEAD")
      && !request.auth
      && !request.cookies[CSRF_COOKIE]
    ) {
      const credentials = createSessionCredentials();
      request.cookies[CSRF_COOKIE] = credentials.csrfToken;
      setCsrfCookie(response, credentials.csrfToken);
    }
    next();
  }

  function requireAuthentication(request, response, next) {
    if (!request.auth) {
      next(
        new HttpError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Sign in to access this resource."
        )
      );
      return;
    }
    next();
  }

  function requireRecentStrongAuthorization(request, response, next) {
    if (!request.auth) {
      requireAuthentication(request, response, next);
      return;
    }
    if (
      !isFuture(
        request.auth.session.stepUpUntil,
        currentDate(clock),
      )
    ) {
      next(
        new HttpError(
          403,
          "STRONG_AUTHORIZATION_REQUIRED",
          "A recent password or user-verified passkey check is required.",
        ),
      );
      return;
    }
    next();
  }

  function requireCsrf(request, response, next) {
    const csrfCookieValue = request.cookies[CSRF_COOKIE];
    const headerToken = request.get("x-csrf-token");
    const matchingDoubleSubmit =
      typeof csrfCookieValue === "string"
      && verifyToken(headerToken, sha256(csrfCookieValue));
    const matchingSession =
      !request.auth
      || verifyToken(headerToken, request.auth.session.csrfHash);

    if (!matchingDoubleSubmit || !matchingSession) {
      next(
        new HttpError(
          403,
          "CSRF_REJECTED",
          "A valid CSRF token is required for this request."
        )
      );
      return;
    }
    next();
  }

  async function appendAudit(event, request) {
    const metadata = request
      ? {
          ...(
            event.metadata &&
            typeof event.metadata === "object" &&
            !Array.isArray(event.metadata)
              ? event.metadata
              : {}
          ),
          ipAddress: observedIp(request),
        }
      : event.metadata;
    return database.appendAudit({
      outcome: "success",
      ...event,
      metadata,
    });
  }

  async function createAuthenticatedSession(
    user,
    response,
    options = {},
  ) {
    const credentials = await database.createSession(user.id, {
      ttlMs: sessionTtlMs,
    });
    if (options.strongAuthentication === true) {
      const stepUpUntil = new Date(
        currentDate(clock).getTime() + stepUpGrantMs,
      );
      await database.setStepUpUntil(
        credentials.session.id,
        stepUpUntil,
      );
      credentials.session.stepUpUntil = stepUpUntil.toISOString();
    }
    setAuthenticationCookies(response, credentials);
    return credentials;
  }

  function isAdministrator(user) {
    return Boolean(
      user
      && Number.isSafeInteger(user.id)
      && administratorUserIds.has(user.id),
    );
  }

  async function verifyHumanProof(body, request) {
    const readiness = providerRuntime.turnstile.readiness();
    if (readiness.disabled === true) {
      return {
        status: "unavailable",
        provider: "turnstile",
      };
    }
    const token =
      body?.turnstileToken;
    if (typeof token !== "string" || token.length < 1) {
      throw new HttpError(
        403,
        "HUMAN_CHALLENGE_REQUIRED",
        "Complete the configured browser challenge before continuing.",
      );
    }
    const result = await providerRuntime.turnstile.verify({
      token,
      remoteIp: observedIp(request),
    });
    if (result.valid === true) {
      return {
        status: "passed",
        provider: "turnstile",
      };
    }
    if (result.available === false && result.disabled !== true) {
      throw new HttpError(
        503,
        "HUMAN_CHALLENGE_UNAVAILABLE",
        "The browser challenge provider is temporarily unavailable.",
      );
    }
    throw new HttpError(
      403,
      result.code || "HUMAN_CHALLENGE_REJECTED",
      "The browser challenge was not accepted. Complete a fresh challenge.",
    );
  }

  app.use("/api", attachAuthentication, issueAnonymousCsrf);

  app.get("/api/health", (request, response) => {
    response.json({
      status: "ok",
      service: packageMetadata.name,
      version: packageMetadata.version,
      schemaVersion: SCHEMA_VERSION,
      timestamp: currentDate(clock).toISOString(),
    });
  });

  app.get("/api/ready", async (request, response) => {
    const readiness = await providerRuntime.readiness.check();
    response.status(readiness.ready ? 200 : 503).json(readiness);
  });

  app.get("/metrics", (request, response) => {
    if (production && !metricsToken) {
      response.status(404).type("text/plain").send("Not found");
      return;
    }
    if (metricsToken) {
      const authorization = request.get("authorization");
      const candidate = typeof authorization === "string"
        && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      if (!verifyToken(candidate, sha256(metricsToken))) {
        response
          .status(401)
          .set("WWW-Authenticate", "Bearer")
          .type("text/plain")
          .send("Authentication required");
        return;
      }
    }
    response
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(providerRuntime.monitoring.render());
  });

  app.post(
    "/api/auth/register",
    sameOrigin,
    authLimiter,
    requireCsrf,
    async (request, response) => {
      const body = requireObjectBody(request.body);
      const humanProof = await verifyHumanProof(body, request);
      const username = normalizeUsername(body.username);
      const credential = validatePassword(body.password);
      const existing = await database.getUserByUsername(username);
      if (existing) {
        throw new HttpError(
          409,
          "USERNAME_TAKEN",
          "That username is already registered."
        );
      }

      const credentialHash = await hashPassword(credential);
      let user;
      try {
        user = await database.createUser({
          username,
          passwordHash: credentialHash,
        });
      } catch (error) {
        if (isUsernameConflict(error)) {
          throw new HttpError(
            409,
            "USERNAME_TAKEN",
            "That username is already registered."
          );
        }
        throw error;
      }

      const credentials = await createAuthenticatedSession(
        user,
        response,
        { strongAuthentication: true },
      );
      await appendAudit({
        userId: user.id,
        sessionId: credentials.session.id,
        eventType: "auth.register",
        metadata: {
          humanProofStatus: humanProof.status,
        },
      }, request);
      response.status(201).json({
        user: publicUser(user),
        session: publicSession(credentials.session, currentDate(clock)),
      });
    }
  );

  app.post(
    "/api/auth/login",
    sameOrigin,
    authLimiter,
    requireCsrf,
    async (request, response) => {
      const body = requireObjectBody(request.body);
      let username = null;
      try {
        username = normalizeUsername(body.username);
      } catch (_error) {
        username = null;
      }

      const suppliedPassword =
        typeof body.password === "string"
        && Buffer.byteLength(body.password, "utf8") <= 512
          ? body.password
          : "";
      const user = username
        ? await database.getUserByUsername(username)
        : null;
      let candidateHash = dummyPasswordHash;
      if (user && !user.disabledAt) {
        candidateHash = user.passwordHash;
      }
      const validPassword = await verifyPassword(
        suppliedPassword,
        candidateHash
      );

      if (!user || user.disabledAt || !validPassword) {
        await appendAudit({
          userId: user ? user.id : undefined,
          eventType: "auth.login",
          outcome: "denied",
          reasonCode: "INVALID_CREDENTIALS",
          metadata: username ? { username } : undefined,
        }, request);
        throw new HttpError(
          401,
          "INVALID_CREDENTIALS",
          "The username or password is incorrect."
        );
      }

      const credentials = await createAuthenticatedSession(
        user,
        response,
        { strongAuthentication: true },
      );
      await appendAudit({
        userId: user.id,
        sessionId: credentials.session.id,
        eventType: "auth.login",
      }, request);
      response.json({
        user: publicUser(user),
        session: publicSession(credentials.session, currentDate(clock)),
      });
    }
  );

  app.get(
    "/api/auth/me",
    requireAuthentication,
    (request, response) => {
      response.json({
        user: publicUser(request.auth.user),
        session: publicSession(
          request.auth.session,
          currentDate(clock)
        ),
      });
    }
  );

  app.post(
    "/api/auth/logout",
    sameOrigin,
    async (request, response) => {
      if (request.auth) {
        await appendAudit({
          userId: request.auth.user.id,
          sessionId: request.auth.session.id,
          eventType: "auth.logout",
        }, request);
        await database.deleteSession(request.auth.session.id);
      }
      clearAuthenticationCookies(response);
      response.json({ loggedOut: true });
    }
  );

  app.post(
    "/api/auth/step-up",
    sameOrigin,
    authLimiter,
    requireCsrf,
    requireAuthentication,
    async (request, response) => {
      const body = requireObjectBody(request.body);
      const suppliedPassword =
        typeof body.password === "string"
        && Buffer.byteLength(body.password, "utf8") <= 512
          ? body.password
          : "";
      const validPassword = await verifyPassword(
        suppliedPassword,
        request.auth.user.passwordHash
      );
      if (!validPassword) {
        await database.setStepUpUntil(request.auth.session.id, null);
        await appendAudit({
          userId: request.auth.user.id,
          sessionId: request.auth.session.id,
          eventType: "auth.step_up",
          outcome: "denied",
          reasonCode: "INVALID_PASSWORD",
        }, request);
        throw new HttpError(
          401,
          "INVALID_CREDENTIALS",
          "The password is incorrect."
        );
      }

      const stepUpUntil = new Date(
        currentDate(clock).getTime() + stepUpGrantMs
      );
      await database.setStepUpUntil(
        request.auth.session.id,
        stepUpUntil
      );
      await appendAudit({
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "auth.step_up",
      }, request);
      response.json({ stepUpUntil: stepUpUntil.toISOString() });
    }
  );

  registerAccountSecurityRoutes(app, {
    HttpError,
    appendAudit,
    authLimiter,
    clearDeviceCookie,
    clock,
    createAuthenticatedSession,
    database,
    decodeWebAuthnClientData: decodeClientData,
    deviceCookieTtlMs,
    evaluateDeviceConfidence,
    geminiProvider: null,
    huggingFaceProvider: providerRuntime.huggingFace,
    initializeCrossDeviceTransfer,
    normalizeUsername,
    notificationProvider: providerRuntime.notifications,
    observedIp,
    proofHuman: providerRuntime.turnstile,
    proofHumanAction: turnstileActions[0] ?? null,
    proofHumanSiteKey: turnstileSiteKey || null,
    publicDevice,
    publicPasskey,
    publicSession,
    publicUser,
    recalibrateCrossDeviceTemplate,
    requestOrigin,
    requireAuthentication,
    requireCsrf,
    requireRecentStrongAuthorization,
    sameOrigin,
    setDeviceCookie,
    templateAccessState,
    validateProfileId,
    verificationLimiter,
    webAuthnService,
  });
  registerAccountManagementRoutes(app, {
    HttpError,
    appendAudit,
    authLimiter,
    clearAuthenticationCookies,
    clearDeviceCookie,
    database,
    hashPassword,
    humanProofRequired: turnstileConfigured,
    isAdministrator,
    normalizeUsername,
    notificationService: providerRuntime.notifications,
    observedIp,
    proofHuman: providerRuntime.turnstile,
    requireAuthentication,
    requireCsrf,
    requireRecentStrongAuthorization,
    resolveRecoveryRecipient: options.resolveRecoveryRecipient,
    sameOrigin,
    validatePassword,
    verificationLimiter,
  });

  app.get(
    "/api/profiles",
    requireAuthentication,
    async (request, response) => {
      const profiles = await database.listProfiles(request.auth.user.id);
      response.json({ profiles });
    }
  );

  app.get(
    "/api/profiles/:profileId",
    requireAuthentication,
    async (request, response) => {
      const profileId = validateProfileId(request.params.profileId);
      const profile = await getProfileOrThrow(
        database,
        request.auth.user.id,
        profileId
      );
      response.json(profileMetadata(profile));
    }
  );

  app.post(
    "/api/enroll",
    sameOrigin,
    requireCsrf,
    requireAuthentication,
    requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requireObjectBody(request.body);
      const profileId = validateProfileId(body.profileId);
      const previous = await database.getProfile(
        request.auth.user.id,
        profileId
      );
      if (request.device) {
        const existingAssociations =
          await database.listDeviceProfileAssociations(
            request.auth.user.id,
            {
              deviceId: request.device.id,
              profileId,
            },
          );
        if (
          existingAssociations.some(
            (association) =>
              association.relationship === "transferred",
          )
          && previous?.template?.transfer?.requiresRecalibration !== true
        ) {
          throw new HttpError(
            409,
            "TRANSFER_DESTINATION_PROFILE_REQUIRED",
            "Recalibrate a transferred baseline under its distinct destination profile.",
          );
        }
      }
      const template = (
        previous?.template?.transfer?.requiresRecalibration === true
          ? recalibrateCrossDeviceTemplate(
            previous.template,
            body.samples,
            { recalibratedAt: currentDate(clock).toISOString() },
          )
          : createTemplate(body.samples)
      );
      const metadata = await database.setProfile(
        request.auth.user.id,
        profileId,
        template
      );
      if (request.device) {
        await database.associateDeviceProfile(
          request.auth.user.id,
          request.device.id,
          profileId,
          { relationship: "primary" },
        );
      }
      await database.setBehaviorVerifiedUntil(
        request.auth.session.id,
        null
      );
      await appendAudit({
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "profile.enroll",
        metadata: {
          profileId,
          sampleCount: template.sampleCount,
          featureCount: template.featureKeys.length,
          replaced: Boolean(previous),
        },
      }, request);
      response.status(previous ? 200 : 201).json({
        ...metadata,
        replaced: Boolean(previous),
      });
    }
  );

  app.post(
    "/api/verify",
    sameOrigin,
    verificationLimiter,
    requireCsrf,
    requireAuthentication,
    async (request, response) => {
      const body = requireObjectBody(request.body);
      const profileId = validateProfileId(body.profileId);
      const profile = await getProfileOrThrow(
        database,
        request.auth.user.id,
        profileId
      );
      const typingDiagnostics = validateTypingDiagnostics(
        body.diagnostics,
        VERIFICATION_ROUNDS
      );
      const diagnosticRound = typingDiagnostics
        ? VERIFICATION_ROUNDS.find(
            (round) => round.id === typingDiagnostics.missionId
          )
        : VERIFICATION_ROUNDS[0];
      const measuredResult = evaluateVector(body.vector, profile.template);
      const measuredDistance = scaledManhattanDistance(
        body.vector,
        profile.template,
      );
      const featureDeltas = Object.entries(
        measuredDistance.contributions,
      )
        .filter(([name]) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name))
        .sort((left, right) => right[1] - left[1])
        .slice(0, 24)
        .map(([name, normalizedDelta]) => ({
          name,
          normalizedDelta: Math.min(100, normalizedDelta),
        }));
      const templateState = templateAccessState(profile.template);
      const profileAssociations = request.device
        ? await database.listDeviceProfileAssociations(
          request.auth.user.id,
          {
            deviceId: request.device.id,
            profileId,
          },
        )
        : [];
      const transferredAssociation = profileAssociations.some(
        (association) => association.relationship === "transferred",
      );
      const transferRestricted = (
        templateState.state === "restricted"
        || transferredAssociation
      );
      const result = transferRestricted
        ? {
          ...measuredResult,
          decision: "step_up",
          reasonCodes: [
            "CROSS_DEVICE_RECALIBRATION_REQUIRED",
            ...measuredResult.reasonCodes,
          ],
          policy: {
            ...measuredResult.policy,
            allowSensitiveActions: false,
            stepUpRequired: true,
          },
        }
        : measuredResult;
      const behaviorDiagnostics = buildBehaviorDiagnostics(
        body.vector,
        profile.template,
        typingDiagnostics,
        diagnosticRound
      );
      let behaviorVerifiedUntil = null;
      const behaviorAllowed =
        result.decision === "allow"
        && result.policy.allowSensitiveActions;

      if (behaviorAllowed) {
        behaviorVerifiedUntil = new Date(
          currentDate(clock).getTime() + behaviorGrantMs
        );
        await database.setBehaviorVerifiedUntil(
          request.auth.session.id,
          behaviorVerifiedUntil
        );
      } else {
        await database.setBehaviorVerifiedUntil(
          request.auth.session.id,
          null
        );
        if (result.decision === "deny") {
          await database.setStepUpUntil(
            request.auth.session.id,
            null,
          );
          request.auth.session.stepUpUntil = null;
        }
      }
      const strongVerification = (
        behaviorAllowed
        && isFuture(
          request.auth.session.stepUpUntil,
          currentDate(clock),
        )
      );
      const verificationEvent = await appendAudit({
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "behavior.verify",
        outcome: behaviorAllowed ? "success" : "denied",
        reasonCode: result.reasonCodes[0],
        metadata: {
          profileId,
          decision: result.decision,
          trustPercent: result.trustPercent,
          normalizedDistance: result.normalizedDistance,
          acceptanceThreshold: profile.template.acceptanceThreshold,
          reasonCodes: result.reasonCodes,
          behaviorDiagnostics,
          featureDeltas,
          transferRestricted,
          strongVerification,
          ...(
            strongVerification
              ? {
                updateCandidate: {
                  vector: body.vector,
                },
              }
              : {}
          ),
        },
      }, request);

      let driftUpdate = {
        status: "not_attempted",
        reasonCode: strongVerification
          ? "WAITING_FOR_DISTINCT_VERIFIED_SESSIONS"
          : "RECENT_STRONG_AUTHORIZATION_REQUIRED",
      };
      if (strongVerification && !transferRestricted) {
        const recentEvents = await database.listAudit({
          userId: request.auth.user.id,
          limit: 100,
        });
        const updatedAfter = new Date(
          profile.template.evolution?.lastUpdatedAt
          ?? profile.template.updatedAt
          ?? profile.updatedAt,
        ).getTime();
        const distinctSessions = new Map();
        for (const event of recentEvents) {
          const metadata = event.metadata;
          const eventTime = new Date(event.createdAt).getTime();
          if (
            event.eventType !== "behavior.verify"
            || event.outcome !== "success"
            || event.sessionId === null
            || !metadata
            || metadata.profileId !== profileId
            || metadata.strongVerification !== true
            || !metadata.updateCandidate?.vector
            || !Number.isFinite(eventTime)
            || eventTime <= updatedAfter
            || distinctSessions.has(event.sessionId)
          ) {
            continue;
          }
          distinctSessions.set(event.sessionId, {
            sessionId: `session:${event.sessionId}`,
            strongVerification: true,
            vector: metadata.updateCandidate.vector,
          });
        }
        const evolved = evolveTemplate(
          profile.template,
          [...distinctSessions.values()],
          { updatedAt: currentDate(clock).toISOString() },
        );
        driftUpdate = evolved.update;
        if (evolved.update.status === "updated") {
          await database.setProfile(
            request.auth.user.id,
            profileId,
            evolved.template,
          );
          await appendAudit({
            userId: request.auth.user.id,
            sessionId: request.auth.session.id,
            eventType: "profile.evolve",
            metadata: {
              profileId,
              sourceVerificationEventId: verificationEvent.id,
              acceptedSessionIds:
                evolved.update.acceptedSessionIds,
              rejectedSessions:
                evolved.update.rejectedSessions,
              meanShifts: evolved.update.meanShifts,
              learningRate: evolved.update.learningRate,
            },
          }, request);
        }
      }

      response.json({
        profileId,
        evaluatedAt: currentDate(clock).toISOString(),
        behaviorVerifiedUntil:
          behaviorVerifiedUntil && behaviorVerifiedUntil.toISOString(),
        diagnostics: behaviorDiagnostics,
        templateAccess: {
          ...templateState,
          transferRestricted,
        },
        driftUpdate,
        ...result,
      });
    }
  );

  async function deleteProfile(request, response, reset = false) {
    const profileId = validateProfileId(request.params.profileId);
    const deleted = await database.deleteProfile(
      request.auth.user.id,
      profileId
    );
    if (!deleted) {
      throw new NotFoundError(`Profile "${profileId}" is not enrolled.`);
    }
    await database.setBehaviorVerifiedUntil(request.auth.session.id, null);
    await appendAudit({
      userId: request.auth.user.id,
      sessionId: request.auth.session.id,
      eventType: "profile.delete",
      metadata: { profileId, reset },
    }, request);
    response.json({ profileId, deleted: true, reset });
  }

  app.delete(
    "/api/profiles/:profileId",
    sameOrigin,
    requireCsrf,
    requireAuthentication,
    requireRecentStrongAuthorization,
    (request, response) => deleteProfile(request, response)
  );

  app.post(
    "/api/profiles/:profileId/reset",
    sameOrigin,
    requireCsrf,
    requireAuthentication,
    requireRecentStrongAuthorization,
    (request, response) => deleteProfile(request, response, true)
  );

  app.get(
    "/api/audit",
    requireAuthentication,
    async (request, response) => {
      const limit = request.query.limit === undefined
        ? 50
        : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError(
          "Audit limit must be an integer between 1 and 100."
        );
      }
      const before = request.query.before;
      if (
        before !== undefined
        && (
          typeof before !== "string"
          || before.length > 100
          || Number.isNaN(new Date(before).getTime())
        )
      ) {
        throw new ValidationError("Audit before cursor is invalid.");
      }
      const events = await database.listAudit({
        userId: request.auth.user.id,
        limit,
        before,
      });
      response.json({ events });
    }
  );

  app.post(
    "/api/actions/secure-record",
    sameOrigin,
    verificationLimiter,
    requireCsrf,
    requireAuthentication,
    async (request, response) => {
      requireObjectBody(request.body);
      const now = currentDate(clock);
      const behaviorActive = isFuture(
        request.auth.session.behaviorVerifiedUntil,
        now
      );
      const stepUpActive = isFuture(
        request.auth.session.stepUpUntil,
        now
      );

      if (!behaviorActive && !stepUpActive) {
        await appendAudit({
          userId: request.auth.user.id,
          sessionId: request.auth.session.id,
          eventType: "secure_record.access",
          outcome: "denied",
          reasonCode: "RECENT_VERIFICATION_REQUIRED",
        }, request);
        throw new HttpError(
          403,
          "STEP_UP_REQUIRED",
          "Recent behavioral verification or password step-up is required."
        );
      }

      const authorizedBy = behaviorActive ? "behavior" : "password_step_up";
      const accessEvent = await appendAudit({
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "secure_record.access",
        metadata: { authorizedBy },
      }, request);
      const profiles = await database.listProfiles(request.auth.user.id);
      const recentEvents = await database.listAudit({
        userId: request.auth.user.id,
        limit: 12,
      });
      const grantExpiresAt = behaviorActive
        ? request.auth.session.behaviorVerifiedUntil
        : request.auth.session.stepUpUntil;
      const latestVerificationEvent = recentEvents.find(
        (event) =>
          event.eventType === "behavior.verify"
          && event.sessionId === request.auth.session.id
      );
      const latestVerificationMetadata =
        latestVerificationEvent
        && latestVerificationEvent.metadata
        && typeof latestVerificationEvent.metadata === "object"
          ? latestVerificationEvent.metadata
          : {};
      const latestBehaviorDiagnostics =
        latestVerificationMetadata.behaviorDiagnostics
        && typeof latestVerificationMetadata.behaviorDiagnostics === "object"
          ? latestVerificationMetadata.behaviorDiagnostics
          : null;
      const currentIpAddress = observedIp(request);
      const profileSummaries = profiles.map((profile) => ({
        ...profile,
        maturity:
          profile.sampleCount >= 15
            ? "Expanded baseline"
            : profile.sampleCount >= 8
              ? "Developing baseline"
              : "Starter baseline",
      }));
      const totalEnrollmentSamples = profiles.reduce(
        (total, profile) => total + profile.sampleCount,
        0
      );
      const signalFeatureCount = profiles.reduce(
        (maximum, profile) => Math.max(maximum, profile.featureCount),
        0
      );
      const grantExpiresAtMs = new Date(grantExpiresAt).getTime();
      const grantRemainingSeconds = Number.isFinite(grantExpiresAtMs)
        ? Math.max(
            0,
            Math.ceil((grantExpiresAtMs - now.getTime()) / 1_000)
          )
        : null;
      const recommendations = [
        authorizedBy === "behavior"
          ? "Re-run Signal Trail when the current behavior grant expires or interaction conditions change."
          : "Complete Signal Trail to replace password step-up with a current behavioral assessment.",
        "Keep a password or passkey fallback because behavioral similarity is a risk signal, not proof of identity.",
        "Measure false acceptance and false rejection rates on consented, representative data before setting a production threshold.",
      ];
      if (profiles.some((profile) => profile.sampleCount < 8)) {
        recommendations.unshift(
          "Treat this as a starter baseline. Evaluate repeat sessions, normal day-to-day variation, and device changes before relying on it."
        );
      }

      response.json({
        authorizedBy,
        record: {
          reportVersion: 3,
          id: `ATH-ACCESS-${String(accessEvent.id).padStart(6, "0")}`,
          title: "Account security report",
          classification: "Protected account data",
          generatedAt: accessEvent.createdAt,
          summary: {
            status: "Access authorized",
            posture:
              authorizedBy === "behavior"
                ? "Behavior matched"
                : "Password step-up passed",
            explanation:
              authorizedBy === "behavior"
                ? "The latest interaction matched the enrolled profile and produced an active behavior grant."
                : "No active behavior grant was available, so the account password authorized this report.",
            latestTrustPercent:
              Number.isFinite(latestVerificationMetadata.trustPercent)
                ? latestVerificationMetadata.trustPercent
                : null,
            latestDecision: latestVerificationMetadata.decision || null,
            profileCount: profiles.length,
            totalEnrollmentSamples,
            signalFeatureCount,
            averageKeyHoldMs:
              latestBehaviorDiagnostics?.keyboard?.averageKeyHoldMs ?? null,
            cadencePattern:
              latestBehaviorDiagnostics?.typing?.cadencePattern ?? null,
          },
          account: {
            username: request.auth.user.username,
            createdAt: request.auth.user.createdAt,
          },
          authorization: {
            method: authorizedBy,
            grantExpiresAt,
            grantRemainingSeconds,
            sessionExpiresAt: request.auth.session.expiresAt,
          },
          session: {
            createdAt: request.auth.session.createdAt,
            lastSeenAt: request.auth.session.lastSeenAt,
            expiresAt: request.auth.session.expiresAt,
          },
          network: {
            currentIpAddress,
            latestVerificationIpAddress:
              latestVerificationMetadata.ipAddress || null,
            sameAsLatestVerification:
              Boolean(latestVerificationMetadata.ipAddress) &&
              latestVerificationMetadata.ipAddress === currentIpAddress,
            source:
              "Server-observed request address after configured trusted-proxy rules.",
          },
          latestVerification: latestVerificationEvent
            ? {
                evaluatedAt: latestVerificationEvent.createdAt,
                profileId: latestVerificationMetadata.profileId || null,
                trustPercent:
                  Number.isFinite(latestVerificationMetadata.trustPercent)
                    ? latestVerificationMetadata.trustPercent
                    : null,
                normalizedDistance:
                  Number.isFinite(latestVerificationMetadata.normalizedDistance)
                    ? latestVerificationMetadata.normalizedDistance
                    : null,
                decision: latestVerificationMetadata.decision || null,
                reasonCodes: Array.isArray(
                  latestVerificationMetadata.reasonCodes
                )
                  ? latestVerificationMetadata.reasonCodes
                  : [],
                ipAddress: latestVerificationMetadata.ipAddress || null,
                behaviorDiagnostics: latestBehaviorDiagnostics,
                grantActive: behaviorActive,
              }
            : null,
          controls: [
            {
              name: "Authenticated account session",
              status: "Active",
              detail: "The report is scoped to the signed-in account.",
            },
            {
              name: "Same-origin request validation",
              status: "Passed",
              detail: "The protected request originated from the Odysseus site.",
            },
            {
              name: "CSRF token validation",
              status: "Passed",
              detail: "The request included a valid session-bound token.",
            },
            {
              name: "Encrypted behavioral templates",
              status: profiles.length > 0 ? "Active" : "Not enrolled",
              detail:
                profiles.length > 0
                  ? "Account-scoped templates are encrypted at rest with AES-256-GCM."
                  : "No behavioral profile is stored for this account.",
            },
            {
              name: "Recent authorization grant",
              status: "Active",
              detail:
                authorizedBy === "behavior"
                  ? "Issued after a matching behavior challenge."
                  : "Issued after password step-up.",
            },
            {
              name: "Server-observed network address",
              status: currentIpAddress ? "Recorded" : "Unavailable",
              detail:
                "The address comes from the connection and only trusts forwarded values when trusted-proxy handling is configured.",
            },
            {
              name: "Baseline bootstrap assurance",
              status: "Limited",
              detail:
                "The browser rejects basic script-dispatched events, but no external proof-of-human or WebAuthn user-verification ceremony is configured.",
            },
          ],
          privacy: {
            browserProcessing:
              "Guided and free-typing text is evaluated locally and discarded after each mission.",
            transmitted:
              "Aggregate keyboard timing, pointer movement, pause and burst counts, and text-free word positions are submitted.",
            stored:
              "The server stores an encrypted statistical template plus security audit metadata containing aggregate diagnostics and server-observed IP addresses.",
            excluded: [
              "Free-typing content",
              "Raw keystroke events",
              "Individual key identities",
              "Raw pointer coordinates",
              "Passwords or session tokens in audit events",
            ],
          },
          geminiReadiness: {
            status: "Structured context ready, no AI model called",
            schemaVersion: 1,
            intendedUse:
              "Explain the deterministic behavior result and highlight anomalies for human review.",
            authorizationBoundary:
              "Gemini must not issue grants, change trust scores, or replace the server policy.",
            availableSignals: [
              "Trust score and normalized distance",
              "Current and baseline timing comparisons",
              "Pause, burst, and cadence summaries",
              "Slow guided words and anonymous free-word positions",
              "Server-observed IP consistency",
            ],
            excludedContext: [
              "Passwords",
              "Session tokens",
              "Free-typing content",
              "Raw keystroke or pointer event streams",
            ],
          },
          limitations: [
            "This MVP uses a small, mostly single-session baseline.",
            "Its aggregate features do not model individual key identities or full pointer paths.",
            "Word duration is an approximate interval derived from browser input timing, not a linguistic or cognitive measurement.",
            "An IP address can identify a network path, not a person, and proxy configuration affects its accuracy.",
            "Trusted browser events provide basic automation resistance, not proof that the enrollee is human or the rightful account owner.",
            "Its decision threshold has not been calibrated against a representative impostor population.",
            "Device, posture, fatigue, injury, and accessibility needs can change legitimate behavior.",
          ],
          recommendations,
          profiles: profileSummaries,
          recentActivity: recentEvents.map((event) => ({
            eventType: event.eventType,
            outcome: event.outcome,
            reasonCode: event.reasonCode,
            ipAddress: event.metadata?.ipAddress || null,
            detail:
              event.eventType === "behavior.verify"
              && Number.isFinite(event.metadata?.trustPercent)
                ? `${event.metadata.trustPercent}% trust, ${
                    event.metadata.decision || "evaluated"
                  }`
                : event.eventType === "profile.enroll"
                  ? `${event.metadata?.sampleCount || 0} samples enrolled`
                  : event.eventType === "secure_record.access"
                    ? readableAuthorizationMethod(
                        event.metadata?.authorizedBy
                      )
                    : null,
            createdAt: event.createdAt,
          })),
        },
      });
    }
  );

  app.use("/api", (request, response) => {
    response.status(404).json({
      error: {
        code: "ENDPOINT_NOT_FOUND",
        message: "API endpoint not found.",
      },
    });
  });

  app.get("/vendor/fingerprintjs.min.js", (request, response) => {
    response.sendFile(
      path.join(
        __dirname,
        "node_modules",
        "@fingerprintjs",
        "fingerprintjs",
        "dist",
        "fp.umd.min.js",
      ),
      {
        headers: {
          "Cache-Control": production
            ? "public, max-age=86400"
            : "no-store",
        },
      },
    );
  });

  app.use(express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    index: "index.html",
    maxAge: 0,
  }));

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    if (
      error instanceof ValidationError
      || error instanceof AuthValidationError
      || error instanceof DatabaseValidationError
      || error instanceof DomainValidationError
      || error instanceof WebAuthnVerificationError
    ) {
      response.status(400).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    if (error instanceof DatabaseConflictError) {
      response.status(409).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    if (
      error instanceof SyntaxError
      && error.type === "entity.parse.failed"
    ) {
      response.status(400).json({
        error: {
          code: "INVALID_JSON",
          message: "Request body contains invalid JSON.",
        },
      });
      return;
    }

    if (error.type === "entity.too.large") {
      response.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "JSON payload exceeds the 100kb limit.",
        },
      });
      return;
    }

    console.error("Unhandled request error:", error);
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "The server could not complete the request.",
      },
    });
  });

    return app;
  } catch (error) {
    try {
      await Promise.allSettled([
        database.close(),
        closeRedisClient(ownedRedisClient),
      ]);
    } catch (closeError) {
      console.error("Odysseus database cleanup failed:", closeError);
    }
    throw error;
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

async function startServer(options = {}) {
  const environment = options.env ?? process.env;
  const port = parsePort(options.port ?? environment.PORT ?? 3000);
  const host = options.host ?? environment.HOST ?? "127.0.0.1";
  const app = await createApp({
    ...options,
    env: environment,
    allowedOrigins:
      options.allowedOrigins
      ?? parseAllowedOrigins(environment.ODYSSEUS_ALLOWED_ORIGINS),
    trustProxy:
      options.trustProxy
      ?? parseTrustProxy(environment.ODYSSEUS_TRUST_PROXY),
    sessionTtlMs:
      options.sessionTtlMs ?? environment.ODYSSEUS_SESSION_TTL_MS,
    stepUpGrantMs:
      options.stepUpGrantMs ?? environment.ODYSSEUS_STEP_UP_GRANT_MS,
    behaviorGrantMs:
      options.behaviorGrantMs ?? environment.ODYSSEUS_BEHAVIOR_GRANT_MS,
    databasePath:
      options.databasePath ?? environment.ODYSSEUS_DATABASE_PATH,
    masterKey: options.masterKey,
    masterKeyPath:
      options.masterKeyPath ?? environment.ODYSSEUS_MASTER_KEY_PATH,
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Odysseus listening at http://${host}:${port}`);
      resolve({
        app,
        database: app.locals.database,
        server,
        host,
        port,
      });
    });
    server.once("error", async (error) => {
      await app.locals.closeDatabase();
      reject(error);
    });
    server.once("close", () => {
      Promise.resolve(app.locals.closeDatabase()).catch((error) => {
        console.error("Odysseus database close failed:", error);
      });
    });
  });
}

async function closeRuntime(runtime) {
  if (!runtime || !runtime.server) {
    return;
  }

  if (runtime.server.listening) {
    await new Promise((resolve, reject) => {
      runtime.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await runtime.database?.close();
}

function installGracefulShutdown(runtime, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  let stopping = false;
  const handlers = new Map();

  const shutdown = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`Odysseus received ${signal}. Closing cleanly.`);
    const forceTimer = setTimeout(() => {
      console.error("Odysseus shutdown timed out.");
      process.exitCode = 1;
      runtime.server.closeAllConnections?.();
    }, timeoutMs);
    forceTimer.unref();

    try {
      await closeRuntime(runtime);
    } catch (error) {
      console.error("Odysseus shutdown failed:", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(forceTimer);
    }
  };

  for (const signal of signals) {
    const handler = () => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return function removeShutdownHandlers() {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

if (require.main === module) {
  startServer()
    .then((runtime) => {
      installGracefulShutdown(runtime);
    })
    .catch((error) => {
      console.error("Odysseus failed to start:", error);
      process.exitCode = 1;
    });
}

module.exports = {
  CSRF_COOKIE,
  HttpError,
  NotFoundError,
  SESSION_COOKIE,
  closeRuntime,
  createApp,
  currentDate,
  getProfileOrThrow,
  installGracefulShutdown,
  parseAllowedOrigins,
  parseAdministratorUserIds,
  parseDuration,
  parsePort,
  parseTrustProxy,
  publicSession,
  publicUser,
  requireObjectBody,
  startServer,
};
