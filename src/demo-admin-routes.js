"use strict";

const {
  evaluateVector,
  scaledManhattanDistance,
  validateFeatureVector,
  validateProfileId,
} = require("./behavior");
const {
  assessAutomationRisk,
  validateInteractionEvidence,
} = require("./automation-risk");
const {
  MIN_DOWN_DOWN_SAMPLES,
  MIN_DWELL_SAMPLES,
  MIN_FLIGHT_SAMPLES,
  MIN_POINTER_SAMPLES,
} = require("./behavior-lifecycle");
const { sha256 } = require("./crypto");
const {
  buildBehaviorDiagnostics,
  validateTypingDiagnostics,
} = require("./diagnostics");
const { evolveTemplate } = require("./template-evolution");
const { VERIFICATION_ROUNDS } = require("../public/challenge");

const STRONG_TEST_SAMPLE_COUNT = 3;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLoopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || "").toLowerCase();
  return (
    address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
  );
}

function boundedSecret(value) {
  return (
    typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 512
  )
    ? value
    : "";
}

function round(value, places = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
}

function profileFingerprint(profile, index, username) {
  const template = profile.template;
  const featureKeys = Array.isArray(template.featureKeys)
    ? template.featureKeys
    : [];
  return {
    reportLabel: `Report ${index + 1}`,
    subjectLabel: username,
    profileId: profile.profileId,
    sampleCount: profile.sampleCount,
    featureCount: profile.featureCount,
    enrolledAt: profile.enrolledAt,
    updatedAt: profile.updatedAt,
    templateVersion: profile.templateVersion,
    comparisonModel: "Scaled Manhattan Distance",
    acceptanceThreshold: round(template.acceptanceThreshold),
    stepUpThreshold: round(
      Number(template.acceptanceThreshold) * 2.5,
    ),
    calibration: {
      p90EnrollmentDistance: round(template.calibration?.p90Distance),
      maximumEnrollmentDistance: round(
        template.calibration?.maximumDistance,
      ),
    },
    assurance: template.assurance || null,
    evolution: isPlainObject(template.evolution)
      ? {
        updateCount: Number(template.evolution.updateCount) || 0,
        returnUpdateCount:
          Number(template.evolution.returnUpdateCount) || 0,
        lastUpdatedAt:
          template.evolution.lastUpdatedAt
          || template.evolution.lastReturnUpdatedAt
          || null,
        thresholdChanged:
          template.evolution.thresholdChanged === true,
      }
      : null,
    features: featureKeys.map((name) => ({
      name,
      baselineCenter: round(template.means?.[name]),
      normalVariation: round(template.deviations?.[name]),
      normalizationScale: round(template.scales?.[name]),
    })),
  };
}

function decisionHistoryReport(event, index) {
  const metadata = isPlainObject(event.metadata) ? event.metadata : {};
  const decision = isPlainObject(metadata.behaviorDecision)
    ? metadata.behaviorDecision
    : null;
  return {
    decisionLabel: `Decision ${index + 1}`,
    eventType: event.eventType,
    evaluatedAt: event.createdAt,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    profileId:
      metadata.behaviorProfileId
      || metadata.profileId
      || null,
    demoSubjectLabel: metadata.demoSubjectLabel || null,
    decision: decision?.decision || null,
    classification: decision?.classification || null,
    reasonCodes: Array.isArray(decision?.reasonCodes)
      ? decision.reasonCodes
      : [],
    identitySimilarity: isPlainObject(decision?.identitySimilarity)
      ? decision.identitySimilarity
      : null,
    automationRisk: isPlainObject(decision?.automationRisk)
      ? decision.automationRisk
      : null,
    simulatedIpRestriction:
      isPlainObject(decision?.simulatedIpRestriction)
        ? decision.simulatedIpRestriction
        : { displayed: false, enforced: false },
    amendment: isPlainObject(decision?.amendment)
      ? decision.amendment
      : null,
    sampleCounts: isPlainObject(metadata.sampleCounts)
      ? metadata.sampleCounts
      : null,
  };
}

function updateHistoryReport(event, index) {
  const metadata = isPlainObject(event.metadata) ? event.metadata : {};
  const storedAmendment = isPlainObject(metadata.amendment)
    ? metadata.amendment
    : isPlainObject(metadata.testReport?.amendment)
      ? metadata.testReport.amendment
      : null;
  const amendment = storedAmendment || (
    event.eventType === "profile.evolve"
      ? {
        status: "applied",
        reasonCode:
          event.reasonCode
          || "VERIFIED_MULTI_SESSION_DRIFT_APPLIED",
        acceptedSessionIds: Array.isArray(metadata.acceptedSessionIds)
          ? metadata.acceptedSessionIds
          : [],
        rejectedSessions: Array.isArray(metadata.rejectedSessions)
          ? metadata.rejectedSessions
          : [],
        meanShifts: isPlainObject(metadata.meanShifts)
          ? metadata.meanShifts
          : {},
        learningRate: round(metadata.learningRate),
        acceptanceThresholdChanged: false,
      }
      : null
  );
  return {
    updateLabel: `Update ${index + 1}`,
    eventType: event.eventType,
    updatedAt: event.createdAt,
    outcome: event.outcome,
    reasonCode: event.reasonCode || amendment?.reasonCode || null,
    profileId:
      metadata.profileId
      || metadata.behaviorProfileId
      || null,
    source:
      metadata.source
      || (
        event.eventType === "demo_admin.behavior_test"
          ? "approved_admin_test"
          : "verified_behavior"
      ),
    amendment,
  };
}

function comparisonReport(event, index) {
  const metadata = isPlainObject(event.metadata) ? event.metadata : {};
  const diagnostics = isPlainObject(metadata.behaviorDiagnostics)
    ? metadata.behaviorDiagnostics
    : null;
  const automation = isPlainObject(metadata.automationAssessment)
    ? metadata.automationAssessment
    : null;
  return {
    comparisonLabel: `Comparison ${index + 1}`,
    claimedSubject: metadata.demoSubjectLabel || "Unlabeled session",
    evaluatedAt: event.createdAt,
    profileId: metadata.profileId || null,
    outcome: event.outcome,
    identitySimilarity: {
      decision: metadata.decision || null,
      trustPercent: round(metadata.trustPercent, 2),
      normalizedDistance: round(metadata.normalizedDistance),
      acceptanceThreshold: round(metadata.acceptanceThreshold),
      reasonCodes: Array.isArray(metadata.reasonCodes)
        ? metadata.reasonCodes
        : [],
    },
    automationRisk: automation,
    baselineComparison: Array.isArray(diagnostics?.baselineComparison)
      ? diagnostics.baselineComparison
      : [],
    typingSummary: diagnostics?.typing || null,
    keyboardSummary: diagnostics?.keyboard || null,
    pointerSummary: diagnostics?.pointer || null,
  };
}

function strongTestReport(event, index) {
  const report = isPlainObject(event.metadata?.testReport)
    ? event.metadata.testReport
    : {};
  return {
    reportLabel: report.reportLabel || `Strong test ${index + 1}`,
    profileId: report.profileId || event.metadata?.profileId || null,
    subjectLabel:
      report.subjectLabel
      || event.metadata?.demoSubjectLabel
      || "Unlabeled session",
    createdAt: event.createdAt,
    sampleCount: Number(report.sampleCount) || 0,
    identitySimilarity: isPlainObject(report.identitySimilarity)
      ? report.identitySimilarity
      : null,
    automationRisk: isPlainObject(report.automationRisk)
      ? report.automationRisk
      : null,
    amendment: isPlainObject(report.amendment)
      ? report.amendment
      : null,
    featureSummary: Array.isArray(report.featureSummary)
      ? report.featureSummary
      : [],
    samples: Array.isArray(report.samples) ? report.samples : [],
  };
}

function publicActivity(event) {
  return {
    eventType: event.eventType,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    createdAt: event.createdAt,
    ipAddress: event.metadata?.ipAddress || null,
  };
}

async function buildAccountDemoReport(database, user) {
  const [profileMetadata, events, devices, passkeys] = await Promise.all([
    database.listProfiles(user.id),
    database.listAudit({ userId: user.id, limit: 100 }),
    database.listDevices(user.id, { includeRevoked: true }),
    database.listWebAuthnCredentials(user.id),
  ]);
  const profiles = await Promise.all(
    profileMetadata.map((profile) =>
      database.getProfile(user.id, profile.profileId)
    ),
  );
  const comparisons = events
    .filter((event) => event.eventType === "behavior.verify")
    .slice(0, 20)
    .map(comparisonReport);
  const automationFlags = events.filter(
    (event) => event.eventType === "auth.automation_flag",
  );
  const strongTests = events
    .filter((event) => event.eventType === "demo_admin.behavior_test")
    .slice(0, 20)
    .map(strongTestReport);
  const decisionHistory = events
    .filter((event) => isPlainObject(event.metadata?.behaviorDecision))
    .slice(0, 50)
    .map(decisionHistoryReport);
  const updateHistory = events
    .filter((event) => (
      event.eventType === "profile.reinforce"
      || event.eventType === "profile.evolve"
      || (
        event.eventType === "demo_admin.behavior_test"
        && isPlainObject(event.metadata?.amendment)
      )
    ))
    .slice(0, 50)
    .map(updateHistoryReport);
  const suspiciousBehaviorFlags = events.filter(
    (event) => event.eventType === "account.behavior_flag",
  );

  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    demoOnly: true,
    account: {
      username: user.username,
      createdAt: user.createdAt,
      disabled: Boolean(user.disabledAt),
    },
    interpretation: {
      identityQuestion:
        "How close is this interaction to the selected account baseline?",
      automationQuestion:
        "Does this interaction contain patterns associated with automation?",
      separation:
        "A human can differ from Human A, and an agent can imitate Human A. These are separate assessments.",
      caution:
        "Neither assessment proves legal identity, humanity, intent, or account ownership.",
    },
    securityPosture: {
      registeredDevices: devices.filter((device) => !device.revokedAt).length,
      revokedDevices: devices.filter((device) => device.revokedAt).length,
      passkeys: passkeys.length,
      credentialAutomationFlags: automationFlags.length,
      suspiciousBehaviorFlags: suspiciousBehaviorFlags.length,
      accountFlaggedAsSuspicious: suspiciousBehaviorFlags.length > 0,
      strongerReports: strongTests.length,
    },
    fingerprints: profiles
      .filter(Boolean)
      .map((profile, index) =>
        profileFingerprint(profile, index, user.username)
      ),
    comparisons,
    decisionHistory,
    updateHistory,
    strongTests,
    recentActivity: events.slice(0, 50).map(publicActivity),
    omitted: [
      "Account password and password hash",
      "Session and CSRF credentials",
      "Device fingerprint digests",
      "Passkey credential IDs and public keys",
      "Typed text and raw browser events",
      "Encrypted profile ciphertext and encryption key material",
    ],
  };
}

function validateSubjectLabel(value, context) {
  const allowed = new Set(["Human A", "Human B", "Automated agent"]);
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new context.HttpError(
      400,
      "INVALID_DEMO_SUBJECT",
      "The demo subject label is not recognized.",
    );
  }
  return value;
}

function requestBody(request, allowed, context) {
  if (!isPlainObject(request.body)) {
    throw new context.HttpError(
      400,
      "INVALID_REQUEST_BODY",
      "Request body must be a JSON object.",
    );
  }
  if (Object.keys(request.body).some((key) => !allowed.has(key))) {
    throw new context.HttpError(
      400,
      "UNEXPECTED_REQUEST_FIELDS",
      "Request body contains unsupported fields.",
    );
  }
  return request.body;
}

async function authorizeDemoAdmin(request, context, allowed) {
  if (!context.enabled) {
    throw new context.HttpError(
      503,
      "DEMO_ADMIN_DISABLED",
      "The local demo report viewer is not configured.",
    );
  }
  if (!isLoopbackRequest(request)) {
    throw new context.HttpError(
      403,
      "LOCAL_ACCESS_REQUIRED",
      "The demo report viewer is available only from this computer.",
    );
  }
  const body = requestBody(request, allowed, context);
  let username = null;
  try {
    username = context.normalizeUsername(body.username);
  } catch (_error) {
    username = null;
  }
  const user = username
    ? await context.database.getUserByUsername(username)
    : null;
  // The viewer takes the same account credentials as the sign-in page. A
  // dummy hash keeps the work comparable when the account does not exist.
  const suppliedPassword = boundedSecret(body.password);
  const candidateHash = user && !user.disabledAt
    ? user.passwordHash
    : context.dummyPasswordHash;
  const validPassword = await context.verifyPassword(
    suppliedPassword,
    candidateHash,
  );
  if (!user || user.disabledAt || !validPassword) {
    await context.appendAudit({
      userId: user?.id,
      eventType: "demo_admin.report_access",
      outcome: "denied",
      reasonCode: "INVALID_DEMO_ADMIN_CREDENTIALS",
      metadata: username
        ? {
            usernameDigest: sha256(username).toString("hex"),
          }
        : undefined,
    }, request);
    throw new context.HttpError(
      401,
      "INVALID_CREDENTIALS",
      "The account name or password is incorrect.",
    );
  }
  return { body, user };
}

function average(values) {
  const finiteValues = values
    .map(Number)
    .filter((value) => Number.isFinite(value));
  return finiteValues.length > 0
    ? finiteValues.reduce((total, value) => total + value, 0)
      / finiteValues.length
    : null;
}

function strongestAutomationClassification(assessments) {
  const order = new Map([
    ["insufficient_evidence", 0],
    ["human_like_interaction", 1],
    ["elevated_review", 2],
    ["automation_likely", 3],
  ]);
  return assessments
    .map((assessment) => assessment.classification)
    .sort((left, right) =>
      (order.get(right) || 0) - (order.get(left) || 0)
    )[0] || "insufficient_evidence";
}

function compactAutomationAssessment(assessment) {
  return {
    classification: assessment.classification,
    level: assessment.level,
    riskScore: assessment.riskScore,
    reasonCodes: assessment.reasonCodes,
  };
}

function evaluateStrongTest(profile, body, context) {
  if (
    !Array.isArray(body.samples)
    || body.samples.length !== STRONG_TEST_SAMPLE_COUNT
  ) {
    throw new context.HttpError(
      400,
      "INVALID_STRONG_TEST",
      `A stronger report requires exactly ${STRONG_TEST_SAMPLE_COUNT} samples.`,
    );
  }
  const subjectLabel = validateSubjectLabel(
    body.demoSubjectLabel,
    context,
  );
  const evaluated = body.samples.map((sample, index) => {
    if (!isPlainObject(sample)) {
      throw new context.HttpError(
        400,
        "INVALID_STRONG_TEST",
        `Strong test sample ${index + 1} must be an object.`,
      );
    }
    const extras = Object.keys(sample).filter(
      (key) => !new Set([
        "vector",
        "diagnostics",
        "interactionEvidence",
      ]).has(key),
    );
    if (extras.length > 0) {
      throw new context.HttpError(
        400,
        "INVALID_STRONG_TEST",
        `Strong test sample ${index + 1} contains unsupported fields.`,
      );
    }
    const vector = validateFeatureVector(
      sample.vector,
      profile.template.featureKeys,
    ).vector;
    const diagnostics = validateTypingDiagnostics(
      sample.diagnostics,
      VERIFICATION_ROUNDS,
    );
    const evidence = validateInteractionEvidence(
      sample.interactionEvidence,
    );
    const round = diagnostics
      ? VERIFICATION_ROUNDS.find(
          (candidate) => candidate.id === diagnostics.missionId,
        )
      : VERIFICATION_ROUNDS[0];
    const identity = evaluateVector(vector, profile.template);
    const distance = scaledManhattanDistance(vector, profile.template);
    const automation = assessAutomationRisk(
      vector,
      diagnostics,
      evidence,
    );
    const evidenceSufficient = Boolean(
      diagnostics
      && evidence
      && evidence.trustedEventsRequired === true
      && evidence.rejectedSyntheticEvents === 0
      && evidence.sampleCounts.dwell >= MIN_DWELL_SAMPLES
      && evidence.sampleCounts.flight >= MIN_FLIGHT_SAMPLES
      && evidence.sampleCounts.downDown >= MIN_DOWN_DOWN_SAMPLES
      && evidence.sampleCounts.pointer >= MIN_POINTER_SAMPLES
    );
    const behaviorDiagnostics = buildBehaviorDiagnostics(
      vector,
      profile.template,
      diagnostics,
      round,
    );
    return {
      vector,
      identity,
      distance,
      automation,
      behaviorDiagnostics,
      evidenceSufficient,
    };
  });

  const allowCount = evaluated.filter(
    (sample) => sample.identity.decision === "allow",
  ).length;
  const meanTrustPercent = round(average(
    evaluated.map((sample) => sample.identity.trustPercent),
  ), 2);
  const meanNormalizedDistance = round(average(
    evaluated.map((sample) => sample.identity.normalizedDistance),
  ));
  const identityClassification = allowCount === STRONG_TEST_SAMPLE_COUNT
    ? "close_to_baseline"
    : allowCount === 0
      ? "different_from_baseline"
      : "mixed_similarity";
  const automationClassification = strongestAutomationClassification(
    evaluated.map((sample) => sample.automation),
  );
  const maximumAutomationRisk = Math.max(
    ...evaluated.map((sample) => sample.automation.riskScore),
  );
  const featureSummary = profile.template.featureKeys.map((name) => {
    const currentAverage = average(
      evaluated.map((sample) => sample.vector[name]),
    );
    const baselineCenter = Number(profile.template.means[name]);
    return {
      name,
      currentAverage: round(currentAverage),
      baselineCenter: round(baselineCenter),
      difference: round(currentAverage - baselineCenter),
      normalizationScale: round(profile.template.scales[name]),
    };
  });
  const samples = evaluated.map((sample, index) => ({
    sampleLabel: `Sample ${index + 1}`,
    decision: sample.identity.decision,
    trustPercent: sample.identity.trustPercent,
    normalizedDistance: sample.identity.normalizedDistance,
    reasonCodes: sample.identity.reasonCodes,
    automationRisk: compactAutomationAssessment(sample.automation),
    evidenceSufficient: sample.evidenceSufficient,
    baselineComparison:
      sample.behaviorDiagnostics.baselineComparison,
  }));

  return {
    reportLabel: "Stronger comparison report",
    profileId: profile.profileId,
    subjectLabel,
    sampleCount: STRONG_TEST_SAMPLE_COUNT,
    identitySimilarity: {
      classification: identityClassification,
      matchingSamples: allowCount,
      sampleCount: STRONG_TEST_SAMPLE_COUNT,
      meanTrustPercent,
      meanNormalizedDistance,
      acceptanceThreshold: round(profile.template.acceptanceThreshold),
    },
    automationRisk: {
      classification: automationClassification,
      maximumRiskScore: maximumAutomationRisk,
      meanRiskScore: round(average(
        evaluated.map((sample) => sample.automation.riskScore),
      ), 2),
    },
    featureSummary,
    samples,
    limitations: [
      "Three samples are stronger than one sample but do not prove identity or humanity.",
      "The admin subject label is evaluation metadata and does not affect any score.",
      "This local test does not issue a login or sensitive-action grant.",
      "Only close, sufficiently evidenced, human-like samples may strengthen the saved baseline.",
    ],
  };
}

function validateContext(context) {
  const requiredFunctions = [
    "HttpError",
    "appendAudit",
    "credentialAccountLimiter",
    "credentialBurstLimiter",
    "normalizeUsername",
    "requireCsrf",
    "sameOrigin",
    "verifyPassword",
  ];
  for (const name of requiredFunctions) {
    if (typeof context?.[name] !== "function") {
      throw new TypeError(`demo admin routes require context.${name}.`);
    }
  }
  const databaseMethods = [
    "getProfile",
    "getUserByUsername",
    "listAudit",
    "listDevices",
    "listProfiles",
    "listWebAuthnCredentials",
    "setProfile",
  ];
  for (const name of databaseMethods) {
    if (typeof context.database?.[name] !== "function") {
      throw new TypeError(
        `demo admin routes require context.database.${name}.`,
      );
    }
  }
  return context;
}

function registerDemoAdminRoutes(app, suppliedContext) {
  const context = validateContext(suppliedContext);

  app.post(
    "/api/demo-admin/report",
    context.sameOrigin,
    context.credentialBurstLimiter,
    context.credentialAccountLimiter,
    context.requireCsrf,
    async (request, response) => {
      const { user } = await authorizeDemoAdmin(
        request,
        context,
        new Set(["username", "password"]),
      );

      const report = await buildAccountDemoReport(context.database, user);
      await context.appendAudit({
        userId: user.id,
        eventType: "demo_admin.report_access",
        metadata: {
          profileCount: report.fingerprints.length,
          comparisonCount: report.comparisons.length,
        },
      }, request);
      response.set("Cache-Control", "no-store");
      response.json({ report });
    },
  );

  app.post(
    "/api/demo-admin/test",
    context.sameOrigin,
    context.credentialBurstLimiter,
    context.credentialAccountLimiter,
    context.requireCsrf,
    async (request, response) => {
      const { body, user } = await authorizeDemoAdmin(
        request,
        context,
        new Set([
          "username",
          "password",
          "profileId",
          "demoSubjectLabel",
          "samples",
        ]),
      );
      const profileId = validateProfileId(body.profileId);
      const profile = await context.database.getProfile(
        user.id,
        profileId,
      );
      if (!profile) {
        throw new context.HttpError(
          404,
          "PROFILE_NOT_FOUND",
          "The selected account profile was not found.",
        );
      }
      const testReport = evaluateStrongTest(profile, body, context);
      const eligibleSamples = (
        testReport.samples.every(
          (sample) => sample.decision === "allow",
        )
        && testReport.samples.every(
          (sample) =>
            sample.automationRisk?.classification
            === "human_like_interaction",
        )
        && testReport.samples.every(
          (sample) => sample.evidenceSufficient === true,
        )
      );
      let amendment = {
        status: "not_applied",
        reasonCode: eligibleSamples
          ? "ROBUST_FILTER_DID_NOT_ACCEPT_SAMPLES"
          : "UNTRUSTED_ADMIN_TEST_SAMPLES_NOT_APPLIED",
        previousSampleCount: profile.template.sampleCount,
        sampleCount: profile.template.sampleCount,
      };
      if (eligibleSamples) {
        const updateTimestamp = new Date().toISOString();
        const candidates = body.samples.map((sample, index) => ({
          sessionId: `admin:${Date.now()}:${index + 1}`,
          strongVerification: true,
          vector: validateFeatureVector(
            sample.vector,
            profile.template.featureKeys,
          ).vector,
        }));
        const evolved = evolveTemplate(
          profile.template,
          candidates,
          {
            minimumSessions: STRONG_TEST_SAMPLE_COUNT,
            maximumSessions: STRONG_TEST_SAMPLE_COUNT,
            maxDistanceRatio: 1,
            updatedAt: updateTimestamp,
          },
        );
        amendment = evolved.update.status === "updated"
          ? {
            status: "applied",
            reasonCode: evolved.update.reasonCode,
            previousSampleCount: profile.template.sampleCount,
            sampleCount: evolved.template.sampleCount,
            acceptedSessionIds: evolved.update.acceptedSessionIds,
            rejectedSessions: evolved.update.rejectedSessions,
            meanShifts: evolved.update.meanShifts,
            learningRate: evolved.update.learningRate,
            acceptanceThresholdChanged: false,
          }
          : {
            status: evolved.update.status === "insufficient_evidence"
              ? "pending"
              : "not_applied",
            reasonCode: evolved.update.reasonCode,
            previousSampleCount: profile.template.sampleCount,
            sampleCount: profile.template.sampleCount,
            acceptedSessionIds: evolved.update.acceptedSessionIds,
            rejectedSessions: evolved.update.rejectedSessions,
          };
        if (amendment.status === "applied") {
          await context.database.setProfile(
            user.id,
            profileId,
            evolved.template,
          );
        }
      }
      testReport.amendment = amendment;
      const auditEvent = await context.appendAudit({
        userId: user.id,
        eventType: "demo_admin.behavior_test",
        reasonCode: amendment.reasonCode,
        metadata: {
          profileId,
          demoSubjectLabel: testReport.subjectLabel,
          testReport,
          amendment,
        },
      }, request);
      response.set("Cache-Control", "no-store");
      response.status(201).json({
        report: {
          id: `ODY-STRONG-${String(auditEvent.id).padStart(6, "0")}`,
          createdAt: auditEvent.createdAt,
          ...testReport,
        },
      });
    },
  );
}

module.exports = {
  STRONG_TEST_SAMPLE_COUNT,
  buildAccountDemoReport,
  evaluateStrongTest,
  isLoopbackRequest,
  registerDemoAdminRoutes,
};
