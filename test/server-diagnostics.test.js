"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { VERIFICATION_ROUNDS } = require("../public/challenge");
const {
  buildBehaviorDiagnostics,
  validateTypingDiagnostics,
} = require("../src/diagnostics");

function validTypingDiagnostics() {
  return {
    version: 1,
    missionId: VERIFICATION_ROUNDS[0].id,
    totalDurationMs: 4_200,
    inputEventCount: 48,
    keyPressCount: 46,
    cadencePerMinute: 657.14,
    pauses: {
      thresholdMs: 500,
      count: 2,
      longestMs: 760,
    },
    bursts: {
      count: 3,
      averageEvents: 16,
    },
    guided: {
      durationMs: 2_100,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 1, durationMs: 120 },
        { index: 2, characterCount: 7, durationMs: 620 },
        { index: 3, characterCount: 7, durationMs: 480 },
      ],
    },
    freeTyping: {
      durationMs: 1_700,
      wordCount: 2,
      words: [
        { index: 1, characterCount: 5, durationMs: 460 },
        { index: 2, characterCount: 8, durationMs: 710 },
      ],
    },
  };
}

function validTypingDiagnosticsV2() {
  const value = validTypingDiagnostics();
  value.version = 2;
  Object.assign(value.guided, {
    corrections: 2,
    deletions: 1,
    replacements: 1,
    largestRollback: 2,
  });
  Object.assign(value.freeTyping, {
    corrections: 1,
    deletions: 1,
    replacements: 0,
    largestRollback: 1,
  });
  value.corrections = {
    total: 3,
    deletions: 2,
    replacements: 1,
    largestRollback: 2,
  };
  return value;
}

test("validates text-free typing diagnostics and rejects added content", () => {
  const valid = validateTypingDiagnostics(
    validTypingDiagnostics(),
    VERIFICATION_ROUNDS
  );
  assert.equal(valid.missionId, VERIFICATION_ROUNDS[0].id);
  assert.equal(valid.guided.words.length, 3);

  const withText = validTypingDiagnostics();
  withText.freeTyping.text = "content that must not be stored";
  assert.throws(
    () => validateTypingDiagnostics(withText, VERIFICATION_ROUNDS),
    /unsupported fields/
  );
});

test("accepts version 2 correction aggregates without storing raw input", () => {
  const valid = validateTypingDiagnostics(
    validTypingDiagnosticsV2(),
    VERIFICATION_ROUNDS
  );

  assert.equal(valid.version, 2);
  assert.deepEqual(valid.corrections, {
    total: 3,
    deletions: 2,
    replacements: 1,
    largestRollback: 2,
  });
  assert.equal(valid.guided.corrections, 2);
  assert.equal(valid.freeTyping.replacements, 0);

  const withRawInput = validTypingDiagnosticsV2();
  withRawInput.corrections.rawKeys = ["Backspace"];
  assert.throws(
    () => validateTypingDiagnostics(withRawInput, VERIFICATION_ROUNDS),
    /unsupported fields/
  );

  const withRawFieldInput = validTypingDiagnosticsV2();
  withRawFieldInput.guided.typedText = "private text";
  assert.throws(
    () => validateTypingDiagnostics(withRawFieldInput, VERIFICATION_ROUNDS),
    /unsupported fields/
  );
});

test("keeps version 1 compatible and rejects inconsistent corrections", () => {
  const legacy = validateTypingDiagnostics(
    validTypingDiagnostics(),
    VERIFICATION_ROUNDS
  );
  assert.equal(legacy.version, 1);
  assert.equal(Object.hasOwn(legacy, "corrections"), false);

  const aggregateMismatch = validTypingDiagnosticsV2();
  aggregateMismatch.corrections.total = 4;
  assert.throws(
    () => validateTypingDiagnostics(aggregateMismatch, VERIFICATION_ROUNDS),
    /must match/
  );

  const excessiveCorrections = validTypingDiagnosticsV2();
  excessiveCorrections.inputEventCount = 2;
  assert.throws(
    () => validateTypingDiagnostics(excessiveCorrections, VERIFICATION_ROUNDS),
    /cannot exceed inputEventCount/
  );
});

test("builds readable keyboard, pointer, pause, and slow-word analysis", () => {
  const vector = {
    dwellMean: 94,
    dwellDeviation: 18,
    flightMean: 72,
    flightDeviation: 25,
    downDownMean: 166,
    downDownDeviation: 31,
    pointerVelocityMean: 720,
    pointerVelocityDeviation: 140,
    pointerAccelerationMean: 4_300,
    pointerAccelerationDeviation: 900,
    pointerJitterMean: 0.17,
    pointerJitterDeviation: 0.08,
  };
  const template = {
    means: Object.fromEntries(
      Object.entries(vector).map(([key, value]) => [key, value * 0.95])
    ),
  };
  const typing = validateTypingDiagnostics(
    validTypingDiagnostics(),
    VERIFICATION_ROUNDS
  );
  const result = buildBehaviorDiagnostics(
    vector,
    template,
    typing,
    VERIFICATION_ROUNDS[0]
  );

  assert.equal(result.keyboard.averageKeyHoldMs, 94);
  assert.equal(result.keyboard.holdConsistency, "Consistent");
  assert.equal(result.typing.pauses.count, 2);
  assert.equal(result.slowWords.guided[0].label, "Response word 2");
  assert.equal(result.slowWords.freeTyping[0].label, "Free word 2");
  assert.ok(result.baselineComparison.length >= 6);
});

test("adds correction aggregates to version 2 behavior diagnostics", () => {
  const vector = {
    dwellMean: 94,
    dwellDeviation: 18,
    flightMean: 72,
    flightDeviation: 25,
    downDownMean: 166,
    downDownDeviation: 31,
    pointerVelocityMean: 720,
    pointerVelocityDeviation: 140,
    pointerAccelerationMean: 4_300,
    pointerAccelerationDeviation: 900,
    pointerJitterMean: 0.17,
    pointerJitterDeviation: 0.08,
  };
  const template = {
    means: Object.fromEntries(
      Object.entries(vector).map(([key, value]) => [key, value * 0.95])
    ),
  };
  const typing = validateTypingDiagnostics(
    validTypingDiagnosticsV2(),
    VERIFICATION_ROUNDS
  );
  const result = buildBehaviorDiagnostics(
    vector,
    template,
    typing,
    VERIFICATION_ROUNDS[0]
  );

  assert.equal(result.typing.corrections.total, 3);
  assert.equal(result.typing.corrections.guided.total, 2);
  assert.equal(result.typing.corrections.freeTyping.total, 1);
});
