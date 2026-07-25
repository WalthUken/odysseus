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
    // Burst / pause structure. People type in short bursts separated by
    // thinking pauses, and the shape of that alternation is personal in a way
    // the global downDown average erases: two people can share a key interval
    // of 190ms while one reaches it with long fast runs and rare long pauses
    // and the other with short runs and frequent short ones. Derived from
    // inter-keydown gaps alone, so no key identity is involved.
    //
    // Only these two of the family are emitted, and that is a measured choice.
    // Mean burst length is the reciprocal of pause frequency (bursts are
    // pauses + 1, as public/diagnostics.js counts them), so it carries no extra
    // information in a noisier, unbounded form. Burst-length spread, mean pause
    // duration, and the pause-to-burst timing ratio were all measured against
    // two synthetic typists and all three moved an impostor less than they
    // moved the genuine user - they are estimated from the handful of pauses in
    // a window, so their own noise exceeded their signal. Since the score is a
    // mean over features, shipping them lowered the catch rate rather than
    // raising it.
    "downDownPauseRatio",
    "downDownInBurstMean",
    // Key-class transition timing. Per-digraph latency is the most
    // discriminative keystroke signal known, so each of these reports how much
    // slower (positive) or faster (negative) one coarse class of transition
    // runs than the same person's own in-burst average. See KEY CLASS SCHEME.
    "downDownSameHandBias",
    "downDownAlternateHandBias",
    "downDownVowelConsonantBias",
    "downDownConsonantRunBias",
    "downDownWordBoundaryBias",
    "downDownSymbolBias",
  ]);

  // Gaps at or above this are treated as a thinking pause rather than part of a
  // burst. The value matches PAUSE_THRESHOLD_MS in public/diagnostics.js so the
  // identity features and the reported typing diagnostics describe the same
  // structure; burst count is likewise "pauses + 1", as diagnostics counts it.
  const PAUSE_THRESHOLD_MS = 500;
  // A gap this long is not a pause inside a typing session, it is the user
  // walking away, so it is not counted as either a pause or an in-burst gap.
  const IDLE_BREAK_MS = 60000;
  // Pseudo-observations pulling a class-pair estimate toward "no bias" when a
  // class was barely seen. Without it a class with two samples would emit noise
  // as though it were a stable personal trait.
  const CLASS_PRIOR_SAMPLES = 4;

  /* ================= KEY CLASS SCHEME (privacy boundary) =================
     The browser never sends key identities, keycodes, or raw key events, and
     that promise holds here. Each keydown is reduced *at collection time* to
     one of eight coarse classes; the key itself is discarded in the same
     statement that produced the class, is never stored, and never leaves
     classifyKey(). What the vector carries is six averages of inter-key gaps
     grouped by the class of the pair - an aggregate over a whole window, not a
     sequence, so it cannot be inverted into a key, a keycode, or typed text.

       0 OTHER            modifiers, navigation, function keys, IME output
       1 WHITESPACE       space, Enter, Tab (word and line boundaries)
       2 DIGIT            0-9
       3 SYMBOL           punctuation and other single-character keys
       4 LEFT_CONSONANT   q w r t s d f g z x c v b
       5 LEFT_VOWEL       a e
       6 RIGHT_CONSONANT  y p h j k l n m
       7 RIGHT_VOWEL      u i o

     Hands follow the QWERTY split; on another layout the split is still
     deterministic for that user, so it stays a stable personal trait. Twenty-six
     letters share four buckets, so a class carries about two bits and a pair
     carries about four - and even that is only ever released as a mean over
     many keystrokes.
     ====================================================================== */
  const KEY_CLASS = Object.freeze({
    OTHER: 0,
    WHITESPACE: 1,
    DIGIT: 2,
    SYMBOL: 3,
    LEFT_CONSONANT: 4,
    LEFT_VOWEL: 5,
    RIGHT_CONSONANT: 6,
    RIGHT_VOWEL: 7,
  });

  const LEFT_HAND_LETTERS = "qwertasdfgzxcvb";
  const VOWEL_LETTERS = "aeiou";
  const CLASS_PAIR_NAMES = Object.freeze([
    "sameHand",
    "alternateHand",
    "vowelConsonant",
    "consonantRun",
    "wordBoundary",
    "symbol",
  ]);

  function classifyKey(event) {
    const key = event && typeof event.key === "string" ? event.key : "";
    if (key === " " || key === "Spacebar" || key === "Enter" || key === "Tab") {
      return KEY_CLASS.WHITESPACE;
    }
    if (key.length !== 1) {
      // Named keys (Shift, Backspace, ArrowLeft, F5, Process, ...).
      return KEY_CLASS.OTHER;
    }
    if (key >= "0" && key <= "9") {
      return KEY_CLASS.DIGIT;
    }
    const lower = key.toLowerCase();
    if (lower < "a" || lower > "z" || lower.length !== 1) {
      // A letter outside the Latin alphabet says nothing about hands here, so
      // it is grouped with the unclassified keys rather than with punctuation.
      return /\p{L}/u.test(key) ? KEY_CLASS.OTHER : KEY_CLASS.SYMBOL;
    }
    const leftHand = LEFT_HAND_LETTERS.indexOf(lower) >= 0;
    const vowel = VOWEL_LETTERS.indexOf(lower) >= 0;
    if (leftHand) {
      return vowel ? KEY_CLASS.LEFT_VOWEL : KEY_CLASS.LEFT_CONSONANT;
    }
    return vowel ? KEY_CLASS.RIGHT_VOWEL : KEY_CLASS.RIGHT_CONSONANT;
  }

  function isLetterClass(value) {
    return value >= KEY_CLASS.LEFT_CONSONANT;
  }

  function isLeftHandClass(value) {
    return (
      value === KEY_CLASS.LEFT_CONSONANT || value === KEY_CLASS.LEFT_VOWEL
    );
  }

  function isVowelClass(value) {
    return value === KEY_CLASS.LEFT_VOWEL || value === KEY_CLASS.RIGHT_VOWEL;
  }

  function isConsonantClass(value) {
    return (
      value === KEY_CLASS.LEFT_CONSONANT || value === KEY_CLASS.RIGHT_CONSONANT
    );
  }

  function isSymbolClass(value) {
    return value === KEY_CLASS.DIGIT || value === KEY_CLASS.SYMBOL;
  }

  // Categories overlap on purpose: a left-hand "th" is both a same-hand pair
  // and a consonant run, and each aggregate answers a different question.
  function classPairCategories(previous, current) {
    const categories = [];
    if (isLetterClass(previous) && isLetterClass(current)) {
      categories.push(
        isLeftHandClass(previous) === isLeftHandClass(current)
          ? "sameHand"
          : "alternateHand"
      );
    }
    if (isVowelClass(previous) && isConsonantClass(current)) {
      categories.push("vowelConsonant");
    }
    if (isConsonantClass(previous) && isConsonantClass(current)) {
      categories.push("consonantRun");
    }
    if (
      previous === KEY_CLASS.WHITESPACE
      || current === KEY_CLASS.WHITESPACE
    ) {
      categories.push("wordBoundary");
    }
    if (isSymbolClass(previous) || isSymbolClass(current)) {
      categories.push("symbol");
    }
    return categories;
  }

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

  function createRhythmState() {
    const classPairs = {};
    CLASS_PAIR_NAMES.forEach((name) => {
      classPairs[name] = { count: 0, total: 0 };
    });
    return {
      pauseCount: 0,
      inBurstCount: 0,
      inBurstTotal: 0,
      classPairs,
      lastKeyClass: null,
    };
  }

  // Folds one keydown into the burst/pause structure and, when the gap belongs
  // inside a burst, into the class-pair aggregates. `gap` is null when no
  // previous keydown is comparable (window start, or after a visibility break).
  function recordRhythm(rhythm, gap, keyClass) {
    const continues = (
      typeof gap === "number"
      && Number.isFinite(gap)
      && gap >= 0
      && gap <= IDLE_BREAK_MS
    );

    if (!continues) {
      rhythm.lastKeyClass = keyClass;
      return;
    }

    if (gap >= PAUSE_THRESHOLD_MS) {
      rhythm.pauseCount += 1;
      rhythm.lastKeyClass = keyClass;
      return;
    }

    rhythm.inBurstCount += 1;
    rhythm.inBurstTotal += gap;

    // Class-pair timing is a motor measurement, so it is taken from in-burst
    // gaps only. Including thinking pauses would measure where someone stopped
    // to think, not which key combinations their hands stumble over.
    if (rhythm.lastKeyClass !== null) {
      const categories = classPairCategories(rhythm.lastKeyClass, keyClass);
      for (let index = 0; index < categories.length; index += 1) {
        const aggregate = rhythm.classPairs[categories[index]];
        aggregate.count += 1;
        aggregate.total += gap;
      }
    }
    rhythm.lastKeyClass = keyClass;
  }

  // Reported as a bias around zero rather than a ratio around one: a window
  // with no keystrokes at all then reports exactly zero, which the server reads
  // as "this feature carried no signal" instead of as a confident measurement.
  function classPairBias(aggregate, referenceMean) {
    if (
      !aggregate
      || aggregate.count === 0
      || !Number.isFinite(referenceMean)
      || referenceMean <= 0
    ) {
      return 0;
    }
    const observed = aggregate.total / aggregate.count / referenceMean;
    const shrunk = (
      ((observed * aggregate.count) + CLASS_PRIOR_SAMPLES)
      / (aggregate.count + CLASS_PRIOR_SAMPLES)
    );
    return shrunk - 1;
  }

  function summarizeRhythm(rhythm) {
    const intervalCount = rhythm.pauseCount + rhythm.inBurstCount;
    const inBurstMean = rhythm.inBurstCount > 0
      ? rhythm.inBurstTotal / rhythm.inBurstCount
      : 0;

    return {
      // How often the hands stop, and how fast they move when they are not
      // stopped. Together these are the burst structure that downDownMean,
      // which averages both regimes into one number, cannot express.
      pauseRatio: intervalCount > 0 ? rhythm.pauseCount / intervalCount : 0,
      inBurstMean,
      classPairBias: CLASS_PAIR_NAMES.map(
        (name) => classPairBias(rhythm.classPairs[name], inBurstMean)
      ),
    };
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
      // Burst structure and class-pair timing. Holds counters and one coarse
      // class code for the previous key, never a key, keycode, or character.
      this.keystrokeRhythm = createRhythmState();
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
        this.keystrokeRhythm.lastKeyClass = null;
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
        (typeof this.options.shouldCaptureKeyboard === "function" &&
          !this.options.shouldCaptureKeyboard(event))
      ) {
        return;
      }

      const timestamp = now();
      const limit = this.options.maximumMetricSamples;
      // The key is read here and discarded here: only the coarse class code
      // survives this statement, and only aggregates of it are ever emitted.
      const keyClass = classifyKey(event);

      recordRhythm(
        this.keystrokeRhythm,
        this.lastKeyDownAt === null ? null : timestamp - this.lastKeyDownAt,
        keyClass
      );

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
      const rhythm = summarizeRhythm(this.keystrokeRhythm);

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
        rhythm.pauseRatio,
        rhythm.inBurstMean,
        ...rhythm.classPairBias,
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
    KEY_CLASS,
    CLASS_PAIR_NAMES,
    PAUSE_THRESHOLD_MS,
    classifyKey,
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
