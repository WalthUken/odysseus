"use strict";

const { ValidationError } = require("./behavior");

const MAX_INTERACTION_DURATION_MS = 10 * 60 * 1_000;
const MAX_INTERACTION_SAMPLES = 1_000;
const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_EVENTS = 200_000;
const MAX_SESSION_DISTANCE_PX = 1_000_000_000;
const MAX_SESSION_VIEWS = 16;
const MAX_SESSION_SCALE = 10;
const MIN_SESSION_SCALE = 0.1;
const SESSION_VIEW_NAMES = new Set([
  "login",
  "enrollment",
  "verification",
  "dashboard",
  "account",
  "recovery",
  "session",
  "unknown",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAllowedKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ValidationError(`${name} contains unsupported fields`, {
      fields: unexpected,
    });
  }
}

function boundedInteger(value, name, maximum) {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new ValidationError(
      `${name} must be a non-negative integer no greater than ${maximum}`,
    );
  }
  return value;
}

function boundedNumber(value, name, minimum, maximum) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new ValidationError(
      `${name} must be a number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function validateSessionAggregate(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError(
      "interactionEvidence.sessionAggregate must be an object",
    );
  }
  requireAllowedKeys(
    value,
    new Set([
      "elapsedMs",
      "keyboard",
      "pointer",
      "scrolling",
      "delays",
      "zoom",
      "viewTiming",
    ]),
    "interactionEvidence.sessionAggregate",
  );
  for (const name of [
    "keyboard",
    "pointer",
    "scrolling",
    "delays",
    "zoom",
  ]) {
    if (!isPlainObject(value[name])) {
      throw new ValidationError(
        `interactionEvidence.sessionAggregate.${name} must be an object`,
      );
    }
  }

  requireAllowedKeys(
    value.keyboard,
    new Set([
      "keyDownEvents",
      "keyUpEvents",
      "repeatedKeyEvents",
      "inputEvents",
      "correctionEvents",
      "deletionEvents",
      "undoEvents",
    ]),
    "interactionEvidence.sessionAggregate.keyboard",
  );
  requireAllowedKeys(
    value.pointer,
    new Set([
      "moveEvents",
      "distancePx",
      "pointerDownEvents",
      "pointerUpEvents",
      "clickEvents",
      "doubleClickEvents",
      "contextMenuEvents",
    ]),
    "interactionEvidence.sessionAggregate.pointer",
  );
  requireAllowedKeys(
    value.scrolling,
    new Set(["wheelEvents", "scrollEvents", "distancePx"]),
    "interactionEvidence.sessionAggregate.scrolling",
  );
  requireAllowedKeys(
    value.delays,
    new Set(["sampleCount", "averageMs", "deviationMs", "longestMs"]),
    "interactionEvidence.sessionAggregate.delays",
  );
  requireAllowedKeys(
    value.zoom,
    new Set([
      "changeEvents",
      "visualScaleMinimum",
      "visualScaleMaximum",
      "devicePixelRatioMinimum",
      "devicePixelRatioMaximum",
    ]),
    "interactionEvidence.sessionAggregate.zoom",
  );

  const keyboard = Object.fromEntries(
    [
      "keyDownEvents",
      "keyUpEvents",
      "repeatedKeyEvents",
      "inputEvents",
      "correctionEvents",
      "deletionEvents",
      "undoEvents",
    ].map((key) => [
      key,
      boundedInteger(
        value.keyboard[key],
        `interactionEvidence.sessionAggregate.keyboard.${key}`,
        MAX_SESSION_EVENTS,
      ),
    ]),
  );
  if (
    keyboard.repeatedKeyEvents > keyboard.keyDownEvents
    || keyboard.correctionEvents > keyboard.inputEvents
    || keyboard.deletionEvents > keyboard.correctionEvents
    || keyboard.undoEvents > keyboard.correctionEvents
  ) {
    throw new ValidationError(
      "interactionEvidence.sessionAggregate.keyboard counts are inconsistent",
    );
  }

  const pointer = {
    moveEvents: boundedInteger(
      value.pointer.moveEvents,
      "interactionEvidence.sessionAggregate.pointer.moveEvents",
      MAX_SESSION_EVENTS,
    ),
    distancePx: boundedNumber(
      value.pointer.distancePx,
      "interactionEvidence.sessionAggregate.pointer.distancePx",
      0,
      MAX_SESSION_DISTANCE_PX,
    ),
    pointerDownEvents: boundedInteger(
      value.pointer.pointerDownEvents,
      "interactionEvidence.sessionAggregate.pointer.pointerDownEvents",
      MAX_SESSION_EVENTS,
    ),
    pointerUpEvents: boundedInteger(
      value.pointer.pointerUpEvents,
      "interactionEvidence.sessionAggregate.pointer.pointerUpEvents",
      MAX_SESSION_EVENTS,
    ),
    clickEvents: boundedInteger(
      value.pointer.clickEvents,
      "interactionEvidence.sessionAggregate.pointer.clickEvents",
      MAX_SESSION_EVENTS,
    ),
    doubleClickEvents: boundedInteger(
      value.pointer.doubleClickEvents,
      "interactionEvidence.sessionAggregate.pointer.doubleClickEvents",
      MAX_SESSION_EVENTS,
    ),
    contextMenuEvents: boundedInteger(
      value.pointer.contextMenuEvents,
      "interactionEvidence.sessionAggregate.pointer.contextMenuEvents",
      MAX_SESSION_EVENTS,
    ),
  };
  const scrolling = {
    wheelEvents: boundedInteger(
      value.scrolling.wheelEvents,
      "interactionEvidence.sessionAggregate.scrolling.wheelEvents",
      MAX_SESSION_EVENTS,
    ),
    scrollEvents: boundedInteger(
      value.scrolling.scrollEvents,
      "interactionEvidence.sessionAggregate.scrolling.scrollEvents",
      MAX_SESSION_EVENTS,
    ),
    distancePx: boundedNumber(
      value.scrolling.distancePx,
      "interactionEvidence.sessionAggregate.scrolling.distancePx",
      0,
      MAX_SESSION_DISTANCE_PX,
    ),
  };
  const delays = {
    sampleCount: boundedInteger(
      value.delays.sampleCount,
      "interactionEvidence.sessionAggregate.delays.sampleCount",
      MAX_SESSION_EVENTS,
    ),
    averageMs: boundedNumber(
      value.delays.averageMs,
      "interactionEvidence.sessionAggregate.delays.averageMs",
      0,
      MAX_SESSION_DURATION_MS,
    ),
    deviationMs: boundedNumber(
      value.delays.deviationMs,
      "interactionEvidence.sessionAggregate.delays.deviationMs",
      0,
      MAX_SESSION_DURATION_MS,
    ),
    longestMs: boundedNumber(
      value.delays.longestMs,
      "interactionEvidence.sessionAggregate.delays.longestMs",
      0,
      MAX_SESSION_DURATION_MS,
    ),
  };
  if (
    (
      delays.sampleCount === 0
      && (
        delays.averageMs !== 0
        || delays.deviationMs !== 0
        || delays.longestMs !== 0
      )
    )
    || delays.averageMs > delays.longestMs
    || delays.deviationMs > delays.longestMs
  ) {
    throw new ValidationError(
      "interactionEvidence.sessionAggregate.delays values are inconsistent",
    );
  }
  const zoom = {
    changeEvents: boundedInteger(
      value.zoom.changeEvents,
      "interactionEvidence.sessionAggregate.zoom.changeEvents",
      MAX_SESSION_EVENTS,
    ),
    visualScaleMinimum: boundedNumber(
      value.zoom.visualScaleMinimum,
      "interactionEvidence.sessionAggregate.zoom.visualScaleMinimum",
      MIN_SESSION_SCALE,
      MAX_SESSION_SCALE,
    ),
    visualScaleMaximum: boundedNumber(
      value.zoom.visualScaleMaximum,
      "interactionEvidence.sessionAggregate.zoom.visualScaleMaximum",
      MIN_SESSION_SCALE,
      MAX_SESSION_SCALE,
    ),
    devicePixelRatioMinimum: boundedNumber(
      value.zoom.devicePixelRatioMinimum,
      "interactionEvidence.sessionAggregate.zoom.devicePixelRatioMinimum",
      MIN_SESSION_SCALE,
      MAX_SESSION_SCALE,
    ),
    devicePixelRatioMaximum: boundedNumber(
      value.zoom.devicePixelRatioMaximum,
      "interactionEvidence.sessionAggregate.zoom.devicePixelRatioMaximum",
      MIN_SESSION_SCALE,
      MAX_SESSION_SCALE,
    ),
  };
  if (
    zoom.visualScaleMinimum > zoom.visualScaleMaximum
    || zoom.devicePixelRatioMinimum > zoom.devicePixelRatioMaximum
  ) {
    throw new ValidationError(
      "interactionEvidence.sessionAggregate.zoom ranges are invalid",
    );
  }

  if (
    !Array.isArray(value.viewTiming)
    || value.viewTiming.length > MAX_SESSION_VIEWS
  ) {
    throw new ValidationError(
      `interactionEvidence.sessionAggregate.viewTiming must contain no more than ${MAX_SESSION_VIEWS} entries`,
    );
  }
  const usedViews = new Set();
  const viewTiming = value.viewTiming.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new ValidationError(
        "interactionEvidence.sessionAggregate.viewTiming entries must be objects",
      );
    }
    requireAllowedKeys(
      entry,
      new Set(["view", "durationMs"]),
      `interactionEvidence.sessionAggregate.viewTiming[${index}]`,
    );
    if (
      typeof entry.view !== "string"
      || !SESSION_VIEW_NAMES.has(entry.view)
      || usedViews.has(entry.view)
    ) {
      throw new ValidationError(
        "interactionEvidence.sessionAggregate.viewTiming view is invalid",
      );
    }
    usedViews.add(entry.view);
    return {
      view: entry.view,
      durationMs: boundedInteger(
        entry.durationMs,
        `interactionEvidence.sessionAggregate.viewTiming[${index}].durationMs`,
        MAX_SESSION_DURATION_MS,
      ),
    };
  });
  const elapsedMs = boundedInteger(
    value.elapsedMs,
    "interactionEvidence.sessionAggregate.elapsedMs",
    MAX_SESSION_DURATION_MS,
  );
  const totalViewDuration = viewTiming.reduce(
    (total, entry) => total + entry.durationMs,
    0,
  );
  if (totalViewDuration > elapsedMs + 1_000) {
    throw new ValidationError(
      "interactionEvidence.sessionAggregate view timing exceeds elapsedMs",
    );
  }

  return {
    elapsedMs,
    keyboard,
    pointer,
    scrolling,
    delays,
    zoom,
    viewTiming,
  };
}

function validateInteractionEvidence(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new ValidationError("interactionEvidence must be an object");
  }
  if (value.version !== 1 && value.version !== 2) {
    throw new ValidationError("interactionEvidence.version must be 1 or 2");
  }
  const version = value.version;
  requireAllowedKeys(
    value,
    new Set([
      "version",
      "trustedEventsRequired",
      "rejectedSyntheticEvents",
      "sampleCounts",
      "durationMs",
      ...(version === 2 ? ["sessionAggregate"] : []),
    ]),
    "interactionEvidence",
  );
  if (typeof value.trustedEventsRequired !== "boolean") {
    throw new ValidationError(
      "interactionEvidence.trustedEventsRequired must be a boolean",
    );
  }
  if (!isPlainObject(value.sampleCounts)) {
    throw new ValidationError(
      "interactionEvidence.sampleCounts must be an object",
    );
  }
  requireAllowedKeys(
    value.sampleCounts,
    new Set(["dwell", "flight", "downDown", "pointer"]),
    "interactionEvidence.sampleCounts",
  );

  const validated = {
    version,
    trustedEventsRequired: value.trustedEventsRequired,
    rejectedSyntheticEvents: boundedInteger(
      value.rejectedSyntheticEvents,
      "interactionEvidence.rejectedSyntheticEvents",
      MAX_INTERACTION_SAMPLES,
    ),
    sampleCounts: {
      dwell: boundedInteger(
        value.sampleCounts.dwell,
        "interactionEvidence.sampleCounts.dwell",
        MAX_INTERACTION_SAMPLES,
      ),
      flight: boundedInteger(
        value.sampleCounts.flight,
        "interactionEvidence.sampleCounts.flight",
        MAX_INTERACTION_SAMPLES,
      ),
      downDown: boundedInteger(
        value.sampleCounts.downDown,
        "interactionEvidence.sampleCounts.downDown",
        MAX_INTERACTION_SAMPLES,
      ),
      pointer: boundedInteger(
        value.sampleCounts.pointer,
        "interactionEvidence.sampleCounts.pointer",
        MAX_INTERACTION_SAMPLES,
      ),
    },
    durationMs: boundedInteger(
      value.durationMs,
      "interactionEvidence.durationMs",
      MAX_INTERACTION_DURATION_MS,
    ),
  };
  if (version === 2 && value.sessionAggregate !== undefined) {
    validated.sessionAggregate = validateSessionAggregate(
      value.sessionAggregate,
    );
  }
  return validated;
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function ratio(deviation, center) {
  const normalizedDeviation = finite(deviation);
  const normalizedCenter = finite(center);
  if (
    normalizedDeviation === null
    || normalizedCenter === null
    || Math.abs(normalizedCenter) < 0.000001
  ) {
    return null;
  }
  return Math.abs(normalizedDeviation / normalizedCenter);
}

function assessAutomationRisk(vector, diagnostics, evidence) {
  const signals = [];
  let score = 0;

  function add(code, points, detail) {
    if (signals.some((signal) => signal.code === code)) {
      return;
    }
    score += points;
    signals.push({
      code,
      weight: points,
      detail,
    });
  }

  if (!diagnostics) {
    add(
      "TYPING_DIAGNOSTICS_MISSING",
      12,
      "The client did not provide the optional aggregate typing diagnostic.",
    );
  } else {
    const durationMs = finite(diagnostics.totalDurationMs);
    const cadencePerMinute = finite(diagnostics.cadencePerMinute);
    const inputEventCount = finite(diagnostics.inputEventCount);
    const keyPressCount = finite(diagnostics.keyPressCount);

    if (durationMs !== null && durationMs < 1_200) {
      add(
        "IMPLAUSIBLY_FAST_COMPLETION",
        48,
        "The aggregate challenge duration was below 1.2 seconds.",
      );
    } else if (durationMs !== null && durationMs < 2_500) {
      add(
        "VERY_FAST_COMPLETION",
        22,
        "The aggregate challenge duration was unusually short.",
      );
    }

    if (cadencePerMinute !== null && cadencePerMinute > 1_500) {
      add(
        "IMPLAUSIBLE_CADENCE",
        42,
        "The reported key cadence exceeded 1,500 presses per minute.",
      );
    } else if (cadencePerMinute !== null && cadencePerMinute > 900) {
      add(
        "VERY_HIGH_CADENCE",
        22,
        "The reported key cadence was unusually high.",
      );
    }

    if (
      inputEventCount !== null
      && inputEventCount > 0
      && durationMs === 0
    ) {
      add(
        "ZERO_DURATION_WITH_INPUT",
        50,
        "Input events were reported with a zero-duration challenge.",
      );
    }
    if (
      keyPressCount !== null
      && inputEventCount !== null
      && inputEventCount > 0
      && keyPressCount > inputEventCount * 4
    ) {
      add(
        "INPUT_COUNT_INCONSISTENCY",
        24,
        "Reported key and input event counts were internally inconsistent.",
      );
    }
  }

  const normalizedEvidence = evidence || null;
  if (!normalizedEvidence) {
    add(
      "BROWSER_INTEGRITY_EVIDENCE_MISSING",
      8,
      "No browser event-integrity summary accompanied the sample.",
    );
  } else {
    if (normalizedEvidence.trustedEventsRequired !== true) {
      add(
        "TRUSTED_EVENTS_NOT_REQUIRED",
        40,
        "The browser reported that trusted input events were not required.",
      );
    }
    if (normalizedEvidence.rejectedSyntheticEvents > 0) {
      add(
        "SYNTHETIC_EVENTS_OBSERVED",
        55,
        "The browser rejected one or more script-dispatched input events.",
      );
    }
    if (
      normalizedEvidence.durationMs > 0
      && normalizedEvidence.durationMs < 1_000
    ) {
      add(
        "TELEMETRY_WINDOW_TOO_SHORT",
        28,
        "The interaction telemetry window was shorter than one second.",
      );
    }
    const sessionAggregate = normalizedEvidence.sessionAggregate;
    if (sessionAggregate) {
      if (
        sessionAggregate.elapsedMs + 250
        < normalizedEvidence.durationMs
      ) {
        add(
          "SESSION_DURATION_INCONSISTENCY",
          8,
          "Whole-session elapsed time was shorter than the sample window.",
        );
      }
      if (
        sessionAggregate.keyboard.keyDownEvents
          < normalizedEvidence.sampleCounts.dwell
        || (
          diagnostics
          && sessionAggregate.keyboard.inputEvents
            < diagnostics.inputEventCount
        )
      ) {
        add(
          "SESSION_KEYBOARD_COUNT_INCONSISTENCY",
          8,
          "Whole-session keyboard counts were lower than challenge counts.",
        );
      }
      if (
        sessionAggregate.pointer.moveEvents
        < normalizedEvidence.sampleCounts.pointer
      ) {
        add(
          "SESSION_POINTER_COUNT_INCONSISTENCY",
          8,
          "Whole-session pointer counts were lower than challenge counts.",
        );
      }
      if (
        diagnostics
        && diagnostics.version === 2
        && diagnostics.corrections
        && sessionAggregate.keyboard.correctionEvents
          < diagnostics.corrections.total
      ) {
        add(
          "SESSION_CORRECTION_COUNT_INCONSISTENCY",
          8,
          "Whole-session correction counts were lower than challenge counts.",
        );
      }
    }
  }

  if (isPlainObject(vector)) {
    const dwellMean = finite(vector.dwellMean);
    if (dwellMean !== null && dwellMean > 0 && dwellMean < 12) {
      add(
        "IMPLAUSIBLE_KEY_HOLD",
        32,
        "Average key-hold time was below 12 milliseconds.",
      );
    }

    const regularityRatios = [
      ratio(vector.dwellDeviation, vector.dwellMean),
      ratio(vector.flightDeviation, vector.flightMean),
      ratio(vector.downDownDeviation, vector.downDownMean),
    ].filter((value) => value !== null);
    const highlyRegular = regularityRatios.filter((value) => value < 0.015);
    if (highlyRegular.length >= 2) {
      add(
        "ROBOTIC_TIMING_REGULARITY",
        28,
        "Multiple keyboard timing families had extremely low variation.",
      );
    } else if (highlyRegular.length === 1) {
      add(
        "LOW_TIMING_VARIATION",
        8,
        "One keyboard timing family had very low variation.",
      );
    }

    const pointerVelocityDeviation = finite(
      vector.pointerVelocityDeviation,
    );
    const pointerJitterDeviation = finite(vector.pointerJitterDeviation);
    if (
      pointerVelocityDeviation !== null
      && pointerJitterDeviation !== null
      && pointerVelocityDeviation < 1
      && pointerJitterDeviation < 0.002
    ) {
      add(
        "ROBOTIC_POINTER_REGULARITY",
        24,
        "Pointer velocity and direction-change variation were both very low.",
      );
    }
  }

  score = Math.max(0, Math.min(100, score));
  const evidenceAvailable = Boolean(diagnostics || normalizedEvidence);
  let classification = "human_like_interaction";
  let level = "low";
  if (!evidenceAvailable) {
    classification = "insufficient_evidence";
    level = "unknown";
  } else if (score >= 70) {
    classification = "automation_likely";
    level = "high";
  } else if (score >= 40) {
    classification = "elevated_review";
    level = "elevated";
  }

  return {
    version: 1,
    classification,
    level,
    riskScore: score,
    reasonCodes: signals.map((signal) => signal.code),
    signals,
    grantRestrictionRecommended: classification === "automation_likely",
    limitations: [
      "This is an automation-risk estimate, not proof that a person or agent produced the interaction.",
      "Browser-reported evidence can be forged by a direct API client or advanced automation.",
      "Accessibility tools, injuries, unusual hardware, and practiced users can change the same signals.",
    ],
  };
}

module.exports = {
  MAX_INTERACTION_DURATION_MS,
  MAX_INTERACTION_SAMPLES,
  MAX_SESSION_DISTANCE_PX,
  MAX_SESSION_DURATION_MS,
  MAX_SESSION_EVENTS,
  MAX_SESSION_SCALE,
  MAX_SESSION_VIEWS,
  MIN_SESSION_SCALE,
  SESSION_VIEW_NAMES,
  assessAutomationRisk,
  validateSessionAggregate,
  validateInteractionEvidence,
};
