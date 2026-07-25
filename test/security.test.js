"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildContentSecurityPolicy,
  isSameOrigin,
} = require("../src/http-security");
const { createRateLimiter } = require("../src/rate-limit");

function requestWithHeaders(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    protocol: "https",
    path: "/api/verify",
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get(name) {
      return normalized[name.toLowerCase()];
    },
  };
}

function responseRecorder() {
  return {
    headers: new Map(),
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers.set(name, value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("builds a restrictive content security policy", () => {
  const policy = buildContentSecurityPolicy({ production: true });

  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /script-src [^;]*unsafe-inline/);
});

test("accepts only an allowed request origin", () => {
  const accepted = requestWithHeaders({
    host: "odysseus.example",
    origin: "https://odysseus.example",
  });
  const rejected = requestWithHeaders({
    host: "odysseus.example",
    origin: "https://attacker.example",
  });

  assert.equal(isSameOrigin(accepted), true);
  assert.equal(isSameOrigin(rejected), false);
});

test("rate limits a key and resets it after the configured window", () => {
  let now = 1_000;
  const limiter = createRateLimiter({
    maximum: 2,
    windowMs: 1_000,
    clock: () => now,
  });
  const request = requestWithHeaders();

  const first = responseRecorder();
  let firstContinued = false;
  limiter(request, first, () => {
    firstContinued = true;
  });
  assert.equal(firstContinued, true);

  const second = responseRecorder();
  limiter(request, second, () => undefined);
  assert.equal(second.statusCode, 200);

  const blocked = responseRecorder();
  let blockedContinued = false;
  limiter(request, blocked, () => {
    blockedContinued = true;
  });
  assert.equal(blockedContinued, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.error.code, "RATE_LIMITED");

  now += 1_001;
  const afterReset = responseRecorder();
  let resetContinued = false;
  limiter(request, afterReset, () => {
    resetContinued = true;
  });
  assert.equal(resetContinued, true);
});
