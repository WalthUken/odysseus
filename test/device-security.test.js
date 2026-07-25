"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  accountScopedClientFingerprintDigest,
  accountScopedFingerprintDigest,
  normalizeFingerprintVisitorId,
  timingSafeDigestEqual,
} = require("../src/device-security");
const { DomainValidationError } = require("../src/domain-validation");

const VISITOR_ID = "0123456789abcdef0123456789abcdef";
const DESCRIPTOR = Object.freeze({
  browserFamily: "chrome",
  deviceClass: "desktop",
  inputMode: "keyboard-pointer",
  localeLanguage: "en",
  osFamily: "windows",
  timezoneOffsetMinutes: -240,
});

test("normalizes only strict FingerprintJS visitor IDs", () => {
  assert.equal(
    normalizeFingerprintVisitorId(VISITOR_ID.toUpperCase()),
    VISITOR_ID,
  );
  assert.equal(
    normalizeFingerprintVisitorId(undefined, { nullable: true }),
    null,
  );
  assert.equal(
    normalizeFingerprintVisitorId(null, { nullable: true }),
    null,
  );

  for (const invalid of [
    "",
    " 0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef ",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "0123456789abcdef0123456789abcdeg",
    123,
    null,
  ]) {
    assert.throws(
      () => normalizeFingerprintVisitorId(invalid),
      DomainValidationError,
    );
  }
});

test("client visitor HMAC is account scoped and domain separated", () => {
  const key = crypto.randomBytes(32);
  const first = accountScopedClientFingerprintDigest(1, VISITOR_ID, key);
  const canonicalized = accountScopedClientFingerprintDigest(
    1,
    VISITOR_ID.toUpperCase(),
    key,
  );
  const otherAccount = accountScopedClientFingerprintDigest(
    2,
    VISITOR_ID,
    key,
  );
  const coarse = accountScopedFingerprintDigest(1, DESCRIPTOR, key);

  assert.equal(first.length, 32);
  assert.deepEqual(first, canonicalized);
  assert.notDeepEqual(first, otherAccount);
  assert.notDeepEqual(first, coarse);
  assert.equal(first.includes(Buffer.from(VISITOR_ID, "ascii")), false);
});

test("digest equality uses a fixed-width timing-safe comparison contract", () => {
  const digest = crypto.randomBytes(32);
  assert.equal(timingSafeDigestEqual(digest, Buffer.from(digest)), true);
  assert.equal(timingSafeDigestEqual(digest, crypto.randomBytes(32)), false);
  assert.equal(timingSafeDigestEqual(digest, Buffer.alloc(31)), false);
  assert.equal(timingSafeDigestEqual(digest, "not-a-buffer"), false);
});
