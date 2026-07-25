(function (global) {
  "use strict";

  const PAUSE_THRESHOLD_MS = 500;
  const MAX_INPUT_EVENTS = 600;

  function defaultNow() {
    return global.performance && typeof global.performance.now === "function"
      ? global.performance.now()
      : Date.now();
  }

  function round(value, places = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    const factor = 10 ** places;
    return Math.round((numeric + Number.EPSILON) * factor) / factor;
  }

  function normalizedWordLengths(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      return [];
    }
    return normalized
      .split(" ")
      .slice(0, 40)
      .map((word) => Array.from(word).length);
  }

  function createFieldState() {
    return {
      startedAt: null,
      lastAt: null,
      events: [],
    };
  }

  function summarizeField(field) {
    if (!field.events.length) {
      return {
        durationMs: 0,
        wordCount: 0,
        words: [],
      };
    }

    const latest = field.events[field.events.length - 1];
    const words = latest.wordLengths.map((characterCount, wordIndex) => {
      const firstEvent = field.events.find(
        (event) => event.wordLengths.length >= wordIndex + 1
      );
      const nextWordEvent = field.events.find(
        (event) =>
          event.at >= firstEvent.at &&
          event.wordLengths.length >= wordIndex + 2
      );
      const finishedAt = nextWordEvent ? nextWordEvent.at : field.lastAt;
      return {
        index: wordIndex + 1,
        characterCount,
        durationMs: Math.max(0, Math.round(finishedAt - firstEvent.at)),
      };
    });

    return {
      durationMs: Math.max(0, Math.round(field.lastAt - field.startedAt)),
      wordCount: words.length,
      words,
    };
  }

  class TypingDiagnostic {
    constructor(options) {
      const supplied = options || {};
      this.now =
        typeof supplied.now === "function" ? supplied.now : defaultNow;
      this.reset();
    }

    reset() {
      this.fields = {
        guided: createFieldState(),
        free: createFieldState(),
      };
      this.inputEventTimes = [];
      return this;
    }

    record(kind, value) {
      if (!Object.hasOwn(this.fields, kind)) {
        throw new TypeError("Typing diagnostic kind must be guided or free");
      }
      const timestamp = Number(this.now());
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("Typing diagnostic clock must return a number");
      }

      const field = this.fields[kind];
      if (field.startedAt === null) {
        field.startedAt = timestamp;
      }
      field.lastAt = timestamp;
      field.events.push({
        at: timestamp,
        wordLengths: normalizedWordLengths(value),
      });
      if (field.events.length > MAX_INPUT_EVENTS) {
        field.events.splice(0, field.events.length - MAX_INPUT_EVENTS);
      }

      this.inputEventTimes.push(timestamp);
      if (this.inputEventTimes.length > MAX_INPUT_EVENTS) {
        this.inputEventTimes.splice(
          0,
          this.inputEventTimes.length - MAX_INPUT_EVENTS
        );
      }
      return this;
    }

    summarize(options) {
      const supplied = options || {};
      const eventTimes = this.inputEventTimes;
      const intervals = eventTimes
        .slice(1)
        .map((timestamp, index) => timestamp - eventTimes[index])
        .filter((interval) => Number.isFinite(interval) && interval >= 0);
      const pauses = intervals.filter(
        (interval) => interval >= PAUSE_THRESHOLD_MS
      );
      const startedAt = eventTimes.length ? eventTimes[0] : 0;
      const finishedAt = eventTimes.length
        ? eventTimes[eventTimes.length - 1]
        : startedAt;
      const totalDurationMs = Math.max(0, finishedAt - startedAt);
      const suppliedKeyPressCount = Number(supplied.keyPressCount);
      const keyPressCount = Number.isSafeInteger(suppliedKeyPressCount)
        ? Math.max(0, Math.min(1_000, suppliedKeyPressCount))
        : eventTimes.length;
      const burstCount = eventTimes.length ? pauses.length + 1 : 0;

      return {
        version: 1,
        missionId: String(supplied.missionId || "").slice(0, 64),
        totalDurationMs: Math.round(totalDurationMs),
        inputEventCount: eventTimes.length,
        keyPressCount,
        cadencePerMinute:
          totalDurationMs > 0
            ? round(keyPressCount / (totalDurationMs / 60_000))
            : 0,
        pauses: {
          thresholdMs: PAUSE_THRESHOLD_MS,
          count: pauses.length,
          longestMs: pauses.length
            ? Math.round(Math.max(...pauses))
            : 0,
        },
        bursts: {
          count: burstCount,
          averageEvents:
            burstCount > 0 ? round(eventTimes.length / burstCount) : 0,
        },
        guided: summarizeField(this.fields.guided),
        freeTyping: summarizeField(this.fields.free),
      };
    }
  }

  const api = Object.freeze({
    MAX_INPUT_EVENTS,
    PAUSE_THRESHOLD_MS,
    TypingDiagnostic,
    createTypingDiagnostic(options) {
      return new TypingDiagnostic(options);
    },
    normalizedWordLengths,
  });

  global.OdysseusDiagnostics = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
