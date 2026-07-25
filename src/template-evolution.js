"use strict";

const {
  MAX_ENROLLMENT_SAMPLES,
  MIN_ENROLLMENT_SAMPLES,
  ValidationError,
  createTemplate,
  mean,
  meanAbsoluteDeviation,
  quantile,
  scaledManhattanDistance,
  validateFeatureVector,
} = require("./behavior");

const MAX_UPDATE_SESSIONS = 100;
const DEFAULT_MINIMUM_SESSIONS = 3;
const DEFAULT_MAXIMUM_SESSIONS = 20;
const DEFAULT_LEARNING_RATE = 0.08;
const DEFAULT_MAX_DISTANCE_RATIO = 1.25;
const DEFAULT_MAX_SHIFT_IN_SCALES = 0.25;
const DEFAULT_OUTLIER_Z_THRESHOLD = 3.5;
const MAX_TEMPLATE_VALUE = 1_000_000_000;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedNumber(value, name, minimum, maximum, defaultValue) {
  const candidate = value ?? defaultValue;
  if (
    typeof candidate !== "number"
    || !Number.isFinite(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new ValidationError(
      `${name} must be a finite number between ${minimum} and ${maximum}.`,
    );
  }
  return candidate;
}

function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw new ValidationError("Options must be a plain object.");
  }
  return options;
}

function boundedInteger(value, name, minimum, maximum, defaultValue) {
  const candidate = value ?? defaultValue;
  if (
    !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new ValidationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return candidate;
}

function timestamp(value, name) {
  const candidate = value ?? new Date().toISOString();
  if (
    typeof candidate !== "string"
    || candidate.length > 40
    || !Number.isFinite(Date.parse(candidate))
  ) {
    throw new ValidationError(`${name} must be a valid timestamp string.`);
  }
  return new Date(candidate).toISOString();
}

function identifier(value, name) {
  if (
    typeof value !== "string"
    || value.trim().length < 1
    || value.trim().length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(value.trim())
  ) {
    throw new ValidationError(`${name} must be a valid identifier.`);
  }
  return value.trim();
}

function cloneMap(source, keys, name, allowZero) {
  if (!isPlainObject(source)) {
    throw new ValidationError(`Template ${name} must be a plain object.`);
  }
  const sourceKeys = Object.keys(source).sort();
  if (
    sourceKeys.length !== keys.length
    || sourceKeys.some((key, index) => key !== keys[index])
  ) {
    throw new ValidationError(
      `Template ${name} keys must match template feature keys.`,
    );
  }

  const copy = Object.create(null);
  for (const key of keys) {
    const value = source[key];
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || (allowZero ? value < 0 : value <= 0)
      || value > MAX_TEMPLATE_VALUE
    ) {
      throw new ValidationError(
        `Template ${name}.${key} must be a valid numeric value.`,
      );
    }
    copy[key] = value;
  }
  return copy;
}

function validateAndCloneTemplate(template) {
  if (!isPlainObject(template)) {
    throw new ValidationError("A valid template is required.");
  }
  if (
    !Array.isArray(template.featureKeys)
    || template.featureKeys.length < 1
  ) {
    throw new ValidationError(
      "Template featureKeys must be a non-empty array.",
    );
  }
  const featureKeys = [...template.featureKeys].sort();
  if (
    featureKeys.length !== new Set(featureKeys).size
    || featureKeys.some((key, index) => key !== template.featureKeys[index])
  ) {
    throw new ValidationError(
      "Template featureKeys must be unique and sorted.",
    );
  }

  const means = validateFeatureVector(template.means, featureKeys).vector;
  const deviations = cloneMap(
    template.deviations,
    featureKeys,
    "deviations",
    true,
  );
  const scales = cloneMap(
    template.scales,
    featureKeys,
    "scales",
    false,
  );
  if (
    typeof template.acceptanceThreshold !== "number"
    || !Number.isFinite(template.acceptanceThreshold)
    || template.acceptanceThreshold <= 0
    || template.acceptanceThreshold > 100
  ) {
    throw new ValidationError(
      "Template acceptanceThreshold must be a positive number.",
    );
  }

  return {
    ...template,
    featureKeys,
    means,
    deviations,
    scales,
    calibration: isPlainObject(template.calibration)
      ? { ...template.calibration }
      : template.calibration,
    transfer: isPlainObject(template.transfer)
      ? { ...template.transfer }
      : template.transfer,
    evolution: isPlainObject(template.evolution)
      ? { ...template.evolution }
      : template.evolution,
  };
}

function median(values) {
  return quantile(values, 0.5);
}

function clamped(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function rejection(sessionId, reasonCode, normalizedDistance) {
  const result = { sessionId, reasonCode };
  if (Number.isFinite(normalizedDistance)) {
    result.normalizedDistance = rounded(normalizedDistance);
  }
  return result;
}

function prepareCandidateSessions(template, sessions, options) {
  if (
    !Array.isArray(sessions)
    || sessions.length < 1
    || sessions.length > MAX_UPDATE_SESSIONS
  ) {
    throw new ValidationError(
      `sessions must contain between 1 and ${MAX_UPDATE_SESSIONS} entries.`,
    );
  }

  const eligible = [];
  const rejected = [];
  const seenSessionIds = new Set();
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (!isPlainObject(session)) {
      throw new ValidationError(`sessions[${index}] must be a plain object.`);
    }
    const sessionId = identifier(
      session.sessionId,
      `sessions[${index}].sessionId`,
    );
    const vector = validateFeatureVector(
      session.vector,
      template.featureKeys,
    ).vector;

    if (seenSessionIds.has(sessionId)) {
      rejected.push(rejection(sessionId, "DUPLICATE_SESSION"));
      continue;
    }
    seenSessionIds.add(sessionId);

    if (session.strongVerification !== true) {
      rejected.push(rejection(sessionId, "STRONG_VERIFICATION_REQUIRED"));
      continue;
    }

    const normalizedDistance = scaledManhattanDistance(
      vector,
      template,
    ).normalizedDistance;
    if (
      normalizedDistance
      > template.acceptanceThreshold * options.maxDistanceRatio
    ) {
      rejected.push(rejection(
        sessionId,
        "OUTSIDE_UPDATE_ENVELOPE",
        normalizedDistance,
      ));
      continue;
    }

    eligible.push({
      sessionId,
      vector,
      normalizedDistance,
    });
  }

  return { eligible, rejected };
}

function robustSessionFilter(template, eligible, zThreshold) {
  if (eligible.length < 3) {
    return {
      inliers: eligible,
      outliers: [],
    };
  }

  const centers = Object.create(null);
  const robustScales = Object.create(null);
  for (const key of template.featureKeys) {
    const values = eligible.map((session) => session.vector[key]);
    const center = median(values);
    const medianDeviation = median(
      values.map((value) => Math.abs(value - center)),
    );
    centers[key] = center;
    robustScales[key] = Math.max(
      medianDeviation * 1.4826,
      template.scales[key] * 0.1,
      0.000001,
    );
  }

  const inliers = [];
  const outliers = [];
  for (const session of eligible) {
    const robustDistance = mean(template.featureKeys.map(
      (key) => (
        Math.abs(session.vector[key] - centers[key]) / robustScales[key]
      ),
    ));
    if (robustDistance > zThreshold) {
      outliers.push(rejection(
        session.sessionId,
        "INCONSISTENT_WITH_SESSION_CLUSTER",
        session.normalizedDistance,
      ));
    } else {
      inliers.push(session);
    }
  }
  return { inliers, outliers };
}

function evolutionOptions(options) {
  const minimumSessions = boundedInteger(
    options.minimumSessions,
    "minimumSessions",
    3,
    MAX_UPDATE_SESSIONS,
    DEFAULT_MINIMUM_SESSIONS,
  );
  const maximumSessions = boundedInteger(
    options.maximumSessions,
    "maximumSessions",
    minimumSessions,
    MAX_UPDATE_SESSIONS,
    Math.max(DEFAULT_MAXIMUM_SESSIONS, minimumSessions),
  );
  return {
    minimumSessions,
    maximumSessions,
    learningRate: boundedNumber(
      options.learningRate,
      "learningRate",
      0.01,
      0.15,
      DEFAULT_LEARNING_RATE,
    ),
    maxDistanceRatio: boundedNumber(
      options.maxDistanceRatio,
      "maxDistanceRatio",
      0.5,
      1.5,
      DEFAULT_MAX_DISTANCE_RATIO,
    ),
    maxShiftInScales: boundedNumber(
      options.maxShiftInScales,
      "maxShiftInScales",
      0.05,
      0.5,
      DEFAULT_MAX_SHIFT_IN_SCALES,
    ),
    outlierZThreshold: boundedNumber(
      options.outlierZThreshold,
      "outlierZThreshold",
      2,
      8,
      DEFAULT_OUTLIER_Z_THRESHOLD,
    ),
  };
}

function noUpdate(template, status, reasonCode, accepted, rejected) {
  return {
    template,
    update: {
      status,
      reasonCode,
      acceptedSessionIds: accepted.map((session) => session.sessionId),
      rejectedSessions: rejected,
    },
  };
}

function evolveTemplate(template, sessions, options = {}) {
  const current = validateAndCloneTemplate(template);
  if (
    isPlainObject(current.transfer)
    && (
      current.transfer.requiresRecalibration === true
      || current.transfer.status === "restricted"
    )
  ) {
    return noUpdate(
      current,
      "blocked",
      "CROSS_DEVICE_RECALIBRATION_REQUIRED",
      [],
      [],
    );
  }

  const settings = evolutionOptions(validateOptions(options));
  const prepared = prepareCandidateSessions(
    current,
    sessions,
    settings,
  );
  const limited = [...prepared.eligible]
    .sort((left, right) => (
      left.normalizedDistance - right.normalizedDistance
      || left.sessionId.localeCompare(right.sessionId)
    ))
    .slice(0, settings.maximumSessions);
  const overLimit = prepared.eligible
    .filter((session) => !limited.includes(session))
    .map((session) => rejection(
      session.sessionId,
      "BATCH_SESSION_LIMIT",
      session.normalizedDistance,
    ));
  const robust = robustSessionFilter(
    current,
    limited,
    settings.outlierZThreshold,
  );
  const rejected = [
    ...prepared.rejected,
    ...overLimit,
    ...robust.outliers,
  ];
  if (robust.inliers.length < settings.minimumSessions) {
    return noUpdate(
      current,
      "insufficient_evidence",
      "INSUFFICIENT_VERIFIED_CONSISTENT_SESSIONS",
      robust.inliers,
      rejected,
    );
  }

  const updatedAt = timestamp(options.updatedAt, "updatedAt");
  const means = Object.create(null);
  const deviations = Object.create(null);
  const scales = Object.create(null);
  const shifts = Object.create(null);

  for (const key of current.featureKeys) {
    const values = robust.inliers.map((session) => session.vector[key]);
    const aggregateCenter = median(values);
    const proposedMean = current.means[key] + (
      (aggregateCenter - current.means[key]) * settings.learningRate
    );
    const maximumShift = (
      current.scales[key] * settings.maxShiftInScales
    );
    means[key] = clamped(
      proposedMean,
      current.means[key] - maximumShift,
      current.means[key] + maximumShift,
    );
    shifts[key] = rounded(means[key] - current.means[key]);

    const candidateDeviation = meanAbsoluteDeviation(
      values,
      aggregateCenter,
    );
    const proposedDeviation = current.deviations[key] + (
      (candidateDeviation - current.deviations[key])
      * settings.learningRate
    );
    const deviationChangeLimit = current.scales[key] * 0.05;
    deviations[key] = clamped(
      proposedDeviation,
      Math.max(0, current.deviations[key] - deviationChangeLimit),
      current.deviations[key] + deviationChangeLimit,
    );

    const proposedScale = Math.max(
      deviations[key],
      Math.abs(means[key]) * 0.01,
      0.000001,
    );
    scales[key] = clamped(
      proposedScale,
      current.scales[key] * 0.95,
      current.scales[key] * 1.05,
    );
  }

  const previousUpdateCount = Number.isSafeInteger(
    current.evolution?.updateCount,
  )
    ? current.evolution.updateCount
    : 0;
  const next = {
    ...current,
    means,
    deviations,
    scales,
    sampleCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      (Number.isSafeInteger(current.sampleCount) ? current.sampleCount : 0)
      + robust.inliers.length,
    ),
    updatedAt,
    evolution: {
      version: 1,
      updateCount: previousUpdateCount + 1,
      lastUpdatedAt: updatedAt,
      lastSessionCount: robust.inliers.length,
      learningRate: settings.learningRate,
      thresholdChanged: false,
    },
  };

  return {
    template: next,
    update: {
      status: "updated",
      reasonCode: "VERIFIED_MULTI_SESSION_DRIFT_APPLIED",
      acceptedSessionIds: robust.inliers.map(
        (session) => session.sessionId,
      ),
      rejectedSessions: rejected,
      meanShifts: shifts,
      learningRate: settings.learningRate,
      acceptanceThresholdChanged: false,
    },
  };
}

function initializeCrossDeviceTransfer(sourceTemplate, options = {}) {
  const source = validateAndCloneTemplate(sourceTemplate);
  const settings = validateOptions(options);
  if (
    isPlainObject(source.transfer)
    && (
      source.transfer.requiresRecalibration === true
      || source.transfer.status === "restricted"
    )
  ) {
    throw new ValidationError(
      "A restricted template cannot be transferred again.",
    );
  }
  const sourceDeviceId = identifier(
    settings.sourceDeviceId,
    "sourceDeviceId",
  );
  const destinationDeviceId = identifier(
    settings.destinationDeviceId,
    "destinationDeviceId",
  );
  if (sourceDeviceId === destinationDeviceId) {
    throw new ValidationError(
      "sourceDeviceId and destinationDeviceId must be different.",
    );
  }
  const initializedAt = timestamp(
    settings.initializedAt,
    "initializedAt",
  );
  const requiredSamples = boundedInteger(
    settings.requiredSamples,
    "requiredSamples",
    MIN_ENROLLMENT_SAMPLES,
    MAX_ENROLLMENT_SAMPLES,
    5,
  );

  return {
    ...source,
    updatedAt: initializedAt,
    transfer: {
      version: 1,
      status: "restricted",
      sourceDeviceId,
      destinationDeviceId,
      initializedAt,
      completedAt: null,
      requiresRecalibration: true,
      requiredSamples,
      destinationSampleCount: 0,
    },
  };
}

function recalibrateCrossDeviceTemplate(
  transferredTemplate,
  destinationSamples,
  options = {},
) {
  const transferred = validateAndCloneTemplate(transferredTemplate);
  const settings = validateOptions(options);
  if (
    !isPlainObject(transferred.transfer)
    || transferred.transfer.status !== "restricted"
    || transferred.transfer.requiresRecalibration !== true
  ) {
    throw new ValidationError(
      "Template is not awaiting cross-device recalibration.",
    );
  }

  const requiredSamples = boundedInteger(
    transferred.transfer.requiredSamples,
    "transfer.requiredSamples",
    MIN_ENROLLMENT_SAMPLES,
    MAX_ENROLLMENT_SAMPLES,
    5,
  );
  if (
    !Array.isArray(destinationSamples)
    || destinationSamples.length < requiredSamples
  ) {
    throw new ValidationError(
      `Cross-device recalibration requires at least ${requiredSamples} destination samples.`,
    );
  }

  const recalibratedAt = timestamp(
    settings.recalibratedAt,
    "recalibratedAt",
  );
  const destinationTemplate = createTemplate(destinationSamples, {
    enrolledAt: recalibratedAt,
  });
  if (
    destinationTemplate.featureKeys.length
      !== transferred.featureKeys.length
    || destinationTemplate.featureKeys.some(
      (key, index) => key !== transferred.featureKeys[index],
    )
  ) {
    throw new ValidationError(
      "Destination samples must use the source template feature set.",
    );
  }

  return {
    ...destinationTemplate,
    transfer: {
      ...transferred.transfer,
      status: "active",
      completedAt: recalibratedAt,
      requiresRecalibration: false,
      destinationSampleCount: destinationSamples.length,
    },
  };
}

function templateAccessState(template) {
  const current = validateAndCloneTemplate(template);
  if (
    isPlainObject(current.transfer)
    && (
      current.transfer.requiresRecalibration === true
      || current.transfer.status === "restricted"
    )
  ) {
    return {
      state: "restricted",
      allowSensitiveActions: false,
      stepUpRequired: true,
      reasonCode: "CROSS_DEVICE_RECALIBRATION_REQUIRED",
    };
  }
  return {
    state: "active",
    allowSensitiveActions: true,
    stepUpRequired: false,
    reasonCode: "TEMPLATE_ACTIVE",
  };
}

module.exports = {
  DEFAULT_LEARNING_RATE,
  DEFAULT_MAX_DISTANCE_RATIO,
  DEFAULT_MAX_SHIFT_IN_SCALES,
  DEFAULT_MINIMUM_SESSIONS,
  MAX_UPDATE_SESSIONS,
  evolveTemplate,
  initializeCrossDeviceTransfer,
  recalibrateCrossDeviceTemplate,
  templateAccessState,
  validateAndCloneTemplate,
};
