"use strict";

const crypto = require("node:crypto");

const REDIS_INCREMENT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {count, ttl}
`;

function toMilliseconds(value) {
  const current = typeof value === "function" ? value() : Date.now();
  if (current instanceof Date) {
    return current.getTime();
  }
  const milliseconds = Number(current);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

function defaultKeyGenerator(request) {
  return `${request.ip || request.socket.remoteAddress || "unknown"}:${request.path}`;
}

function validateWindow(windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("Rate limit windowMs must be a positive number.");
  }
}

function normalizeStoreResult(value, now, windowMs) {
  if (
    value === null
    || typeof value !== "object"
    || !Number.isSafeInteger(Number(value.count))
    || Number(value.count) < 1
  ) {
    throw new TypeError("Rate limit store returned an invalid count.");
  }

  const resetAt = Number(value.resetAt);
  return {
    count: Number(value.count),
    resetAt:
      Number.isFinite(resetAt) && resetAt > now
        ? resetAt
        : now + windowMs,
  };
}

class MemoryRateLimitStore {
  constructor(options = {}) {
    this.maximumEntries = Number(options.maximumEntries ?? 10_000);
    if (
      !Number.isSafeInteger(this.maximumEntries)
      || this.maximumEntries < 100
    ) {
      throw new TypeError(
        "Memory rate limit maximumEntries must be at least 100."
      );
    }
    this.buckets = new Map();
  }

  prune(now, force = false) {
    if (!force && this.buckets.size < this.maximumEntries) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }

    while (this.buckets.size >= this.maximumEntries) {
      const oldest = this.buckets.keys().next().value;
      this.buckets.delete(oldest);
    }
  }

  increment(key, options) {
    const now = Number(options.now);
    const windowMs = Number(options.windowMs);
    validateWindow(windowMs);
    this.prune(now);

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { ...bucket };
  }

  reset(key) {
    if (key === undefined) {
      this.buckets.clear();
      return;
    }
    this.buckets.delete(String(key));
  }

  async readiness() {
    return {
      ready: true,
      provider: "memory",
      entries: this.buckets.size,
    };
  }
}

class RedisRateLimitStore {
  constructor(options = {}) {
    if (!options.client || typeof options.client !== "object") {
      throw new TypeError("Redis rate limit store requires an injected client.");
    }
    this.client = options.client;
    this.prefix = String(options.prefix ?? "odysseus:rate-limit");
    this.hashKeys = options.hashKeys !== false;
    this.evalStyle = options.evalStyle ?? "auto";
    if (!["auto", "node-redis", "ioredis"].includes(this.evalStyle)) {
      throw new TypeError(
        "Redis rate limit evalStyle must be auto, node-redis, or ioredis."
      );
    }
  }

  redisKey(key) {
    const raw = String(key);
    const suffix = this.hashKeys
      ? crypto.createHash("sha256").update(raw).digest("hex")
      : raw.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 256);
    return `${this.prefix}:${suffix}`;
  }

  async evaluate(redisKey, windowMs) {
    if (typeof this.client.rateLimitIncrement === "function") {
      return this.client.rateLimitIncrement(redisKey, windowMs);
    }
    if (typeof this.client.eval !== "function") {
      throw new TypeError(
        "Redis client must expose eval or rateLimitIncrement."
      );
    }

    if (this.evalStyle === "ioredis") {
      return this.client.eval(
        REDIS_INCREMENT_SCRIPT,
        1,
        redisKey,
        String(Math.ceil(windowMs))
      );
    }
    try {
      return await this.client.eval(REDIS_INCREMENT_SCRIPT, {
        keys: [redisKey],
        arguments: [String(Math.ceil(windowMs))],
      });
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return this.client.eval(
        REDIS_INCREMENT_SCRIPT,
        1,
        redisKey,
        String(Math.ceil(windowMs))
      );
    }
  }

  async increment(key, options) {
    const now = Number(options.now);
    const windowMs = Number(options.windowMs);
    validateWindow(windowMs);
    const result = await this.evaluate(this.redisKey(key), windowMs);

    const values = Array.isArray(result)
      ? result
      : [result && result.count, result && (result.ttlMs ?? result.ttl)];
    const count = Number(values[0]);
    const ttlMs = Number(values[1]);
    if (
      !Number.isSafeInteger(count)
      || count < 1
      || !Number.isFinite(ttlMs)
      || ttlMs < 0
    ) {
      throw new TypeError("Redis rate limit response is invalid.");
    }
    return {
      count,
      resetAt: now + Math.max(1, ttlMs),
    };
  }

  async reset(key) {
    if (key === undefined) {
      throw new TypeError(
        "Redis rate limit reset requires one exact logical key."
      );
    }
    if (typeof this.client.del !== "function") {
      throw new TypeError("Redis client must expose del to reset a key.");
    }
    await this.client.del(this.redisKey(key));
  }

  async readiness() {
    if (typeof this.client.ping !== "function") {
      return {
        ready: false,
        provider: "redis",
        reason: "ping_not_supported",
      };
    }
    try {
      const response = await this.client.ping();
      return {
        ready: response === "PONG" || response === true,
        provider: "redis",
        reason:
          response === "PONG" || response === true
            ? null
            : "unexpected_ping_response",
      };
    } catch (_error) {
      return {
        ready: false,
        provider: "redis",
        reason: "unavailable",
      };
    }
  }
}

function createMemoryRateLimitStore(options) {
  return new MemoryRateLimitStore(options);
}

function createRedisRateLimitStore(options) {
  return new RedisRateLimitStore(options);
}

function createRateLimitStore(options = {}) {
  if (options.store) {
    return options.store;
  }
  if (options.redisClient || options.client) {
    return createRedisRateLimitStore({
      client: options.redisClient ?? options.client,
      prefix: options.prefix,
      hashKeys: options.hashKeys,
      evalStyle: options.evalStyle,
    });
  }
  return createMemoryRateLimitStore({
    maximumEntries: options.maximumEntries,
  });
}

function createRateLimiter(options = {}) {
  const windowMs = Number(options.windowMs ?? 60_000);
  const maximum = Number(options.maximum ?? options.max ?? 60);
  const clock = options.clock ?? Date.now;
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;
  const store = options.store ?? createMemoryRateLimitStore();

  validateWindow(windowMs);
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new TypeError("Rate limit maximum must be a positive integer.");
  }
  if (!store || typeof store.increment !== "function") {
    throw new TypeError("Rate limit store must expose increment.");
  }

  function applyResult(result, now, response, next) {
    const bucket = normalizeStoreResult(result, now, windowMs);
    const remaining = Math.max(0, maximum - bucket.count);
    const resetSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1_000)
    );

    response.set("RateLimit-Limit", String(maximum));
    response.set("RateLimit-Remaining", String(remaining));
    response.set("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > maximum) {
      response.set("Retry-After", String(resetSeconds));
      response.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message:
            options.message
            || "Too many requests. Wait before trying this operation again.",
          retryAfterSeconds: resetSeconds,
        },
      });
      return;
    }
    next();
  }

  function handleStoreError(error, response, next) {
    if (options.failureMode === "open") {
      next();
      return;
    }
    if (typeof options.onStoreError === "function") {
      options.onStoreError(error);
    }
    response.status(503).json({
      error: {
        code: "RATE_LIMIT_UNAVAILABLE",
        message: "Request limiting is temporarily unavailable.",
      },
    });
  }

  function middleware(request, response, next) {
    const now = toMilliseconds(clock);
    let value;
    let key;
    try {
      key = String(keyGenerator(request));
      value = store.increment(key, { now, windowMs });
    } catch (error) {
      handleStoreError(error, response, next);
      return;
    }

    if (value && typeof value.then === "function") {
      return value
        .then((result) => applyResult(result, now, response, next))
        .catch((error) => handleStoreError(error, response, next));
    }
    applyResult(value, now, response, next);
  }

  middleware.reset = (key) => {
    if (typeof store.reset !== "function") {
      return undefined;
    }
    return store.reset(key);
  };
  middleware.readiness = () =>
    typeof store.readiness === "function"
      ? store.readiness()
      : Promise.resolve({
          ready: true,
          provider: "custom",
        });
  middleware.buckets = store.buckets ?? null;
  middleware.store = store;
  return middleware;
}

module.exports = {
  MemoryRateLimitStore,
  REDIS_INCREMENT_SCRIPT,
  RedisRateLimitStore,
  createMemoryRateLimitStore,
  createRateLimitStore,
  createRateLimiter,
  createRedisRateLimitStore,
  defaultKeyGenerator,
  normalizeStoreResult,
  toMilliseconds,
};
