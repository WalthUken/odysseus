"use strict";

const { ValidationError } = require("./behavior");

const DEVICE_CONFIDENCE_POLICY_VERSION = 1;
const DEVICE_STATES = Object.freeze([
  "recognized",
  "restricted",
  "step_up",
  "trusted",
]);
const INPUT_KEYS = new Set([
  "behaviorDecision",
  "credentialAnomaly",
  "credentialBinding",
  "credentialStatus",
  "crossDeviceTransferRestricted",
  "descriptorChanged",
  "deviceRecordFound",
  "fingerprintStatus",
  "humanProofStatus",
  "recentFailureCount",
  "replaySuspected",
  "sessionBindingStatus",
  "userVerification",
]);

class DeviceConfidenceValidationError extends ValidationError {
  constructor(message, details) {
    super(message);
    this.name = "DeviceConfidenceValidationError";
    this.code = "DEVICE_CONFIDENCE_VALIDATION_ERROR";
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

function strictBoolean(value, name, defaultValue = false) {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== "boolean") {
    throw new DeviceConfidenceValidationError(
      `${name} must be a boolean.`,
    );
  }
  return candidate;
}

function enumValue(value, name, allowed, defaultValue) {
  const candidate = value === undefined ? defaultValue : value;
  if (!allowed.includes(candidate)) {
    throw new DeviceConfidenceValidationError(
      `${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return candidate;
}

function normalizeSignals(input) {
  if (!isPlainObject(input)) {
    throw new DeviceConfidenceValidationError(
      "Device confidence input must be a plain object.",
    );
  }
  const unknownKeys = Object.keys(input).filter(
    (key) => !INPUT_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new DeviceConfidenceValidationError(
      "Device confidence input contains unsupported fields.",
      { unsupportedFields: unknownKeys.sort() },
    );
  }

  const recentFailureCount = input.recentFailureCount === undefined
    ? 0
    : input.recentFailureCount;
  if (
    !Number.isSafeInteger(recentFailureCount)
    || recentFailureCount < 0
    || recentFailureCount > 100
  ) {
    throw new DeviceConfidenceValidationError(
      "recentFailureCount must be an integer between 0 and 100.",
    );
  }

  const signals = Object.freeze({
    behaviorDecision: enumValue(
      input.behaviorDecision,
      "behaviorDecision",
      ["allow", "deny", "step_up", "unavailable"],
      "unavailable",
    ),
    credentialAnomaly: strictBoolean(
      input.credentialAnomaly,
      "credentialAnomaly",
    ),
    credentialBinding: enumValue(
      input.credentialBinding,
      "credentialBinding",
      ["device_bound", "synced", "unknown"],
      "unknown",
    ),
    credentialStatus: enumValue(
      input.credentialStatus,
      "credentialStatus",
      ["failed", "unavailable", "verified"],
      "unavailable",
    ),
    crossDeviceTransferRestricted: strictBoolean(
      input.crossDeviceTransferRestricted,
      "crossDeviceTransferRestricted",
    ),
    descriptorChanged: strictBoolean(
      input.descriptorChanged,
      "descriptorChanged",
    ),
    deviceRecordFound: strictBoolean(
      input.deviceRecordFound,
      "deviceRecordFound",
    ),
    fingerprintStatus: enumValue(
      input.fingerprintStatus,
      "fingerprintStatus",
      ["match", "mismatch", "unavailable"],
      "unavailable",
    ),
    humanProofStatus: enumValue(
      input.humanProofStatus,
      "humanProofStatus",
      ["failed", "passed", "unavailable"],
      "unavailable",
    ),
    recentFailureCount,
    replaySuspected: strictBoolean(
      input.replaySuspected,
      "replaySuspected",
    ),
    sessionBindingStatus: enumValue(
      input.sessionBindingStatus,
      "sessionBindingStatus",
      ["match", "mismatch", "unavailable"],
      "unavailable",
    ),
    userVerification: strictBoolean(
      input.userVerification,
      "userVerification",
    ),
  });

  if (
    signals.userVerification
    && signals.credentialStatus !== "verified"
  ) {
    throw new DeviceConfidenceValidationError(
      "userVerification requires a verified credential.",
    );
  }
  return signals;
}

function addContribution(contributions, reasonCodes, signal, weight, code) {
  contributions.push({ signal, weight });
  reasonCodes.push(code);
}

function scoreSignals(signals) {
  const contributions = [];
  const reasonCodes = [];

  if (signals.deviceRecordFound) {
    addContribution(
      contributions,
      reasonCodes,
      "deviceRecordFound",
      10,
      "DEVICE_RECORD_FOUND",
    );
  } else {
    reasonCodes.push("DEVICE_RECORD_UNKNOWN");
  }

  if (signals.fingerprintStatus === "match") {
    addContribution(
      contributions,
      reasonCodes,
      "fingerprintMatch",
      15,
      "FINGERPRINT_MATCH",
    );
  } else if (signals.fingerprintStatus === "mismatch") {
    addContribution(
      contributions,
      reasonCodes,
      "fingerprintMismatch",
      -25,
      "FINGERPRINT_MISMATCH",
    );
  } else {
    reasonCodes.push("FINGERPRINT_UNAVAILABLE");
  }

  if (signals.credentialStatus === "verified") {
    addContribution(
      contributions,
      reasonCodes,
      "credentialVerified",
      35,
      "CREDENTIAL_VERIFIED",
    );
    if (signals.userVerification) {
      addContribution(
        contributions,
        reasonCodes,
        "userVerification",
        15,
        "USER_VERIFICATION_PRESENT",
      );
    }
    if (signals.credentialBinding === "device_bound") {
      addContribution(
        contributions,
        reasonCodes,
        "deviceBoundCredential",
        10,
        "DEVICE_BOUND_CREDENTIAL",
      );
    } else if (signals.credentialBinding === "synced") {
      reasonCodes.push("SYNCED_CREDENTIAL");
    } else {
      reasonCodes.push("CREDENTIAL_BINDING_UNKNOWN");
    }
  } else if (signals.credentialStatus === "failed") {
    addContribution(
      contributions,
      reasonCodes,
      "credentialFailed",
      -35,
      "CREDENTIAL_FAILED",
    );
  } else {
    reasonCodes.push("CREDENTIAL_UNAVAILABLE");
  }

  if (signals.sessionBindingStatus === "match") {
    addContribution(
      contributions,
      reasonCodes,
      "sessionBindingMatch",
      15,
      "SESSION_BINDING_MATCH",
    );
  } else if (signals.sessionBindingStatus === "mismatch") {
    addContribution(
      contributions,
      reasonCodes,
      "sessionBindingMismatch",
      -40,
      "SESSION_BINDING_MISMATCH",
    );
  } else {
    reasonCodes.push("SESSION_BINDING_UNAVAILABLE");
  }

  if (signals.behaviorDecision === "allow") {
    addContribution(
      contributions,
      reasonCodes,
      "behaviorMatch",
      20,
      "BEHAVIOR_MATCH",
    );
  } else if (signals.behaviorDecision === "step_up") {
    addContribution(
      contributions,
      reasonCodes,
      "behaviorDrift",
      5,
      "BEHAVIOR_DRIFT",
    );
  } else if (signals.behaviorDecision === "deny") {
    addContribution(
      contributions,
      reasonCodes,
      "behaviorMismatch",
      -30,
      "BEHAVIOR_MISMATCH",
    );
  } else {
    reasonCodes.push("BEHAVIOR_UNAVAILABLE");
  }

  if (signals.humanProofStatus === "passed") {
    addContribution(
      contributions,
      reasonCodes,
      "humanProofPassed",
      5,
      "HUMAN_PROOF_PASSED",
    );
  } else if (signals.humanProofStatus === "failed") {
    addContribution(
      contributions,
      reasonCodes,
      "humanProofFailed",
      -30,
      "HUMAN_PROOF_FAILED",
    );
  } else {
    reasonCodes.push("HUMAN_PROOF_UNAVAILABLE");
  }

  if (signals.descriptorChanged) {
    addContribution(
      contributions,
      reasonCodes,
      "descriptorChanged",
      -10,
      "DEVICE_DESCRIPTOR_CHANGED",
    );
  }
  if (signals.recentFailureCount > 0) {
    addContribution(
      contributions,
      reasonCodes,
      "recentFailures",
      -Math.min(20, signals.recentFailureCount * 4),
      "RECENT_AUTH_FAILURES",
    );
  }
  if (signals.credentialAnomaly) {
    reasonCodes.push("CREDENTIAL_ANOMALY");
  }
  if (signals.replaySuspected) {
    reasonCodes.push("REPLAY_SUSPECTED");
  }
  if (signals.crossDeviceTransferRestricted) {
    reasonCodes.push("CROSS_DEVICE_RECALIBRATION_REQUIRED");
  }

  const rawScore = contributions.reduce(
    (total, contribution) => total + contribution.weight,
    0,
  );
  return {
    score: Math.max(0, Math.min(100, rawScore)),
    contributions,
    reasonCodes,
  };
}

function determineState(signals, score) {
  const restricted = (
    signals.credentialAnomaly
    || signals.replaySuspected
    || signals.crossDeviceTransferRestricted
    || signals.sessionBindingStatus === "mismatch"
    || signals.credentialStatus === "failed"
    || signals.behaviorDecision === "deny"
    || signals.humanProofStatus === "failed"
  );
  if (restricted) {
    return "restricted";
  }

  const strongDeviceEvidence = (
    signals.credentialBinding === "device_bound"
    || (
      signals.deviceRecordFound
      && signals.fingerprintStatus === "match"
    )
  );
  if (
    score >= 75
    && signals.credentialStatus === "verified"
    && signals.userVerification
    && signals.behaviorDecision === "allow"
    && strongDeviceEvidence
    && signals.fingerprintStatus !== "mismatch"
    && signals.descriptorChanged === false
    && signals.recentFailureCount === 0
  ) {
    return "trusted";
  }
  if (
    score >= 45
    && signals.deviceRecordFound
    && signals.fingerprintStatus !== "mismatch"
  ) {
    return "recognized";
  }
  return "step_up";
}

function policyAdjustedScore(state, evidenceScore) {
  if (state === "trusted") {
    return evidenceScore;
  }
  if (state === "recognized") {
    return Math.min(evidenceScore, 74);
  }
  if (state === "step_up") {
    return Math.min(evidenceScore, 44);
  }
  return Math.min(evidenceScore, 24);
}

function confidenceLabel(score) {
  if (score >= 75) {
    return "high";
  }
  if (score >= 45) {
    return "moderate";
  }
  return "low";
}

function evaluateDeviceConfidence(input) {
  const signals = normalizeSignals(input);
  const scored = scoreSignals(signals);
  const state = determineState(signals, scored.score);
  const score = policyAdjustedScore(state, scored.score);
  const reasonCodes = [...scored.reasonCodes, (
    `DEVICE_STATE_${state.toUpperCase()}`
  )];
  const deviceIdentityProven = (
    signals.credentialStatus === "verified"
    && signals.userVerification
    && signals.credentialBinding === "device_bound"
  );

  return {
    policyVersion: DEVICE_CONFIDENCE_POLICY_VERSION,
    state,
    score,
    evidenceScore: scored.score,
    confidence: confidenceLabel(score),
    allowSensitiveActions: state === "trusted",
    stepUpRequired: state !== "trusted",
    deviceIdentityProven,
    deviceBoundCredentialVerified: deviceIdentityProven,
    signals,
    contributions: scored.contributions,
    reasonCodes,
  };
}

module.exports = {
  DEVICE_CONFIDENCE_POLICY_VERSION,
  DEVICE_STATES,
  DeviceConfidenceValidationError,
  evaluateDeviceConfidence,
  normalizeSignals,
};
