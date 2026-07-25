"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEVICE_CONFIDENCE_POLICY_VERSION,
  DEVICE_STATES,
  DeviceConfidenceValidationError,
  evaluateDeviceConfidence,
  normalizeSignals,
} = require("../src/device-confidence");

test("marks strongly verified device-bound evidence as trusted", () => {
  const result = evaluateDeviceConfidence({
    behaviorDecision: "allow",
    credentialBinding: "device_bound",
    credentialStatus: "verified",
    deviceRecordFound: true,
    fingerprintStatus: "match",
    humanProofStatus: "passed",
    sessionBindingStatus: "match",
    userVerification: true,
  });

  assert.equal(
    result.policyVersion,
    DEVICE_CONFIDENCE_POLICY_VERSION,
  );
  assert.equal(result.state, "trusted");
  assert.equal(result.score, 100);
  assert.equal(result.confidence, "high");
  assert.equal(result.allowSensitiveActions, true);
  assert.equal(result.stepUpRequired, false);
  assert.equal(result.deviceIdentityProven, true);
  assert.ok(result.reasonCodes.includes("DEVICE_BOUND_CREDENTIAL"));
  assert.ok(result.reasonCodes.includes("DEVICE_STATE_TRUSTED"));
});

test("does not treat a synced passkey alone as device-bound proof", () => {
  const result = evaluateDeviceConfidence({
    behaviorDecision: "allow",
    credentialBinding: "synced",
    credentialStatus: "verified",
    deviceRecordFound: true,
    humanProofStatus: "passed",
    userVerification: true,
  });

  assert.equal(result.evidenceScore, 85);
  assert.equal(result.score, 74);
  assert.equal(result.state, "recognized");
  assert.equal(result.deviceIdentityProven, false);
  assert.equal(result.allowSensitiveActions, false);
  assert.equal(result.stepUpRequired, true);
  assert.equal(result.confidence, "moderate");
  assert.ok(result.reasonCodes.includes("SYNCED_CREDENTIAL"));
});

test("recognizes coarse fingerprint and behavior without overclaiming proof", () => {
  const result = evaluateDeviceConfidence({
    behaviorDecision: "allow",
    deviceRecordFound: true,
    fingerprintStatus: "match",
  });

  assert.equal(result.score, 45);
  assert.equal(result.state, "recognized");
  assert.equal(result.deviceIdentityProven, false);
  assert.equal(result.allowSensitiveActions, false);
});

test("requires step-up when the device has insufficient evidence", () => {
  const result = evaluateDeviceConfidence({
    behaviorDecision: "step_up",
    humanProofStatus: "passed",
  });

  assert.equal(result.score, 10);
  assert.equal(result.state, "step_up");
  assert.equal(result.confidence, "low");
  assert.equal(result.stepUpRequired, true);
  assert.ok(result.reasonCodes.includes("DEVICE_RECORD_UNKNOWN"));
  assert.ok(result.reasonCodes.includes("DEVICE_STATE_STEP_UP"));
});

test("hard risk signals restrict access even with positive evidence", () => {
  const base = {
    behaviorDecision: "allow",
    credentialBinding: "device_bound",
    credentialStatus: "verified",
    deviceRecordFound: true,
    fingerprintStatus: "match",
    humanProofStatus: "passed",
    userVerification: true,
  };
  const cases = [
    { credentialAnomaly: true, code: "CREDENTIAL_ANOMALY" },
    { replaySuspected: true, code: "REPLAY_SUSPECTED" },
    {
      crossDeviceTransferRestricted: true,
      code: "CROSS_DEVICE_RECALIBRATION_REQUIRED",
    },
    {
      sessionBindingStatus: "mismatch",
      code: "SESSION_BINDING_MISMATCH",
    },
    { behaviorDecision: "deny", code: "BEHAVIOR_MISMATCH" },
    { humanProofStatus: "failed", code: "HUMAN_PROOF_FAILED" },
  ];

  for (const testCase of cases) {
    const { code, ...risk } = testCase;
    const result = evaluateDeviceConfidence({ ...base, ...risk });
    assert.equal(result.state, "restricted", code);
    assert.ok(result.score <= 24, code);
    assert.equal(result.confidence, "low", code);
    assert.equal(result.allowSensitiveActions, false, code);
    assert.equal(result.stepUpRequired, true, code);
    assert.ok(result.reasonCodes.includes(code), code);
  }
});

test("caps failure penalties and produces deterministic explanations", () => {
  const input = {
    behaviorDecision: "allow",
    deviceRecordFound: true,
    fingerprintStatus: "match",
    recentFailureCount: 100,
  };
  const first = evaluateDeviceConfidence(input);
  const second = evaluateDeviceConfidence(input);

  assert.deepEqual(first, second);
  assert.equal(
    first.contributions.find(
      (entry) => entry.signal === "recentFailures",
    ).weight,
    -20,
  );
  assert.deepEqual(input, {
    behaviorDecision: "allow",
    deviceRecordFound: true,
    fingerprintStatus: "match",
    recentFailureCount: 100,
  });
});

test("normalizes missing optional signals to conservative values", () => {
  const normalized = normalizeSignals({});

  assert.equal(normalized.credentialStatus, "unavailable");
  assert.equal(normalized.fingerprintStatus, "unavailable");
  assert.equal(normalized.behaviorDecision, "unavailable");
  assert.equal(normalized.deviceRecordFound, false);
  assert.equal(normalized.recentFailureCount, 0);
  assert.ok(Object.isFrozen(normalized));
  assert.deepEqual(DEVICE_STATES, [
    "recognized",
    "restricted",
    "step_up",
    "trusted",
  ]);
});

test("rejects malformed and contradictory device evidence", () => {
  assert.throws(
    () => evaluateDeviceConfidence({
      madeUpSignal: true,
    }),
    DeviceConfidenceValidationError,
  );
  assert.throws(
    () => evaluateDeviceConfidence({
      credentialStatus: "unavailable",
      userVerification: true,
    }),
    DeviceConfidenceValidationError,
  );
  assert.throws(
    () => evaluateDeviceConfidence({
      recentFailureCount: -1,
    }),
    DeviceConfidenceValidationError,
  );
  assert.throws(
    () => evaluateDeviceConfidence({
      fingerprintStatus: "exact_model_match",
    }),
    DeviceConfidenceValidationError,
  );
  assert.throws(
    () => evaluateDeviceConfidence({
      fingerprintStatus: null,
    }),
    DeviceConfidenceValidationError,
  );
});

test("does not silently trust changed or mismatched device context", () => {
  const base = {
    behaviorDecision: "allow",
    credentialBinding: "device_bound",
    credentialStatus: "verified",
    deviceRecordFound: true,
    fingerprintStatus: "match",
    userVerification: true,
  };

  const changed = evaluateDeviceConfidence({
    ...base,
    descriptorChanged: true,
  });
  assert.equal(changed.state, "recognized");
  assert.equal(changed.allowSensitiveActions, false);

  const mismatch = evaluateDeviceConfidence({
    ...base,
    fingerprintStatus: "mismatch",
    sessionBindingStatus: "match",
  });
  assert.equal(mismatch.state, "step_up");
  assert.equal(mismatch.allowSensitiveActions, false);

  const failures = evaluateDeviceConfidence({
    ...base,
    recentFailureCount: 1,
  });
  assert.equal(failures.state, "recognized");
  assert.equal(failures.allowSensitiveActions, false);
});
