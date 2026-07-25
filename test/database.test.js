"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { hashPassword } = require("../src/auth");
const {
  OdysseusDatabase,
  DatabaseConflictError,
} = require("../src/database");

async function createTestDatabase(context, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-db-"));
  const databasePath = path.join(directory, "odysseus.sqlite");
  const masterKey = options.masterKey ?? crypto.randomBytes(32);
  const database = await new OdysseusDatabase({
    databasePath,
    masterKey,
  }).init();

  context.after(async () => {
    if (database.initialized) {
      await database.close();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  return { database, databasePath, directory, masterKey };
}

test("stores users and rejects duplicate normalized usernames", async (context) => {
  const { database } = await createTestDatabase(context);
  const passwordHash = await hashPassword("Correct-Horse-42");
  const user = await database.createUser({
    username: "Odysseus.User",
    passwordHash,
  });

  assert.equal(user.username, "odysseus.user");
  assert.equal(user.passwordHash, passwordHash);
  await assert.rejects(
    database.createUser({
      username: "ODYSSEUS.USER",
      passwordHash,
    }),
    DatabaseConflictError,
  );
});

test("stores only hashed session and CSRF credentials", async (context) => {
  const { database } = await createTestDatabase(context);
  const user = await database.createUser({
    username: "session-user",
    passwordHash: await hashPassword("Correct-Horse-42"),
  });
  const created = await database.createSession(user.id);
  const stored = database.database
    .prepare("SELECT token_hash, csrf_hash FROM sessions WHERE id = ?")
    .get(created.session.id);

  assert.equal(Buffer.from(stored.token_hash).length, 32);
  assert.equal(Buffer.from(stored.csrf_hash).length, 32);
  assert.equal(
    Buffer.from(stored.token_hash).includes(Buffer.from(created.token)),
    false,
  );

  const restored = await database.getSessionWithUser(created.token);
  assert.equal(restored.user.id, user.id);
  assert.equal(restored.user.username, "session-user");
  assert.equal(await database.getSessionWithUser("invalid-session-token"), null);

  const stepUpUntil = new Date(Date.now() + 60_000);
  const behaviorUntil = new Date(Date.now() + 30_000);
  await database.setStepUpUntil(created.session.id, stepUpUntil);
  await database.setBehaviorVerifiedUntil(
    created.session.id,
    behaviorUntil,
  );
  const updated = await database.getSessionWithUser(created.token);
  assert.equal(updated.session.stepUpUntil, stepUpUntil.toISOString());
  assert.equal(
    updated.session.behaviorVerifiedUntil,
    behaviorUntil.toISOString(),
  );
});

test("encrypts account-scoped behavior profiles at rest", async (context) => {
  const { database } = await createTestDatabase(context);
  const passwordHash = await hashPassword("Correct-Horse-42");
  const owner = await database.createUser({
    username: "profile-owner",
    passwordHash,
  });
  const otherUser = await database.createUser({
    username: "other-user",
    passwordHash,
  });
  const template = {
    version: 1,
    featureKeys: ["dwellMean"],
    means: { dwellMean: 101.25 },
    deviations: { dwellMean: 3.5 },
    scales: { dwellMean: 3.5 },
    acceptanceThreshold: 1.5,
    calibration: { p90Distance: 0.9, maximumDistance: 1.1 },
    sampleCount: 5,
    enrolledAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  };

  await database.setProfile(owner.id, "laptop", template);
  const stored = database.database
    .prepare(`
      SELECT template_ciphertext
      FROM behavior_profiles
      WHERE user_id = ? AND profile_id = ?
    `)
    .get(owner.id, "laptop");
  const ciphertext = Buffer.from(stored.template_ciphertext);

  assert.equal(ciphertext.includes(Buffer.from("dwellMean")), false);
  assert.equal(ciphertext.includes(Buffer.from("101.25")), false);

  const restored = await database.getProfile(owner.id, "laptop");
  assert.deepEqual(restored.template, template);
  assert.equal(restored.sampleCount, 5);
  assert.equal(
    await database.getProfile(otherUser.id, "laptop"),
    null,
  );
  const profiles = await database.listProfiles(owner.id);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].profileId, "laptop");
  assert.equal(profiles[0].sampleCount, 5);
});

test("persists encrypted profiles and audit events across reopen", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-reopen-"));
  const databasePath = path.join(directory, "odysseus.sqlite");
  const masterKey = crypto.randomBytes(32);
  const first = await new OdysseusDatabase({
    databasePath,
    masterKey,
  }).init();
  const user = await first.createUser({
    username: "audit-user",
    passwordHash: await hashPassword("Correct-Horse-42"),
  });
  const session = await first.createSession(user.id);
  await first.setProfile(user.id, "desktop", {
    version: 1,
    featureKeys: ["flightMean"],
    means: { flightMean: 75 },
    deviations: { flightMean: 4 },
    scales: { flightMean: 4 },
    acceptanceThreshold: 1.5,
    calibration: { p90Distance: 1, maximumDistance: 1.2 },
    sampleCount: 5,
    enrolledAt: "2026-07-24T12:00:00.000Z",
  });
  await first.appendAudit({
    userId: user.id,
    sessionId: session.session.id,
    eventType: "profile.enroll",
    outcome: "success",
    metadata: { profileId: "desktop" },
  });
  await first.close();

  const second = await new OdysseusDatabase({
    databasePath,
    masterKey,
  }).init();
  context.after(async () => {
    if (second.initialized) {
      await second.close();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const profile = await second.getProfile(user.id, "desktop");
  const audit = await second.listAudit({ userId: user.id, limit: 10 });

  assert.equal(profile.template.means.flightMean, 75);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].eventType, "profile.enroll");
  assert.deepEqual(audit[0].metadata, { profileId: "desktop" });
});
