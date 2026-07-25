(function (global) {
  "use strict";

  const MAX_DIMENSION = 10000;
  const MAX_SCALE = 10;
  const MAX_DELAY_MS = 60_000;

  function boundedNumber(value, minimum, maximum, places = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const bounded = Math.max(minimum, Math.min(maximum, numeric));
    const factor = 10 ** places;
    return Math.round(bounded * factor) / factor;
  }

  function displaySnapshot(environment) {
    const scope = environment || global;
    const viewport = scope.visualViewport || {};
    const screenValue = scope.screen || {};

    return Object.freeze({
      layoutViewport: Object.freeze({
        widthPx: boundedNumber(scope.innerWidth, 1, MAX_DIMENSION),
        heightPx: boundedNumber(scope.innerHeight, 1, MAX_DIMENSION),
      }),
      visualViewport: Object.freeze({
        widthPx: boundedNumber(viewport.width, 1, MAX_DIMENSION),
        heightPx: boundedNumber(viewport.height, 1, MAX_DIMENSION),
        scale: boundedNumber(viewport.scale, 0.1, MAX_SCALE, 3),
      }),
      scaleIndicators: Object.freeze({
        devicePixelRatio: boundedNumber(
          scope.devicePixelRatio,
          0.1,
          MAX_SCALE,
          3
        ),
        note:
          "Browser zoom is not exposed reliably. Visual viewport scale and device pixel ratio are indicators, not an exact zoom setting.",
      }),
      screen: Object.freeze({
        widthPx: boundedNumber(screenValue.width, 1, MAX_DIMENSION),
        heightPx: boundedNumber(screenValue.height, 1, MAX_DIMENSION),
      }),
    });
  }

  function createObserver(environment) {
    const scope = environment || global;
    const documentValue = scope.document;
    const visualViewport = scope.visualViewport;
    const startedAt = Date.now();
    const activity = {
      focusLosses: 0,
      focusReturns: 0,
      visibilityChanges: 0,
      resizeEvents: 0,
      orientationChanges: 0,
      keyboard: {
        keyDownEvents: 0,
        keyUpEvents: 0,
        repeatedKeyEvents: 0,
        inputEvents: 0,
        correctionEvents: 0,
        deletionEvents: 0,
        undoEvents: 0,
      },
      pointer: {
        moveEvents: 0,
        distancePx: 0,
        pointerDownEvents: 0,
        pointerUpEvents: 0,
        clickEvents: 0,
        doubleClickEvents: 0,
        contextMenuEvents: 0,
      },
      scrolling: {
        wheelEvents: 0,
        scrollEvents: 0,
        distancePx: 0,
      },
      delays: [],
      lastInteractionAt: null,
      lastPointer: null,
      lastScroll: null,
      inputLengths: new WeakMap(),
      zoomChanges: 0,
      scales: [],
      currentView: "unknown",
      viewStartedAt: startedAt,
      viewDurations: new Map(),
    };
    const listeners = [];

    function listen(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== "function") {
        return;
      }
      target.addEventListener(type, handler, options);
      listeners.push([target, type, handler, options]);
    }

    function recordInteraction() {
      const timestamp = Date.now();
      if (activity.lastInteractionAt !== null) {
        const delay = timestamp - activity.lastInteractionAt;
        if (delay >= 0 && delay <= MAX_DELAY_MS) {
          activity.delays.push(delay);
          if (activity.delays.length > 500) {
            activity.delays.shift();
          }
        }
      }
      activity.lastInteractionAt = timestamp;
    }

    function isPasswordInteraction(event) {
      const target = event && event.target;
      return Boolean(
        target &&
        typeof target === "object" &&
        String(target.type || "").toLocaleLowerCase() === "password"
      );
    }

    function scaleSample() {
      return {
        visual: boundedNumber(
          visualViewport && visualViewport.scale,
          0.1,
          MAX_SCALE,
          3
        ),
        pixelRatio: boundedNumber(
          scope.devicePixelRatio,
          0.1,
          MAX_SCALE,
          3
        ),
      };
    }

    function recordScale() {
      const sample = scaleSample();
      const previous = activity.scales[activity.scales.length - 1];
      if (
        previous &&
        (previous.visual !== sample.visual ||
          previous.pixelRatio !== sample.pixelRatio)
      ) {
        activity.zoomChanges += 1;
      }
      if (
        !previous ||
        previous.visual !== sample.visual ||
        previous.pixelRatio !== sample.pixelRatio
      ) {
        activity.scales.push(sample);
        if (activity.scales.length > 60) {
          activity.scales.shift();
        }
      }
    }

    function finishView(timestamp) {
      const finishedAt = Number(timestamp) || Date.now();
      const duration = Math.max(0, finishedAt - activity.viewStartedAt);
      activity.viewDurations.set(
        activity.currentView,
        (activity.viewDurations.get(activity.currentView) || 0) + duration
      );
      activity.viewStartedAt = finishedAt;
    }

    function delaySummary() {
      if (!activity.delays.length) {
        return {
          sampleCount: 0,
          averageMs: 0,
          deviationMs: 0,
          longestMs: 0,
        };
      }
      const average =
        activity.delays.reduce((sum, value) => sum + value, 0) /
        activity.delays.length;
      const deviation =
        activity.delays.reduce(
          (sum, value) => sum + Math.abs(value - average),
          0
        ) / activity.delays.length;
      return {
        sampleCount: activity.delays.length,
        averageMs: Math.round(average),
        deviationMs: Math.round(deviation),
        longestMs: Math.round(Math.max(...activity.delays)),
      };
    }

    recordScale();
    listen(scope, "blur", () => {
      activity.focusLosses += 1;
    });
    listen(scope, "focus", () => {
      activity.focusReturns += 1;
    });
    listen(scope, "resize", () => {
      activity.resizeEvents += 1;
      recordScale();
    });
    listen(scope, "orientationchange", () => {
      activity.orientationChanges += 1;
      recordScale();
    });
    listen(visualViewport, "resize", recordScale);
    listen(documentValue, "visibilitychange", () => {
      activity.visibilityChanges += 1;
    });
    listen(
      documentValue,
      "keydown",
      (event) => {
        if (isPasswordInteraction(event)) {
          return;
        }
        activity.keyboard.keyDownEvents += 1;
        if (event && event.repeat) {
          activity.keyboard.repeatedKeyEvents += 1;
        }
        recordInteraction();
      },
      { passive: true }
    );
    listen(
      documentValue,
      "keyup",
      (event) => {
        if (isPasswordInteraction(event)) {
          return;
        }
        activity.keyboard.keyUpEvents += 1;
      },
      { passive: true }
    );
    listen(
      documentValue,
      "input",
      (event) => {
        if (isPasswordInteraction(event)) {
          return;
        }
        activity.keyboard.inputEvents += 1;
        const inputType =
          event && typeof event.inputType === "string"
            ? event.inputType
            : "";
        if (inputType.startsWith("delete")) {
          activity.keyboard.deletionEvents += 1;
          activity.keyboard.correctionEvents += 1;
        } else if (inputType === "historyUndo") {
          activity.keyboard.undoEvents += 1;
          activity.keyboard.correctionEvents += 1;
        } else if (
          inputType === "insertReplacementText" ||
          inputType === "historyRedo"
        ) {
          activity.keyboard.correctionEvents += 1;
        }
        const target = event && event.target;
        if (
          target &&
          typeof target === "object" &&
          typeof target.value === "string"
        ) {
          const length = Array.from(target.value).length;
          const previousLength = activity.inputLengths.get(target);
          if (
            Number.isSafeInteger(previousLength) &&
            length < previousLength &&
            inputType === ""
          ) {
            activity.keyboard.correctionEvents += 1;
          }
          activity.inputLengths.set(target, length);
        }
      },
      { passive: true }
    );
    listen(
      documentValue,
      "pointermove",
      (event) => {
        const x = Number(event && event.clientX);
        const y = Number(event && event.clientY);
        activity.pointer.moveEvents += 1;
        if (
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          activity.lastPointer
        ) {
          activity.pointer.distancePx += Math.hypot(
            x - activity.lastPointer.x,
            y - activity.lastPointer.y
          );
        }
        if (Number.isFinite(x) && Number.isFinite(y)) {
          activity.lastPointer = { x, y };
        }
        recordInteraction();
      },
      { passive: true }
    );
    listen(
      documentValue,
      "pointerdown",
      () => {
        activity.pointer.pointerDownEvents += 1;
        recordInteraction();
      },
      { passive: true }
    );
    listen(
      documentValue,
      "pointerup",
      () => {
        activity.pointer.pointerUpEvents += 1;
      },
      { passive: true }
    );
    listen(
      documentValue,
      "click",
      () => {
        activity.pointer.clickEvents += 1;
        recordInteraction();
      },
      { passive: true }
    );
    listen(
      documentValue,
      "dblclick",
      () => {
        activity.pointer.doubleClickEvents += 1;
      },
      { passive: true }
    );
    listen(
      documentValue,
      "contextmenu",
      () => {
        activity.pointer.contextMenuEvents += 1;
      },
      { passive: true }
    );
    listen(
      documentValue,
      "wheel",
      () => {
        activity.scrolling.wheelEvents += 1;
        recordInteraction();
      },
      { passive: true }
    );
    listen(
      scope,
      "scroll",
      () => {
        const position = {
          x: Number(scope.scrollX) || 0,
          y: Number(scope.scrollY) || 0,
        };
        activity.scrolling.scrollEvents += 1;
        if (activity.lastScroll) {
          activity.scrolling.distancePx += Math.hypot(
            position.x - activity.lastScroll.x,
            position.y - activity.lastScroll.y
          );
        }
        activity.lastScroll = position;
      },
      { passive: true }
    );

    return Object.freeze({
      setView(viewName) {
        const nextView = String(viewName || "unknown")
          .trim()
          .slice(0, 40);
        if (!nextView || nextView === activity.currentView) {
          return;
        }
        const timestamp = Date.now();
        finishView(timestamp);
        activity.currentView = nextView;
        activity.viewStartedAt = timestamp;
      },
      snapshot() {
        const timestamp = Date.now();
        const viewDurations = new Map(activity.viewDurations);
        viewDurations.set(
          activity.currentView,
          (viewDurations.get(activity.currentView) || 0) +
            Math.max(0, timestamp - activity.viewStartedAt)
        );
        const visualScales = activity.scales
          .map((sample) => sample.visual)
          .filter(Number.isFinite);
        const pixelRatios = activity.scales
          .map((sample) => sample.pixelRatio)
          .filter(Number.isFinite);
        return Object.freeze({
          capturedAt: new Date(timestamp).toISOString(),
          pageSession: Object.freeze({
            elapsedMs: Math.max(0, timestamp - startedAt),
            focusLosses: activity.focusLosses,
            focusReturns: activity.focusReturns,
            visibilityChanges: activity.visibilityChanges,
            resizeEvents: activity.resizeEvents,
            orientationChanges: activity.orientationChanges,
            visibilityState:
              documentValue &&
              typeof documentValue.visibilityState === "string"
                ? documentValue.visibilityState
                : "Unavailable",
            focused:
              documentValue &&
              typeof documentValue.hasFocus === "function"
                ? Boolean(documentValue.hasFocus())
                : null,
          }),
          interaction: Object.freeze({
            keyboard: Object.freeze({ ...activity.keyboard }),
            pointer: Object.freeze({
              ...activity.pointer,
              distancePx: Math.round(activity.pointer.distancePx),
            }),
            scrolling: Object.freeze({
              ...activity.scrolling,
              distancePx: Math.round(activity.scrolling.distancePx),
            }),
            delays: Object.freeze(delaySummary()),
            viewTiming: Object.freeze(
              Array.from(viewDurations, ([view, durationMs]) =>
                Object.freeze({
                  view,
                  durationMs: Math.round(durationMs),
                })
              )
            ),
          }),
          zoom: Object.freeze({
            changeEvents: activity.zoomChanges,
            visualScaleMinimum: visualScales.length
              ? Math.min(...visualScales)
              : null,
            visualScaleMaximum: visualScales.length
              ? Math.max(...visualScales)
              : null,
            devicePixelRatioMinimum: pixelRatios.length
              ? Math.min(...pixelRatios)
              : null,
            devicePixelRatioMaximum: pixelRatios.length
              ? Math.max(...pixelRatios)
              : null,
            interpretation:
              "These are browser scale indicators. Browsers do not expose one reliable exact zoom value.",
          }),
          display: displaySnapshot(scope),
          privacy: Object.freeze({
            location:
              "This aggregate display and interaction snapshot is added to the authenticated report and safe verification evidence.",
            excluded:
              "No raw pointer coordinates, key identities, typed text, user agent string, persistent visitor identifier, cookie, or token is included.",
          }),
        });
      },
      destroy() {
        finishView(Date.now());
        listeners.forEach(([target, type, handler, options]) => {
          target.removeEventListener(type, handler, options);
        });
        listeners.length = 0;
      },
    });
  }

  const api = Object.freeze({
    boundedNumber,
    createObserver,
    displaySnapshot,
  });

  global.OdysseusSession = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
