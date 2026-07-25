"use strict";

const { ValidationError } = require("./behavior");

const MAX_CALIBRATION_SAMPLES = 100_000;
const MAX_SCORE = 1_000_000_000;
const SAMPLE_LABELS = new Set(["genuine", "impostor"]);

class CalibrationValidationError extends ValidationError {
  constructor(message, details) {
    super(message);
    this.name = "CalibrationValidationError";
    this.code = "CALIBRATION_VALIDATION_ERROR";
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

function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw new CalibrationValidationError(
      "Calibration options must be a plain object.",
    );
  }
  return options;
}

function validateDirection(value) {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new CalibrationValidationError(
      "lowerScoresAreMoreGenuine must be a boolean.",
    );
  }
  return value;
}

function validateLabeledSamples(samples) {
  if (
    !Array.isArray(samples)
    || samples.length < 2
    || samples.length > MAX_CALIBRATION_SAMPLES
  ) {
    throw new CalibrationValidationError(
      `samples must contain between 2 and ${MAX_CALIBRATION_SAMPLES} labeled scores.`,
    );
  }

  const validated = samples.map((sample, index) => {
    if (!isPlainObject(sample)) {
      throw new CalibrationValidationError(
        `samples[${index}] must be a plain object.`,
      );
    }
    if (
      typeof sample.score !== "number"
      || !Number.isFinite(sample.score)
      || sample.score < 0
      || sample.score > MAX_SCORE
    ) {
      throw new CalibrationValidationError(
        `samples[${index}].score must be a finite number between 0 and ${MAX_SCORE}.`,
      );
    }
    if (!SAMPLE_LABELS.has(sample.label)) {
      throw new CalibrationValidationError(
        `samples[${index}].label must be "genuine" or "impostor".`,
      );
    }
    return Object.freeze({
      label: sample.label,
      score: sample.score,
    });
  });

  const genuineCount = validated.filter(
    (sample) => sample.label === "genuine",
  ).length;
  const impostorCount = validated.length - genuineCount;
  if (genuineCount === 0 || impostorCount === 0) {
    throw new CalibrationValidationError(
      "samples must include at least one genuine score and one impostor score.",
    );
  }

  return {
    samples: validated,
    counts: {
      genuine: genuineCount,
      impostor: impostorCount,
      total: validated.length,
    },
  };
}

function validateThreshold(threshold) {
  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold < -MAX_SCORE
    || threshold > MAX_SCORE * 2
  ) {
    throw new CalibrationValidationError(
      "threshold must be a finite number in the supported score range.",
    );
  }
  return threshold;
}

function isAccepted(score, threshold, lowerScoresAreMoreGenuine) {
  return lowerScoresAreMoreGenuine
    ? score <= threshold
    : score >= threshold;
}

function metricsFromValidated(
  samples,
  counts,
  threshold,
  lowerScoresAreMoreGenuine,
) {
  let falseAccepts = 0;
  let falseRejects = 0;
  let trueAccepts = 0;
  let trueRejects = 0;

  for (const sample of samples) {
    const accepted = isAccepted(
      sample.score,
      threshold,
      lowerScoresAreMoreGenuine,
    );
    if (sample.label === "genuine") {
      if (accepted) {
        trueAccepts += 1;
      } else {
        falseRejects += 1;
      }
    } else if (accepted) {
      falseAccepts += 1;
    } else {
      trueRejects += 1;
    }
  }

  return {
    threshold,
    falseAcceptRate: falseAccepts / counts.impostor,
    falseRejectRate: falseRejects / counts.genuine,
    trueAcceptRate: trueAccepts / counts.genuine,
    trueRejectRate: trueRejects / counts.impostor,
    balancedErrorRate: (
      (falseAccepts / counts.impostor)
      + (falseRejects / counts.genuine)
    ) / 2,
    counts: {
      falseAccepts,
      falseRejects,
      trueAccepts,
      trueRejects,
      genuine: counts.genuine,
      impostor: counts.impostor,
      total: counts.total,
    },
  };
}

function calculateOperatingMetrics(samples, threshold, options = {}) {
  const settings = validateOptions(options);
  const validated = validateLabeledSamples(samples);
  const lowerScoresAreMoreGenuine = validateDirection(
    settings.lowerScoresAreMoreGenuine,
  );
  return metricsFromValidated(
    validated.samples,
    validated.counts,
    validateThreshold(threshold),
    lowerScoresAreMoreGenuine,
  );
}

function outerBoundary(value, lower) {
  const delta = Math.max(1, Math.abs(value)) * 1e-9;
  return lower ? value - delta : value + delta;
}

function candidateThresholds(samples, lowerScoresAreMoreGenuine) {
  const unique = [...new Set(samples.map((sample) => sample.score))]
    .sort((left, right) => left - right);
  if (lowerScoresAreMoreGenuine) {
    return [outerBoundary(unique[0], true), ...unique];
  }
  return [
    outerBoundary(unique[unique.length - 1], false),
    ...unique.reverse(),
  ];
}

function calculateEqualErrorRate(samples, options = {}) {
  const settings = validateOptions(options);
  const validated = validateLabeledSamples(samples);
  const lowerScoresAreMoreGenuine = validateDirection(
    settings.lowerScoresAreMoreGenuine,
  );
  const points = candidateThresholds(
    validated.samples,
    lowerScoresAreMoreGenuine,
  ).map((threshold) => metricsFromValidated(
    validated.samples,
    validated.counts,
    threshold,
    lowerScoresAreMoreGenuine,
  ));

  for (const point of points) {
    if (point.falseAcceptRate === point.falseRejectRate) {
      return {
        rate: point.falseAcceptRate,
        threshold: point.threshold,
        falseAcceptRate: point.falseAcceptRate,
        falseRejectRate: point.falseRejectRate,
        method: "observed",
        sampleCounts: { ...validated.counts },
      };
    }
  }

  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    const beforeDifference = (
      before.falseAcceptRate - before.falseRejectRate
    );
    const afterDifference = (
      after.falseAcceptRate - after.falseRejectRate
    );
    if (beforeDifference < 0 && afterDifference > 0) {
      const fraction = (
        -beforeDifference / (afterDifference - beforeDifference)
      );
      const falseAcceptRate = before.falseAcceptRate + (
        (after.falseAcceptRate - before.falseAcceptRate) * fraction
      );
      const falseRejectRate = before.falseRejectRate + (
        (after.falseRejectRate - before.falseRejectRate) * fraction
      );
      return {
        rate: (falseAcceptRate + falseRejectRate) / 2,
        threshold: before.threshold + (
          (after.threshold - before.threshold) * fraction
        ),
        falseAcceptRate,
        falseRejectRate,
        method: "interpolated",
        sampleCounts: { ...validated.counts },
      };
    }
  }

  const closest = [...points].sort((left, right) => {
    const leftGap = Math.abs(
      left.falseAcceptRate - left.falseRejectRate,
    );
    const rightGap = Math.abs(
      right.falseAcceptRate - right.falseRejectRate,
    );
    return leftGap - rightGap
      || left.balancedErrorRate - right.balancedErrorRate
      || left.threshold - right.threshold;
  })[0];
  return {
    rate: closest.balancedErrorRate,
    threshold: closest.threshold,
    falseAcceptRate: closest.falseAcceptRate,
    falseRejectRate: closest.falseRejectRate,
    method: "closest_observed",
    sampleCounts: { ...validated.counts },
  };
}

function validateTargetRate(value) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new CalibrationValidationError(
      "maxFalseAcceptRate must be a number between 0 and 1.",
    );
  }
  return value;
}

function compareTargetFarPoints(
  left,
  right,
  lowerScoresAreMoreGenuine,
) {
  return left.falseRejectRate - right.falseRejectRate
    || left.falseAcceptRate - right.falseAcceptRate
    || (
      lowerScoresAreMoreGenuine
        ? right.threshold - left.threshold
        : left.threshold - right.threshold
    );
}

function calibrationWarnings(counts, metrics) {
  const warnings = [];
  if (counts.genuine < 20 || counts.impostor < 20) {
    warnings.push("SMALL_CALIBRATION_SET");
  }
  if (metrics.trueAcceptRate === 0) {
    warnings.push("NO_GENUINE_SAMPLES_ACCEPTED");
  }
  if (metrics.falseAcceptRate > 0) {
    warnings.push("OBSERVED_FALSE_ACCEPTS");
  }
  return warnings;
}

function calibrateThreshold(samples, options = {}) {
  const settings = validateOptions(options);
  const validated = validateLabeledSamples(samples);
  const lowerScoresAreMoreGenuine = validateDirection(
    settings.lowerScoresAreMoreGenuine,
  );
  const strategy = settings.strategy ?? "target_far";
  if (strategy !== "target_far" && strategy !== "eer") {
    throw new CalibrationValidationError(
      'strategy must be "target_far" or "eer".',
    );
  }

  const eer = calculateEqualErrorRate(validated.samples, {
    lowerScoresAreMoreGenuine,
  });
  let threshold;
  let targetFalseAcceptRate = null;

  if (strategy === "eer") {
    threshold = eer.threshold;
  } else {
    targetFalseAcceptRate = validateTargetRate(
      settings.maxFalseAcceptRate ?? 0.01,
    );
    const eligible = candidateThresholds(
      validated.samples,
      lowerScoresAreMoreGenuine,
    )
      .map((candidate) => metricsFromValidated(
        validated.samples,
        validated.counts,
        candidate,
        lowerScoresAreMoreGenuine,
      ))
      .filter(
        (metrics) => metrics.falseAcceptRate <= targetFalseAcceptRate,
      )
      .sort((left, right) => compareTargetFarPoints(
        left,
        right,
        lowerScoresAreMoreGenuine,
      ));
    threshold = eligible[0].threshold;
  }

  const metrics = metricsFromValidated(
    validated.samples,
    validated.counts,
    threshold,
    lowerScoresAreMoreGenuine,
  );
  return {
    version: 1,
    strategy,
    threshold,
    lowerScoresAreMoreGenuine,
    targetFalseAcceptRate,
    metrics,
    equalErrorRate: eer,
    sampleCounts: { ...validated.counts },
    warnings: calibrationWarnings(validated.counts, metrics),
  };
}

module.exports = {
  CalibrationValidationError,
  MAX_CALIBRATION_SAMPLES,
  calculateEqualErrorRate,
  calculateOperatingMetrics,
  calibrateThreshold,
  validateLabeledSamples,
};
