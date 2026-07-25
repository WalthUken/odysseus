(function (global) {
  "use strict";

  const FEATURE_NAMES = Object.freeze([
    "dwellMean",
    "dwellDeviation",
    "flightMean",
    "flightDeviation",
    "downDownMean",
    "downDownDeviation",
    "pointerVelocityMean",
    "pointerVelocityDeviation",
    "pointerAccelerationMean",
    "pointerAccelerationDeviation",
    "pointerJitterMean",
    "pointerJitterDeviation",
  ]);

  const DEFAULTS = Object.freeze({
    pointerThrottleMs: 80,
    minimumDwellSamples: 10,
    minimumFlightSamples: 8,
    minimumDownDownSamples: 8,
    minimumPointerSamples: 8,
    maximumMetricSamples: 240,
    requireTrustedEvents: true,
  });

  function now() {
    return global.performance && typeof global.performance.now === "function"
      ? global.performance.now()
      : Date.now();
  }

  function mean(values) {
    if (!values.length) {
      return 0;
    }
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  function meanAbsoluteDeviation(values, average) {
    if (!values.length) {
      return 0;
    }
    return (
      values.reduce((total, value) => total + Math.abs(value - average), 0) /
      values.length
    );
  }

  function summarize(values) {
    const average = mean(values);
    return [average, meanAbsoluteDeviation(values, average)];
  }

  function addBounded(values, value, limit) {
    if (!Number.isFinite(value)) {
      return;
    }
    values.push(value);
    if (values.length > limit) {
      values.splice(0, values.length - limit);
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function isTrustedInteraction(event) {
    return Boolean(event && event.isTrusted === true);
  }

  class BehaviorTelemetry {
    constructor(options) {
      const supplied = options || {};
      this.options = Object.assign({}, DEFAULTS, supplied);
      this.keyboardTarget = supplied.keyboardTarget || null;
      this.pointerTarget =
        supplied.pointerTarget || (global.document ? global.document : null);
      this.started = false;

      this.handleKeyDown = this.handleKeyDown.bind(this);
      this.handleKeyUp = this.handleKeyUp.bind(this);
      this.handlePointerMove = this.handlePointerMove.bind(this);
      this.handleVisibilityChange = this.handleVisibilityChange.bind(this);

      this.reset();
    }

    start() {
      if (this.started) {
        return this;
      }

      if (this.keyboardTarget) {
        this.keyboardTarget.addEventListener("keydown", this.handleKeyDown, {
          passive: true,
        });
        this.keyboardTarget.addEventListener("keyup", this.handleKeyUp, {
          passive: true,
        });
      }

      if (this.pointerTarget) {
        this.pointerTarget.addEventListener(
          "pointermove",
          this.handlePointerMove,
          { passive: true }
        );
        this.pointerTarget.addEventListener(
          "mousemove",
          this.handlePointerMove,
          { passive: true }
        );
      }

      if (global.document) {
        global.document.addEventListener(
          "visibilitychange",
          this.handleVisibilityChange,
          { passive: true }
        );
      }

      this.started = true;
      return this;
    }

    stop() {
      if (!this.started) {
        return this;
      }

      if (this.keyboardTarget) {
        this.keyboardTarget.removeEventListener(
          "keydown",
          this.handleKeyDown
        );
        this.keyboardTarget.removeEventListener("keyup", this.handleKeyUp);
      }

      if (this.pointerTarget) {
        this.pointerTarget.removeEventListener(
          "pointermove",
          this.handlePointerMove
        );
        this.pointerTarget.removeEventListener(
          "mousemove",
          this.handlePointerMove
        );
      }

      if (global.document) {
        global.document.removeEventListener(
          "visibilitychange",
          this.handleVisibilityChange
        );
      }

      this.started = false;
      return this;
    }

    destroy() {
      this.stop();
      this.reset();
    }

    reset() {
      this.metrics = {
        dwell: [],
        flight: [],
        downDown: [],
        pointerVelocity: [],
        pointerAcceleration: [],
        pointerJitter: [],
      };

      // Anonymous press records pair timing events without reading keys.
      this.activePresses = [];
      this.lastKeyDownAt = null;
      this.lastKeyUpAt = null;
      this.lastPointer = null;
      this.lastPointerVelocity = null;
      this.lastPointerAngle = null;
      this.rejectedSyntheticEvents = 0;
      this.windowStartedAt = now();
      return this;
    }

    acceptsInteraction(event) {
      if (
        this.options.requireTrustedEvents === false ||
        isTrustedInteraction(event)
      ) {
        return true;
      }
      this.rejectedSyntheticEvents += 1;
      return false;
    }

    eventIntegrity() {
      return Object.freeze({
        trustedEventsRequired: this.options.requireTrustedEvents !== false,
        rejectedSyntheticEvents: this.rejectedSyntheticEvents,
      });
    }

    handleVisibilityChange() {
      if (global.document && global.document.hidden) {
        this.activePresses.length = 0;
        this.lastKeyDownAt = null;
        this.lastKeyUpAt = null;
        this.lastPointer = null;
        this.lastPointerVelocity = null;
        this.lastPointerAngle = null;
      }
    }

    handleKeyDown(event) {
      if (
        !this.acceptsInteraction(event) ||
        event.repeat ||
        event.isComposing ||
        (typeof this.options.shouldCaptureKeyboard === "function" &&
          !this.options.shouldCaptureKeyboard(event))
      ) {
        return;
      }

      const timestamp = now();
      const limit = this.options.maximumMetricSamples;

      if (this.lastKeyDownAt !== null) {
        const downDown = timestamp - this.lastKeyDownAt;
        if (downDown >= 5 && downDown <= 5000) {
          addBounded(this.metrics.downDown, downDown, limit);
        }
      }

      if (this.lastKeyUpAt !== null) {
        const flight = timestamp - this.lastKeyUpAt;
        if (flight >= -1000 && flight <= 5000) {
          addBounded(this.metrics.flight, flight, limit);
        }
      }

      this.activePresses.push({ downAt: timestamp });
      if (this.activePresses.length > 12) {
        this.activePresses.shift();
      }
      this.lastKeyDownAt = timestamp;
    }

    handleKeyUp(event) {
      if (
        !this.acceptsInteraction(event) ||
        event.isComposing ||
        (typeof this.options.shouldCaptureKeyboard === "function" &&
          !this.options.shouldCaptureKeyboard(event))
      ) {
        return;
      }

      const timestamp = now();
      const press = this.activePresses.shift();
      if (press) {
        const dwell = timestamp - press.downAt;
        if (dwell >= 5 && dwell <= 5000) {
          addBounded(
            this.metrics.dwell,
            dwell,
            this.options.maximumMetricSamples
          );
        }
      }
      this.lastKeyUpAt = timestamp;
    }

    handlePointerMove(event) {
      if (!this.acceptsInteraction(event)) {
        return;
      }
      const timestamp = now();
      if (
        this.lastPointer &&
        timestamp - this.lastPointer.timestamp < this.options.pointerThrottleMs
      ) {
        return;
      }

      const current = {
        x: Number(event.clientX),
        y: Number(event.clientY),
        timestamp,
      };

      if (
        !Number.isFinite(current.x) ||
        !Number.isFinite(current.y) ||
        !this.lastPointer
      ) {
        this.lastPointer = current;
        return;
      }

      const elapsedMs = timestamp - this.lastPointer.timestamp;
      if (elapsedMs <= 0 || elapsedMs > 3000) {
        this.lastPointer = current;
        this.lastPointerVelocity = null;
        this.lastPointerAngle = null;
        return;
      }

      const dx = current.x - this.lastPointer.x;
      const dy = current.y - this.lastPointer.y;
      const distance = Math.hypot(dx, dy);
      const elapsedSeconds = elapsedMs / 1000;
      const velocity = distance / elapsedSeconds;
      const angle = distance > 0 ? Math.atan2(dy, dx) : this.lastPointerAngle;
      const limit = this.options.maximumMetricSamples;

      if (velocity <= 100000) {
        addBounded(this.metrics.pointerVelocity, velocity, limit);
      }

      if (this.lastPointerVelocity !== null) {
        const acceleration =
          Math.abs(velocity - this.lastPointerVelocity) / elapsedSeconds;
        if (acceleration <= 1000000) {
          addBounded(this.metrics.pointerAcceleration, acceleration, limit);
        }
      }

      if (angle !== null && this.lastPointerAngle !== null && distance > 0) {
        let angleChange = Math.abs(angle - this.lastPointerAngle);
        if (angleChange > Math.PI) {
          angleChange = 2 * Math.PI - angleChange;
        }
        addBounded(
          this.metrics.pointerJitter,
          clamp(angleChange / Math.PI, 0, 1),
          limit
        );
      }

      this.lastPointer = current;
      this.lastPointerVelocity = velocity;
      if (angle !== null) {
        this.lastPointerAngle = angle;
      }
    }

    sampleCounts() {
      return Object.freeze({
        dwell: this.metrics.dwell.length,
        flight: this.metrics.flight.length,
        downDown: this.metrics.downDown.length,
        pointer: this.metrics.pointerVelocity.length,
      });
    }

    readiness() {
      const counts = this.sampleCounts();
      const missing = [];

      if (counts.dwell < this.options.minimumDwellSamples) {
        missing.push(
          `${this.options.minimumDwellSamples - counts.dwell} more keystrokes`
        );
      }
      if (counts.flight < this.options.minimumFlightSamples) {
        missing.push(
          `${
            this.options.minimumFlightSamples - counts.flight
          } more flight timings`
        );
      }
      if (counts.downDown < this.options.minimumDownDownSamples) {
        missing.push(
          `${
            this.options.minimumDownDownSamples - counts.downDown
          } more key intervals`
        );
      }
      if (counts.pointer < this.options.minimumPointerSamples) {
        missing.push(
          `${
            this.options.minimumPointerSamples - counts.pointer
          } more pointer movements`
        );
      }

      return Object.freeze({
        ready: missing.length === 0,
        counts,
        missing,
        integrity: this.eventIntegrity(),
      });
    }

    finalize(options) {
      const supplied = options || {};
      const readiness = this.readiness();
      if (!readiness.ready) {
        return Object.freeze({
          ok: false,
          reason: `Keep interacting: ${readiness.missing.join(", ")}.`,
          counts: readiness.counts,
        });
      }

      const dwell = summarize(this.metrics.dwell);
      const flight = summarize(this.metrics.flight);
      const downDown = summarize(this.metrics.downDown);
      const pointerVelocity = summarize(this.metrics.pointerVelocity);
      const pointerAcceleration = summarize(this.metrics.pointerAcceleration);
      const pointerJitter = summarize(this.metrics.pointerJitter);

      const featureValues = [
        dwell[0],
        dwell[1],
        flight[0],
        flight[1],
        downDown[0],
        downDown[1],
        pointerVelocity[0],
        pointerVelocity[1],
        pointerAcceleration[0],
        pointerAcceleration[1],
        pointerJitter[0],
        pointerJitter[1],
      ].map((value) => Number(value.toFixed(6)));

      const vector = {};
      FEATURE_NAMES.forEach((name, index) => {
        vector[name] = featureValues[index];
      });

      Object.freeze(vector);
      const result = Object.freeze({
        ok: true,
        vector,
        counts: readiness.counts,
        integrity: readiness.integrity,
        durationMs: Math.round(now() - this.windowStartedAt),
      });

      if (supplied.reset !== false) {
        this.reset();
      }
      return result;
    }
  }

  const api = Object.freeze({
    BehaviorTelemetry,
    FEATURE_NAMES,
    DEFAULTS,
    isTrustedInteraction,
    createCollector(options) {
      return new BehaviorTelemetry(options);
    },
  });

  global.OdysseusTelemetry = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
