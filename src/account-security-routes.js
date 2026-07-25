"use strict";

const MAX_PROFILE_ID_LENGTH = 64;

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`account security routes require context.${name}.`);
  }
  return value;
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`account security routes require context.${name}.`);
  }
  return value;
}

function validateContext(context) {
  assertObject(context, "database");
  const requiredFunctions = [
    "appendAudit",
    "authLimiter",
    "clearDeviceCookie",
    "createAuthenticatedSession",
    "decodeWebAuthnClientData",
    "publicDevice",
    "publicPasskey",
    "publicSession",
    "publicUser",
    "requestOrigin",
    "requireAuthentication",
    "requireCsrf",
    "requireRecentStrongAuthorization",
    "sameOrigin",
    "setDeviceCookie",
    "verificationLimiter",
  ];
  for (const name of requiredFunctions) {
    assertFunction(context[name], name);
  }
  assertFunction(context.HttpError, "HttpError");
  if (context.clock !== undefined) {
    assertFunction(context.clock, "clock");
  }
  if (context.webAuthnService !== null) {
    assertObject(context.webAuthnService, "webAuthnService");
  }
  return context;
}

function requestBody(request, context) {
  if (
    request.body === null
    || typeof request.body !== "object"
    || Array.isArray(request.body)
  ) {
    throw new context.HttpError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body must be a JSON object.",
    );
  }
  return request.body;
}

function bodyObject(value, name, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new context.HttpError(
      400,
      "INVALID_INPUT",
      `${name} must be a JSON object.`,
    );
  }
  return value;
}

function positiveId(value, name, context) {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new context.HttpError(
      400,
      "INVALID_IDENTIFIER",
      `${name} must be a positive integer.`,
    );
  }
  return parsed;
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

function optionalProfileId(value, context) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof context.validateProfileId === "function") {
    return context.validateProfileId(value);
  }
  return boundedString(value, "profileId", context, {
    maximum: MAX_PROFILE_ID_LENGTH,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  });
}

function currentDate(context) {
  const value = typeof context.clock === "function"
    ? context.clock()
    : Date.now();
  const date = value instanceof Date ? new Date(value) : new Date(Number(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("context.clock must return a Date or timestamp.");
  }
  return date;
}

function futureTimestamp(value, context) {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp > currentDate(context).getTime();
}

function credentialId(response, context) {
  const value = response && (response.id || response.rawId);
  return boundedString(value, "credential.id", context, {
    maximum: 1_366,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
}

function webAuthnUnavailable(context) {
  if (
    !context.webAuthnService
    || typeof context.webAuthnService.createRegistrationOptions !== "function"
    || typeof context.webAuthnService.createAuthenticationOptions !== "function"
    || typeof context.webAuthnService.verifyRegistration !== "function"
    || typeof context.webAuthnService.verifyAuthentication !== "function"
  ) {
    throw new context.HttpError(
      503,
      "PASSKEYS_UNAVAILABLE",
      "Passkey operations are not configured.",
    );
  }
  return context.webAuthnService;
}

function publicProviderState(name, provider, readiness) {
  const state = readiness && typeof readiness === "object"
    ? readiness
    : {};
  return {
    provider: name,
    configured: Boolean(provider) && state.disabled !== true,
    ready: state.ready === true,
    disabled: !provider || state.disabled === true,
    reason: typeof state.reason === "string" ? state.reason : null,
  };
}

async function providerState(name, provider) {
  if (!provider) {
    return publicProviderState(name, null, { disabled: true });
  }
  let readiness = {};
  if (typeof provider.readiness === "function") {
    try {
      readiness = await provider.readiness();
    } catch {
      readiness = { ready: false, reason: "readiness_check_failed" };
    }
  }
  return publicProviderState(name, provider, readiness);
}

async function createSecurityNotification(context, userId, input) {
  const notification = await context.database.createSecurityNotification(
    userId,
    input,
  );
  const provider = context.notificationProvider;
  if (provider && typeof provider.deliver === "function") {
    const externalType = new Map([
      ["device.registered", "new_device"],
      ["device.revoked", "new_device"],
      ["passkey.registered", "profile_changed"],
      ["password.reset", "recovery_event"],
      ["recovery_codes.rotated", "recovery_event"],
    ]).get(input.type) ?? "system";
    try {
      await provider.deliver({
        recipient: { userId },
        notification: {
          type: externalType,
          severity: input.severity,
          title: input.title,
          body: input.body,
          metadata: input.metadata,
        },
        channels: ["webhook", "email"],
      });
    } catch {
      return notification;
    }
  }
  return notification;
}

async function consumeVerifiedChallenge(
  context,
  challenge,
  ceremony,
  origin,
  expectedUserId,
) {
  const record = await context.database.consumeWebAuthnChallenge(
    challenge,
    {
      ceremony,
      rpId: context.webAuthnService.rpId,
      origin,
    },
  );
  if (
    !record
    || (
      expectedUserId !== undefined
      && expectedUserId !== null
      && record.userId !== expectedUserId
    )
  ) {
    throw new context.HttpError(
      401,
      "PASSKEY_CHALLENGE_REJECTED",
      "The passkey challenge is invalid, expired, or already used.",
    );
  }
  return record;
}

function passkeyVerificationError(context) {
  return new context.HttpError(
    401,
    "PASSKEY_VERIFICATION_FAILED",
    "The passkey response could not be verified.",
  );
}

async function recordAudit(context, request, event) {
  return context.appendAudit(event, request);
}

async function securitySummary(request, context) {
  const userId = request.auth.user.id;
  let profileId = optionalProfileId(request.query.profileId, context);
  if (!profileId) {
    const profiles = await context.database.listProfiles(userId);
    profileId = profiles[0]?.profileId ?? null;
  }
  const profile = profileId
    ? await context.database.getProfile(userId, profileId)
    : null;
  const associations = profileId && request.device
    ? await context.database.listDeviceProfileAssociations(userId, {
      deviceId: request.device.id,
      profileId,
    })
    : [];
  const transferredAssociation = associations.some(
    (association) => association.relationship === "transferred",
  );

  let accessState = {
    state: transferredAssociation ? "restricted" : "active",
    allowSensitiveActions: !transferredAssociation,
    stepUpRequired: transferredAssociation,
    reasonCode: transferredAssociation
      ? "CROSS_DEVICE_RECALIBRATION_REQUIRED"
      : "TEMPLATE_ACTIVE",
  };
  if (
    profile
    && typeof context.templateAccessState === "function"
  ) {
    accessState = context.templateAccessState(profile.template);
    if (transferredAssociation) {
      accessState = {
        state: "restricted",
        allowSensitiveActions: false,
        stepUpRequired: true,
        reasonCode: "CROSS_DEVICE_RECALIBRATION_REQUIRED",
      };
    }
  }

  const baselineQuality = profile
    ? Math.max(0, Math.min(1, Number(profile.sampleCount || 0) / 5))
    : null;
  let confidence = null;
  let confidenceState = null;
  if (typeof context.evaluateDeviceConfidence === "function") {
    const evaluated = context.evaluateDeviceConfidence({
      behaviorDecision: futureTimestamp(
        request.auth.session.behaviorVerifiedUntil,
        context,
      )
        ? "allow"
        : "unavailable",
      credentialAnomaly: false,
      credentialBinding: "unknown",
      credentialStatus: "unavailable",
      crossDeviceTransferRestricted: accessState.state === "restricted",
      descriptorChanged: false,
      deviceRecordFound: Boolean(request.device),
      fingerprintStatus: "unavailable",
      humanProofStatus: "unavailable",
      recentFailureCount: 0,
      replaySuspected: false,
      sessionBindingStatus: request.device ? "match" : "unavailable",
      userVerification: false,
    });
    confidence = evaluated.score / 100;
    confidenceState = evaluated.state;
  }

  return {
    profileId,
    calibration: baselineQuality,
    calibrationConfidence: baselineQuality,
    drift: null,
    driftScore: null,
    deviceConfidence: confidence,
    deviceState: confidenceState,
    accessState,
    message: profile
      ? "Baseline quality and current server security state are shown. Drift requires a recent verified sample."
      : "No behavioral profile is enrolled.",
  };
}

function registerDeviceRoutes(app, context) {
  app.get(
    "/api/devices",
    context.requireAuthentication,
    async (request, response) => {
      const devices = await context.database.listDevices(
        request.auth.user.id,
      );
      response.json({
        devices: devices.map((device) => context.publicDevice(
          device,
          request.device?.id,
        )),
      });
    },
  );

  app.post(
    "/api/devices",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requestBody(request, context);
      if (
        request.device
        && typeof context.database.evaluateDeviceSignals === "function"
      ) {
        const signals = await context.database.evaluateDeviceSignals(
          request.auth.user.id,
          request.device.id,
          body.descriptor,
          body.clientFingerprint ?? null,
        );
        if (
          signals?.coarseMatch === true
          && signals.clientFingerprintState !== "changed"
        ) {
          await context.database.touchDevice(
            request.auth.user.id,
            request.device.id,
          );
          response.json({
            device: context.publicDevice(
              request.device,
              request.device.id,
            ),
            recognized: true,
            signals,
          });
          return;
        }
      }
      const registered = await context.database.registerDevice(
        request.auth.user.id,
        {
          label: body.label,
          descriptor: body.descriptor,
          clientFingerprint: body.clientFingerprint ?? null,
          profileId: body.profileId,
          ttlMs: context.deviceCookieTtlMs,
        },
      );
      context.setDeviceCookie(
        response,
        registered.token,
        registered.device.tokenExpiresAt,
      );
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "device.register",
        metadata: {
          deviceId: registered.device.id,
          clientFingerprintProvided:
            typeof body.clientFingerprint === "string",
        },
      });
      await createSecurityNotification(
        context,
        request.auth.user.id,
        {
          type: "device.registered",
          severity: "info",
          title: "Device registered",
          body: "A browser device was added to your account.",
          metadata: { deviceId: registered.device.id },
        },
      );
      response.status(201).json({
        device: context.publicDevice(
          registered.device,
          registered.device.id,
        ),
      });
    },
  );

  app.delete(
    "/api/devices/:deviceId",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const deviceId = positiveId(
        request.params.deviceId,
        "deviceId",
        context,
      );
      const revoked = await context.database.revokeDevice(
        request.auth.user.id,
        deviceId,
      );
      if (!revoked) {
        throw new context.HttpError(
          404,
          "DEVICE_NOT_FOUND",
          "The active device was not found.",
        );
      }
      if (request.device?.id === deviceId) {
        context.clearDeviceCookie(response);
      }
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "device.revoke",
        metadata: { deviceId },
      });
      await createSecurityNotification(
        context,
        request.auth.user.id,
        {
          type: "device.revoked",
          severity: "warning",
          title: "Device revoked",
          body: "A managed device was removed from your account.",
          metadata: { deviceId },
        },
      );
      response.json({ revoked: true, deviceId });
    },
  );
}

function registerPasskeyRoutes(app, context) {
  app.get(
    "/api/auth/passkeys",
    context.requireAuthentication,
    async (request, response) => {
      const credentials =
        await context.database.listWebAuthnCredentials(
          request.auth.user.id,
        );
      response.json({
        credentials: credentials.map(context.publicPasskey),
      });
    },
  );

  app.post(
    "/api/auth/passkeys/register/options",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      requestBody(request, context);
      const service = webAuthnUnavailable(context);
      const origin = context.requestOrigin(request);
      const credentials = await context.database.listWebAuthnCredentials(
        request.auth.user.id,
      );
      const challenge = await context.database.createWebAuthnChallenge({
        userId: request.auth.user.id,
        ceremony: "registration",
        rpId: service.rpId,
        origin,
      });
      const options = await service.createRegistrationOptions({
        user: request.auth.user,
        credentials,
        challenge: challenge.challenge,
      });
      response.json(options);
    },
  );

  app.post(
    "/api/auth/passkeys/register/verify",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requestBody(request, context);
      const service = webAuthnUnavailable(context);
      const origin = context.requestOrigin(request);
      const credential = bodyObject(
        body.credential,
        "credential",
        context,
      );
      const clientData = context.decodeWebAuthnClientData(
        credential,
        "webauthn.create",
      );
      if (clientData.crossOrigin === true) {
        throw passkeyVerificationError(context);
      }
      let verified;
      try {
        verified = await service.verifyRegistration({
          response: credential,
          origin,
          expectedChallenge: clientData.challenge,
          name: body.name ?? "Passkey",
        });
      } catch {
        await recordAudit(context, request, {
          userId: request.auth.user.id,
          sessionId: request.auth.session.id,
          eventType: "passkey.register",
          outcome: "denied",
          reasonCode: "PASSKEY_VERIFICATION_FAILED",
        });
        throw passkeyVerificationError(context);
      }
      await consumeVerifiedChallenge(
        context,
        clientData.challenge,
        "registration",
        origin,
        request.auth.user.id,
      );
      const stored = await context.database.createWebAuthnCredential(
        request.auth.user.id,
        verified,
      );
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "passkey.register",
        metadata: {
          credentialId: stored.id,
          backupEligible: stored.backupEligible,
          backupState: stored.backupState,
          userVerified: stored.userVerified,
        },
      });
      await createSecurityNotification(
        context,
        request.auth.user.id,
        {
          type: "passkey.registered",
          severity: "info",
          title: "Passkey added",
          body: "A user-verified passkey was added to your account.",
          metadata: {
            credentialId: stored.id,
            backupEligible: stored.backupEligible,
          },
        },
      );
      response.status(201).json({
        credential: context.publicPasskey(stored),
      });
    },
  );

  app.post(
    "/api/auth/passkeys/login/options",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    async (request, response) => {
      const body = requestBody(request, context);
      const service = webAuthnUnavailable(context);
      const origin = context.requestOrigin(request);
      let user = null;
      if (typeof body.username === "string" && body.username.trim()) {
        try {
          const username = typeof context.normalizeUsername === "function"
            ? context.normalizeUsername(body.username)
            : body.username.trim().toLowerCase();
          user = await context.database.getUserByUsername(username);
          if (user?.disabledAt) {
            user = null;
          }
        } catch {
          user = null;
        }
      }
      const credentials = user
        ? await context.database.listWebAuthnCredentials(user.id)
        : null;
      const challenge = await context.database.createWebAuthnChallenge({
        userId: user?.id ?? null,
        ceremony: "authentication",
        rpId: service.rpId,
        origin,
      });
      const options = await service.createAuthenticationOptions({
        credentials,
        challenge: challenge.challenge,
      });
      response.json(options);
    },
  );

  app.post(
    "/api/auth/passkeys/login/verify",
    context.sameOrigin,
    context.authLimiter,
    context.requireCsrf,
    async (request, response) => {
      const body = requestBody(request, context);
      const service = webAuthnUnavailable(context);
      const origin = context.requestOrigin(request);
      const credentialResponse = bodyObject(
        body.credential,
        "credential",
        context,
      );
      const clientData = context.decodeWebAuthnClientData(
        credentialResponse,
        "webauthn.get",
      );
      if (clientData.crossOrigin === true) {
        throw passkeyVerificationError(context);
      }
      const storedCredential = await context.database.getWebAuthnCredential(
        credentialId(credentialResponse, context),
      );
      if (!storedCredential) {
        throw passkeyVerificationError(context);
      }
      let verified;
      try {
        verified = await service.verifyAuthentication({
          response: credentialResponse,
          origin,
          expectedChallenge: clientData.challenge,
          credential: storedCredential,
        });
      } catch {
        await recordAudit(context, request, {
          userId: storedCredential.userId,
          eventType: "passkey.login",
          outcome: "denied",
          reasonCode: "PASSKEY_VERIFICATION_FAILED",
        });
        throw passkeyVerificationError(context);
      }
      const challenge = await consumeVerifiedChallenge(
        context,
        clientData.challenge,
        "authentication",
        origin,
        null,
      );
      if (
        challenge.userId !== null
        && challenge.userId !== storedCredential.userId
      ) {
        throw passkeyVerificationError(context);
      }
      const user = await context.database.getUserById(
        storedCredential.userId,
      );
      if (!user || user.disabledAt) {
        throw passkeyVerificationError(context);
      }
      const updatedCredential =
        await context.database.updateWebAuthnCredentialUsage(
          storedCredential.credentialId,
          verified,
        );
      if (!updatedCredential) {
        throw passkeyVerificationError(context);
      }
      const credentials = await context.createAuthenticatedSession(
        user,
        response,
        { strongAuthentication: true },
      );
      await recordAudit(context, request, {
        userId: user.id,
        sessionId: credentials.session.id,
        eventType: "passkey.login",
        metadata: {
          credentialId: updatedCredential.id,
          backupEligible: updatedCredential.backupEligible,
          backupState: updatedCredential.backupState,
          userVerified: verified.userVerified === true,
        },
      });
      response.json({
        user: context.publicUser(user),
        session: context.publicSession(
          credentials.session,
          currentDate(context),
        ),
      });
    },
  );

  app.delete(
    "/api/auth/passkeys/:credentialId",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const id = boundedString(
        request.params.credentialId,
        "credentialId",
        context,
        {
          maximum: 1_366,
          pattern: /^[A-Za-z0-9_-]+$/,
        },
      );
      const deleted = await context.database.deleteWebAuthnCredential(
        request.auth.user.id,
        id,
      );
      if (!deleted) {
        throw new context.HttpError(
          404,
          "PASSKEY_NOT_FOUND",
          "The account passkey was not found.",
        );
      }
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "passkey.delete",
      });
      response.json({ deleted: true });
    },
  );
}

function registerTurnstileRoute(app, context) {
  app.get("/api/security/turnstile", async (request, response) => {
    const status = await providerState("turnstile", context.proofHuman);
    response.json({
      enabled: status.configured,
      siteKey: status.configured
        ? context.proofHumanSiteKey ?? null
        : null,
      action: status.configured
        ? context.proofHumanAction ?? null
        : null,
      status,
    });
  });
}

function registerProviderRoutes(app, context) {
  app.get("/api/security/capabilities", async (request, response) => {
    const [turnstile, gemini, huggingFace, notifications] =
      await Promise.all([
        providerState("turnstile", context.proofHuman),
        providerState("gemini", context.geminiProvider),
        providerState("hugging_face", context.huggingFaceProvider),
        providerState("notifications", context.notificationProvider),
      ]);
    response.json({
      passkeys: {
        configured: Boolean(context.webAuthnService),
        ready: Boolean(context.webAuthnService),
      },
      providers: {
        turnstile,
        gemini,
        huggingFace,
        notifications,
      },
      authorizationPolicy: {
        aiAuthoritative: false,
        providerOutputsMayGrantAccess: false,
      },
    });
  });

  app.get(
    "/api/security/summary",
    context.requireAuthentication,
    async (request, response) => {
      response.json(await securitySummary(request, context));
    },
  );
}

function registerTransferRoutes(app, context) {
  app.get(
    "/api/profile-transfers",
    context.requireAuthentication,
    async (request, response) => {
      const transfers = await context.database.listProfileTransfers(
        request.auth.user.id,
        { limit: 50 },
      );
      response.json({ transfers });
    },
  );

  app.post(
    "/api/profile-transfers",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requestBody(request, context);
      const sourceDeviceId = positiveId(
        body.sourceDeviceId,
        "sourceDeviceId",
        context,
      );
      if (!request.device || request.device.id !== sourceDeviceId) {
        throw new context.HttpError(
          403,
          "SOURCE_DEVICE_BINDING_REQUIRED",
          "The current device must be the transfer source.",
        );
      }
      const profileId = optionalProfileId(body.profileId, context);
      if (!profileId) {
        throw new context.HttpError(
          400,
          "PROFILE_ID_REQUIRED",
          "profileId is required.",
        );
      }
      const created = await context.database.createProfileTransfer(
        request.auth.user.id,
        {
          profileId,
          sourceDeviceId,
          targetDeviceId: body.targetDeviceId === undefined
            ? undefined
            : positiveId(body.targetDeviceId, "targetDeviceId", context),
          ttlMs: body.ttlMs,
          metadata: { initiatedBy: "account_security" },
        },
      );
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "profile_transfer.create",
        metadata: {
          transferId: created.transfer.id,
          profileId,
          sourceDeviceId,
          targetDeviceId: created.transfer.targetDeviceId,
        },
      });
      response.status(201).json({
        transfer: created.transfer,
        token: created.token,
      });
    },
  );

  app.post(
    "/api/profile-transfers/consume",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requestBody(request, context);
      if (
        typeof context.initializeCrossDeviceTransfer !== "function"
        || typeof context.templateAccessState !== "function"
      ) {
        throw new context.HttpError(
          503,
          "CROSS_DEVICE_MODEL_UNAVAILABLE",
          "Cross-device template initialization is unavailable.",
        );
      }
      const targetDeviceId = positiveId(
        body.targetDeviceId,
        "targetDeviceId",
        context,
      );
      if (!request.device || request.device.id !== targetDeviceId) {
        throw new context.HttpError(
          403,
          "TARGET_DEVICE_BINDING_REQUIRED",
          "The current device must be the transfer target.",
        );
      }
      const sourceProfileId = optionalProfileId(
        body.sourceProfileId,
        context,
      );
      const destinationProfileId = optionalProfileId(
        body.destinationProfileId,
        context,
      );
      if (!sourceProfileId || !destinationProfileId) {
        throw new context.HttpError(
          400,
          "TRANSFER_PROFILE_IDS_REQUIRED",
          "sourceProfileId and destinationProfileId are required.",
        );
      }
      if (sourceProfileId === destinationProfileId) {
        throw new context.HttpError(
          409,
          "DESTINATION_PROFILE_MUST_BE_DISTINCT",
          "The destination profile must not overwrite the source profile.",
        );
      }
      if (
        await context.database.getProfile(
          request.auth.user.id,
          destinationProfileId,
        )
      ) {
        throw new context.HttpError(
          409,
          "DESTINATION_PROFILE_EXISTS",
          "The destination profile already exists.",
        );
      }
      const token =
        boundedString(body.token, "token", context, {
        minimum: 20,
        maximum: 512,
      });
      const completed = await context.database.consumeProfileTransfer(
        token,
        targetDeviceId,
      );
      if (!completed) {
        throw new context.HttpError(
          401,
          "PROFILE_TRANSFER_REJECTED",
          "The transfer token is invalid, expired, or already used.",
        );
      }
      if (
        completed.userId !== request.auth.user.id
        || completed.profileId !== sourceProfileId
      ) {
        throw new context.HttpError(
          409,
          "PROFILE_TRANSFER_CONTEXT_MISMATCH",
          "The transfer does not match the requested source profile.",
        );
      }
      const sourceProfile = await context.database.getProfile(
        request.auth.user.id,
        sourceProfileId,
      );
      if (!sourceProfile) {
        throw new context.HttpError(
          404,
          "SOURCE_PROFILE_NOT_FOUND",
          "The source profile was not found.",
        );
      }
      const initializedAt = currentDate(context).toISOString();
      const restrictedTemplate =
        context.initializeCrossDeviceTransfer(
          sourceProfile.template,
          {
            sourceDeviceId: String(completed.sourceDeviceId),
            destinationDeviceId: String(targetDeviceId),
            initializedAt,
            requiredSamples: body.requiredSamples,
          },
        );
      const destination = await context.database.setProfile(
        request.auth.user.id,
        destinationProfileId,
        restrictedTemplate,
      );
      await context.database.associateDeviceProfile(
        request.auth.user.id,
        targetDeviceId,
        destinationProfileId,
        {
          relationship: "transferred",
          sourceDeviceId: completed.sourceDeviceId,
        },
      );
      const accessState = context.templateAccessState(restrictedTemplate);
      if (
        accessState.state !== "restricted"
        || accessState.allowSensitiveActions !== false
      ) {
        throw new context.HttpError(
          500,
          "UNSAFE_TRANSFER_STATE",
          "The destination template did not enter restricted state.",
        );
      }
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "profile_transfer.consume",
        metadata: {
          transferId: completed.id,
          sourceProfileId,
          destinationProfileId,
          sourceDeviceId: completed.sourceDeviceId,
          targetDeviceId,
          accessState: accessState.state,
        },
      });
      response.status(201).json({
        transfer: completed,
        destinationProfile: destination,
        accessState,
      });
    },
  );

  app.post(
    "/api/profile-transfers/recalibrate",
    context.sameOrigin,
    context.verificationLimiter,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const body = requestBody(request, context);
      if (
        typeof context.recalibrateCrossDeviceTemplate !== "function"
        || typeof context.templateAccessState !== "function"
      ) {
        throw new context.HttpError(
          503,
          "CROSS_DEVICE_MODEL_UNAVAILABLE",
          "Cross-device recalibration is unavailable.",
        );
      }
      if (!request.device) {
        throw new context.HttpError(
          403,
          "TARGET_DEVICE_BINDING_REQUIRED",
          "A registered target device is required.",
        );
      }
      const destinationProfileId = optionalProfileId(
        body.destinationProfileId,
        context,
      );
      if (!destinationProfileId) {
        throw new context.HttpError(
          400,
          "DESTINATION_PROFILE_REQUIRED",
          "destinationProfileId is required.",
        );
      }
      const destinationProfile = await context.database.getProfile(
        request.auth.user.id,
        destinationProfileId,
      );
      if (!destinationProfile) {
        throw new context.HttpError(
          404,
          "DESTINATION_PROFILE_NOT_FOUND",
          "The destination profile was not found.",
        );
      }
      const transfer = destinationProfile.template?.transfer;
      if (
        !transfer
        || transfer.status !== "restricted"
        || transfer.destinationDeviceId !== String(request.device.id)
      ) {
        throw new context.HttpError(
          403,
          "RECALIBRATION_CONTEXT_REJECTED",
          "The restricted template does not belong to this target device.",
        );
      }
      const recalibrated = context.recalibrateCrossDeviceTemplate(
        destinationProfile.template,
        body.samples,
        { recalibratedAt: currentDate(context).toISOString() },
      );
      const accessState = context.templateAccessState(recalibrated);
      if (
        accessState.state !== "active"
        || accessState.allowSensitiveActions !== true
      ) {
        throw new context.HttpError(
          500,
          "UNSAFE_RECALIBRATION_STATE",
          "Recalibration did not produce an active destination template.",
        );
      }
      const updated = await context.database.setProfile(
        request.auth.user.id,
        destinationProfileId,
        recalibrated,
      );
      await context.database.associateDeviceProfile(
        request.auth.user.id,
        request.device.id,
        destinationProfileId,
        {
          relationship: "primary",
          sourceDeviceId: Number(transfer.sourceDeviceId),
        },
      );
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "profile_transfer.recalibrate",
        metadata: {
          destinationProfileId,
          targetDeviceId: request.device.id,
          sampleCount: Array.isArray(body.samples)
            ? body.samples.length
            : null,
          accessState: accessState.state,
        },
      });
      response.json({
        destinationProfile: updated,
        accessState,
      });
    },
  );

  app.delete(
    "/api/profile-transfers/:transferId",
    context.sameOrigin,
    context.requireCsrf,
    context.requireAuthentication,
    context.requireRecentStrongAuthorization,
    async (request, response) => {
      const transferId = positiveId(
        request.params.transferId,
        "transferId",
        context,
      );
      const cancelled = await context.database.cancelProfileTransfer(
        request.auth.user.id,
        transferId,
      );
      if (!cancelled) {
        throw new context.HttpError(
          404,
          "PENDING_TRANSFER_NOT_FOUND",
          "The pending transfer was not found.",
        );
      }
      await recordAudit(context, request, {
        userId: request.auth.user.id,
        sessionId: request.auth.session.id,
        eventType: "profile_transfer.cancel",
        metadata: { transferId },
      });
      response.json({ cancelled: true, transferId });
    },
  );
}

function registerAccountSecurityRoutes(app, suppliedContext) {
  if (
    !app
    || typeof app.get !== "function"
    || typeof app.post !== "function"
    || typeof app.delete !== "function"
  ) {
    throw new TypeError("An Express-compatible app is required.");
  }
  const context = validateContext(suppliedContext);
  registerDeviceRoutes(app, context);
  registerPasskeyRoutes(app, context);
  registerTurnstileRoute(app, context);
  registerProviderRoutes(app, context);
  registerTransferRoutes(app, context);
  return app;
}

module.exports = {
  registerAccountSecurityRoutes,
};
