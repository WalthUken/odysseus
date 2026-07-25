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
  assert.equal(result.slowWords.guided[0].label, "trusted");
  assert.equal(result.slowWords.freeTyping[0].label, "Free word 2");
  assert.ok(result.baselineComparison.length >= 6);
});
