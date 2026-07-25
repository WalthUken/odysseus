"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CalibrationValidationError,
  calculateEqualErrorRate,
  calculateOperatingMetrics,
  calibrateThreshold,
  validateLabeledSamples,
} = require("../src/calibration");

test("calculates FAR, FRR, acceptance, and rejection counts", () => {
  const samples = [
    { label: "genuine", score: 0.1 },
    { label: "genuine", score: 0.2 },
    { label: "genuine", score: 0.3 },
    { label: "genuine", score: 0.9 },
    { label: "impostor", score: 0.8 },
    { label: "impostor", score: 1 },
    { label: "impostor", score: 1.2 },
    { label: "impostor", score: 1.4 },
  ];

  const metrics = calculateOperatingMetrics(samples, 0.5);

  assert.equal(metrics.falseAcceptRate, 0);
  assert.equal(metrics.falseRejectRate, 0.25);
  assert.equal(metrics.trueAcceptRate, 0.75);
  assert.equal(metrics.trueRejectRate, 1);
  assert.equal(metrics.balancedErrorRate, 0.125);
  assert.deepEqual(metrics.counts, {
    falseAccepts: 0,
    falseRejects: 1,
    trueAccepts: 3,
    trueRejects: 4,
    genuine: 4,
    impostor: 4,
    total: 8,
  });
});

test("supports scores where higher values indicate a genuine match", () => {
  const samples = [
    { label: "genuine", score: 0.8 },
    { label: "genuine", score: 0.9 },
    { label: "impostor", score: 0.1 },
    { label: "impostor", score: 0.2 },
  ];

  const metrics = calculateOperatingMetrics(samples, 0.8, {
    lowerScoresAreMoreGenuine: false,
  });

  assert.equal(metrics.falseAcceptRate, 0);
  assert.equal(metrics.falseRejectRate, 0);
  assert.equal(metrics.trueAcceptRate, 1);
});

test("returns an observed equal error operating point when available", () => {
  const samples = [
    { label: "genuine", score: 1 },
    { label: "genuine", score: 4 },
    { label: "impostor", score: 2 },
    { label: "impostor", score: 3 },
  ];

  const result = calculateEqualErrorRate(samples);

  assert.equal(result.method, "observed");
  assert.equal(result.threshold, 2);
  assert.equal(result.rate, 0.5);
  assert.equal(result.falseAcceptRate, 0.5);
  assert.equal(result.falseRejectRate, 0.5);
});

test("reports zero EER for a perfectly separated evaluation set", () => {
  const result = calculateEqualErrorRate([
    { label: "genuine", score: 1 },
    { label: "genuine", score: 2 },
    { label: "impostor", score: 3 },
    { label: "impostor", score: 4 },
  ]);

  assert.equal(result.method, "observed");
  assert.equal(result.threshold, 2);
  assert.equal(result.rate, 0);
});

test("interpolates EER between adjacent observed operating points", () => {
  const samples = [
    { label: "genuine", score: 1 },
    { label: "genuine", score: 2 },
    { label: "genuine", score: 5 },
    { label: "impostor", score: 3 },
    { label: "impostor", score: 4 },
  ];

  const result = calculateEqualErrorRate(samples);

  assert.equal(result.method, "interpolated");
  assert.ok(Math.abs(result.threshold - (8 / 3)) < 1e-12);
  assert.ok(Math.abs(result.rate - (1 / 3)) < 1e-12);
  assert.ok(
    Math.abs(result.falseAcceptRate - result.falseRejectRate) < 1e-12,
  );
});

test("calibrates the most usable threshold under a FAR limit", () => {
  const samples = [
    { label: "genuine", score: 0.1 },
    { label: "genuine", score: 0.2 },
    { label: "genuine", score: 0.9 },
    { label: "impostor", score: 0.8 },
    { label: "impostor", score: 1 },
  ];

  const calibration = calibrateThreshold(samples, {
    maxFalseAcceptRate: 0,
  });

  assert.equal(calibration.version, 1);
  assert.equal(calibration.strategy, "target_far");
  assert.equal(calibration.threshold, 0.2);
  assert.equal(calibration.metrics.falseAcceptRate, 0);
  assert.equal(calibration.metrics.falseRejectRate, 1 / 3);
  assert.deepEqual(calibration.sampleCounts, {
    genuine: 3,
    impostor: 2,
    total: 5,
  });
  assert.ok(calibration.warnings.includes("SMALL_CALIBRATION_SET"));
});

test("can calibrate directly to the EER threshold", () => {
  const samples = [
    { label: "genuine", score: 1 },
    { label: "genuine", score: 4 },
    { label: "impostor", score: 2 },
    { label: "impostor", score: 3 },
  ];

  const calibration = calibrateThreshold(samples, {
    strategy: "eer",
  });

  assert.equal(calibration.threshold, 2);
  assert.equal(calibration.metrics.falseAcceptRate, 0.5);
  assert.equal(calibration.metrics.falseRejectRate, 0.5);
  assert.equal(calibration.targetFalseAcceptRate, null);
});

test("rejects malformed samples, missing classes, and invalid options", () => {
  assert.throws(
    () => validateLabeledSamples([
      { label: "genuine", score: 0.1 },
      { label: "genuine", score: 0.2 },
    ]),
    CalibrationValidationError,
  );
  assert.throws(
    () => calculateOperatingMetrics([
      { label: "genuine", score: Number.NaN },
      { label: "impostor", score: 1 },
    ], 0.5),
    CalibrationValidationError,
  );
  assert.throws(
    () => calibrateThreshold([
      { label: "genuine", score: 0.1 },
      { label: "impostor", score: 1 },
    ], {
      maxFalseAcceptRate: 2,
    }),
    CalibrationValidationError,
  );
  assert.throws(
    () => calibrateThreshold([
      { label: "genuine", score: 0.1 },
      { label: "impostor", score: 1 },
    ], {
      strategy: "guess",
    }),
    CalibrationValidationError,
  );
  assert.throws(
    () => calculateEqualErrorRate([
      { label: "genuine", score: 0.1 },
      { label: "impostor", score: 1 },
    ], null),
    CalibrationValidationError,
  );
});
