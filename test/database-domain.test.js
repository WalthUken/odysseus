"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { hashPassword, verifyPassword } = require("../src/auth");
const {
  OdysseusDatabase,
  DatabaseConflictError,
  SCHEMA_VERSION,
} = require("../src/database");
const { DomainValidationError } = require("../src/domain-validation");
const { POSTGRES_RLS_REQUIREMENTS } = require("../src/postgres-rls");

async function createDatabase() {
  const database = await new OdysseusDatabase({
    databasePath: ":memory:",
    masterKey: crypto.randomBytes(32),
  }).init();
  return database;
}

async function createUser(database, username = "domain-user") {
  return database.createUser({
    username,
    passwordHash: await hashPassword("Correct-Horse-42"),
  });
}

function deviceDescriptor(overrides = {}) {
  return {
    browserFamily: "chrome",
    deviceClass: "desktop",
    inputMode: "keyboard-pointer",
    localeLanguage: "en-CA",
    osFamily: "windows",
    timezoneOffsetMinutes: -270,
    ...overrides,
  };
}

function behaviorTemplate() {
  return {
    version: 1,
    featureKeys: ["dwellMean"],
    means: { dwellMean: 100 },
    deviations: { dwellMean: 4 },
    scales: { dwellMean: 4 },
    sampleCount: 5,
    enrolledAt: "2026-07-25T12:00:00.000Z",
  };
}

test("migration creates every extended domain table", async () => {
  const database = await createDatabase();
  try {
    assert.equal(SCHEMA_VERSION, 4);
    const rows = database.database
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
      `)
      .all();
    const names = new Set(rows.map((row) => row.name));
    for (const name of [
      "device_profile_links",
      "devices",
      "profile_transfers",
      "recovery_codes",
      "recovery_requests",
      "security_notifications",
      "webauthn_challenges",
      "webauthn_credentials",
    ]) {
      assert.equal(names.has(name), true, `Missing table ${name}`);
    }
    assert.equal(
      Number(database.database.prepare("PRAGMA user_version").get().user_version),
      4,
    );
    const deviceColumns = database.database
      .prepare("PRAGMA table_info(devices)")
      .all()
      .map((row) => row.name);
    assert.equal(deviceColumns.includes("client_fingerprint_digest"), true);
  } finally {
    await database.close();
  }
});

test("upgrades an existing version-one database without losing users", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "odysseus-migration-"));
  const databasePath = path.join(directory, "odysseus.sqlite");
  const masterKey = crypto.randomBytes(32);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const current = await new OdysseusDatabase({ databasePath, masterKey }).init();
  const user = await createUser(current, "migration-user");
  await current.close();

  const legacyShape = new DatabaseSync(databasePath);
  legacyShape.exec("PRAGMA foreign_keys = OFF;");
  for (const table of [
    "device_profile_links",
    "profile_transfers",
    "security_notifications",
    "recovery_requests",
    "recovery_codes",
    "webauthn_challenges",
    "webauthn_credentials",
    "devices",
  ]) {
    legacyShape.exec(`DROP TABLE ${table};`);
  }
  legacyShape.prepare("DELETE FROM schema_migrations WHERE version >= 2").run();
  legacyShape.exec("PRAGMA user_version = 1;");
  legacyShape.close();

  const upgraded = await new OdysseusDatabase({ databasePath, masterKey }).init();
  try {
    assert.equal((await upgraded.getUserById(user.id)).username, "migration-user");
    assert.equal(
      Number(upgraded.database.prepare("PRAGMA user_version").get().user_version),
      4,
    );
    assert.ok(
      upgraded.database
        .prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'devices'
        `)
        .get(),
    );
  } finally {
    await upgraded.close();
  }
});

test("upgrades a version-three device database without losing records", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odysseus-v3-migration-"),
  );
  const databasePath = path.join(directory, "odysseus.sqlite");
  const masterKey = crypto.randomBytes(32);
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const current = await new OdysseusDatabase({ databasePath, masterKey }).init();
  const user = await createUser(current, "v3-migration-user");
  const registered = await current.registerDevice(user.id, {
    label: "Existing device",
    descriptor: deviceDescriptor(),
  });
  await current.close();

  const legacyShape = new DatabaseSync(databasePath);
  legacyShape.exec("DROP INDEX devices_user_client_fingerprint_idx;");
  legacyShape.exec(
    "ALTER TABLE devices DROP COLUMN client_fingerprint_digest;",
  );
  legacyShape.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
  legacyShape.exec("PRAGMA user_version = 3;");
  legacyShape.close();

  const upgraded = await new OdysseusDatabase({ databasePath, masterKey }).init();
  try {
    assert.equal(
      Number(upgraded.database.prepare("PRAGMA user_version").get().user_version),
      4,
    );
    const restored = await upgraded.getDevice(user.id, registered.device.id);
    assert.equal(restored.label, "Existing device");
    const stored = upgraded.database
      .prepare(`
        SELECT client_fingerprint_digest
        FROM devices
        WHERE id = ?
      `)
      .get(registered.device.id);
    assert.equal(stored.client_fingerprint_digest, null);
  } finally {
    await upgraded.close();
  }
});

test("stores normalized devices with hashed tokens and scoped fingerprints", async () => {
  const database = await createDatabase();
  try {
    const firstUser = await createUser(database, "device-user-one");
    const secondUser = await createUser(database, "device-user-two");
    const visitorId = "0123456789abcdef0123456789abcdef";
    const first = await database.registerDevice(firstUser.id, {
      label: "Work laptop",
      descriptor: deviceDescriptor(),
      clientFingerprint: visitorId,
    });
    const second = await database.registerDevice(secondUser.id, {
      label: "Work laptop",
      descriptor: deviceDescriptor(),
      clientFingerprint: visitorId,
    });

    assert.equal(first.device.descriptor.timezoneOffsetMinutes, -240);
    assert.notEqual(
      first.device.fingerprintDigest,
      second.device.fingerprintDigest,
    );
    const stored = database.database
      .prepare(`
        SELECT token_hash, descriptor_json, client_fingerprint_digest
        FROM devices
        WHERE id = ?
      `)
      .get(first.device.id);
    const secondStored = database.database
      .prepare(`
        SELECT client_fingerprint_digest
        FROM devices
        WHERE id = ?
      `)
      .get(second.device.id);
    assert.equal(Buffer.from(stored.token_hash).length, 32);
    assert.equal(Buffer.from(stored.client_fingerprint_digest).length, 32);
    assert.notDeepEqual(
      Buffer.from(stored.client_fingerprint_digest),
      Buffer.from(visitorId, "ascii"),
    );
    assert.notDeepEqual(
      Buffer.from(stored.client_fingerprint_digest),
      Buffer.from(secondStored.client_fingerprint_digest),
    );
    assert.equal("clientFingerprint" in first.device, false);
    assert.equal("clientFingerprintDigest" in first.device, false);
    assert.equal(JSON.stringify(first).includes(visitorId), false);
    assert.equal(stored.descriptor_json.includes(visitorId), false);
    assert.equal(
      Buffer.from(stored.token_hash).includes(Buffer.from(first.token)),
      false,
    );
    assert.equal((await database.getDeviceByToken(first.token)).id, first.device.id);
    const rotated = await database.rotateDeviceToken(
      firstUser.id,
      first.device.id,
    );
    assert.equal(await database.getDeviceByToken(first.token), null);
    assert.equal(
      (await database.getDeviceByToken(rotated.token)).id,
      first.device.id,
    );
    assert.ok(new Date(rotated.expiresAt).getTime() > Date.now());
    assert.equal(
      await database.getDevice(secondUser.id, first.device.id),
      null,
    );
    await assert.rejects(
      database.registerDevice(firstUser.id, {
        label: "Unsafe",
        descriptor: {
          ...deviceDescriptor(),
          userAgent: "raw-user-agent",
        },
      }),
      DomainValidationError,
    );
  } finally {
    await database.close();
  }
});

test("evaluates coarse and optional client fingerprint signals privately", async () => {
  const database = await createDatabase();
  try {
    const owner = await createUser(database, "signal-owner");
    const other = await createUser(database, "signal-other");
    const visitorId = "0123456789abcdef0123456789abcdef";
    const changedVisitorId = "fedcba9876543210fedcba9876543210";
    const registered = await database.registerDevice(owner.id, {
      label: "Signal device",
      descriptor: deviceDescriptor(),
      clientFingerprint: visitorId,
    });
    const withoutClientFingerprint = await database.registerDevice(owner.id, {
      label: "Coarse only",
      descriptor: deviceDescriptor(),
    });

    assert.deepEqual(
      await database.evaluateDeviceSignals(
        owner.id,
        registered.device.id,
        deviceDescriptor(),
        visitorId.toUpperCase(),
      ),
      {
        coarseMatch: true,
        clientFingerprintState: "matched",
      },
    );
    assert.deepEqual(
      await database.evaluateDeviceSignals(
        owner.id,
        registered.device.id,
        deviceDescriptor({ browserFamily: "firefox" }),
        changedVisitorId,
      ),
      {
        coarseMatch: false,
        clientFingerprintState: "changed",
      },
    );
    assert.deepEqual(
      await database.evaluateDeviceSignals(
        owner.id,
        registered.device.id,
        deviceDescriptor(),
        null,
      ),
      {
        coarseMatch: true,
        clientFingerprintState: "unavailable",
      },
    );
    assert.deepEqual(
      await database.evaluateDeviceSignals(
        owner.id,
        withoutClientFingerprint.device.id,
        deviceDescriptor(),
        visitorId,
      ),
      {
        coarseMatch: true,
        clientFingerprintState: "unavailable",
      },
    );
    assert.equal(
      await database.evaluateDeviceSignals(
        other.id,
        registered.device.id,
        deviceDescriptor(),
        visitorId,
      ),
      null,
    );
    await assert.rejects(
      database.evaluateDeviceSignals(
        owner.id,
        registered.device.id,
        deviceDescriptor(),
        `${visitorId} `,
      ),
      DomainValidationError,
    );
    assert.equal(
      await database.revokeDevice(owner.id, registered.device.id),
      true,
    );
    assert.equal(
      await database.evaluateDeviceSignals(
        owner.id,
        registered.device.id,
        deviceDescriptor(),
        visitorId,
      ),
      null,
    );
  } finally {
    await database.close();
  }
});

test("does not persist a raw client visitor ID in SQLite files", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odysseus-fingerprint-leak-"),
  );
  const databasePath = path.join(directory, "odysseus.sqlite");
  const masterKey = crypto.randomBytes(32);
  const visitorId = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const database = await new OdysseusDatabase({ databasePath, masterKey }).init();
  const user = await createUser(database, "raw-fingerprint-check");
  const registered = await database.registerDevice(user.id, {
    label: "Private fingerprint",
    descriptor: deviceDescriptor(),
    clientFingerprint: visitorId,
  });
  assert.equal(JSON.stringify(registered).includes(visitorId), false);
  await database.close();

  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      const bytes = await fs.readFile(candidate);
      assert.equal(
        bytes.includes(Buffer.from(visitorId, "ascii")),
        false,
        `Raw visitor ID leaked into ${path.basename(candidate)}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
});

test("transfers profiles once and records the device association", async () => {
  const database = await createDatabase();
  try {
    const user = await createUser(database, "transfer-user");
    await database.setProfile(user.id, "primary", behaviorTemplate());
    const source = await database.registerDevice(user.id, {
      label: "Source",
      descriptor: deviceDescriptor(),
      profileId: "primary",
    });
    const target = await database.registerDevice(user.id, {
      label: "Target",
      descriptor: deviceDescriptor({ browserFamily: "firefox" }),
    });
    const created = await database.createProfileTransfer(user.id, {
      profileId: "primary",
      sourceDeviceId: source.device.id,
      targetDeviceId: target.device.id,
      metadata: { channel: "settings" },
    });
    const stored = database.database
      .prepare(`
        SELECT token_hash
        FROM profile_transfers
        WHERE id = ?
      `)
      .get(created.transfer.id);
    assert.equal(Buffer.from(stored.token_hash).length, 32);

    const completed = await database.consumeProfileTransfer(
      created.token,
      target.device.id,
    );
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.metadata, { channel: "settings" });
    assert.equal(
      await database.consumeProfileTransfer(created.token, target.device.id),
      null,
    );
    const associations = await database.listDeviceProfileAssociations(
      user.id,
      { deviceId: target.device.id },
    );
    assert.equal(associations.length, 1);
    assert.equal(associations[0].relationship, "transferred");
    assert.equal(associations[0].sourceDeviceId, source.device.id);
  } finally {
    await database.close();
  }
});

test("persists WebAuthn metadata and consumes hashed challenges once", async () => {
  const database = await createDatabase();
  try {
    const user = await createUser(database, "passkey-user");
    const credentialId = crypto.randomBytes(32);
    const credential = await database.createWebAuthnCredential(user.id, {
      credentialId,
      publicKey: crypto.randomBytes(96),
      counter: 1,
      aaguid: crypto.randomBytes(16),
      transports: ["internal", "hybrid"],
      userVerified: true,
      backupEligible: true,
      backupState: false,
      name: "Phone passkey",
    });
    assert.equal(credential.backupEligible, true);
    assert.equal(credential.backupState, false);

    const updated = await database.updateWebAuthnCredentialUsage(
      credentialId,
      {
        counter: 2,
        userVerified: true,
        backupState: true,
      },
    );
    assert.equal(updated.counter, 2);
    assert.equal(updated.backupState, true);
    await assert.rejects(
      database.updateWebAuthnCredentialUsage(credentialId, {
        counter: 2,
      }),
      DatabaseConflictError,
    );

    const challenge = await database.createWebAuthnChallenge({
      userId: user.id,
      ceremony: "registration",
      rpId: "example.com",
      origin: "https://example.com",
    });
    const stored = database.database
      .prepare(`
        SELECT challenge_hash
        FROM webauthn_challenges
        WHERE id = ?
      `)
      .get(challenge.record.id);
    assert.equal(Buffer.from(stored.challenge_hash).length, 32);
    assert.equal(
      Buffer.from(stored.challenge_hash).includes(
        Buffer.from(challenge.challenge),
      ),
      false,
    );
    const context = {
      ceremony: "registration",
      rpId: "example.com",
      origin: "https://example.com",
    };
    assert.equal(
      (await database.consumeWebAuthnChallenge(
        challenge.challenge,
        context,
      )).userId,
      user.id,
    );
    assert.equal(
      await database.consumeWebAuthnChallenge(challenge.challenge, context),
      null,
    );
  } finally {
    await database.close();
  }
});

test("uses recovery artifacts once and revokes sessions after password reset", async () => {
  const database = await createDatabase();
  try {
    const user = await createUser(database, "recovery-user");
    const recovery = await database.replaceRecoveryCodes(user.id, {
      count: 4,
    });
    assert.equal(recovery.codes.length, 4);
    assert.equal(
      database.database
        .prepare(`
          SELECT length(code_hash) AS length
          FROM recovery_codes
          LIMIT 1
        `)
        .get().length,
      32,
    );
    assert.equal(
      await database.consumeRecoveryCode(user.id, recovery.codes[0]),
      true,
    );
    assert.equal(
      await database.consumeRecoveryCode(user.id, recovery.codes[0]),
      false,
    );

    const session = await database.createSession(user.id);
    const request = await database.createRecoveryRequest(user.id, {
      purpose: "password_reset",
      context: { channel: "in-app" },
    });
    const replacementHash = await hashPassword("Different-Horse-84");
    const updatedUser = await database.completePasswordReset(
      request.token,
      replacementHash,
    );
    assert.equal(
      await verifyPassword("Different-Horse-84", updatedUser.passwordHash),
      true,
    );
    assert.equal(await database.getSessionWithUser(session.token), null);
    assert.equal(
      await database.completePasswordReset(request.token, replacementHash),
      null,
    );
  } finally {
    await database.close();
  }
});

test("keeps notifications account-scoped and account deletion comprehensive", async () => {
  const database = await createDatabase();
  try {
    const user = await createUser(database, "notification-user");
    const other = await createUser(database, "notification-other");
    await database.appendAudit({
      userId: user.id,
      eventType: "security.test",
    });
    const notification = await database.createSecurityNotification(user.id, {
      type: "password.changed",
      severity: "warning",
      title: "Password changed",
      body: "Your account password was changed.",
      metadata: { source: "recovery" },
    });
    assert.equal(await database.countUnreadSecurityNotifications(user.id), 1);
    assert.equal(
      await database.markSecurityNotificationRead(
        other.id,
        notification.id,
      ),
      false,
    );
    assert.equal(
      await database.markSecurityNotificationRead(
        user.id,
        notification.id,
      ),
      true,
    );

    const overview = await database.getAdminOverview();
    assert.equal(overview.users.total, 2);
    assert.equal(JSON.stringify(overview).includes(user.username), false);
    const deletion = await database.deleteAccount(user.id);
    assert.equal(deletion.deleted, true);
    assert.equal(await database.getUserById(user.id), null);
    assert.equal(
      Number(
        database.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM audit_events
            WHERE user_id = ?
          `)
          .get(user.id).count,
      ),
      0,
    );
    assert.ok(await database.getUserById(other.id));
  } finally {
    await database.close();
  }
});

test("documents mandatory PostgreSQL row-level security requirements", () => {
  assert.equal(POSTGRES_RLS_REQUIREMENTS.required, true);
  assert.ok(
    POSTGRES_RLS_REQUIREMENTS.accountScopedTables.includes("devices"),
  );
  assert.ok(
    POSTGRES_RLS_REQUIREMENTS.accountScopedTables.includes(
      "webauthn_credentials",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(POSTGRES_RLS_REQUIREMENTS),
    /disable row level security/i,
  );
});
