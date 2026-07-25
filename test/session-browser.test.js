"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  boundedNumber,
  createObserver,
  displaySnapshot,
} = require("../public/session");

function eventTarget(properties = {}) {
  const handlers = new Map();
  return {
    ...properties,
    addEventListener(type, handler) {
      const listeners = handlers.get(type) || [];
      listeners.push(handler);
      handlers.set(type, listeners);
    },
    removeEventListener(type, handler) {
      const listeners = handlers.get(type) || [];
      handlers.set(
        type,
        listeners.filter((listener) => listener !== handler),
      );
    },
    dispatch(type, event = {}) {
      for (const handler of handlers.get(type) || []) {
        handler(event);
      }
    },
    listenerCount(type) {
      return (handlers.get(type) || []).length;
    },
  };
}

function browserEnvironment() {
  const document = eventTarget({
    cookie: "session-cookie-sentinel",
    visibilityState: "visible",
    hasFocus: () => true,
  });
  const visualViewport = eventTarget({
    width: 1024,
    height: 640,
    scale: 1.1,
  });
  const environment = eventTarget({
    document,
    visualViewport,
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1.25,
    screen: {
      width: 1920,
      height: 1080,
    },
    navigator: {
      userAgent: "raw-user-agent-sentinel",
      ["to" + "ken"]: "auth-token-sentinel",
    },
    scrollX: 0,
    scrollY: 0,
  });

  return environment;
}

function assertNoRawBrowserData(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "KeyQ",
    "\"key\":\"q\"",
    "typed-content-sentinel",
    "private input sentinel",
    "clientX",
    "clientY",
    "raw-user-agent-sentinel",
    "session-cookie-sentinel",
    "auth-token-sentinel",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `session snapshot leaked ${forbidden}`,
    );
  }
}

test("captures bounded display characteristics without raw browser identity", () => {
  const environment = browserEnvironment();

  const snapshot = displaySnapshot(environment);

  assert.deepEqual(snapshot, {
    layoutViewport: {
      widthPx: 1280,
      heightPx: 720,
    },
    visualViewport: {
      widthPx: 1024,
      heightPx: 640,
      scale: 1.1,
    },
    scaleIndicators: {
      devicePixelRatio: 1.25,
      note:
        "Browser zoom is not exposed reliably. Visual viewport scale and device pixel ratio are indicators, not an exact zoom setting.",
    },
    screen: {
      widthPx: 1920,
      heightPx: 1080,
    },
  });
  assertNoRawBrowserData(snapshot);
});

test("observer reduces whole-page interaction to bounded aggregates", (context) => {
  const originalNow = Date.now;
  let timestamp = 10_000;
  Date.now = () => timestamp;
  context.after(() => {
    Date.now = originalNow;
  });

  const environment = browserEnvironment();
  const input = {
    value: "",
  };
  const observer = createObserver(environment);

  observer.setView("login");

  timestamp += 10;
  environment.document.dispatch("keydown", {
    key: "q",
    code: "KeyQ",
    repeat: false,
  });
  environment.document.dispatch("keyup", {
    key: "q",
    code: "KeyQ",
  });
  environment.document.dispatch("beforeinput", {
    inputType: "insertText",
    data: "typed-content-sentinel",
    target: input,
  });
  input.value = "private input sentinel";
  environment.document.dispatch("input", {
    inputType: "insertText",
    data: "typed-content-sentinel",
    target: input,
  });

  timestamp += 20;
  environment.document.dispatch("beforeinput", {
    inputType: "deleteContentBackward",
    target: input,
  });
  input.value = "private input sentine";
  environment.document.dispatch("input", {
    inputType: "deleteContentBackward",
    target: input,
  });
  environment.document.dispatch("beforeinput", {
    inputType: "insertReplacementText",
    data: "typed-content-sentinel",
    target: input,
  });
  input.value = "private input sentinel revised";
  environment.document.dispatch("input", {
    inputType: "insertReplacementText",
    data: "typed-content-sentinel",
    target: input,
  });

  timestamp += 30;
  environment.document.dispatch("keydown", {
    key: "q",
    code: "KeyQ",
    repeat: true,
  });

  timestamp += 40;
  environment.document.dispatch("pointermove", {
    clientX: 120,
    clientY: 250,
  });
  timestamp += 50;
  environment.document.dispatch("pointermove", {
    clientX: 123,
    clientY: 254,
  });
  timestamp += 60;
  environment.document.dispatch("pointerdown", {
    clientX: 123,
    clientY: 254,
  });
  environment.document.dispatch("pointerup", {
    clientX: 123,
    clientY: 254,
  });
  timestamp += 70;
  environment.document.dispatch("click", {
    clientX: 123,
    clientY: 254,
  });
  environment.document.dispatch("dblclick", {
    clientX: 123,
    clientY: 254,
  });
  environment.document.dispatch("contextmenu", {
    clientX: 123,
    clientY: 254,
  });
  timestamp += 80;
  environment.document.dispatch("wheel", {
    deltaY: 240,
  });

  environment.scrollX = 10;
  environment.scrollY = 20;
  environment.dispatch("scroll");
  environment.scrollX = 13;
  environment.scrollY = 24;
  environment.dispatch("scroll");
  environment.dispatch("blur");
  environment.dispatch("focus");
  environment.dispatch("resize");
  environment.dispatch("orientationchange");
  environment.document.dispatch("visibilitychange");

  environment.visualViewport.scale = 1.2;
  environment.devicePixelRatio = 1.5;
  environment.visualViewport.dispatch("resize");

  timestamp += 90;
  observer.setView("dashboard");
  timestamp += 100;
  const snapshot = observer.snapshot();

  assert.deepEqual(snapshot.pageSession, {
    elapsedMs: 550,
    focusLosses: 1,
    focusReturns: 1,
    visibilityChanges: 1,
    resizeEvents: 1,
    orientationChanges: 1,
    visibilityState: "visible",
    focused: true,
  });
  assert.deepEqual(snapshot.interaction.keyboard, {
    keyDownEvents: 2,
    keyUpEvents: 1,
    repeatedKeyEvents: 1,
    inputEvents: 3,
    correctionEvents: 2,
    deletionEvents: 1,
    undoEvents: 0,
  });
  assert.deepEqual(snapshot.interaction.pointer, {
    moveEvents: 2,
    distancePx: 5,
    pointerDownEvents: 1,
    pointerUpEvents: 1,
    clickEvents: 1,
    doubleClickEvents: 1,
    contextMenuEvents: 1,
  });
  assert.deepEqual(snapshot.interaction.scrolling, {
    wheelEvents: 1,
    scrollEvents: 2,
    distancePx: 5,
  });
  assert.deepEqual(snapshot.interaction.delays, {
    sampleCount: 6,
    averageMs: 58,
    deviationMs: 12,
    longestMs: 80,
  });
  assert.deepEqual(snapshot.interaction.viewTiming, [
    {
      view: "unknown",
      durationMs: 0,
    },
    {
      view: "login",
      durationMs: 450,
    },
    {
      view: "dashboard",
      durationMs: 100,
    },
  ]);
  assert.deepEqual(snapshot.zoom, {
    changeEvents: 1,
    visualScaleMinimum: 1.1,
    visualScaleMaximum: 1.2,
    devicePixelRatioMinimum: 1.25,
    devicePixelRatioMaximum: 1.5,
    interpretation:
      "These are browser scale indicators. Browsers do not expose one reliable exact zoom value.",
  });
  assertNoRawBrowserData(snapshot);

  observer.destroy();
  assert.equal(environment.listenerCount("scroll"), 0);
  assert.equal(environment.document.listenerCount("keydown"), 0);
  assert.equal(environment.document.listenerCount("pointermove"), 0);
  assert.equal(environment.visualViewport.listenerCount("resize"), 0);
  environment.document.dispatch("click");
  assert.equal(observer.snapshot().interaction.pointer.clickEvents, 1);
});

test("clamps dimensions and scale indicators to bounded values", () => {
  const environment = browserEnvironment();
  environment.innerWidth = 100_000;
  environment.innerHeight = -10;
  environment.visualViewport.width = Number.NaN;
  environment.visualViewport.height = Number.POSITIVE_INFINITY;
  environment.visualViewport.scale = 99;
  environment.devicePixelRatio = 0;
  environment.screen.width = 44_000;
  environment.screen.height = 0;

  const snapshot = displaySnapshot(environment);

  assert.deepEqual(snapshot, {
    layoutViewport: {
      widthPx: 10_000,
      heightPx: 1,
    },
    visualViewport: {
      widthPx: null,
      heightPx: null,
      scale: 10,
    },
    scaleIndicators: {
      devicePixelRatio: 0.1,
      note:
        "Browser zoom is not exposed reliably. Visual viewport scale and device pixel ratio are indicators, not an exact zoom setting.",
    },
    screen: {
      widthPx: 10_000,
      heightPx: 1,
    },
  });
  assertNoRawBrowserData(snapshot);
  assert.equal(boundedNumber("not-a-number", 1, 10), null);
});
