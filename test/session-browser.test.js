"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createObserver,
  displaySnapshot,
} = require("../public/session");

function eventTarget(values = {}) {
  const listeners = new Map();
  return {
    ...values,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((entry) => entry !== handler)
      );
    },
    dispatch(type) {
      (listeners.get(type) || []).forEach((handler) => handler());
    },
  };
}

function browserEnvironment() {
  const document = eventTarget({
    visibilityState: "visible",
    hasFocus: () => true,
  });
  return eventTarget({
    document,
    innerWidth: 1280.4,
    innerHeight: 720.6,
    outerWidth: 1400,
    outerHeight: 900,
    devicePixelRatio: 1.25,
    visualViewport: {
      width: 1024.2,
      height: 576.8,
      scale: 1.1,
    },
    screen: {
      width: 1920,
      height: 1080,
    },
    navigator: { userAgent: "must-not-appear" },
  });
}

test("collects bounded browser display indicators without raw identifiers", () => {
  const snapshot = displaySnapshot(browserEnvironment());

  assert.deepEqual(snapshot.layoutViewport, {
    widthPx: 1280,
    heightPx: 721,
  });
  assert.equal(snapshot.visualViewport.scale, 1.1);
  assert.equal(snapshot.scaleIndicators.devicePixelRatio, 1.25);
  assert.deepEqual(Object.keys(snapshot), [
    "layoutViewport",
    "visualViewport",
    "scaleIndicators",
    "screen",
  ]);
  assert.deepEqual(Object.keys(snapshot.screen), ["widthPx", "heightPx"]);

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("userAgent"), false);
  assert.equal(serialized.includes("clientX"), false);
  assert.equal(serialized.includes("keyCode"), false);
});

test("observer summarizes page activity and removes its listeners", () => {
  const environment = browserEnvironment();
  const observer = createObserver(environment);

  environment.dispatch("blur");
  environment.dispatch("focus");
  environment.dispatch("resize");
  environment.dispatch("orientationchange");
  environment.document.dispatch("visibilitychange");

  const snapshot = observer.snapshot();
  assert.equal(snapshot.pageSession.focusLosses, 1);
  assert.equal(snapshot.pageSession.focusReturns, 1);
  assert.equal(snapshot.pageSession.resizeEvents, 1);
  assert.equal(snapshot.pageSession.orientationChanges, 1);
  assert.equal(snapshot.pageSession.visibilityChanges, 1);
  assert.equal(snapshot.pageSession.focused, true);
  assert.match(snapshot.privacy.excluded, /No raw pointer coordinates/);

  observer.destroy();
  environment.dispatch("resize");
  assert.equal(observer.snapshot().pageSession.resizeEvents, 1);
});

test("clamps unreasonable display values and tolerates missing APIs", () => {
  const snapshot = displaySnapshot({
    innerWidth: 50000,
    innerHeight: Number.NaN,
    devicePixelRatio: 40,
    screen: {},
    navigator: {},
  });

  assert.equal(snapshot.layoutViewport.widthPx, 10000);
  assert.equal(snapshot.layoutViewport.heightPx, null);
  assert.equal(snapshot.scaleIndicators.devicePixelRatio, 10);
  assert.equal(snapshot.visualViewport.scale, null);
  assert.equal(snapshot.screen.widthPx, null);
});
