"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BehaviorTelemetry,
  isTrustedInteraction,
} = require("../public/telemetry");

test("rejects script-dispatched interaction events by default", () => {
  const collector = new BehaviorTelemetry({
    keyboardTarget: null,
    pointerTarget: null,
  });
  const syntheticKey = {
    isTrusted: false,
    repeat: false,
    isComposing: false,
  };
  const syntheticPointer = {
    isTrusted: false,
    clientX: 20,
    clientY: 30,
  };

  collector.handleKeyDown(syntheticKey);
  collector.handleKeyUp(syntheticKey);
  collector.handlePointerMove(syntheticPointer);

  assert.equal(collector.lastKeyDownAt, null);
  assert.equal(collector.lastPointer, null);
  assert.deepEqual(collector.sampleCounts(), {
    dwell: 0,
    flight: 0,
    downDown: 0,
    pointer: 0,
  });
  assert.equal(collector.eventIntegrity().rejectedSyntheticEvents, 3);
  assert.equal(isTrustedInteraction(syntheticKey), false);
});

test("accepts user-agent interaction events", () => {
  const collector = new BehaviorTelemetry({
    keyboardTarget: null,
    pointerTarget: null,
  });
  const trustedKey = {
    isTrusted: true,
    repeat: false,
    isComposing: false,
  };
  const trustedPointer = {
    isTrusted: true,
    clientX: 20,
    clientY: 30,
  };

  collector.handleKeyDown(trustedKey);
  collector.handlePointerMove(trustedPointer);

  assert.notEqual(collector.lastKeyDownAt, null);
  assert.deepEqual(collector.lastPointer.x, 20);
  assert.equal(collector.eventIntegrity().rejectedSyntheticEvents, 0);
  assert.equal(isTrustedInteraction(trustedPointer), true);
});
