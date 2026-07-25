"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTemplate,
} = require("../src/behavior");
const {
  buildBehaviorDecision,
  evaluateCompatibleEvidence,
  reinforceTrustedSample,
} = require("../src/behavior-lifecycle");
const {
  evolveTemplate,
} = require("../src/template-evolution");
const {
  evaluateStrongTest,
} = require("../src/demo-admin-routes");

const PERSON_A_ENROLLMENT = [
  {
    dwellMean: 100,
    dwellDeviation: 24,
    flightMean: 80,
    flightDeviation: 31,
    downDownMean: 188,
    downDownDeviation: 45,
    pointerVelocityMean: 510,
    pointerVelocityDeviation: 180,
    pointerJitterMean: 0.28,
    pointerJitterDeviation: 0.12,
  },
  {
    dwellMean: 104,
    dwellDeviation: 25,
    flightMean: 78,
    flightDeviation: 29,
    downDownMean: 192,
    downDownDeviation: 47,
    pointerVelocityMean: 530,
    pointerVelocityDeviation: 175,
    pointerJitterMean: 0.3,
    pointerJitterDeviation: 0.13,
  },
  {
    dwellMean: 98,
    dwellDeviation: 23,
    flightMean: 83,
    flightDeviation: 32,
    downDownMean: 185,
    downDownDeviation: 43,
    pointerVelocityMean: 500,
    pointerVelocityDeviation: 185,
    pointerJitterMean: 0.27,
    pointerJitterDeviation: 0.11,
  },
  {
    dwellMean: 102,
    dwellDeviation: 24,
    flightMean: 79,
    flightDeviation: 30,
    downDownMean: 190,
    downDownDeviation: 46,
    pointerVelocityMean: 520,
    pointerVelocityDeviation: 178,
    pointerJitterMean: 0.29,
    pointerJitterDeviation: 0.12,
  },
  {
    dwellMean: 101,
    dwellDeviation: 25,
    flightMean: 81,
    flightDeviation: 31,
    downDownMean: 189,
    downDownDeviation: 44,
    pointerVelocityMean: 515,
    pointerVelocityDeviation: 182,
    pointerJitterMean: 0.28,
    pointerJitterDeviation: 0.12,
  },
];

const PERSON_A_REPEAT = {
  dwellMean: 101,
  dwellDeviation: 24,
  flightMean: 80,
  flightDeviation: 31,
  downDownMean: 189,
  downDownDeviation: 45,
  pointerVelocityMean: 516,
  pointerVelocityDeviation: 180,
  pointerJitterMean: 0.28,
  pointerJitterDeviation: 0.12,
};

const PERSON_B_REPEAT = {
  dwellMean: 260,
  dwellDeviation: 70,
  flightMean: 240,
  flightDeviation: 85,
  downDownMean: 510,
  downDownDeviation: 110,
  pointerVelocityMean: 1_800,
  pointerVelocityDeviation: 620,
  pointerJitterMean: 1.4,
  pointerJitterDeviation: 0.75,
};

function humanDiagnostics() {
  return {
    version: 1,
    missionId: "steady-session",
    totalDurationMs: 4_800,
    inputEventCount: 52,
    keyPressCount: 50,
    cadencePerMinute: 625,
    pauses: {
      thresholdMs: 500,
      count: 2,
      longestMs: 840,
    },
    bursts: {
      count: 3,
      averageEvents: 17.33,
    },
    guided: {
      durationMs: 2_600,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 1, durationMs: 100 },
        { index: 2, characterCount: 7, durationMs: 620 },
        { index: 3, characterCount: 7, durationMs: 510 },
      ],
    },
    freeTyping: {
      durationMs: 1_900,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 4, durationMs: 430 },
        { index: 2, characterCount: 7, durationMs: 680 },
        { index: 3, characterCount: 5, durationMs: 470 },
      ],
    },
  };
}

function interactionEvidence(overrides = {}) {
  return {
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 50,
      flight: 48,
      downDown: 48,
      pointer: 20,
    },
    durationMs: 5_200,
    ...overrides,
  };
}

function evidence(vector, overrides = {}) {
  return {
    profileId: "primary",
    status: "ready",
    sampleCounts: {
      dwell: 50,
      flight: 48,
      downDown: 48,
      pointer: 20,
    },
    vector,
    diagnostics: humanDiagnostics(),
    interactionEvidence: interactionEvidence(),
    ...overrides,
  };
}

function decisionFor(template, evaluation, amendment = null) {
  return buildBehaviorDecision({
    template,
    evidenceStatus: evaluation.status,
    identitySimilarity: evaluation.identitySimilarity,
    distance: evaluation.distance,
    comparedFeatureNames: evaluation.comparedFeatureNames,
    ignoredFeatureNames: evaluation.ignoredFeatureNames,
    automationRisk: evaluation.automationRisk,
    amendment,
    forcedReasonCodes: evaluation.reasonCodes,
  });
}

function templateSnapshot(template) {
  return JSON.stringify(template);
}

test("Person A enrollment and close return preserve separate decision axes", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const evaluation = evaluateCompatibleEvidence(
    template,
    evidence(PERSON_A_REPEAT),
  );
  const result = decisionFor(template, evaluation);

  assert.equal(template.sampleCount, 5);
  assert.equal(evaluation.status, "ready");
  assert.equal(evaluation.identitySimilarity.decision, "allow");
  assert.equal(
    evaluation.automationRisk.classification,
    "human_like_interaction",
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.classification, "trusted_return");
  assert.equal(result.simulatedIpRestriction.displayed, false);
  assert.equal(result.simulatedIpRestriction.enforced, false);
  assert.ok(result.identitySimilarity);
  assert.ok(result.automationRisk);
  assert.notStrictEqual(
    result.identitySimilarity,
    result.automationRisk,
  );
});

test("a close Person A return receives only bounded reinforcement", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const original = structuredClone(template);
  const evaluation = evaluateCompatibleEvidence(
    template,
    evidence(PERSON_A_REPEAT),
  );
  const reinforced = reinforceTrustedSample(
    template,
    evaluation.vector,
    {
      comparedFeatureNames: evaluation.comparedFeatureNames,
      updatedAt: "2026-07-25T12:05:00.000Z",
    },
  );
  const result = decisionFor(
    template,
    evaluation,
    reinforced.amendment,
  );

  assert.equal(reinforced.amendment.status, "applied");
  assert.equal(result.amendment.status, "applied");
  assert.equal(result.decision, "allow");
  assert.ok(reinforced.template.sampleCount > template.sampleCount);
  for (const name of template.featureKeys) {
    assert.ok(
      Math.abs(
        reinforced.template.means[name] - original.means[name],
      ) <= original.scales[name] * 0.02 + Number.EPSILON,
    );
    assert.equal(
      reinforced.template.scales[name],
      original.scales[name],
    );
  }
  assert.equal(
    reinforced.template.acceptanceThreshold,
    original.acceptanceThreshold,
  );
  assert.equal(templateSnapshot(template), templateSnapshot(original));
});

test("reinforcement moves only compared features and respects anchor drift", () => {
  const original = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  let current = original;
  const target = {
    dwellMean: (
      original.means.dwellMean
      + original.scales.dwellMean * 0.8
    ),
  };

  for (let index = 0; index < 100; index += 1) {
    current = reinforceTrustedSample(current, target, {
      comparedFeatureNames: ["dwellMean"],
      updatedAt: new Date(
        Date.parse("2026-07-25T12:10:00.000Z") + index * 1_000,
      ).toISOString(),
    }).template;
  }

  assert.ok(
    Math.abs(current.means.dwellMean - original.means.dwellMean)
      <= original.scales.dwellMean * 0.25 + 1e-9,
  );
  for (const name of original.featureKeys) {
    if (name !== "dwellMean") {
      assert.equal(current.means[name], original.means[name]);
    }
    assert.equal(current.scales[name], original.scales[name]);
  }
  assert.equal(
    current.acceptanceThreshold,
    original.acceptanceThreshold,
  );
});

test("Human B is suspicious without poisoning Person A's template", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const before = templateSnapshot(template);
  const evaluation = evaluateCompatibleEvidence(
    template,
    evidence(PERSON_B_REPEAT),
  );
  const result = decisionFor(template, evaluation);

  assert.equal(evaluation.identitySimilarity.decision, "deny");
  assert.equal(
    evaluation.automationRisk.classification,
    "human_like_interaction",
  );
  assert.equal(result.decision, "review");
  assert.equal(result.classification, "suspicious_identity");
  assert.equal(result.simulatedIpRestriction.displayed, true);
  assert.equal(result.simulatedIpRestriction.enforced, false);
  assert.equal(result.amendment.status, "not_applied");
  assert.equal(templateSnapshot(template), before);
});

test("an automated lookalike is denied without poisoning the template", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const before = templateSnapshot(template);
  const evaluation = evaluateCompatibleEvidence(
    template,
    evidence(PERSON_A_REPEAT, {
      diagnostics: {
        ...humanDiagnostics(),
        totalDurationMs: 500,
        cadencePerMinute: 4_800,
      },
      interactionEvidence: interactionEvidence({
        rejectedSyntheticEvents: 3,
        durationMs: 500,
      }),
    }),
  );
  const result = decisionFor(template, evaluation);

  assert.equal(evaluation.identitySimilarity.decision, "allow");
  assert.equal(
    evaluation.automationRisk.classification,
    "automation_likely",
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.classification, "automation_likely");
  assert.equal(result.amendment.status, "not_applied");
  assert.equal(templateSnapshot(template), before);
});

test("missing evidence cannot bypass an enrolled account", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT);
  const evaluation = evaluateCompatibleEvidence(template, {
    status: "insufficient_evidence",
    sampleCounts: {
      dwell: 0,
      flight: 0,
      downDown: 0,
      pointer: 0,
    },
  });
  const result = decisionFor(template, evaluation);

  assert.equal(evaluation.status, "insufficient_evidence");
  assert.equal(result.decision, "review");
  assert.notEqual(result.classification, "baseline_missing");
  assert.equal(result.amendment.status, "not_applied");
});

test("only an account with no profile receives baseline_missing", () => {
  const result = buildBehaviorDecision({
    template: null,
    evidenceStatus: "insufficient_evidence",
  });

  assert.equal(result.classification, "baseline_missing");
  assert.equal(result.decision, "allow");
  assert.equal(result.identitySimilarity, null);
  assert.equal(result.automationRisk, null);
  assert.equal(result.amendment.status, "not_applied");
});

test("/admin/test strengthening accepts only a matching human-like batch", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const personABatch = [
    {
      ...PERSON_A_REPEAT,
      dwellMean: 100.8,
    },
    {
      ...PERSON_A_REPEAT,
      dwellMean: 101,
      flightMean: 80.2,
    },
    {
      ...PERSON_A_REPEAT,
      dwellMean: 101.2,
    },
  ].map((vector, index) => ({
    sessionId: `admin-test-human-a-${index + 1}`,
    strongVerification: true,
    vector,
  }));
  const strengthened = evolveTemplate(template, personABatch, {
    updatedAt: "2026-07-25T12:30:00.000Z",
  });

  assert.equal(strengthened.update.status, "updated");
  assert.equal(strengthened.update.acceptedSessionIds.length, 3);
  assert.equal(
    strengthened.template.acceptanceThreshold,
    template.acceptanceThreshold,
  );

  const personBBatch = [1, 2, 3].map((index) => ({
    sessionId: `admin-test-human-b-${index}`,
    strongVerification: true,
    vector: PERSON_B_REPEAT,
  }));
  const rejected = evolveTemplate(template, personBBatch, {
    updatedAt: "2026-07-25T12:31:00.000Z",
  });

  assert.equal(rejected.update.status, "insufficient_evidence");
  assert.ok(rejected.update.rejectedSessions.every(
    (entry) => entry.reasonCode === "OUTSIDE_UPDATE_ENVELOPE",
  ));
  assert.equal(
    templateSnapshot(rejected.template),
    templateSnapshot(template),
  );
});

test("demo subject labels cannot change scores or strengthening eligibility", () => {
  const template = createTemplate(PERSON_A_ENROLLMENT, {
    enrolledAt: "2026-07-25T12:00:00.000Z",
  });
  const profile = {
    profileId: "primary",
    template,
  };
  const samples = [
    {
      ...PERSON_A_REPEAT,
      dwellMean: 100.8,
    },
    PERSON_A_REPEAT,
    {
      ...PERSON_A_REPEAT,
      dwellMean: 101.2,
    },
  ].map((vector) => ({
    vector,
    diagnostics: humanDiagnostics(),
    interactionEvidence: interactionEvidence(),
  }));
  const context = {
    HttpError: TestLifecycleHttpError,
  };
  const reports = [
    "Human A",
    "Human B",
    "Automated agent",
  ].map((demoSubjectLabel) => evaluateStrongTest(profile, {
    demoSubjectLabel,
    samples,
  }, context));
  const scoreFields = (report) => ({
    identitySimilarity: report.identitySimilarity,
    automationRisk: report.automationRisk,
    featureSummary: report.featureSummary,
    samples: report.samples,
  });

  assert.deepEqual(
    scoreFields(reports[0]),
    scoreFields(reports[1]),
  );
  assert.deepEqual(
    scoreFields(reports[0]),
    scoreFields(reports[2]),
  );
  for (const report of reports) {
    const strengtheningEligible = (
      report.identitySimilarity.classification === "close_to_baseline"
      && report.identitySimilarity.matchingSamples === report.sampleCount
      && report.automationRisk.classification === "human_like_interaction"
    );
    assert.equal(strengtheningEligible, true);
  }
});

class TestLifecycleHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
