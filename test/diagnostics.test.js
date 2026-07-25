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

  assert.equal(summary.version, 1);
  assert.equal(summary.missionId, "north-bridge");
  assert.equal(summary.keyPressCount, 28);
  assert.equal(summary.guided.wordCount, 3);
  assert.equal(summary.guided.words[0].characterCount, 5);
  assert.equal(summary.freeTyping.wordCount, 5);
  assert.ok(summary.pauses.count >= 1);
  assert.equal(summary.pauses.thresholdMs, PAUSE_THRESHOLD_MS);
  assert.ok(summary.bursts.count >= 2);
  assert.doesNotMatch(JSON.stringify(summary), /Quiet|signals|enjoy|testing/);
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
  assert.equal(summary.inputEventCount, 0);
  assert.equal(summary.freeTyping.wordCount, 0);
});
