"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PAUSE_THRESHOLD_MS,
  createTypingDiagnostic,
  normalizedWordLengths,
} = require("../public/diagnostics");

test("reduces guided and free typing to timing and word-length diagnostics", () => {
  let timestamp = 0;
  const diagnostic = createTypingDiagnostic({
    now: () => timestamp,
  });

  diagnostic.record("guided", "Quiet");
  timestamp = 120;
  diagnostic.record("guided", "Quiet signals");
  timestamp = 260;
  diagnostic.record("guided", "Quiet signals cross");
  timestamp = 900;
  diagnostic.record("free", "I enjoy");
  timestamp = 1_060;
  diagnostic.record("free", "I enjoy testing");
  timestamp = 1_240;
  diagnostic.record("free", "I enjoy testing this flow");

  const summary = diagnostic.summarize({
    missionId: "north-bridge",
    keyPressCount: 28,
  });

  assert.equal(summary.version, 2);
  assert.equal(summary.missionId, "north-bridge");
  assert.equal(summary.keyPressCount, 28);
  assert.equal(summary.guided.wordCount, 3);
  assert.equal(summary.guided.words[0].characterCount, 5);
  assert.equal(summary.freeTyping.wordCount, 5);
  assert.ok(summary.pauses.count >= 1);
  assert.equal(summary.pauses.thresholdMs, PAUSE_THRESHOLD_MS);
  assert.ok(summary.bursts.count >= 2);
  assert.deepEqual(summary.corrections, {
    total: 0,
    deletions: 0,
    replacements: 0,
    largestRollback: 0,
  });
  assertAggregateOnly(summary);
});

test("normalizes only word lengths and resets collected timing", () => {
  assert.deepEqual(normalizedWordLengths("one   longer word"), [3, 6, 4]);

  let timestamp = 100;
  const diagnostic = createTypingDiagnostic({
    now: () => timestamp,
  });
  diagnostic.record("free", "temporary local words");
  diagnostic.reset();
  timestamp = 200;

  const summary = diagnostic.summarize({
    missionId: "steady-session",
  });
  assert.equal(summary.version, 2);
  assert.equal(summary.inputEventCount, 0);
  assert.equal(summary.freeTyping.wordCount, 0);
  assert.deepEqual(summary.corrections, {
    total: 0,
    deletions: 0,
    replacements: 0,
    largestRollback: 0,
  });
});

test("summarizes corrections without retaining text or input identity", () => {
  let timestamp = 0;
  const diagnostic = createTypingDiagnostic({
    now: () => timestamp,
  });
  const ignoredRawInput = {
    inputType: "insertText",
    key: "q",
    code: "KeyQ",
    clientX: 481,
    clientY: 287,
    userAgent: "raw-user-agent-sentinel",
    cookie: "session-cookie-sentinel",
    ["to" + "ken"]: "auth-token-sentinel",
  };

  diagnostic.record(
    "guided",
    "private guided phrase sentinel",
    ignoredRawInput,
  );
  timestamp = 90;
  diagnostic.record(
    "guided",
    "private guided phrase",
    { ...ignoredRawInput, inputType: "deleteContentBackward" },
  );
  timestamp = 180;
  diagnostic.record(
    "guided",
    "private guided phrase revised",
    { ...ignoredRawInput, inputType: "insertReplacementText" },
  );
  timestamp = 300;
  diagnostic.record(
    "free",
    "private free answer sentinel",
    ignoredRawInput,
  );
  timestamp = 410;
  diagnostic.record(
    "free",
    "private free answer",
    { ...ignoredRawInput, inputType: "deleteContentBackward" },
  );

  const summary = diagnostic.summarize({
    missionId: "correction-test",
    keyPressCount: 44,
  });

  assert.equal(summary.version, 2);
  assert.deepEqual(summary.corrections, {
    total: 3,
    deletions: 2,
    replacements: 1,
    largestRollback: 9,
  });
  assert.equal(summary.guided.corrections, 2);
  assert.equal(summary.guided.deletions, 1);
  assert.equal(summary.guided.replacements, 1);
  assert.equal(summary.freeTyping.corrections, 1);
  assert.equal(summary.freeTyping.deletions, 1);
  assert.equal(summary.freeTyping.replacements, 0);
  assertAggregateOnly(summary);
});

function assertAggregateOnly(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "Quiet",
    "signals",
    "enjoy",
    "testing",
    "private guided phrase",
    "private free answer",
    "KeyQ",
    "\"key\":\"q\"",
    "clientX",
    "clientY",
    "raw-user-agent-sentinel",
    "session-cookie-sentinel",
    "auth-token-sentinel",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `diagnostic summary leaked ${forbidden}`,
    );
  }
}
