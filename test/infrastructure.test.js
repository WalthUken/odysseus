"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRateLimitStore,
  createRateLimiter,
} = require("../src/rate-limit");
const {
  createOdysseusMonitoring,
  createMetricsRegistry,
} = require("../src/monitoring");
const { createReadinessRegistry } = require("../src/readiness");
const { createProviderRuntime } = require("../src/provider-runtime");

function request() {
  return {
    ip: "127.0.0.1",
    path: "/api/verify",
    socket: { remoteAddress: "127.0.0.1" },
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
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("supports synchronous memory and asynchronous rate limit stores", async () => {
  let now = 1_000;
  const memory = new MemoryRateLimitStore();
  const memoryLimiter = createRateLimiter({
    maximum: 1,
    windowMs: 1_000,
    clock: () => now,
    store: memory,
  });
  let continued = false;
  memoryLimiter(request(), responseRecorder(), () => {
    continued = true;
  });
  assert.equal(continued, true);

  const blocked = responseRecorder();
  memoryLimiter(request(), blocked, () => undefined);
  assert.equal(blocked.statusCode, 429);
  now += 1_001;
  memoryLimiter.reset();
  assert.equal(memory.buckets.size, 0);

  const asyncStore = {
    async increment(_key, options) {
      return { count: 1, resetAt: options.now + options.windowMs };
    },
    async readiness() {
      return { ready: true, provider: "test" };
    },
  };
  const asyncLimiter = createRateLimiter({ store: asyncStore });
  let asyncContinued = false;
  await asyncLimiter(request(), responseRecorder(), () => {
    asyncContinued = true;
  });
  assert.equal(asyncContinued, true);
  assert.equal((await asyncLimiter.readiness()).ready, true);
});

test("uses an injected Redis-compatible rate limit client without raw keys", async () => {
  const calls = [];
  const client = {
    async rateLimitIncrement(key, windowMs) {
      calls.push(["increment", key, windowMs]);
      return [2, 750];
    },
    async ping() {
      return "PONG";
    },
    async del(key) {
      calls.push(["delete", key]);
    },
  };
  const store = createRateLimitStore({
    redisClient: client,
    prefix: "odysseus:test",
  });
  assert.ok(store instanceof RedisRateLimitStore);
  const result = await store.increment("user:private-user", {
    now: 10_000,
    windowMs: 1_000,
  });
  assert.equal(result.count, 2);
  assert.equal(result.resetAt, 10_750);
  assert.doesNotMatch(calls[0][1], /private-user/);
  assert.match(calls[0][1], /^odysseus:test:[a-f0-9]{64}$/);
  assert.equal((await store.readiness()).ready, true);
  await store.reset("user:private-user");
  assert.equal(calls[1][1], calls[0][1]);
});

test("fails closed when an asynchronous rate limit store is unavailable", async () => {
  const limiter = createRateLimiter({
    store: {
      async increment() {
        throw new Error("connection details must not leak");
      },
    },
  });
  const response = responseRecorder();
  await limiter(request(), response, () => {
    throw new Error("Unavailable limiter must not continue.");
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, "RATE_LIMIT_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(response.body), /connection details/);
});

test("renders bounded Prometheus counters and histograms", () => {
  const monitoring = createOdysseusMonitoring({ prefix: "odysseus" });
  monitoring.httpRequests.inc({
    method: "BREW",
    route: "secret-user-route",
    status: "418",
  });
  monitoring.providerRequests.inc({
    provider: "gemini",
    outcome: "success",
  });
  monitoring.providerDuration.observe({ provider: "gemini" }, 0.25);
  const text = monitoring.render();

  assert.match(text, /# TYPE odysseus_http_requests_total counter/);
  assert.match(
    text,
    /odysseus_http_requests_total\{method="other",route="other",status="other"\} 1/
  );
  assert.match(
    text,
    /odysseus_provider_duration_seconds_bucket\{provider="gemini",le="0.25"\} 1/
  );
  assert.doesNotMatch(text, /secret-user-route/);
});

test("rejects unbounded monitoring labels", () => {
  const registry = createMetricsRegistry();
  assert.throws(
    () =>
      registry.counter("unsafe_total", "Unsafe dynamic labels.", {
        labelNames: ["user_id"],
      }),
    /allowlist/
  );
});

test("reports required readiness failures and optional disabled services", async () => {
  const readiness = createReadinessRegistry({ timeoutMs: 20 });
  readiness.register("database", async () => true);
  readiness.register(
    "optional_ai",
    async () => ({
      ready: false,
      disabled: true,
      reason: "disabled",
    }),
    { required: false }
  );
  readiness.register(
    "required_cache",
    async () => ({ ready: false, reason: "unavailable" })
  );
  const result = await readiness.check();
  assert.equal(result.ready, false);
  assert.equal(result.status, "not_ready");
  assert.equal(
    result.checks.find((entry) => entry.name === "optional_ai").disabled,
    true
  );
});

test("times out readiness probes without exposing exception messages", async () => {
  const readiness = createReadinessRegistry({ timeoutMs: 10 });
  readiness.register("slow_service", () => new Promise(() => undefined));
  const result = await readiness.check();
  assert.equal(result.ready, false);
  assert.equal(result.checks[0].reason, "timeout");
});

test("creates a disabled-by-default provider runtime honestly", async () => {
  const runtime = createProviderRuntime();
  assert.ok(runtime.rateLimitStore instanceof MemoryRateLimitStore);
  assert.equal(runtime.turnstile.readiness().disabled, true);
  assert.equal(runtime.gemini.readiness().disabled, true);
  assert.equal(runtime.huggingFace.readiness().disabled, true);
  const readiness = await runtime.readiness.check();
  assert.equal(readiness.ready, true);
});

test("PostgreSQL deployment artifact always enables and forces RLS", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "src", "postgres-account-rls.sql"),
    "utf8"
  );
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /DROP POLICY %I ON public\.%I/);
  assert.doesNotMatch(
    sql,
    new RegExp(["DISABLE", "ROW LEVEL SECURITY"].join(" "))
  );
  assert.match(sql, /current_setting\(''odysseus\.user_id''/);
  for (const table of [
    "audit_events",
    "behavior_profiles",
    "devices",
    "security_notifications",
    "sessions",
    "webauthn_credentials",
  ]) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
});
