"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assessAutomationRisk,
  validateInteractionEvidence,
} = require("../src/automation-risk");

function ordinaryVector() {
  return {
    dwellMean: 105,
    dwellDeviation: 24,
    flightMean: 82,
    flightDeviation: 31,
    downDownMean: 190,
    downDownDeviation: 45,
    pointerVelocityMean: 520,
    pointerVelocityDeviation: 180,
    pointerJitterMean: 0.28,
    pointerJitterDeviation: 0.12,
  };
}

function ordinaryDiagnostics() {
  return {
    totalDurationMs: 8_200,
    inputEventCount: 92,
    keyPressCount: 88,
    cadencePerMinute: 644,
  };
}

function ordinaryEvidence() {
  return validateInteractionEvidence({
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 88,
      flight: 84,
      downDown: 84,
      pointer: 32,
    },
    durationMs: 10_400,
  });
}

function ordinarySessionAggregate() {
  return {
    elapsedMs: 15_000,
    keyboard: {
      keyDownEvents: 100,
      keyUpEvents: 98,
      repeatedKeyEvents: 2,
      inputEvents: 100,
      correctionEvents: 4,
      deletionEvents: 3,
      undoEvents: 1,
    },
    pointer: {
      moveEvents: 50,
      distancePx: 4_200.5,
      pointerDownEvents: 8,
      pointerUpEvents: 8,
      clickEvents: 7,
      doubleClickEvents: 1,
      contextMenuEvents: 0,
    },
    scrolling: {
      wheelEvents: 10,
      scrollEvents: 9,
      distancePx: 2_100.25,
    },
    delays: {
      sampleCount: 20,
      averageMs: 250.5,
      deviationMs: 100.25,
      longestMs: 800,
    },
    zoom: {
      changeEvents: 1,
      visualScaleMinimum: 1,
      visualScaleMaximum: 1.25,
      devicePixelRatioMinimum: 1,
      devicePixelRatioMaximum: 2,
    },
    viewTiming: [
      { view: "login", durationMs: 2_000 },
      { view: "verification", durationMs: 8_000 },
      { view: "dashboard", durationMs: 4_000 },
    ],
  };
}

function ordinaryEvidenceV2() {
  return validateInteractionEvidence({
    version: 2,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 88,
      flight: 84,
      downDown: 84,
      pointer: 32,
    },
    durationMs: 10_400,
    sessionAggregate: ordinarySessionAggregate(),
  });
}

test("classifies ordinary aggregate interaction as human-like without proof claims", () => {
  const result = assessAutomationRisk(
    ordinaryVector(),
    ordinaryDiagnostics(),
    ordinaryEvidence(),
  );

  assert.equal(result.classification, "human_like_interaction");
  assert.equal(result.level, "low");
  assert.equal(result.grantRestrictionRecommended, false);
  assert.ok(result.limitations.some((value) => /not proof/i.test(value)));
});

test("flags synthetic, implausibly fast, and robotic interaction evidence", () => {
  const evidence = validateInteractionEvidence({
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 3,
    sampleCounts: {
      dwell: 80,
      flight: 79,
      downDown: 79,
      pointer: 24,
    },
    durationMs: 500,
  });
  const result = assessAutomationRisk(
    {
      dwellMean: 8,
      dwellDeviation: 0,
      flightMean: 5,
      flightDeviation: 0,
      downDownMean: 12,
      downDownDeviation: 0,
      pointerVelocityMean: 500,
      pointerVelocityDeviation: 0,
      pointerJitterMean: 0,
      pointerJitterDeviation: 0,
    },
    {
      totalDurationMs: 600,
      inputEventCount: 90,
      keyPressCount: 90,
      cadencePerMinute: 9_000,
    },
    evidence,
  );

  assert.equal(result.classification, "automation_likely");
  assert.equal(result.level, "high");
  assert.equal(result.riskScore, 100);
  assert.equal(result.grantRestrictionRecommended, true);
  assert.ok(result.reasonCodes.includes("SYNTHETIC_EVENTS_OBSERVED"));
  assert.ok(result.reasonCodes.includes("ROBOTIC_TIMING_REGULARITY"));
});

test("accepts bounded version 2 whole-session aggregate telemetry", () => {
  const evidence = ordinaryEvidenceV2();

  assert.equal(evidence.version, 2);
  assert.equal(evidence.sessionAggregate.keyboard.keyDownEvents, 100);
  assert.equal(evidence.sessionAggregate.pointer.distancePx, 4_200.5);
  assert.deepEqual(evidence.sessionAggregate.viewTiming, [
    { view: "login", durationMs: 2_000 },
    { view: "verification", durationMs: 8_000 },
    { view: "dashboard", durationMs: 4_000 },
  ]);

  const withoutAggregate = validateInteractionEvidence({
    version: 2,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 1,
      flight: 0,
      downDown: 0,
      pointer: 0,
    },
    durationMs: 250,
  });
  assert.equal(Object.hasOwn(withoutAggregate, "sessionAggregate"), false);
});

test("strictly excludes raw keys, text, coordinates, and unknown views", () => {
  const rawKey = ordinarySessionAggregate();
  rawKey.keyboard.key = "q";
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: rawKey,
    }),
    /unsupported fields/
  );

  const coordinates = ordinarySessionAggregate();
  coordinates.pointer.coordinates = [{ x: 1, y: 2 }];
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: coordinates,
    }),
    /unsupported fields/
  );

  const unknownView = ordinarySessionAggregate();
  unknownView.viewTiming[0].view = "private answer";
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: unknownView,
    }),
    /view is invalid/
  );

  const rawRootText = {
    version: 2,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 1,
      flight: 0,
      downDown: 0,
      pointer: 0,
    },
    durationMs: 250,
    typedText: "private text",
  };
  assert.throws(
    () => validateInteractionEvidence(rawRootText),
    /unsupported fields/
  );
});

test("rejects inconsistent version 2 session aggregates", () => {
  const corrections = ordinarySessionAggregate();
  corrections.keyboard.inputEvents = 1;
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: corrections,
    }),
    /keyboard counts are inconsistent/
  );

  const zoom = ordinarySessionAggregate();
  zoom.zoom.visualScaleMinimum = 2;
  zoom.zoom.visualScaleMaximum = 1;
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: zoom,
    }),
    /zoom ranges are invalid/
  );

  const viewTiming = ordinarySessionAggregate();
  viewTiming.elapsedMs = 10_000;
  assert.throws(
    () => validateInteractionEvidence({
      version: 2,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 1,
        flight: 0,
        downDown: 0,
        pointer: 0,
      },
      durationMs: 250,
      sessionAggregate: viewTiming,
    }),
    /view timing exceeds elapsedMs/
  );
});

test("keeps whole-session consistency signals conservative", () => {
  const aggregate = ordinarySessionAggregate();
  aggregate.elapsedMs = 500;
  aggregate.keyboard.keyDownEvents = 10;
  aggregate.keyboard.inputEvents = 10;
  aggregate.keyboard.correctionEvents = 1;
  aggregate.keyboard.deletionEvents = 1;
  aggregate.keyboard.undoEvents = 0;
  aggregate.pointer.moveEvents = 4;
  aggregate.viewTiming = [{ view: "unknown", durationMs: 500 }];

  const evidence = validateInteractionEvidence({
    version: 2,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 88,
      flight: 84,
      downDown: 84,
      pointer: 32,
    },
    durationMs: 10_400,
    sessionAggregate: aggregate,
  });
  const result = assessAutomationRisk(
    ordinaryVector(),
    {
      ...ordinaryDiagnostics(),
      version: 2,
      corrections: {
        total: 4,
        deletions: 3,
        replacements: 1,
        largestRollback: 2,
      },
    },
    evidence
  );

  assert.equal(result.riskScore, 32);
  assert.equal(result.classification, "human_like_interaction");
  assert.equal(result.level, "low");
  assert.equal(result.grantRestrictionRecommended, false);
  assert.ok(result.reasonCodes.includes("SESSION_DURATION_INCONSISTENCY"));
  assert.ok(result.reasonCodes.includes("SESSION_KEYBOARD_COUNT_INCONSISTENCY"));
  assert.ok(result.reasonCodes.includes("SESSION_POINTER_COUNT_INCONSISTENCY"));
  assert.ok(result.reasonCodes.includes("SESSION_CORRECTION_COUNT_INCONSISTENCY"));
});

test("strictly validates bounded interaction evidence", () => {
  assert.throws(
    () => validateInteractionEvidence({
      version: 1,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 12,
        flight: 10,
        downDown: 10,
        pointer: 8,
      },
      durationMs: 2_000,
      rawEvents: [],
    }),
    /unsupported fields/,
  );

  const legacyWithSessionAggregate = {
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 12,
      flight: 10,
      downDown: 10,
      pointer: 8,
    },
    durationMs: 2_000,
    sessionAggregate: ordinarySessionAggregate(),
  };
  assert.throws(
    () => validateInteractionEvidence(legacyWithSessionAggregate),
    /unsupported fields/
  );
});
