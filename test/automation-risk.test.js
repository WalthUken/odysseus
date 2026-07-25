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

// A passively observed dashboard window can contain no typing at all, so every
// keyboard feature is exactly zero and only the pointer families carry signal.
function pointerOnlyVector(overrides = {}) {
  return {
    dwellMean: 0,
    dwellDeviation: 0,
    flightMean: 0,
    flightDeviation: 0,
    downDownMean: 0,
    downDownDeviation: 0,
    pointerVelocityMean: 470,
    pointerVelocityDeviation: 165,
    pointerAccelerationMean: 3_100,
    pointerAccelerationDeviation: 1_450,
    pointerJitterMean: 0.24,
    pointerJitterDeviation: 0.11,
    ...overrides,
  };
}

function mechanicalPointerVector(overrides = {}) {
  return pointerOnlyVector({
    pointerVelocityMean: 640,
    pointerVelocityDeviation: 4.1,
    pointerAccelerationMean: 6.2,
    pointerAccelerationDeviation: 3.4,
    pointerJitterMean: 0.0004,
    pointerJitterDeviation: 0.0009,
    ...overrides,
  });
}

function pointerOnlyEvidence(overrides = {}) {
  return validateInteractionEvidence({
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 0,
      flight: 0,
      downDown: 0,
      pointer: 96,
    },
    durationMs: 42_000,
    ...overrides,
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

test("flags a mechanically driven pointer-only window as automation", () => {
  const result = assessAutomationRisk(
    mechanicalPointerVector(),
    null,
    pointerOnlyEvidence(),
  );

  assert.equal(result.classification, "automation_likely");
  assert.equal(result.level, "high");
  assert.equal(result.grantRestrictionRecommended, true);
  assert.ok(result.riskScore >= 70 && result.riskScore <= 100);
  assert.ok(result.reasonCodes.includes("POINTER_PATH_WITHOUT_CURVATURE"));
  assert.ok(result.reasonCodes.includes("POINTER_VELOCITY_WITHOUT_VARIATION"));
  assert.ok(
    result.reasonCodes.includes("POINTER_WITHOUT_ACCELERATION_PROFILE"),
  );
  assert.ok(result.reasonCodes.includes("ROBOTIC_POINTER_REGULARITY"));
  assert.ok(result.limitations.some((value) => /not proof/i.test(value)));
});

test("flags teleporting pointer travel that skips the space between points", () => {
  const result = assessAutomationRisk(
    mechanicalPointerVector({
      pointerVelocityMean: 41_000,
      pointerVelocityDeviation: 900,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.equal(result.classification, "automation_likely");
  assert.ok(result.reasonCodes.includes("IMPLAUSIBLE_POINTER_VELOCITY"));
});

test("keeps a natural pointer-only window human-like", () => {
  const result = assessAutomationRisk(
    pointerOnlyVector(),
    null,
    pointerOnlyEvidence(),
  );

  assert.equal(result.classification, "human_like_interaction");
  assert.equal(result.level, "low");
  assert.equal(result.riskScore, 0);
  assert.equal(result.grantRestrictionRecommended, false);
  assert.deepEqual(result.reasonCodes, []);
});

test("does not charge a pointer-only window for absent typing diagnostics", () => {
  const pointerOnly = assessAutomationRisk(
    pointerOnlyVector(),
    null,
    pointerOnlyEvidence(),
  );
  assert.equal(
    pointerOnly.reasonCodes.includes("TYPING_DIAGNOSTICS_MISSING"),
    false,
  );

  const typingExpected = assessAutomationRisk(
    ordinaryVector(),
    null,
    ordinaryEvidence(),
  );
  assert.ok(typingExpected.reasonCodes.includes("TYPING_DIAGNOSTICS_MISSING"));
  assert.equal(typingExpected.classification, "human_like_interaction");

  const pointerSamplesOnly = assessAutomationRisk(
    pointerOnlyVector(),
    null,
    pointerOnlyEvidence({
      sampleCounts: {
        dwell: 4,
        flight: 3,
        downDown: 3,
        pointer: 96,
      },
    }),
  );
  assert.ok(
    pointerSamplesOnly.reasonCodes.includes("TYPING_DIAGNOSTICS_MISSING"),
  );
});

test("leaves smooth pointer hardware short of a restriction", () => {
  const smoothStylus = assessAutomationRisk(
    pointerOnlyVector({
      pointerVelocityMean: 300,
      pointerVelocityDeviation: 26,
      pointerAccelerationMean: 640,
      pointerAccelerationDeviation: 210,
      pointerJitterMean: 0.05,
      pointerJitterDeviation: 0.02,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.deepEqual(smoothStylus.reasonCodes, ["ROBOTIC_POINTER_REGULARITY"]);
  assert.equal(smoothStylus.classification, "human_like_interaction");
  assert.equal(smoothStylus.grantRestrictionRecommended, false);

  const assistivePointer = assessAutomationRisk(
    pointerOnlyVector({
      pointerVelocityMean: 210,
      pointerVelocityDeviation: 7,
      pointerAccelerationMean: 480,
      pointerAccelerationDeviation: 160,
      pointerJitterMean: 0.04,
      pointerJitterDeviation: 0.018,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.equal(assistivePointer.classification, "elevated_review");
  assert.equal(assistivePointer.grantRestrictionRecommended, false);
  assert.ok(
    assistivePointer.limitations.some((value) => /Accessibility tools/i.test(value)),
  );
});

test("still separates keyboard automation from ordinary typing", () => {
  const automated = assessAutomationRisk(
    ordinaryVector(),
    {
      ...ordinaryDiagnostics(),
      totalDurationMs: 500,
      cadencePerMinute: 4_800,
    },
    validateInteractionEvidence({
      version: 1,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 3,
      sampleCounts: {
        dwell: 88,
        flight: 84,
        downDown: 84,
        pointer: 32,
      },
      durationMs: 500,
    }),
  );

  assert.equal(automated.classification, "automation_likely");
  assert.equal(automated.level, "high");
  assert.equal(automated.grantRestrictionRecommended, true);
  assert.ok(automated.reasonCodes.includes("IMPLAUSIBLY_FAST_COMPLETION"));
  assert.ok(automated.reasonCodes.includes("IMPLAUSIBLE_CADENCE"));
  assert.ok(automated.reasonCodes.includes("SYNTHETIC_EVENTS_OBSERVED"));

  const borderline = assessAutomationRisk(
    ordinaryVector(),
    {
      ...ordinaryDiagnostics(),
      totalDurationMs: 2_000,
    },
    validateInteractionEvidence({
      version: 1,
      trustedEventsRequired: true,
      rejectedSyntheticEvents: 0,
      sampleCounts: {
        dwell: 88,
        flight: 84,
        downDown: 84,
        pointer: 32,
      },
      durationMs: 900,
    }),
  );

  assert.equal(borderline.classification, "elevated_review");
  assert.equal(borderline.level, "elevated");
  assert.equal(borderline.grantRestrictionRecommended, false);
  assert.ok(borderline.reasonCodes.includes("VERY_FAST_COMPLETION"));
  assert.ok(borderline.reasonCodes.includes("TELEMETRY_WINDOW_TOO_SHORT"));

  const ordinary = assessAutomationRisk(
    ordinaryVector(),
    ordinaryDiagnostics(),
    ordinaryEvidence(),
  );
  assert.equal(ordinary.classification, "human_like_interaction");
  assert.equal(ordinary.riskScore, 0);
});

test("reports a bounded risk score for every evidence shape", () => {
  const shapes = [
    [null, null, null],
    [pointerOnlyVector(), null, pointerOnlyEvidence()],
    [mechanicalPointerVector(), null, pointerOnlyEvidence()],
    [ordinaryVector(), ordinaryDiagnostics(), null],
    [ordinaryVector(), ordinaryDiagnostics(), ordinaryEvidenceV2()],
  ];

  for (const [vector, diagnostics, evidence] of shapes) {
    const result = assessAutomationRisk(vector, diagnostics, evidence);
    assert.ok(Number.isInteger(result.riskScore));
    assert.ok(result.riskScore >= 0 && result.riskScore <= 100);
    assert.equal(
      result.grantRestrictionRecommended,
      result.classification === "automation_likely",
    );
  }

  const noEvidence = assessAutomationRisk(pointerOnlyVector(), null, null);
  assert.equal(noEvidence.classification, "insufficient_evidence");
  assert.equal(noEvidence.level, "unknown");
});

test("flags travel interpolated between targets by the shape of its turns", () => {
  // An eased glide from one control to the next carries a human-looking speed
  // and acceleration profile, so its straightness only shows in the shape of
  // the direction change: nearly every sample turns by nothing and the few
  // turns between targets are abrupt.
  const interpolated = assessAutomationRisk(
    pointerOnlyVector({
      pointerVelocityMean: 372.8,
      pointerVelocityDeviation: 240.5,
      pointerAccelerationMean: 3_100.2,
      pointerAccelerationDeviation: 2_410.6,
      pointerJitterMean: 0.031,
      pointerJitterDeviation: 0.108,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.deepEqual(interpolated.reasonCodes, ["POINTER_WAYPOINT_TRAVEL"]);
  assert.equal(interpolated.classification, "elevated_review");
  assert.equal(interpolated.level, "elevated");
  assert.equal(interpolated.grantRestrictionRecommended, false);

  // A gentle hand curves continuously, so its direction change stays close to
  // its own average however small that average is.
  const gentleHand = assessAutomationRisk(
    pointerOnlyVector({
      pointerVelocityMean: 305,
      pointerVelocityDeviation: 96,
      pointerAccelerationMean: 640,
      pointerAccelerationDeviation: 210,
      pointerJitterMean: 0.035,
      pointerJitterDeviation: 0.016,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.deepEqual(gentleHand.reasonCodes, []);
  assert.equal(gentleHand.classification, "human_like_interaction");
  assert.equal(gentleHand.riskScore, 0);
});

test("restricts straight travel once a second mechanical trait joins it", () => {
  // Real automation drives a genuine browser, so its step timing carries enough
  // scheduler noise to clear the constant-speed and flat-acceleration floors.
  // Straight travel plus steady speed still has to reach a restriction on its
  // own, because the browser-reported integrity fields cost such a bot nothing.
  const drivenBrowser = assessAutomationRisk(
    mechanicalPointerVector({
      pointerVelocityMean: 610,
      pointerVelocityDeviation: 52,
      pointerAccelerationMean: 640,
      pointerAccelerationDeviation: 410,
      pointerJitterMean: 0.0009,
      pointerJitterDeviation: 0.004,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.equal(drivenBrowser.classification, "automation_likely");
  assert.equal(drivenBrowser.level, "high");
  assert.equal(drivenBrowser.grantRestrictionRecommended, true);
  assert.ok(drivenBrowser.riskScore >= 70);
  assert.deepEqual(drivenBrowser.reasonCodes, [
    "POINTER_PATH_WITHOUT_CURVATURE",
    "ROBOTIC_POINTER_REGULARITY",
  ]);
  assert.equal(
    drivenBrowser.reasonCodes.includes("TRUSTED_EVENTS_NOT_REQUIRED"),
    false,
  );
  assert.equal(
    drivenBrowser.reasonCodes.includes("SYNTHETIC_EVENTS_OBSERVED"),
    false,
  );

  // One mechanical trait on its own is worth a look, never a restriction.
  const straightOnly = assessAutomationRisk(
    mechanicalPointerVector({
      pointerVelocityMean: 610,
      pointerVelocityDeviation: 300,
      pointerAccelerationMean: 640,
      pointerAccelerationDeviation: 410,
      pointerJitterMean: 0.0009,
      pointerJitterDeviation: 0.4,
    }),
    null,
    pointerOnlyEvidence(),
  );

  assert.deepEqual(straightOnly.reasonCodes, ["POINTER_PATH_WITHOUT_CURVATURE"]);
  assert.equal(straightOnly.classification, "elevated_review");
  assert.equal(straightOnly.grantRestrictionRecommended, false);
});

test("needs a body of attainable checks before reporting a verdict", () => {
  // Bookkeeping signals fire on every sparse sample by construction. Read
  // against a denominator of only themselves they would read as certainty, so
  // the ratio is held to a minimum body of attainable weight.
  const sparse = assessAutomationRisk(null, {}, null);

  assert.deepEqual(sparse.reasonCodes, ["BROWSER_INTEGRITY_EVIDENCE_MISSING"]);
  assert.equal(sparse.classification, "human_like_interaction");
  assert.equal(sparse.level, "low");
  assert.equal(sparse.grantRestrictionRecommended, false);
});
