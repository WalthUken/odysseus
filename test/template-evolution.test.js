"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  createTemplate,
} = require("../src/behavior");
const {
  evolveTemplate,
  initializeCrossDeviceTransfer,
  recalibrateCrossDeviceTemplate,
  templateAccessState,
} = require("../src/template-evolution");

const enrollment = [
  { dwellMean: 100, flightMean: 75 },
  { dwellMean: 102, flightMean: 76 },
  { dwellMean: 98, flightMean: 74 },
  { dwellMean: 101, flightMean: 75 },
  { dwellMean: 99, flightMean: 76 },
];

function verifiedSession(sessionId, dwellMean, flightMean) {
  return {
    sessionId,
    strongVerification: true,
    vector: { dwellMean, flightMean },
  };
}

test("applies a bounded update from verified consistent sessions", () => {
  const original = createTemplate(enrollment, {
    enrolledAt: "2026-07-20T12:00:00.000Z",
  });
  const originalSnapshot = JSON.stringify(original);
  const result = evolveTemplate(original, [
    verifiedSession("session-1", 100.5, 75.4),
    verifiedSession("session-2", 100.7, 75.5),
    verifiedSession("session-3", 100.6, 75.6),
  ], {
    updatedAt: "2026-07-25T12:00:00.000Z",
  });

  assert.equal(result.update.status, "updated");
  assert.equal(
    result.update.reasonCode,
    "VERIFIED_MULTI_SESSION_DRIFT_APPLIED",
  );
  assert.equal(result.update.acceptedSessionIds.length, 3);
  assert.equal(result.template.updatedAt, "2026-07-25T12:00:00.000Z");
  assert.equal(result.template.evolution.updateCount, 1);
  assert.equal(result.template.evolution.thresholdChanged, false);
  assert.equal(
    result.template.acceptanceThreshold,
    original.acceptanceThreshold,
  );
  assert.ok(result.template.means.dwellMean > original.means.dwellMean);
  assert.ok(
    Math.abs(
      result.template.scales.dwellMean / original.scales.dwellMean,
    ) <= 1.05,
  );
  assert.equal(JSON.stringify(original), originalSnapshot);
});

test("does not update from unverified, duplicate, or distant sessions", () => {
  const template = createTemplate(enrollment);
  const result = evolveTemplate(template, [
    {
      ...verifiedSession("duplicate", 100.3, 75.2),
      strongVerification: false,
    },
    verifiedSession("duplicate", 100.3, 75.2),
    verifiedSession("distant", 500, 700),
  ]);

  assert.equal(result.update.status, "insufficient_evidence");
  assert.equal(
    result.update.reasonCode,
    "INSUFFICIENT_VERIFIED_CONSISTENT_SESSIONS",
  );
  assert.ok(result.update.rejectedSessions.some(
    (entry) => entry.reasonCode === "STRONG_VERIFICATION_REQUIRED",
  ));
  assert.ok(result.update.rejectedSessions.some(
    (entry) => entry.reasonCode === "OUTSIDE_UPDATE_ENVELOPE",
  ));
  assert.deepEqual(result.template.means, template.means);
});

test("rejects an inconsistent session within the outer update envelope", () => {
  const template = createTemplate(enrollment);
  const result = evolveTemplate(template, [
    verifiedSession("session-1", 100.1, 75.2),
    verifiedSession("session-2", 100.2, 75.3),
    verifiedSession("session-3", 100.3, 75.2),
    verifiedSession("cluster-outlier", 102, 76),
  ]);

  assert.equal(result.update.status, "updated");
  assert.deepEqual([...result.update.acceptedSessionIds].sort(), [
    "session-1",
    "session-2",
    "session-3",
  ]);
  assert.ok(result.update.rejectedSessions.some(
    (entry) => (
      entry.sessionId === "cluster-outlier"
      && entry.reasonCode === "INCONSISTENT_WITH_SESSION_CLUSTER"
    ),
  ));
});

test("caps each update shift and never loosens the threshold", () => {
  const template = createTemplate([
    { dwellMean: 99 },
    { dwellMean: 100 },
    { dwellMean: 101 },
  ]);
  const result = evolveTemplate(template, [
    verifiedSession("session-1", 101.35, undefined),
    verifiedSession("session-2", 101.4, undefined),
    verifiedSession("session-3", 101.45, undefined),
  ].map((session) => ({
    sessionId: session.sessionId,
    strongVerification: true,
    vector: { dwellMean: session.vector.dwellMean },
  })), {
    learningRate: 0.15,
    maxShiftInScales: 0.05,
  });

  assert.equal(result.update.status, "updated");
  assert.ok(
    Math.abs(result.update.meanShifts.dwellMean)
      <= template.scales.dwellMean * 0.05,
  );
  assert.equal(
    result.template.acceptanceThreshold,
    template.acceptanceThreshold,
  );
});

test("initializes a transferred template in a restricted state", () => {
  const source = createTemplate(enrollment, {
    enrolledAt: "2026-07-20T12:00:00.000Z",
  });
  const transferred = initializeCrossDeviceTransfer(source, {
    sourceDeviceId: "device-primary",
    destinationDeviceId: "device-travel",
    initializedAt: "2026-07-25T12:00:00.000Z",
    requiredSamples: 3,
  });

  assert.equal(transferred.transfer.status, "restricted");
  assert.equal(transferred.transfer.requiresRecalibration, true);
  assert.equal(transferred.transfer.destinationSampleCount, 0);
  assert.deepEqual(templateAccessState(transferred), {
    state: "restricted",
    allowSensitiveActions: false,
    stepUpRequired: true,
    reasonCode: "CROSS_DEVICE_RECALIBRATION_REQUIRED",
  });

  const blocked = evolveTemplate(transferred, []);
  assert.equal(blocked.update.status, "blocked");
  assert.equal(
    blocked.update.reasonCode,
    "CROSS_DEVICE_RECALIBRATION_REQUIRED",
  );
});

test("activates a transferred template only after fresh device samples", () => {
  const source = createTemplate(enrollment);
  const transferred = initializeCrossDeviceTransfer(source, {
    sourceDeviceId: "device-primary",
    destinationDeviceId: "device-travel",
    requiredSamples: 3,
  });
  const destinationSamples = [
    { dwellMean: 110, flightMean: 82 },
    { dwellMean: 111, flightMean: 81 },
    { dwellMean: 109, flightMean: 83 },
  ];

  assert.throws(
    () => recalibrateCrossDeviceTemplate(
      transferred,
      destinationSamples.slice(0, 2),
    ),
    ValidationError,
  );

  const active = recalibrateCrossDeviceTemplate(
    transferred,
    destinationSamples,
    {
      recalibratedAt: "2026-07-26T12:00:00.000Z",
    },
  );

  assert.equal(active.transfer.status, "active");
  assert.equal(active.transfer.requiresRecalibration, false);
  assert.equal(active.transfer.destinationSampleCount, 3);
  assert.equal(active.means.dwellMean, 110);
  assert.deepEqual(templateAccessState(active), {
    state: "active",
    allowSensitiveActions: true,
    stepUpRequired: false,
    reasonCode: "TEMPLATE_ACTIVE",
  });
});

test("rejects unsafe transfer identities and malformed update entries", () => {
  const source = createTemplate(enrollment);
  assert.throws(
    () => initializeCrossDeviceTransfer(source, {
      sourceDeviceId: "same-device",
      destinationDeviceId: "same-device",
    }),
    ValidationError,
  );
  assert.throws(
    () => evolveTemplate(source, [{
      sessionId: "bad-session",
      strongVerification: true,
      vector: { dwellMean: 100 },
    }]),
    ValidationError,
  );
  assert.throws(
    () => initializeCrossDeviceTransfer(source, null),
    ValidationError,
  );
});
