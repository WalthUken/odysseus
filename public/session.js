(function (global) {
  "use strict";

  const MAX_DIMENSION = 10000;
  const MAX_SCALE = 10;

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
    const startedAt = Date.now();
    const activity = {
      focusLosses: 0,
      focusReturns: 0,
      visibilityChanges: 0,
      resizeEvents: 0,
      orientationChanges: 0,
    };
    const listeners = [];

    function listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== "function") {
        return;
      }
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    }

    listen(scope, "blur", () => {
      activity.focusLosses += 1;
    });
    listen(scope, "focus", () => {
      activity.focusReturns += 1;
    });
    listen(scope, "resize", () => {
      activity.resizeEvents += 1;
    });
    listen(scope, "orientationchange", () => {
      activity.orientationChanges += 1;
    });
    listen(documentValue, "visibilitychange", () => {
      activity.visibilityChanges += 1;
    });

    return Object.freeze({
      snapshot() {
        return Object.freeze({
          capturedAt: new Date().toISOString(),
          pageSession: Object.freeze({
            elapsedMs: Math.max(0, Date.now() - startedAt),
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
          display: displaySnapshot(scope),
          privacy: Object.freeze({
            location:
              "This display and activity snapshot stays in the browser and is added only to the authenticated on-screen report.",
            excluded:
              "No raw pointer coordinates, key identities, typed text, user agent string, persistent visitor identifier, cookie, or token is included.",
          }),
        });
      },
      destroy() {
        listeners.forEach(([target, type, handler]) => {
          target.removeEventListener(type, handler);
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
