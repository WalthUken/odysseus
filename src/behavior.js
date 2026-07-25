"use strict";

const MIN_ENROLLMENT_SAMPLES = 3;
const MAX_ENROLLMENT_SAMPLES = 50;
const MAX_FEATURES = 32;
const MAX_FEATURE_NAME_LENGTH = 64;
const MAX_ABSOLUTE_FEATURE_VALUE = 1_000_000_000;
const TEMPLATE_VERSION = 2;

const FEATURE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const FORBIDDEN_FEATURE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.code = "VALIDATION_ERROR";
    this.details = details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateProfileId(profileId) {
  if (typeof profileId !== "string") {
    throw new ValidationError("profileId must be a string.");
  }

  const normalized = profileId.trim();
  if (normalized.length < 1 || normalized.length > 128) {
    throw new ValidationError("profileId must contain between 1 and 128 characters.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(normalized)) {
    throw new ValidationError(
      "profileId may contain letters, numbers, periods, underscores, colons, at signs, plus signs, and hyphens.",
    );
  }

  return normalized;
}

function validateFeatureName(name) {
  if (
    typeof name !== "string"
    || name.length > MAX_FEATURE_NAME_LENGTH
    || !FEATURE_NAME_PATTERN.test(name)
    || FORBIDDEN_FEATURE_NAMES.has(name)
  ) {
    throw new ValidationError(
      `Invalid feature name "${String(name)}". Feature names must start with a letter and contain only letters, numbers, periods, underscores, or hyphens.`,
    );
  }
}

function validateFeatureVector(vector, expectedFeatureKeys) {
  if (!isPlainObject(vector)) {
    throw new ValidationError("Each feature vector must be a plain object.");
  }

  const keys = Object.keys(vector).sort();
  if (keys.length < 1 || keys.length > MAX_FEATURES) {
    throw new ValidationError(
      `Each feature vector must contain between 1 and ${MAX_FEATURES} features.`,
    );
  }

  for (const key of keys) {
    validateFeatureName(key);
    const value = vector[key];

    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || Math.abs(value) > MAX_ABSOLUTE_FEATURE_VALUE
    ) {
      throw new ValidationError(
        `Feature "${key}" must be a finite number with an absolute value no greater than ${MAX_ABSOLUTE_FEATURE_VALUE}.`,
      );
    }
  }

  if (expectedFeatureKeys) {
    if (
      keys.length !== expectedFeatureKeys.length
      || keys.some((key, index) => key !== expectedFeatureKeys[index])
    ) {
      throw new ValidationError(
        "Feature vector keys must exactly match the enrolled feature set.",
        {
          expected: expectedFeatureKeys,
          received: keys,
        },
      );
    }
  }

  const validated = Object.create(null);
  for (const key of keys) {
    validated[key] = vector[key];
  }

  return { keys, vector: validated };
}

function validateEnrollmentSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new ValidationError("samples must be an array of feature vectors.");
  }

  if (
    samples.length < MIN_ENROLLMENT_SAMPLES
    || samples.length > MAX_ENROLLMENT_SAMPLES
  ) {
    throw new ValidationError(
      `Enrollment requires between ${MIN_ENROLLMENT_SAMPLES} and ${MAX_ENROLLMENT_SAMPLES} samples.`,
    );
  }

  let featureKeys;
  const validatedSamples = samples.map((sample) => {
    const result = validateFeatureVector(sample, featureKeys);
    featureKeys ??= result.keys;
    return result.vector;
  });

  return { featureKeys, samples: validatedSamples };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanAbsoluteDeviation(values, center = mean(values)) {
  return mean(values.map((value) => Math.abs(value - center)));
}

function quantile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ValidationError("Cannot calculate a quantile for an empty value set.");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const fraction = index - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * fraction);
}

function effectiveScale(center, deviation) {
  return Math.max(deviation, Math.abs(center) * 0.01, 0.000001);
}

// A feature that never moved and never had a value across enrollment carried no
// information. Comparing against it would divide by the 1e-6 scale floor and
// report an astronomical distance for any real measurement that arrives later,
// so such features are excluded from scoring until they are adopted.
function isInertFeature(means, deviations, key) {
  return means[key] === 0 && deviations[key] === 0;
}

function activeKeysFrom(featureKeys, means, deviations) {
  return featureKeys.filter((key) => !isInertFeature(means, deviations, key));
}

// v1 templates predate activeFeatureKeys and treated every key as comparable.
function comparableFeatureKeys(template) {
  return Array.isArray(template.activeFeatureKeys)
    ? template.activeFeatureKeys
    : template.featureKeys;
}

function scaledManhattanDistance(vector, template) {
  const validated = validateFeatureVector(vector, template.featureKeys).vector;
  const comparableKeys = comparableFeatureKeys(template);

  if (comparableKeys.length === 0) {
    throw new ValidationError(
      "The stored template has no comparable features and cannot score a sample.",
    );
  }

  let distance = 0;
  const contributions = Object.create(null);

  for (const key of comparableKeys) {
    const scale = template.scales[key];
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
      throw new Error(`Stored template has an invalid scale for feature "${key}".`);
    }

    const contribution = Math.abs(validated[key] - template.means[key]) / scale;
    contributions[key] = contribution;
    distance += contribution;
  }

  return {
    distance,
    normalizedDistance: distance / comparableKeys.length,
    comparedFeatureCount: comparableKeys.length,
    contributions,
  };
}

function createTemplate(samples, options = {}) {
  const { featureKeys, samples: validatedSamples } = validateEnrollmentSamples(samples);
  const means = Object.create(null);
  const deviations = Object.create(null);
  const scales = Object.create(null);

  for (const key of featureKeys) {
    const values = validatedSamples.map((sample) => sample[key]);
    const center = mean(values);
    const deviation = meanAbsoluteDeviation(values, center);

    means[key] = center;
    deviations[key] = deviation;
    scales[key] = effectiveScale(center, deviation);
  }

  const activeFeatureKeys = activeKeysFrom(featureKeys, means, deviations);
  if (activeFeatureKeys.length === 0) {
    throw new ValidationError(
      "Enrollment samples carried no measurable signal in any feature.",
    );
  }

  const draftTemplate = {
    version: TEMPLATE_VERSION,
    featureKeys,
    activeFeatureKeys,
    means,
    deviations,
    scales,
  };
  const enrollmentDistances = validatedSamples.map(
    (sample) => scaledManhattanDistance(sample, draftTemplate).normalizedDistance,
  );
  const p90Distance = quantile(enrollmentDistances, 0.9);
  const acceptanceThreshold = Math.min(
    4,
    Math.max(1.5, p90Distance * 1.5),
  );
  const enrolledAt = options.enrolledAt ?? new Date().toISOString();

  return {
    ...draftTemplate,
    acceptanceThreshold,
    calibration: {
      p90Distance,
      maximumDistance: Math.max(...enrollmentDistances),
    },
    sampleCount: validatedSamples.length,
    enrolledAt,
    updatedAt: enrolledAt,
  };
}

function reasonCodeForFeature(key) {
  return `FEATURE_DEVIATION_${key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function applyPolicy(normalizedDistance, acceptanceThreshold) {
  const stepUpThreshold = acceptanceThreshold * 2.5;

  if (normalizedDistance <= acceptanceThreshold) {
    return {
      decision: "allow",
      reasonCode: "BEHAVIOR_MATCH",
      allowSensitiveActions: true,
      stepUpRequired: false,
      acceptanceThreshold,
      stepUpThreshold,
    };
  }

  if (normalizedDistance <= stepUpThreshold) {
    return {
      decision: "step_up",
      reasonCode: "BEHAVIOR_DRIFT",
      allowSensitiveActions: false,
      stepUpRequired: true,
      acceptanceThreshold,
      stepUpThreshold,
    };
  }

  return {
    decision: "deny",
    reasonCode: "BEHAVIOR_MISMATCH",
    allowSensitiveActions: false,
    stepUpRequired: true,
    acceptanceThreshold,
    stepUpThreshold,
  };
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function evaluateVector(vector, template) {
  if (!isPlainObject(template)) {
    throw new ValidationError("A valid enrolled template is required.");
  }

  const result = scaledManhattanDistance(vector, template);
  const policy = applyPolicy(
    result.normalizedDistance,
    template.acceptanceThreshold,
  );
  const distanceRatio = result.normalizedDistance / template.acceptanceThreshold;
  const trustScore = Math.max(
    0,
    Math.min(1, Math.exp(Math.log(0.7) * distanceRatio)),
  );
  const reasonCodes = [policy.reasonCode];
  const outlyingFeatures = Object.entries(result.contributions)
    .filter(([, contribution]) => contribution > 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  for (const [key] of outlyingFeatures) {
    reasonCodes.push(reasonCodeForFeature(key));
  }

  return {
    trustScore: round(trustScore),
    trustPercent: round(trustScore * 100, 2),
    decision: policy.decision,
    reasonCodes,
    distance: round(result.distance),
    normalizedDistance: round(result.normalizedDistance),
    comparedFeatureCount: result.comparedFeatureCount,
    policy: {
      allowSensitiveActions: policy.allowSensitiveActions,
      stepUpRequired: policy.stepUpRequired,
      acceptanceDistance: round(
        policy.acceptanceThreshold * result.comparedFeatureCount,
      ),
      stepUpDistance: round(
        policy.stepUpThreshold * result.comparedFeatureCount,
      ),
    },
  };
}

// Promotes features that were inert at enrollment but carry real signal in a set
// of strongly-verified samples. This is how a profile built from one interaction
// surface (for example pointer-only dashboard use) is later amplified by another
// (typing), instead of scoring that new signal as an infinite mismatch.
function adoptFeatures(template, samples, options = {}) {
  if (!isPlainObject(template)) {
    throw new ValidationError("A valid enrolled template is required.");
  }

  if (!Array.isArray(samples) || samples.length < MIN_ENROLLMENT_SAMPLES) {
    throw new ValidationError(
      `Feature adoption requires at least ${MIN_ENROLLMENT_SAMPLES} samples.`,
    );
  }

  const validatedSamples = samples.map(
    (sample) => validateFeatureVector(sample, template.featureKeys).vector,
  );
  const active = new Set(comparableFeatureKeys(template));
  const means = { ...template.means };
  const deviations = { ...template.deviations };
  const scales = { ...template.scales };
  const adopted = [];

  for (const key of template.featureKeys) {
    if (active.has(key)) {
      continue;
    }

    const values = validatedSamples.map((sample) => sample[key]);
    const center = mean(values);
    const deviation = meanAbsoluteDeviation(values, center);

    // Still nothing to learn from this family in these samples.
    if (center === 0 && deviation === 0) {
      continue;
    }

    means[key] = center;
    deviations[key] = deviation;
    scales[key] = effectiveScale(center, deviation);
    active.add(key);
    adopted.push(key);
  }

  if (adopted.length === 0) {
    return { status: "no_features_adopted", adopted: [], template };
  }

  return {
    status: "adopted",
    adopted,
    template: {
      ...template,
      version: TEMPLATE_VERSION,
      activeFeatureKeys: template.featureKeys.filter((key) => active.has(key)),
      means,
      deviations,
      scales,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
    },
  };
}

function templateMetadata(profileId, template) {
  return {
    profileId,
    sampleCount: template.sampleCount,
    featureCount: template.featureKeys.length,
    featureKeys: [...template.featureKeys],
    enrolledAt: template.enrolledAt,
    updatedAt: template.updatedAt,
    templateVersion: template.version,
  };
}

module.exports = {
  MAX_ENROLLMENT_SAMPLES,
  MAX_FEATURES,
  MIN_ENROLLMENT_SAMPLES,
  TEMPLATE_VERSION,
  ValidationError,
  adoptFeatures,
  applyPolicy,
  comparableFeatureKeys,
  createTemplate,
  evaluateVector,
  mean,
  meanAbsoluteDeviation,
  quantile,
  scaledManhattanDistance,
  templateMetadata,
  validateEnrollmentSamples,
  validateFeatureVector,
  validateProfileId,
};
