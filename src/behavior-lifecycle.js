"use strict";

const {
  ValidationError,
  comparableFeatureKeys,
  evaluateVector,
  scaledManhattanDistance,
  validateFeatureVector,
} = require("./behavior");
const {
  assessAutomationRisk,
  validateInteractionEvidence,
} = require("./automation-risk");
const { validateTypingDiagnostics } = require("./diagnostics");
const {
  validateAndCloneTemplate,
} = require("./template-evolution");
const { VERIFICATION_ROUNDS } = require("../public/challenge");

const MAX_SAMPLE_COUNT = 1_000;
const MIN_DWELL_SAMPLES = 10;
const MIN_FLIGHT_SAMPLES = 8;
const MIN_DOWN_DOWN_SAMPLES = 8;
const MIN_POINTER_SAMPLES = 8;
const RETURN_LEARNING_RATE = 0.01;
const RETURN_MAX_EVENT_SHIFT_IN_SCALES = 0.02;
const RETURN_MAX_ANCHOR_DRIFT_IN_SCALES = 0.25;
const RETURN_MAX_DISTANCE_RATIO = 0.75;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAllowedKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ValidationError(`${name} contains unsupported fields.`, {
      fields: unexpected,
    });
  }
}

function boundedCount(value, name) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_SAMPLE_COUNT
  ) {
    throw new ValidationError(
      `${name} must be an integer between 0 and ${MAX_SAMPLE_COUNT}.`,
    );
  }
  return value;
}

function validateSampleCounts(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError(
      "behaviorEvidence.sampleCounts must be an object.",
    );
  }
  const names = ["dwell", "flight", "downDown", "pointer"];
  requireAllowedKeys(
    value,
    new Set(names),
    "behaviorEvidence.sampleCounts",
  );
  return Object.fromEntries(names.map((name) => [
    name,
    boundedCount(
      value[name],
      `behaviorEvidence.sampleCounts.${name}`,
    ),
  ]));
}

function familyForFeature(name) {
  if (name.startsWith("dwell")) {
    return "dwell";
  }
  if (name.startsWith("flight")) {
    return "flight";
  }
  if (name.startsWith("downDown")) {
    return "downDown";
  }
  if (name.startsWith("pointer")) {
    return "pointer";
  }
  return null;
}

function availableFamilies(sampleCounts) {
  return new Set([
    ...(sampleCounts.dwell >= MIN_DWELL_SAMPLES ? ["dwell"] : []),
    ...(sampleCounts.flight >= MIN_FLIGHT_SAMPLES ? ["flight"] : []),
    ...(
      sampleCounts.downDown >= MIN_DOWN_DOWN_SAMPLES
        ? ["downDown"]
        : []
    ),
    ...(sampleCounts.pointer >= MIN_POINTER_SAMPLES ? ["pointer"] : []),
  ]);
}

function reducedTemplate(template, featureNames) {
  const means = Object.create(null);
  const deviations = Object.create(null);
  const scales = Object.create(null);
  for (const name of featureNames) {
    means[name] = template.means[name];
    deviations[name] = template.deviations[name];
    scales[name] = template.scales[name];
  }
  const projected = {
    ...template,
    featureKeys: [...featureNames],
    means,
    deviations,
    scales,
  };
  // activeFeatureKeys must be narrowed alongside featureKeys, or the projection
  // would still claim features whose scales it no longer carries.
  const activeInProjection = Array.isArray(template.activeFeatureKeys)
    ? featureNames.filter((name) => template.activeFeatureKeys.includes(name))
    : null;
  if (activeInProjection && activeInProjection.length > 0) {
    projected.activeFeatureKeys = activeInProjection;
  } else {
    // Nothing comparable survives the projection; fall back to treating every
    // projected feature as comparable so scoring stays defined.
    delete projected.activeFeatureKeys;
  }
  return projected;
}

// Coverage requirements are measured against the features the template can
// actually compare. A profile enrolled from one interaction surface only (for
// example pointer-only dashboard use) carries inert keyboard keys that no later
// sample could ever satisfy, so holding it to a two-family minimum would reject
// every verification permanently.
function minimumComparedFeatureCount(template) {
  return Math.min(comparableFeatureKeys(template).length, 4);
}

function hasEnoughFeatureFamilies(template, comparedFeatureNames) {
  const templateFamilies = new Set(
    comparableFeatureKeys(template).map(familyForFeature).filter(Boolean),
  );
  const comparedFamilies = new Set(
    comparedFeatureNames.map(familyForFeature).filter(Boolean),
  );
  const requiredFamilies = Math.min(templateFamilies.size, 2);
  return comparedFamilies.size >= requiredFamilies;
}

// Reports which of a template's features a sample could actually be scored
// against, given how much of each interaction family the sample carries. The
// verify route uses this so it reports honest coverage instead of assuming every
// enrolled feature was compared.
function describeFeatureCoverage(template, sampleCounts) {
  const comparable = comparableFeatureKeys(template);
  const families = sampleCounts
    ? availableFamilies(sampleCounts)
    : null;
  const comparedFeatureNames = families
    ? comparable.filter((name) => families.has(familyForFeature(name)))
    : [...comparable];
  const ignoredFeatureNames = template.featureKeys.filter(
    (name) => !comparedFeatureNames.includes(name),
  );

  return {
    comparedFeatureNames,
    ignoredFeatureNames,
    sufficient: (
      comparedFeatureNames.length >= minimumComparedFeatureCount(template)
      && hasEnoughFeatureFamilies(template, comparedFeatureNames)
    ),
  };
}

function validateEvidenceShape(behaviorEvidence) {
  if (!isPlainObject(behaviorEvidence)) {
    throw new ValidationError("behaviorEvidence must be an object.");
  }
  requireAllowedKeys(
    behaviorEvidence,
    new Set([
      "profileId",
      "status",
      "sampleCounts",
      "vector",
      "diagnostics",
      "interactionEvidence",
    ]),
    "behaviorEvidence",
  );
  if (
    behaviorEvidence.status !== "ready"
    && behaviorEvidence.status !== "insufficient_evidence"
  ) {
    throw new ValidationError(
      "behaviorEvidence.status must be ready or insufficient_evidence.",
    );
  }
  const sampleCounts = validateSampleCounts(behaviorEvidence.sampleCounts);
  if (
    behaviorEvidence.status === "insufficient_evidence"
    && (
      behaviorEvidence.vector !== undefined
      || behaviorEvidence.diagnostics !== undefined
      || behaviorEvidence.interactionEvidence !== undefined
    )
  ) {
    throw new ValidationError(
      "Insufficient behavior evidence must not contain scored telemetry.",
    );
  }
  return {
    ...behaviorEvidence,
    sampleCounts,
  };
}

function evidenceSampleCountsMatch(left, right) {
  return ["dwell", "flight", "downDown", "pointer"].every(
    (name) => left[name] === right[name],
  );
}

function insufficientEvidenceResult(template, reasonCodes, details = {}) {
  return {
    status: "insufficient_evidence",
    identitySimilarity: null,
    distance: null,
    comparedFeatureNames: [],
    ignoredFeatureNames: [...template.featureKeys],
    vector: null,
    automationRisk: null,
    reasonCodes,
    ...details,
  };
}

function evaluateCompatibleEvidence(template, behaviorEvidence) {
  const current = validateAndCloneTemplate(template);
  const evidence = validateEvidenceShape(behaviorEvidence);
  if (evidence.status === "insufficient_evidence") {
    return insufficientEvidenceResult(
      current,
      ["BEHAVIOR_EVIDENCE_INSUFFICIENT"],
      { sampleCounts: evidence.sampleCounts },
    );
  }

  const validatedVector = validateFeatureVector(evidence.vector).vector;
  const suppliedFeatureNames = Object.keys(validatedVector);
  const templateFeatureNames = new Set(current.featureKeys);
  const unexpectedFeatures = suppliedFeatureNames.filter(
    (name) => !templateFeatureNames.has(name),
  );
  if (unexpectedFeatures.length > 0) {
    throw new ValidationError(
      "Behavior evidence contains features outside the enrolled profile.",
      { features: unexpectedFeatures },
    );
  }

  const diagnostics = validateTypingDiagnostics(
    evidence.diagnostics,
    VERIFICATION_ROUNDS,
  );
  const interactionEvidence = validateInteractionEvidence(
    evidence.interactionEvidence,
  );
  if (
    interactionEvidence
    && !evidenceSampleCountsMatch(
      evidence.sampleCounts,
      interactionEvidence.sampleCounts,
    )
  ) {
    throw new ValidationError(
      "Behavior evidence sample counts are inconsistent.",
    );
  }

  const families = availableFamilies(evidence.sampleCounts);
  // Only features the template can actually score count as compared; an inert
  // feature contributes nothing and must not satisfy the coverage minimum.
  const comparedFeatureNames = comparableFeatureKeys(current).filter((name) => (
    Object.hasOwn(validatedVector, name)
    && families.has(familyForFeature(name))
  ));
  const ignoredFeatureNames = current.featureKeys.filter(
    (name) => !comparedFeatureNames.includes(name),
  );
  const compatibleVector = Object.create(null);
  for (const name of comparedFeatureNames) {
    compatibleVector[name] = validatedVector[name];
  }
  const automationRisk = assessAutomationRisk(
    compatibleVector,
    diagnostics,
    interactionEvidence,
  );
  if (
    comparedFeatureNames.length < minimumComparedFeatureCount(current)
    || !hasEnoughFeatureFamilies(current, comparedFeatureNames)
  ) {
    return {
      ...insufficientEvidenceResult(
        current,
        ["PROFILE_FEATURE_COVERAGE_INSUFFICIENT"],
      ),
      ignoredFeatureNames,
      automationRisk,
      sampleCounts: evidence.sampleCounts,
    };
  }

  const projectedTemplate = reducedTemplate(
    current,
    comparedFeatureNames,
  );
  return {
    status: "ready",
    identitySimilarity: evaluateVector(
      compatibleVector,
      projectedTemplate,
    ),
    distance: scaledManhattanDistance(
      compatibleVector,
      projectedTemplate,
    ),
    comparedFeatureNames,
    ignoredFeatureNames,
    vector: compatibleVector,
    automationRisk,
    diagnostics,
    interactionEvidence,
    sampleCounts: evidence.sampleCounts,
    reasonCodes: [],
  };
}

function round(value, places = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
}

function unique(values) {
  return [...new Set(values.filter(
    (value) => typeof value === "string" && value.length > 0,
  ))];
}

function contributionList(distance) {
  if (!isPlainObject(distance?.contributions)) {
    return [];
  }
  return Object.entries(distance.contributions)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 24)
    .map(([name, normalizedDelta]) => ({
      name,
      normalizedDelta: round(Math.min(100, normalizedDelta)),
    }));
}

function publicIdentitySimilarity(
  identity,
  distance,
  comparedFeatureNames,
  ignoredFeatureNames,
) {
  if (!identity) {
    return null;
  }
  return {
    decision: identity.decision,
    trustPercent: identity.trustPercent,
    normalizedDistance: identity.normalizedDistance,
    acceptanceThreshold: round(identity.policy?.acceptanceDistance
      / Math.max(1, comparedFeatureNames.length)),
    stepUpThreshold: round(identity.policy?.stepUpDistance
      / Math.max(1, comparedFeatureNames.length)),
    reasonCodes: Array.isArray(identity.reasonCodes)
      ? [...identity.reasonCodes]
      : [],
    comparedFeatureCount: comparedFeatureNames.length,
    comparedFeatureNames: [...comparedFeatureNames],
    ignoredFeatureNames: [...ignoredFeatureNames],
    featureContributions: contributionList(distance),
  };
}

function defaultAmendment(reasonCode) {
  return {
    status: "not_applied",
    reasonCode,
    previousSampleCount: null,
    sampleCount: null,
  };
}

function buildBehaviorDecision(input = {}) {
  const template = input.template || null;
  const identity = input.identitySimilarity || null;
  const automation = input.automationRisk || null;
  const comparedFeatureNames = Array.isArray(input.comparedFeatureNames)
    ? input.comparedFeatureNames
    : [];
  const ignoredFeatureNames = Array.isArray(input.ignoredFeatureNames)
    ? input.ignoredFeatureNames
    : [];
  const forcedReasonCodes = Array.isArray(input.forcedReasonCodes)
    ? input.forcedReasonCodes
    : [];
  let decision;
  let classification;
  let primaryReasonCode;

  if (!template) {
    decision = "allow";
    classification = "baseline_missing";
    primaryReasonCode = "BASELINE_NOT_ENROLLED";
  } else if (automation?.classification === "automation_likely") {
    decision = "deny";
    classification = "automation_likely";
    primaryReasonCode = "AUTOMATION_LIKELY";
  } else if (
    input.evidenceStatus !== "ready"
    || !identity
  ) {
    decision = "review";
    classification = "suspicious_identity";
    primaryReasonCode = forcedReasonCodes[0]
      || "BEHAVIOR_EVIDENCE_REQUIRED";
  } else if (
    automation?.classification !== "human_like_interaction"
  ) {
    decision = "review";
    classification = "suspicious_identity";
    primaryReasonCode = "AUTOMATION_EVIDENCE_REVIEW_REQUIRED";
  } else if (identity.decision !== "allow") {
    decision = "review";
    classification = "suspicious_identity";
    primaryReasonCode = "BEHAVIOR_IDENTITY_REVIEW_REQUIRED";
  } else {
    decision = "allow";
    classification = "trusted_return";
    primaryReasonCode = "TRUSTED_RETURN";
  }

  const identityReasonCodes = Array.isArray(identity?.reasonCodes)
    ? identity.reasonCodes
    : [];
  const automationReasonCodes = Array.isArray(automation?.reasonCodes)
    ? automation.reasonCodes
    : [];
  return {
    decision,
    classification,
    identitySimilarity: publicIdentitySimilarity(
      identity,
      input.distance,
      comparedFeatureNames,
      ignoredFeatureNames,
    ),
    automationRisk: automation,
    reasonCodes: unique([
      primaryReasonCode,
      ...forcedReasonCodes,
      ...identityReasonCodes,
      ...automationReasonCodes,
    ]),
    simulatedIpRestriction: {
      displayed: (
        (
          classification === "suspicious_identity"
          && input.evidenceStatus === "ready"
          && Boolean(identity)
        )
        || classification === "automation_likely"
      ),
      enforced: false,
    },
    amendment: input.amendment
      || defaultAmendment(
        decision === "allow"
          ? "AMENDMENT_NOT_EVALUATED"
          : "UNTRUSTED_EVIDENCE_NOT_APPLIED",
      ),
  };
}

function clamped(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function validatedTimestamp(value) {
  const candidate = value ?? new Date().toISOString();
  if (
    typeof candidate !== "string"
    || candidate.length > 40
    || !Number.isFinite(Date.parse(candidate))
  ) {
    throw new ValidationError("updatedAt must be a valid timestamp.");
  }
  return new Date(candidate).toISOString();
}

function anchorMap(current, source, kind) {
  const result = Object.create(null);
  for (const name of current.featureKeys) {
    const candidate = source?.[name];
    if (
      typeof candidate === "number"
      && Number.isFinite(candidate)
      && (
        kind === "scale"
          ? candidate > 0
          : Math.abs(candidate) <= 1_000_000_000
      )
    ) {
      result[name] = candidate;
    } else {
      result[name] = kind === "scale"
        ? current.scales[name]
        : current.means[name];
    }
  }
  return result;
}

function reinforceTrustedSample(template, vector, options = {}) {
  const current = validateAndCloneTemplate(template);
  const comparedFeatureNames = Array.isArray(options.comparedFeatureNames)
    ? [...new Set(options.comparedFeatureNames)].sort()
    : Object.keys(vector || {}).sort();
  if (comparedFeatureNames.length < 1) {
    throw new ValidationError(
      "At least one compared feature is required for reinforcement.",
    );
  }
  const unknownFeatures = comparedFeatureNames.filter(
    (name) => !current.featureKeys.includes(name),
  );
  if (unknownFeatures.length > 0) {
    throw new ValidationError(
      "Reinforcement features must belong to the enrolled profile.",
      { features: unknownFeatures },
    );
  }
  const validated = validateFeatureVector(
    vector,
    comparedFeatureNames,
  ).vector;
  const projectedTemplate = reducedTemplate(
    current,
    comparedFeatureNames,
  );
  const distance = scaledManhattanDistance(
    validated,
    projectedTemplate,
  ).normalizedDistance;
  const previousSampleCount = Number.isSafeInteger(current.sampleCount)
    ? current.sampleCount
    : 0;
  if (
    distance
    > current.acceptanceThreshold * RETURN_MAX_DISTANCE_RATIO
  ) {
    return {
      template: current,
      amendment: {
        status: "pending",
        reasonCode: "TRUSTED_SAMPLE_OUTSIDE_UPDATE_ENVELOPE",
        previousSampleCount,
        sampleCount: previousSampleCount,
        normalizedDistance: round(distance),
      },
    };
  }

  const updatedAt = validatedTimestamp(options.updatedAt);
  const anchorMeans = anchorMap(
    current,
    current.evolution?.anchorMeans,
    "mean",
  );
  const anchorScales = anchorMap(
    current,
    current.evolution?.anchorScales,
    "scale",
  );
  const means = Object.assign(Object.create(null), current.means);
  const meanShifts = Object.create(null);
  for (const name of comparedFeatureNames) {
    const eventLimit = (
      anchorScales[name] * RETURN_MAX_EVENT_SHIFT_IN_SCALES
    );
    const anchorLimit = (
      anchorScales[name] * RETURN_MAX_ANCHOR_DRIFT_IN_SCALES
    );
    const proposedShift = (
      validated[name] - current.means[name]
    ) * RETURN_LEARNING_RATE;
    const boundedShift = clamped(
      proposedShift,
      -eventLimit,
      eventLimit,
    );
    means[name] = clamped(
      current.means[name] + boundedShift,
      anchorMeans[name] - anchorLimit,
      anchorMeans[name] + anchorLimit,
    );
    meanShifts[name] = round(means[name] - current.means[name]);
  }

  const sampleCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    previousSampleCount + 1,
  );
  const previousReturnUpdateCount = Number.isSafeInteger(
    current.evolution?.returnUpdateCount,
  )
    ? current.evolution.returnUpdateCount
    : 0;
  const next = {
    ...current,
    means,
    sampleCount,
    updatedAt,
    evolution: {
      ...current.evolution,
      version: 1,
      anchorMeans,
      anchorScales,
      returnUpdateCount: previousReturnUpdateCount + 1,
      lastReturnUpdatedAt: updatedAt,
      lastReturnFeatureCount: comparedFeatureNames.length,
      thresholdChanged: false,
    },
  };
  return {
    template: next,
    amendment: {
      status: "applied",
      reasonCode: "TRUSTED_RETURN_BOUNDED_UPDATE_APPLIED",
      previousSampleCount,
      sampleCount,
      comparedFeatureNames,
      meanShifts,
      learningRate: RETURN_LEARNING_RATE,
      acceptanceThresholdChanged: false,
      scaleChanged: false,
    },
  };
}

module.exports = {
  MAX_SAMPLE_COUNT,
  MIN_DOWN_DOWN_SAMPLES,
  MIN_DWELL_SAMPLES,
  MIN_FLIGHT_SAMPLES,
  MIN_POINTER_SAMPLES,
  RETURN_LEARNING_RATE,
  RETURN_MAX_ANCHOR_DRIFT_IN_SCALES,
  RETURN_MAX_DISTANCE_RATIO,
  RETURN_MAX_EVENT_SHIFT_IN_SCALES,
  buildBehaviorDecision,
  describeFeatureCoverage,
  evaluateCompatibleEvidence,
  reinforceTrustedSample,
  validateEvidenceShape,
  validateSampleCounts,
};
