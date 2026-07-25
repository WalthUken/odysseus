"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  createTemplate,
  evaluateVector,
  validateFeatureVector,
  validateProfileId,
} = require("../src/behavior");

const samples = [
  { dwellMean: 100, flightMean: 75, pointerVelocityMean: 420 },
  { dwellMean: 104, flightMean: 72, pointerVelocityMean: 440 },
  { dwellMean: 98, flightMean: 78, pointerVelocityMean: 410 },
  { dwellMean: 102, flightMean: 74, pointerVelocityMean: 430 },
  { dwellMean: 101, flightMean: 76, pointerVelocityMean: 425 },
];

test("creates a calibrated template from enrollment samples", () => {
  const template = createTemplate(samples, {
    enrolledAt: "2026-07-24T12:00:00.000Z",
  });

  assert.equal(template.sampleCount, 5);
  assert.deepEqual(template.featureKeys, [
    "dwellMean",
    "flightMean",
    "pointerVelocityMean",
  ]);
  assert.equal(template.enrolledAt, "2026-07-24T12:00:00.000Z");
  assert.ok(template.acceptanceThreshold >= 1.5);
  assert.ok(template.scales.dwellMean > 0);
});

test("allows a vector that resembles the enrollment baseline", () => {
  const template = createTemplate(samples);
  const result = evaluateVector(
    { dwellMean: 101, flightMean: 75, pointerVelocityMean: 427 },
    template,
  );

  assert.equal(result.decision, "allow");
  assert.equal(result.policy.allowSensitiveActions, true);
  assert.equal(result.policy.stepUpRequired, false);
  assert.ok(result.trustScore >= 0.7);
  assert.ok(result.reasonCodes.includes("BEHAVIOR_MATCH"));
});

test("denies a vector far outside the enrollment baseline", () => {
  const template = createTemplate(samples);
  const result = evaluateVector(
    { dwellMean: 450, flightMean: 500, pointerVelocityMean: 4000 },
    template,
  );

  assert.equal(result.decision, "deny");
  assert.equal(result.policy.allowSensitiveActions, false);
  assert.equal(result.policy.stepUpRequired, true);
  assert.ok(result.trustScore < 0.7);
  assert.ok(result.reasonCodes.includes("BEHAVIOR_MISMATCH"));
});

test("rejects feature vectors that do not match the enrolled feature set", () => {
  const template = createTemplate(samples);

  assert.throws(
    () => evaluateVector({ dwellMean: 100, flightMean: 75 }, template),
    ValidationError,
  );
});

test("validates profile identifiers and finite numeric features", () => {
  assert.equal(validateProfileId(" demo-user "), "demo-user");
  assert.throws(() => validateProfileId("../../profile"), ValidationError);
  assert.throws(
    () => validateFeatureVector({ dwellMean: Number.NaN }),
    ValidationError,
  );
});
