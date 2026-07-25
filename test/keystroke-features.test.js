"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createApp } = require("../server");

const ORIGINAL_FEATURE_NAMES = [
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
];

const BURST_FEATURE_NAMES = [
  "downDownPauseRatio",
  "downDownInBurstMean",
];

const CLASS_PAIR_FEATURE_NAMES = [
  "downDownSameHandBias",
  "downDownAlternateHandBias",
  "downDownVowelConsonantBias",
  "downDownConsonantRunBias",
  "downDownWordBoundaryBias",
  "downDownSymbolBias",
];

const EXPECTED_FEATURE_NAMES = [
  ...ORIGINAL_FEATURE_NAMES,
  ...BURST_FEATURE_NAMES,
  ...CLASS_PAIR_FEATURE_NAMES,
];

const REPOSITORY_ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------------ *
 * Browser harness
 *
 * Both collectors are loaded into their own vm context with a virtual
 * clock, so the same synthetic keystroke stream can be replayed through
 * each of them and the resulting vectors compared directly.
 * ------------------------------------------------------------------ */

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
      handlers.set(
        type,
        (handlers.get(type) || []).filter((listener) => listener !== handler),
      );
    },
    dispatch(type, event = {}) {
      for (const handler of [...(handlers.get(type) || [])]) {
        handler(event);
      }
    },
  };
}

function virtualClock() {
  return { value: 1_000 };
}

function readSource(...segments) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, ...segments), "utf8");
}

function loadConsoleTelemetry(clock) {
  const context = vm.createContext({
    performance: { now: () => clock.value },
  });
  vm.runInContext(readSource("public", "telemetry.js"), context, {
    filename: "public/telemetry.js",
  });
  return context.OdysseusTelemetry;
}

function loadMockupContext(clock) {
  const documentStub = eventTarget({
    hidden: false,
    documentElement: { setAttribute() {}, removeAttribute() {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const context = vm.createContext({
    document: documentStub,
    // The collector reads the global performance clock, so it has to be stubbed
    // here as well as on window or every timing lands on the real clock.
    performance: { now: () => clock.value },
    window: {
      performance: { now: () => clock.value },
      location: { href: "" },
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval() {},
    fetch: () => Promise.resolve({ ok: true }),
    console: { log() {}, warn() {}, error() {} },
  });
  // The mockup no longer carries its own copy of the collector. It loads the
  // shared telemetry.js, so what these tests compare is that the file the
  // mockup serves and the file the console serves behave identically - a
  // profile enrolled on one surface has to verify on the other.
  vm.runInContext(readSource("mockup_website", "telemetry.js"), context, {
    filename: "mockup_website/telemetry.js",
  });
  const shared = context.window.OdysseusTelemetry
    || context.OdysseusTelemetry;
  context.createBehaviorCollector = options => shared.createCollector(options);
  context.TELEMETRY_FEATURE_NAMES = shared.FEATURE_NAMES;
  context.TELEMETRY_KEY_CLASS = shared.KEY_CLASS;
  context.classifyTelemetryKey = shared.classifyKey;
  return context;
}

// One keystroke stream, described independently of either collector.
function typingScript(text, options = {}) {
  const gapFor = options.gapFor || (() => 120);
  const dwell = options.dwell || 90;
  const characters = Array.from(text);
  return characters.map((key, index) => ({
    key,
    gap: index === 0 ? 0 : gapFor(characters[index - 1], key, index),
    dwell,
  }));
}

function replay(keyboard, pointer, clock, script, pointerMoves = 14) {
  for (const step of script) {
    clock.value += step.gap;
    keyboard.dispatch("keydown", {
      key: step.key,
      isTrusted: true,
      repeat: false,
    });
    clock.value += step.dwell;
    keyboard.dispatch("keyup", { key: step.key, isTrusted: true });
    clock.value -= step.dwell;
  }
  let x = 400;
  let y = 300;
  for (let index = 0; index < pointerMoves; index += 1) {
    clock.value += 100 + index;
    x += 17 + (index % 5) * 3;
    y += 11 + (index % 3) * 4;
    pointer.dispatch("pointermove", {
      isTrusted: true,
      clientX: x,
      clientY: y,
    });
  }
}

function collectConsoleVector(script) {
  const clock = virtualClock();
  const telemetry = loadConsoleTelemetry(clock);
  const keyboard = eventTarget();
  const pointer = eventTarget();
  const collector = telemetry.createCollector({
    keyboardTarget: keyboard,
    pointerTarget: pointer,
  });
  collector.start();
  replay(keyboard, pointer, clock, script);
  const result = collector.finalize({ reset: false });
  return { telemetry, collector, result };
}

function collectMockupVector(script) {
  const clock = virtualClock();
  const context = loadMockupContext(clock);
  const keyboard = eventTarget();
  const pointer = eventTarget();
  const collector = context.createBehaviorCollector({
    keyboardTarget: keyboard,
    pointerTarget: pointer,
  });
  collector.start();
  replay(keyboard, pointer, clock, script);
  return { context, result: collector.finalize() };
}

const LEFT_HAND_LETTERS = new Set(Array.from("qwertasdfgzxcvb"));

function isSameHandPair(previous, key) {
  if (!/^[a-z]$/.test(previous) || !/^[a-z]$/.test(key)) {
    return false;
  }
  return LEFT_HAND_LETTERS.has(previous) === LEFT_HAND_LETTERS.has(key);
}

// Long enough that every class pair is seen many times over.
const SAMPLE_TEXT = (
  "the quarterly report shows that our desk closed 14 accounts this week, "
  + "and the review board asked whether the pricing model still holds."
);

test("both collectors publish the same feature names", () => {
  const clock = virtualClock();
  const telemetry = loadConsoleTelemetry(clock);
  const mockup = loadMockupContext(clock);
  const mockupNames = vm.runInContext(
    "TELEMETRY_FEATURE_NAMES",
    mockup,
  );

  assert.deepEqual([...telemetry.FEATURE_NAMES], EXPECTED_FEATURE_NAMES);
  assert.deepEqual([...mockupNames], EXPECTED_FEATURE_NAMES);
  // src/behavior.js refuses a vector wider than MAX_FEATURES.
  assert.ok(telemetry.FEATURE_NAMES.length <= 32);
});

test("both collectors derive the same vector from one keystroke stream", () => {
  const script = typingScript(SAMPLE_TEXT, {
    gapFor: (previous, key) => (isSameHandPair(previous, key) ? 210 : 110),
  });
  const console_ = collectConsoleVector(script);
  const mockup = collectMockupVector(script);

  assert.equal(console_.result.ok, true);
  assert.equal(mockup.result.ok, true);
  assert.deepEqual(
    Object.keys(mockup.result.vector).sort(),
    EXPECTED_FEATURE_NAMES.slice().sort(),
  );
  // Identical semantics, not merely identical names: a profile enrolled on the
  // console has to be verifiable from the mockup and the other way round.
  // Each collector runs in its own realm, so the values are compared as plain
  // objects of this realm rather than by prototype identity.
  assert.deepEqual(
    { ...mockup.result.vector },
    { ...console_.result.vector },
  );
  assert.deepEqual(
    { ...mockup.result.counts },
    { ...console_.result.counts },
  );
});

test("both collectors agree on the coarse key classes", () => {
  const clock = virtualClock();
  const telemetry = loadConsoleTelemetry(clock);
  const mockup = loadMockupContext(clock);
  const keys = [
    "a", "e", "s", "t", "z",
    "u", "i", "o", "h", "m", "p",
    " ", "Enter", "Tab",
    "4", "7", ".", ",", ";",
    "Shift", "Backspace", "ArrowLeft", "F5",
    "A", "T",
  ];

  for (const key of keys) {
    assert.equal(
      telemetry.classifyKey({ key }),
      mockup.classifyTelemetryKey({ key }),
      `class mismatch for ${JSON.stringify(key)}`,
    );
  }

  const { KEY_CLASS } = telemetry;
  assert.equal(telemetry.classifyKey({ key: "a" }), KEY_CLASS.LEFT_VOWEL);
  assert.equal(telemetry.classifyKey({ key: "s" }), KEY_CLASS.LEFT_CONSONANT);
  assert.equal(telemetry.classifyKey({ key: "u" }), KEY_CLASS.RIGHT_VOWEL);
  assert.equal(telemetry.classifyKey({ key: "h" }), KEY_CLASS.RIGHT_CONSONANT);
  assert.equal(telemetry.classifyKey({ key: " " }), KEY_CLASS.WHITESPACE);
  assert.equal(telemetry.classifyKey({ key: "Enter" }), KEY_CLASS.WHITESPACE);
  assert.equal(telemetry.classifyKey({ key: "7" }), KEY_CLASS.DIGIT);
  assert.equal(telemetry.classifyKey({ key: "," }), KEY_CLASS.SYMBOL);
  assert.equal(telemetry.classifyKey({ key: "Shift" }), KEY_CLASS.OTHER);
  // Capitals must land in the same bucket as their lowercase form, or the
  // features would report where someone used the shift key.
  assert.equal(
    telemetry.classifyKey({ key: "T" }),
    telemetry.classifyKey({ key: "t" }),
  );
});

test("burst features report structure the global averages hide", () => {
  const steady = collectConsoleVector(
    typingScript(SAMPLE_TEXT, { gapFor: () => 130 }),
  ).result.vector;
  // The same hands at the same speed, but stopping to think every fifth key.
  const bursty = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key, index) => (index % 5 === 0 ? 900 : 130),
    }),
  ).result.vector;

  assert.equal(steady.downDownPauseRatio, 0);
  assert.ok(
    bursty.downDownPauseRatio > 0.15,
    `expected pauses to be counted, saw ${bursty.downDownPauseRatio}`,
  );

  // In-burst timing is the motor measurement, so it must ignore the pauses
  // entirely even though the global key interval moved a long way.
  assert.ok(Math.abs(bursty.downDownInBurstMean - 130) < 1);
  assert.ok(Math.abs(steady.downDownInBurstMean - 130) < 1);
  assert.ok(
    bursty.downDownMean - steady.downDownMean > 100,
    "the global key interval should have moved even though in-burst did not",
  );

  // Pause frequency uses the same 500ms threshold as public/diagnostics.js, so
  // the identity features and the reported typing diagnostics agree.
  const diagnostics = require("../public/diagnostics");
  assert.equal(diagnostics.PAUSE_THRESHOLD_MS, 500);
  const justUnder = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key, index) => (index % 5 === 0 ? 499 : 130),
    }),
  ).result.vector;
  assert.equal(justUnder.downDownPauseRatio, 0);
});

test("burst features survive an idle break without inventing a pause", () => {
  const clock = virtualClock();
  const telemetry = loadConsoleTelemetry(clock);
  const keyboard = eventTarget();
  const pointer = eventTarget();
  const collector = telemetry.createCollector({
    keyboardTarget: keyboard,
    pointerTarget: pointer,
  });
  collector.start();
  const script = typingScript(SAMPLE_TEXT, { gapFor: () => 130 });
  replay(keyboard, pointer, clock, script.slice(0, 40), 8);
  // The user walks away for five minutes and comes back.
  clock.value += 5 * 60 * 1_000;
  replay(keyboard, pointer, clock, script.slice(40), 8);

  const vector = collector.finalize().vector;
  assert.equal(vector.downDownPauseRatio, 0);
  assert.ok(Math.abs(vector.downDownInBurstMean - 130) < 1);
});

test("class-pair features respond to a per-transition struggle", () => {
  const even = collectConsoleVector(
    typingScript(SAMPLE_TEXT, { gapFor: () => 120 }),
  ).result.vector;
  const sameHandSlow = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key) => (isSameHandPair(previous, key) ? 240 : 120),
    }),
  ).result.vector;
  const alternateHandSlow = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key) => (
        /^[a-z]$/.test(previous)
        && /^[a-z]$/.test(key)
        && !isSameHandPair(previous, key)
          ? 240
          : 120
      ),
    }),
  ).result.vector;

  // Even typing is the reference: nothing is slower than anything else.
  for (const name of CLASS_PAIR_FEATURE_NAMES) {
    assert.ok(
      Math.abs(even[name]) < 0.06,
      `${name} should be near zero for even typing, saw ${even[name]}`,
    );
  }

  // Each person's struggle shows up in its own class and nowhere else.
  assert.ok(
    sameHandSlow.downDownSameHandBias > 0.2,
    `saw ${sameHandSlow.downDownSameHandBias}`,
  );
  assert.ok(sameHandSlow.downDownAlternateHandBias < 0);
  assert.ok(
    alternateHandSlow.downDownAlternateHandBias > 0.2,
    `saw ${alternateHandSlow.downDownAlternateHandBias}`,
  );
  assert.ok(alternateHandSlow.downDownSameHandBias < 0);

  // The two typists are almost indistinguishable on the original twelve: the
  // whole point of the class-pair family is that this difference is invisible
  // to a global average.
  for (const name of ["dwellMean", "downDownMean", "flightMean"]) {
    const spread = Math.abs(sameHandSlow[name] - alternateHandSlow[name]);
    const scale = Math.max(
      Math.abs(sameHandSlow[name]),
      Math.abs(alternateHandSlow[name]),
      1,
    );
    assert.ok(
      spread / scale < 0.2,
      `${name} should barely move between the two, saw ${spread}`,
    );
  }
  const classSpread = CLASS_PAIR_FEATURE_NAMES.reduce(
    (total, name) => (
      total + Math.abs(sameHandSlow[name] - alternateHandSlow[name])
    ),
    0,
  );
  assert.ok(classSpread > 0.8, `class features barely moved: ${classSpread}`);
});

test("word-boundary and symbol transitions are measured separately", () => {
  const spaceSlow = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key) => (previous === " " || key === " " ? 260 : 120),
    }),
  ).result.vector;
  const digitSlow = collectConsoleVector(
    typingScript(SAMPLE_TEXT, {
      gapFor: (previous, key) => (
        /[0-9.,;]/.test(previous) || /[0-9.,;]/.test(key) ? 300 : 120
      ),
    }),
  ).result.vector;

  assert.ok(
    spaceSlow.downDownWordBoundaryBias > 0.2,
    `saw ${spaceSlow.downDownWordBoundaryBias}`,
  );
  assert.ok(
    digitSlow.downDownSymbolBias > 0.2,
    `saw ${digitSlow.downDownSymbolBias}`,
  );
  assert.ok(digitSlow.downDownWordBoundaryBias < spaceSlow.downDownWordBoundaryBias);
  assert.ok(spaceSlow.downDownSymbolBias < digitSlow.downDownSymbolBias);
});

/* ------------------------------------------------------------------ *
 * Privacy boundary
 * ------------------------------------------------------------------ */

function stringLeaves(value, found = []) {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      stringLeaves(entry, found);
    }
  }
  return found;
}

test("no key identity, keycode, or raw key event ever reaches a sample", () => {
  const secret = "zqxjkvbwyfghpluminadorest 4297.,;";
  const script = typingScript(secret.repeat(4), { gapFor: () => 140 });
  const { collector, result } = collectConsoleVector(script);

  // Nothing the collector hands over carries text at all.
  assert.deepEqual(stringLeaves(result.vector), []);
  assert.deepEqual(stringLeaves(result.counts), []);
  assert.deepEqual(stringLeaves(result.integrity), []);
  for (const name of Object.keys(result.vector)) {
    assert.ok(
      EXPECTED_FEATURE_NAMES.includes(name),
      `unexpected feature name ${name}`,
    );
    assert.equal(typeof result.vector[name], "number");
    assert.ok(Number.isFinite(result.vector[name]));
  }

  // Nor does the collector retain any while it runs: the only memory of a key
  // is one small integer class code.
  const retained = stringLeaves({
    rhythm: collector.keystrokeRhythm,
    presses: collector.activePresses,
    metrics: collector.metrics,
  });
  assert.deepEqual(retained, []);
  assert.equal(typeof collector.keystrokeRhythm.lastKeyClass, "number");
  assert.ok(collector.keystrokeRhythm.lastKeyClass >= 0);
  assert.ok(collector.keystrokeRhythm.lastKeyClass <= 7);

  // The payload is numeric through and through, so there is nowhere for a
  // character, a keycode, or a fragment of typed text to hide in it.
  const serializedValues = JSON.stringify(Object.values(result.vector));
  assert.match(serializedValues, /^\[-?[0-9.,e+-]*\]$/);

  const mockup = collectMockupVector(script);
  assert.deepEqual(stringLeaves(mockup.result.vector), []);
  assert.deepEqual({ ...mockup.result.vector }, { ...result.vector });
});

test("the collectors keep the documented key-class scheme coarse", () => {
  const clock = virtualClock();
  const telemetry = loadConsoleTelemetry(clock);
  const classes = new Set(
    Array.from("abcdefghijklmnopqrstuvwxyz").map(
      (key) => telemetry.classifyKey({ key }),
    ),
  );
  // Twenty-six letters share four buckets, so a class cannot name a key.
  assert.equal(classes.size, 4);
  assert.equal(telemetry.CLASS_PAIR_NAMES.length, 6);
  assert.equal(telemetry.PAUSE_THRESHOLD_MS, 500);
});

/* ------------------------------------------------------------------ *
 * Server side: profiles enrolled before the new features still verify
 * ------------------------------------------------------------------ */

const VALID_FIXTURE = "Correct-Horse-42";

function verificationDiagnostics() {
  return {
    version: 1,
    missionId: "steady-session",
    totalDurationMs: 4_800,
    inputEventCount: 52,
    keyPressCount: 50,
    cadencePerMinute: 625,
    pauses: { thresholdMs: 500, count: 2, longestMs: 840 },
    bursts: { count: 3, averageEvents: 17.33 },
    guided: {
      durationMs: 2_600,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 1, durationMs: 100 },
        { index: 2, characterCount: 7, durationMs: 620 },
        { index: 3, characterCount: 7, durationMs: 510 },
      ],
    },
    freeTyping: {
      durationMs: 1_900,
      wordCount: 3,
      words: [
        { index: 1, characterCount: 4, durationMs: 430 },
        { index: 2, characterCount: 7, durationMs: 680 },
        { index: 3, characterCount: 5, durationMs: 470 },
      ],
    },
  };
}

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  absorbCookies(response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const value of setCookies) {
      const segments = value.split(";").map((segment) => segment.trim());
      const separator = segments[0].indexOf("=");
      if (separator < 1) {
        continue;
      }
      const name = segments[0].slice(0, separator);
      const cookieValue = segments[0].slice(separator + 1);
      if (segments.some((segment) => segment.toLowerCase() === "max-age=0")) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
    return setCookies;
  }

  async request(route, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers = new Headers(options.headers ?? {});
    const cookie = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    if (mutating) {
      headers.set("Origin", this.baseUrl);
      const csrf = this.cookies.get("odysseus_csrf");
      if (csrf) {
        headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      }
    }
    let body = options.body;
    if (body !== undefined && typeof body !== "string") {
      body = JSON.stringify(body);
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body,
    });
    this.absorbCookies(response);
    const contentType = response.headers.get("content-type") ?? "";
    const responseBody = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return { response, body: responseBody };
  }
}

async function startTestServer(context) {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "odysseus-keystroke-"),
  );
  const app = await createApp({
    databasePath: path.join(directory, "odysseus.sqlite"),
    masterKey: crypto.randomBytes(32),
    production: false,
    rateLimits: false,
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  context.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await app.locals.closeDatabase();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new TestClient(baseUrl);
  await client.request("/api/auth/me");
  const registration = await client.request("/api/auth/register", {
    method: "POST",
    body: {
      username: `keystroke-user-${crypto.randomUUID().slice(0, 8)}`,
      password: VALID_FIXTURE,
    },
  });
  assert.equal(registration.response.status, 201);
  return client;
}

// A steady, plausible sample: every feature carries signal, so none of them is
// treated as inert at enrollment.
function sampleVector(names, index) {
  const bases = {
    dwellMean: 96,
    dwellDeviation: 14,
    flightMean: 42,
    flightDeviation: 12,
    downDownMean: 138,
    downDownDeviation: 26,
    pointerVelocityMean: 410,
    pointerVelocityDeviation: 120,
    pointerAccelerationMean: 900,
    pointerAccelerationDeviation: 260,
    pointerJitterMean: 0.18,
    pointerJitterDeviation: 0.07,
    downDownPauseRatio: 0.08,
    downDownInBurstMean: 118,
    downDownSameHandBias: 0.21,
    downDownAlternateHandBias: -0.09,
    downDownVowelConsonantBias: 0.05,
    downDownConsonantRunBias: 0.12,
    downDownWordBoundaryBias: -0.04,
    downDownSymbolBias: 0.16,
  };
  const drift = 1 + (((index % 5) - 2) * 0.02);
  const vector = {};
  for (const name of names) {
    vector[name] = Number((bases[name] * drift).toFixed(6));
  }
  return vector;
}

test("a profile enrolled on the old twelve features still verifies when the browser sends the new ones", async (context) => {
  const client = await startTestServer(context);
  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "legacy-console",
      samples: [0, 1, 2, 3, 4].map(
        (index) => sampleVector(ORIGINAL_FEATURE_NAMES, index),
      ),
    },
  });
  assert.equal(enrollment.response.status, 201);
  assert.equal(enrollment.body.featureCount, 12);

  // The updated collector sends twenty features to a template that knows
  // twelve. Without the projection this is a hard validation error.
  const verification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "legacy-console",
      vector: sampleVector(EXPECTED_FEATURE_NAMES, 2),
      diagnostics: verificationDiagnostics(),
    },
  });

  assert.equal(verification.response.status, 200);
  assert.equal(verification.body.decision, "allow");
  assert.equal(verification.body.comparedFeatureCount, 12);
  assert.ok(verification.body.behaviorVerifiedUntil);
  for (const name of [...BURST_FEATURE_NAMES, ...CLASS_PAIR_FEATURE_NAMES]) {
    assert.ok(
      !Object.hasOwn(verification.body.diagnostics.keyboard, name),
      `${name} should not be scored against a template that never enrolled it`,
    );
  }
});

test("a profile enrolled on the new features still verifies from a stale browser", async (context) => {
  const client = await startTestServer(context);
  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "current-console",
      samples: [0, 1, 2, 3, 4].map(
        (index) => sampleVector(EXPECTED_FEATURE_NAMES, index),
      ),
    },
  });
  assert.equal(enrollment.response.status, 201);
  assert.equal(enrollment.body.featureCount, 20);

  const verification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "current-console",
      vector: sampleVector(ORIGINAL_FEATURE_NAMES, 2),
      diagnostics: verificationDiagnostics(),
    },
  });

  assert.equal(verification.response.status, 200);
  assert.equal(verification.body.decision, "allow");
  assert.equal(verification.body.comparedFeatureCount, 12);
});

test("a vector that shares almost nothing with the profile is rejected", async (context) => {
  const client = await startTestServer(context);
  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: {
      profileId: "narrow-check",
      samples: [0, 1, 2, 3, 4].map(
        (index) => sampleVector(EXPECTED_FEATURE_NAMES, index),
      ),
    },
  });
  assert.equal(enrollment.response.status, 201);

  const verification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "narrow-check",
      vector: {
        dwellMean: 96,
        flightMean: 42,
        downDownSameHandBias: 0.21,
      },
      diagnostics: verificationDiagnostics(),
    },
  });

  assert.equal(verification.response.status, 400);
  assert.equal(verification.body.error.code, "VALIDATION_ERROR");
});

test("the full collector output verifies end to end against its own enrollment", async (context) => {
  const client = await startTestServer(context);
  // Deterministic jitter: a perfectly metronomic stream reads as automation to
  // the bot checks, and a zero-variance feature is treated as carrying no
  // signal at all, so the fixture types like a person instead of a robot.
  const jitter = (index) => ((index * 37) % 11) - 5;
  const script = typingScript(SAMPLE_TEXT, {
    gapFor: (previous, key, index) => {
      if (index % 7 === 0) {
        return 700 + (jitter(index) * 9);
      }
      return (isSameHandPair(previous, key) ? 190 : 115) + (jitter(index) * 4);
    },
  }).map((step, index) => ({
    ...step,
    dwell: step.dwell + (jitter(index * 3) * 3),
  }));
  const samples = [0, 1, 2, 3, 4].map((index) => {
    const shifted = script.map((step) => ({
      ...step,
      gap: step.gap === 0 ? 0 : step.gap + index * 2,
      dwell: step.dwell + index,
    }));
    return collectConsoleVector(shifted).result.vector;
  });

  const enrollment = await client.request("/api/enroll", {
    method: "POST",
    body: { profileId: "collected", samples: samples.map((v) => ({ ...v })) },
  });
  assert.equal(enrollment.response.status, 201);
  assert.equal(enrollment.body.featureCount, 20);

  const verification = await client.request("/api/verify", {
    method: "POST",
    body: {
      profileId: "collected",
      vector: { ...collectConsoleVector(script).result.vector },
      diagnostics: verificationDiagnostics(),
    },
  });
  assert.equal(verification.response.status, 200);
  assert.equal(verification.body.decision, "allow");
  assert.equal(verification.body.comparedFeatureCount, 20);
});
