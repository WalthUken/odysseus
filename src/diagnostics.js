"use strict";

const { ValidationError } = require("./behavior");

const MAX_DIAGNOSTIC_DURATION_MS = 10 * 60 * 1_000;
const MAX_DIAGNOSTIC_EVENTS = 1_000;
const MAX_DIAGNOSTIC_WORDS = 40;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAllowedKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new ValidationError(
      `${name} contains unsupported fields`,
      { fields: unexpected }
    );
  }
}

function boundedNumber(value, name, maximum, integer = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new ValidationError(
      `${name} must be a non-negative ${
        integer ? "integer" : "number"
      } no greater than ${maximum}`
    );
  }
  return value;
}

function validateWords(words, name) {
  if (!Array.isArray(words) || words.length > MAX_DIAGNOSTIC_WORDS) {
    throw new ValidationError(
      `${name} must contain no more than ${MAX_DIAGNOSTIC_WORDS} word timings`
    );
  }
  return words.map((word, position) => {
    if (!isPlainObject(word)) {
      throw new ValidationError(`${name} word timings must be objects`);
    }
    requireAllowedKeys(
      word,
      new Set(["index", "characterCount", "durationMs"]),
      `${name}[${position}]`
    );
    const index = boundedNumber(
      word.index,
      `${name}[${position}].index`,
      MAX_DIAGNOSTIC_WORDS,
      true
    );
    if (index !== position + 1) {
      throw new ValidationError(`${name} word indexes must be sequential`);
    }
    return {
      index,
      characterCount: boundedNumber(
        word.characterCount,
        `${name}[${position}].characterCount`,
        64,
        true
      ),
      durationMs: boundedNumber(
        word.durationMs,
        `${name}[${position}].durationMs`,
        MAX_DIAGNOSTIC_DURATION_MS,
        true
      ),
    };
  });
}

function validateField(value, name) {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  requireAllowedKeys(
    value,
    new Set(["durationMs", "wordCount", "words"]),
    name
  );
  const words = validateWords(value.words, `${name}.words`);
  const wordCount = boundedNumber(
    value.wordCount,
    `${name}.wordCount`,
    MAX_DIAGNOSTIC_WORDS,
    true
  );
  if (wordCount !== words.length) {
    throw new ValidationError(`${name}.wordCount must match its word timings`);
  }
  return {
    durationMs: boundedNumber(
      value.durationMs,
      `${name}.durationMs`,
      MAX_DIAGNOSTIC_DURATION_MS,
      true
    ),
    wordCount,
    words,
  };
}

function validateTypingDiagnostics(value, rounds) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new ValidationError("diagnostics must be an object");
  }
  requireAllowedKeys(
    value,
    new Set([
      "version",
      "missionId",
      "totalDurationMs",
      "inputEventCount",
      "keyPressCount",
      "cadencePerMinute",
      "pauses",
      "bursts",
      "guided",
      "freeTyping",
    ]),
    "diagnostics"
  );
  if (value.version !== 1) {
    throw new ValidationError("diagnostics.version must be 1");
  }
  if (typeof value.missionId !== "string") {
    throw new ValidationError("diagnostics.missionId must be a string");
  }
  const round = rounds.find((candidate) => candidate.id === value.missionId);
  if (!round) {
    throw new ValidationError("diagnostics.missionId is not recognized");
  }
  if (!isPlainObject(value.pauses) || !isPlainObject(value.bursts)) {
    throw new ValidationError(
      "diagnostics pauses and bursts must be objects"
    );
  }
  requireAllowedKeys(
    value.pauses,
    new Set(["thresholdMs", "count", "longestMs"]),
    "diagnostics.pauses"
  );
  requireAllowedKeys(
    value.bursts,
    new Set(["count", "averageEvents"]),
    "diagnostics.bursts"
  );

  const guided = validateField(value.guided, "diagnostics.guided");
  const freeTyping = validateField(
    value.freeTyping,
    "diagnostics.freeTyping"
  );
  const expectedWords = round.prompt.split(/\s+/);
  if (guided.words.length > expectedWords.length + 2) {
    throw new ValidationError(
      "diagnostics.guided contains too many word timings"
    );
  }

  return {
    version: 1,
    missionId: round.id,
    totalDurationMs: boundedNumber(
      value.totalDurationMs,
      "diagnostics.totalDurationMs",
      MAX_DIAGNOSTIC_DURATION_MS,
      true
    ),
    inputEventCount: boundedNumber(
      value.inputEventCount,
      "diagnostics.inputEventCount",
      MAX_DIAGNOSTIC_EVENTS,
      true
    ),
    keyPressCount: boundedNumber(
      value.keyPressCount,
      "diagnostics.keyPressCount",
      MAX_DIAGNOSTIC_EVENTS,
      true
    ),
    cadencePerMinute: boundedNumber(
      value.cadencePerMinute,
      "diagnostics.cadencePerMinute",
      5_000
    ),
    pauses: {
      thresholdMs: boundedNumber(
        value.pauses.thresholdMs,
        "diagnostics.pauses.thresholdMs",
        10_000,
        true
      ),
      count: boundedNumber(
        value.pauses.count,
        "diagnostics.pauses.count",
        MAX_DIAGNOSTIC_EVENTS,
        true
      ),
      longestMs: boundedNumber(
        value.pauses.longestMs,
        "diagnostics.pauses.longestMs",
        MAX_DIAGNOSTIC_DURATION_MS,
        true
      ),
    },
    bursts: {
      count: boundedNumber(
        value.bursts.count,
        "diagnostics.bursts.count",
        MAX_DIAGNOSTIC_EVENTS,
        true
      ),
      averageEvents: boundedNumber(
        value.bursts.averageEvents,
        "diagnostics.bursts.averageEvents",
        MAX_DIAGNOSTIC_EVENTS
      ),
    },
    guided,
    freeTyping,
  };
}

function roundNumber(value, places = 2) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function variationLabel(mean, deviation) {
  if (!Number.isFinite(mean) || mean <= 0 || !Number.isFinite(deviation)) {
    return "Unavailable";
  }
  const ratio = deviation / mean;
  if (ratio <= 0.25) {
    return "Consistent";
  }
  if (ratio <= 0.55) {
    return "Moderately variable";
  }
  return "Highly variable";
}

function transitionLabel(value) {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }
  if (value < 80) {
    return "Rapid transitions";
  }
  if (value < 240) {
    return "Measured transitions";
  }
  return "Deliberate transitions";
}

function cadenceLabel(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Unavailable";
  }
  if (value >= 300) {
    return "Fast cadence";
  }
  if (value >= 160) {
    return "Moderate cadence";
  }
  return "Deliberate cadence";
}

function signalComparison(vector, template) {
  const signals = [
    ["dwellMean", "Average key hold", "ms"],
    ["dwellDeviation", "Key-hold variation", "ms"],
    ["flightMean", "Average key transition", "ms"],
    ["flightDeviation", "Transition variation", "ms"],
    ["downDownMean", "Average key interval", "ms"],
    ["pointerVelocityMean", "Pointer velocity", "px/s"],
    ["pointerJitterMean", "Pointer direction change", "ratio"],
  ];
  return signals
    .filter(
      ([key]) =>
        Number.isFinite(vector[key]) &&
        Number.isFinite(template.means[key])
    )
    .map(([key, label, unit]) => {
      const current = roundNumber(vector[key]);
      const baseline = roundNumber(template.means[key]);
      return {
        key,
        label,
        unit,
        current,
        baseline,
        difference: roundNumber(current - baseline),
      };
    });
}

function slowestWords(typing, round) {
  if (!typing) {
    return {
      guided: [],
      freeTyping: [],
    };
  }
  const promptWords = round.prompt.split(/\s+/);
  const guided = typing.guided.words
    .map((word) => ({
      ...word,
      label: promptWords[word.index - 1] || `Guided word ${word.index}`,
    }))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5);
  const freeTyping = typing.freeTyping.words
    .map((word) => ({
      ...word,
      label: `Free word ${word.index}`,
    }))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5);
  return { guided, freeTyping };
}

function buildBehaviorDiagnostics(vector, template, typing, round) {
  const slowWords = slowestWords(typing, round);
  return {
    keyboard: {
      averageKeyHoldMs: roundNumber(vector.dwellMean),
      keyHoldVariationMs: roundNumber(vector.dwellDeviation),
      averageTransitionMs: roundNumber(vector.flightMean),
      transitionVariationMs: roundNumber(vector.flightDeviation),
      averageKeyIntervalMs: roundNumber(vector.downDownMean),
      intervalVariationMs: roundNumber(vector.downDownDeviation),
      holdConsistency: variationLabel(
        vector.dwellMean,
        vector.dwellDeviation
      ),
      transitionPattern: transitionLabel(vector.flightMean),
    },
    pointer: {
      averageVelocityPxPerSecond: roundNumber(vector.pointerVelocityMean),
      velocityVariation: roundNumber(vector.pointerVelocityDeviation),
      averageAcceleration: roundNumber(vector.pointerAccelerationMean),
      accelerationVariation: roundNumber(
        vector.pointerAccelerationDeviation
      ),
      averageDirectionChange: roundNumber(vector.pointerJitterMean),
      directionChangeVariation: roundNumber(
        vector.pointerJitterDeviation
      ),
    },
    typing: typing
      ? {
          missionId: typing.missionId,
          totalDurationMs: typing.totalDurationMs,
          inputEventCount: typing.inputEventCount,
          keyPressCount: typing.keyPressCount,
          cadencePerMinute: roundNumber(typing.cadencePerMinute),
          cadencePattern: cadenceLabel(typing.cadencePerMinute),
          pauses: typing.pauses,
          bursts: typing.bursts,
          guidedDurationMs: typing.guided.durationMs,
          freeTypingDurationMs: typing.freeTyping.durationMs,
          guidedWordCount: typing.guided.wordCount,
          freeWordCount: typing.freeTyping.wordCount,
        }
      : null,
    slowWords,
    baselineComparison: signalComparison(vector, template),
  };
}

module.exports = {
  MAX_DIAGNOSTIC_DURATION_MS,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_WORDS,
  buildBehaviorDiagnostics,
  validateTypingDiagnostics,
};
