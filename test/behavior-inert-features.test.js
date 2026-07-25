"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  adoptFeatures,
  comparableFeatureKeys,
  createTemplate,
  evaluateVector,
} = require("../src/behavior");
const { describeFeatureCoverage } = require("../src/behavior-lifecycle");

const FEATURE_NAMES = [
  "dwellMean",
  "dwellDeviation",
  "flightMean",
  "flightDeviation",
  "downDownMean",
  "downDownDeviation",
  "pointerVelocityMean",
  "pointerVelocityDeviation",
  "pointerAccelerationMean",
  "pointerAccelerationDeviation",
  "pointerJitterMean",
  "pointerJitterDeviation",
];

const KEYBOARD_FEATURES = FEATURE_NAMES.filter(
  (name) => !name.startsWith("pointer"),
);

function vector(values) {
  const result = {};
  for (const name of FEATURE_NAMES) {
    result[name] = values[name] ?? 0;
  }
  return result;
}

function pointerSample(index) {
  return vector({
    pointerVelocityMean: 250 + index,
    pointerVelocityDeviation: 22 + (index * 0.5),
    pointerAccelerationMean: 820 + (index * 4),
    pointerAccelerationDeviation: 92 + index,
    pointerJitterMean: 0.31 + (index * 0.004),
    pointerJitterDeviation: 0.05,
  });
}

function typingSample(index) {
  return vector({
    dwellMean: 95 + index,
    dwellDeviation: 12,
    flightMean: 120 + index,
    flightDeviation: 20,
    downDownMean: 210 + index,
    downDownDeviation: 30,
    pointerVelocityMean: 250 + index,
    pointerVelocityDeviation: 22,
    pointerAccelerationMean: 820,
    pointerAccelerationDeviation: 92,
    pointerJitterMean: 0.31,
    pointerJitterDeviation: 0.05,
  });
}

const pointerOnlyEnrollment = [0, 1, 2, 3, 4].map(pointerSample);
const fullEnrollment = [0, 1, 2, 3, 4].map(typingSample);

test("marks features that carried no enrollment signal as inert", () => {
  const template = createTemplate(pointerOnlyEnrollment);

  assert.equal(template.version, 2);
  assert.equal(template.featureKeys.length, FEATURE_NAMES.length);
  assert.equal(template.activeFeatureKeys.length, 6);
  for (const name of KEYBOARD_FEATURES) {
    assert.ok(
      !template.activeFeatureKeys.includes(name),
      `${name} should be inert for a pointer-only enrollment`,
    );
  }
});

test("scores only comparable features rather than the full feature set", () => {
  const template = createTemplate(pointerOnlyEnrollment);
  const result = evaluateVector(pointerSample(2), template);

  assert.equal(result.comparedFeatureCount, 6);
});

test("a later typing sample is not treated as an infinite mismatch", () => {
  // An inert feature stores mean 0 with the 1e-6 scale floor. Scoring a real
  // measurement against it would previously produce a distance in the millions
  // and deny the account permanently.
  const template = createTemplate(pointerOnlyEnrollment);
  const result = evaluateVector(typingSample(2), template);

  assert.ok(
    result.normalizedDistance < template.acceptanceThreshold,
    `expected a comparable distance, received ${result.normalizedDistance}`,
  );
  assert.equal(result.decision, "allow");
});

test("adopts inert families from strongly verified samples", () => {
  const template = createTemplate(pointerOnlyEnrollment);
  const adoption = adoptFeatures(template, [0, 1, 2].map(typingSample), {
    updatedAt: "2026-07-25T01:00:00.000Z",
  });

  assert.equal(adoption.status, "adopted");
  assert.deepEqual(adoption.adopted.sort(), [...KEYBOARD_FEATURES].sort());
  assert.equal(adoption.template.activeFeatureKeys.length, 12);
  assert.equal(adoption.template.updatedAt, "2026-07-25T01:00:00.000Z");
  assert.equal(
    evaluateVector(typingSample(1), adoption.template).comparedFeatureCount,
    12,
  );
});

test("adoption reports when the samples add no new signal", () => {
  const template = createTemplate(pointerOnlyEnrollment);
  const adoption = adoptFeatures(template, [0, 1, 2].map(pointerSample));

  assert.equal(adoption.status, "no_features_adopted");
  assert.deepEqual(adoption.adopted, []);
  assert.equal(adoption.template, template);
});

test("rejects an enrollment with no measurable signal anywhere", () => {
  assert.throws(
    () => createTemplate([vector({}), vector({}), vector({})]),
    ValidationError,
  );
});

test("v1 templates without activeFeatureKeys compare every feature", () => {
  const template = createTemplate(fullEnrollment);
  delete template.activeFeatureKeys;

  assert.deepEqual(comparableFeatureKeys(template), template.featureKeys);
  assert.equal(
    evaluateVector(typingSample(2), template).comparedFeatureCount,
    12,
  );
});

test("feature coverage tracks what a sample can actually be scored against", () => {
  const pointerOnly = createTemplate(pointerOnlyEnrollment);
  const full = createTemplate(fullEnrollment);
  const pointerCounts = { dwell: 0, flight: 0, downDown: 0, pointer: 40 };
  const fullCounts = { dwell: 30, flight: 25, downDown: 25, pointer: 40 };

  // A profile enrolled with typing cannot be verified on mouse movement alone.
  const starved = describeFeatureCoverage(full, pointerCounts);
  assert.equal(starved.sufficient, false);
  assert.equal(starved.comparedFeatureNames.length, 6);

  assert.equal(describeFeatureCoverage(full, fullCounts).sufficient, true);

  // A pointer-only profile is no longer held to a family minimum it can never
  // meet, which previously rejected every passive verification forever.
  const passive = describeFeatureCoverage(pointerOnly, pointerCounts);
  assert.equal(passive.sufficient, true);
  assert.equal(passive.comparedFeatureNames.length, 6);
  assert.equal(passive.ignoredFeatureNames.length, 6);
});
