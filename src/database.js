"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  createSessionCredentials,
  normalizeUsername,
  parsePasswordHash,
} = require("./auth");
const { validateProfileId } = require("./behavior");
const {
  DEFAULT_MASTER_KEY_PATH,
  decryptJson,
  encryptJson,
  generateOpaqueToken,
  loadMasterKey,
  parseMasterKey,
  profileAdditionalData,
  sha256,
} = require("./crypto");
const {
  accountScopedClientFingerprintDigest,
  accountScopedFingerprintDigest,
  normalizeDeviceDescriptor,
  normalizeDeviceLabel,
  normalizeFingerprintVisitorId,
  normalizeTransferMetadata,
  timingSafeDigestEqual,
} = require("./device-security");
const {
  DomainValidationError,
  boundedJson,
  boundedString,
  safeInteger,
  strictBoolean,
} = require("./domain-validation");
const {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryPurpose,
  validateRecoveryCodeCount,
} = require("./account-recovery");
const {
  normalizeCeremony,
  normalizeCredential,
  normalizeCredentialId,
  normalizeOrigin,
  normalizeRpId,
} = require("./webauthn-data");

const DEFAULT_DATABASE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "odysseus.sqlite",
);
const SCHEMA_VERSION = 4;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_AUDIT_METADATA_BYTES = 16 * 1024;
const DEFAULT_DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MIN_DEVICE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEVICE_TOKEN_TTL_MS = 730 * 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_TRANSFER_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RECOVERY_REQUEST_TTL_MS = 15 * 60 * 1000;
const MIN_EPHEMERAL_TTL_MS = 60 * 1000;
const MAX_EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT
      ) STRICT;

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
        csrf_hash BLOB NOT NULL UNIQUE CHECK(length(csrf_hash) = 32),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        step_up_until TEXT,
        behavior_verified_until TEXT
      ) STRICT;

      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE behavior_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        template_ciphertext BLOB NOT NULL,
        template_iv BLOB NOT NULL CHECK(length(template_iv) = 12),
        template_auth_tag BLOB NOT NULL CHECK(length(template_auth_tag) = 16),
        template_version INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        feature_count INTEGER NOT NULL,
        enrolled_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, profile_id)
      ) STRICT;

      CREATE INDEX behavior_profiles_user_id_idx
        ON behavior_profiles(user_id);

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX audit_events_user_created_idx
        ON audit_events(user_id, created_at DESC);
      CREATE INDEX audit_events_created_idx
        ON audit_events(created_at DESC);

      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
        token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
        fingerprint_digest BLOB NOT NULL CHECK(length(fingerprint_digest) = 32),
        descriptor_json TEXT NOT NULL CHECK(length(descriptor_json) <= 2048),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX devices_user_id_idx ON devices(user_id);
      CREATE INDEX devices_user_fingerprint_idx
        ON devices(user_id, fingerprint_digest);

      CREATE TABLE webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id BLOB NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 1 AND 1024),
        public_key BLOB NOT NULL CHECK(length(public_key) BETWEEN 1 AND 4096),
        sign_count INTEGER NOT NULL CHECK(sign_count >= 0),
        aaguid BLOB CHECK(aaguid IS NULL OR length(aaguid) = 16),
        transports_json TEXT NOT NULL CHECK(length(transports_json) <= 512),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        user_verified INTEGER NOT NULL CHECK(user_verified IN (0, 1)),
        backup_eligible INTEGER NOT NULL CHECK(backup_eligible IN (0, 1)),
        backup_state INTEGER NOT NULL CHECK(backup_state IN (0, 1)),
        created_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE INDEX webauthn_credentials_user_id_idx
        ON webauthn_credentials(user_id);

      CREATE TABLE webauthn_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        challenge_hash BLOB NOT NULL UNIQUE CHECK(length(challenge_hash) = 32),
        ceremony TEXT NOT NULL CHECK(ceremony IN ('authentication', 'registration')),
        rp_id TEXT NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
        origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      ) STRICT;

      CREATE INDEX webauthn_challenges_expiry_idx
        ON webauthn_challenges(expires_at);
      CREATE INDEX webauthn_challenges_user_id_idx
        ON webauthn_challenges(user_id);

      CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash BLOB NOT NULL UNIQUE CHECK(length(code_hash) = 32),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        used_at TEXT,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX recovery_codes_user_id_idx
        ON recovery_codes(user_id);

      CREATE TABLE recovery_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
        purpose TEXT NOT NULL CHECK(purpose IN ('account_recovery', 'password_reset')),
        state TEXT NOT NULL CHECK(state IN ('pending', 'consumed', 'revoked', 'expired')),
        context_json TEXT CHECK(context_json IS NULL OR length(context_json) <= 4096),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX recovery_requests_user_state_idx
        ON recovery_requests(user_id, state);
      CREATE INDEX recovery_requests_expiry_idx
        ON recovery_requests(expires_at);

      CREATE TABLE security_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 80),
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
        metadata_json TEXT CHECK(metadata_json IS NULL OR length(metadata_json) <= 8192),
        created_at TEXT NOT NULL,
        read_at TEXT,
        dismissed_at TEXT
      ) STRICT;

      CREATE INDEX security_notifications_user_created_idx
        ON security_notifications(user_id, created_at DESC);

      CREATE TABLE profile_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        behavior_profile_id INTEGER NOT NULL REFERENCES behavior_profiles(id) ON DELETE CASCADE,
        source_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        target_device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash) = 32),
        state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'cancelled', 'expired')),
        metadata_json TEXT CHECK(metadata_json IS NULL OR length(metadata_json) <= 4096),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT
      ) STRICT;

      CREATE INDEX profile_transfers_user_created_idx
        ON profile_transfers(user_id, created_at DESC);
      CREATE INDEX profile_transfers_expiry_idx
        ON profile_transfers(expires_at);

      CREATE TABLE device_profile_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        behavior_profile_id INTEGER NOT NULL REFERENCES behavior_profiles(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL CHECK(relationship IN ('primary', 'secondary', 'transferred')),
        source_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        transfer_id INTEGER REFERENCES profile_transfers(id) ON DELETE SET NULL,
        associated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(device_id, behavior_profile_id)
      ) STRICT;

      CREATE INDEX device_profile_links_profile_idx
        ON device_profile_links(behavior_profile_id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE devices ADD COLUMN token_expires_at TEXT;
      UPDATE devices
      SET token_expires_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        created_at,
        '+365 days'
      )
      WHERE token_expires_at IS NULL;
      CREATE INDEX devices_token_expiry_idx ON devices(token_expires_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE devices ADD COLUMN client_fingerprint_digest BLOB
        CHECK(
          client_fingerprint_digest IS NULL
          OR length(client_fingerprint_digest) = 32
        );
      CREATE INDEX devices_user_client_fingerprint_idx
        ON devices(user_id, client_fingerprint_digest)
        WHERE client_fingerprint_digest IS NOT NULL;
    `,
  },
];

class DatabaseValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "DatabaseValidationError";
    this.code = "DATABASE_VALIDATION_ERROR";
    this.details = details;
  }
}

class DatabaseConflictError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DatabaseConflictError";
    this.code = "DATABASE_CONFLICT";
  }
}

function timestamp(value = new Date(), nullable = false) {
  if (nullable && (value === null || value === undefined || value === "")) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DatabaseValidationError("Timestamp value is invalid.");
  }
  return date.toISOString();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DatabaseValidationError(`${name} must be a positive integer.`);
  }
  return value;
}

function affectedRows(result) {
  return Number(result.changes);
}

function insertedId(result) {
  return Number(result.lastInsertRowid);
}

function mapUser(row) {
  if (!row) {
    return null;
  }
  const credentialHash = row.password_hash;
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: credentialHash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at ?? null,
  };
}

function mapSession(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.session_id ?? row.id),
    userId: Number(row.user_id),
    csrfHash: Buffer.from(row.csrf_hash),
    createdAt: row.session_created_at ?? row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    stepUpUntil: row.step_up_until ?? null,
    behaviorVerifiedUntil: row.behavior_verified_until ?? null,
  };
}

function mapProfileMetadata(row) {
  return {
    profileId: row.profile_id,
    sampleCount: Number(row.sample_count),
    featureCount: Number(row.feature_count),
    enrolledAt: row.enrolled_at,
    updatedAt: row.updated_at,
    templateVersion: Number(row.template_version),
  };
}

function mapAudit(row) {
  let metadata = null;
  if (row.metadata_json !== null && row.metadata_json !== undefined) {
    metadata = JSON.parse(row.metadata_json);
  }

  return {
    id: Number(row.id),
    userId: row.user_id === null ? null : Number(row.user_id),
    sessionId: row.session_id === null ? null : Number(row.session_id),
    eventType: row.event_type,
    outcome: row.outcome,
    reasonCode: row.reason_code ?? null,
    metadata,
    createdAt: row.created_at,
  };
}

function parseJsonColumn(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function mapDevice(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    label: row.label,
    fingerprintDigest: Buffer.from(row.fingerprint_digest).toString("base64url"),
    descriptor: parseJsonColumn(row.descriptor_json),
    tokenExpiresAt:
      row.token_expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? null,
  };
}

function mapWebAuthnCredential(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    credentialId: Buffer.from(row.credential_id),
    publicKey: Buffer.from(row.public_key),
    counter: Number(row.sign_count),
    aaguid: row.aaguid === null ? null : Buffer.from(row.aaguid),
    transports: parseJsonColumn(row.transports_json),
    name: row.name,
    userVerified: Boolean(row.user_verified),
    backupEligible: Boolean(row.backup_eligible),
    backupState: Boolean(row.backup_state),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

function mapWebAuthnChallenge(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: row.user_id === null ? null : Number(row.user_id),
    ceremony: row.ceremony,
    rpId: row.rp_id,
    origin: row.origin,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? null,
  };
}

function mapRecoveryRequest(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    purpose: row.purpose,
    state: row.state,
    context: parseJsonColumn(row.context_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

function mapNotification(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    metadata: parseJsonColumn(row.metadata_json),
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
    dismissedAt: row.dismissed_at ?? null,
  };
}

function mapTransfer(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    profileId: row.profile_id,
    sourceDeviceId: Number(row.source_device_id),
    targetDeviceId: row.target_device_id === null
      ? null
      : Number(row.target_device_id),
    state: row.state,
    metadata: parseJsonColumn(row.metadata_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
  };
}

function validateEphemeralTtl(ttlMs, name, defaultValue) {
  const value = ttlMs ?? defaultValue;
  if (
    !Number.isSafeInteger(value)
    || value < MIN_EPHEMERAL_TTL_MS
    || value > MAX_EPHEMERAL_TTL_MS
  ) {
    throw new DatabaseValidationError(
      `${name} must be between ${MIN_EPHEMERAL_TTL_MS} and ${MAX_EPHEMERAL_TTL_MS} milliseconds.`,
    );
  }
  return value;
}

function validateDeviceTokenTtl(ttlMs) {
  const value = ttlMs ?? DEFAULT_DEVICE_TOKEN_TTL_MS;
  if (
    !Number.isSafeInteger(value)
    || value < MIN_DEVICE_TOKEN_TTL_MS
    || value > MAX_DEVICE_TOKEN_TTL_MS
  ) {
    throw new DatabaseValidationError(
      `Device token ttlMs must be between ${MIN_DEVICE_TOKEN_TTL_MS} and ${MAX_DEVICE_TOKEN_TTL_MS} milliseconds.`,
    );
  }
  return value;
}

function validateOptionalExpiry(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const result = timestamp(value);
  if (result <= timestamp()) {
    throw new DatabaseValidationError("Expiration must be in the future.");
  }
  return result;
}

function validateSeverity(value) {
  const normalized = boundedString(value ?? "info", "severity", {
    maximum: 16,
  }).toLowerCase();
  if (!new Set(["critical", "info", "warning"]).has(normalized)) {
    throw new DomainValidationError("severity must be info, warning, or critical.");
  }
  return normalized;
}

function validatePasswordHash(passwordHash) {
  if (!parsePasswordHash(passwordHash)) {
    throw new DatabaseValidationError(
      "passwordHash must be a supported scrypt password hash.",
    );
  }
  return passwordHash;
}

function validateProfileTemplate(template) {
  if (
    template === null
    || typeof template !== "object"
    || Array.isArray(template)
  ) {
    throw new DatabaseValidationError("Behavior profile template must be an object.");
  }

  const forbiddenKeys = [
    "events",
    "keystrokes",
    "password",
    "rawEvents",
    "samples",
    "secret",
  ];
  for (const key of forbiddenKeys) {
    if (Object.hasOwn(template, key)) {
      throw new DatabaseValidationError(
        `Behavior profile template must not contain raw field "${key}".`,
      );
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(template);
  } catch (error) {
    throw new DatabaseValidationError(
      "Behavior profile template must be JSON serializable.",
      { cause: error.message },
    );
  }

  if (
    serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_BYTES
  ) {
    throw new DatabaseValidationError(
      `Behavior profile template must not exceed ${MAX_PROFILE_BYTES} bytes.`,
    );
  }

  return template;
}

function validateAuditText(value, name, options = {}) {
  if (options.nullable && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DatabaseValidationError(`${name} must be a string.`);
  }

  const normalized = value.trim();
  const maximum = options.maximum ?? 128;
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new DatabaseValidationError(
      `${name} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

class OdysseusDatabase {
  constructor(options = {}) {
    if (typeof options === "string") {
      options = { databasePath: options };
    }

    this.databasePath = options.databasePath ?? DEFAULT_DATABASE_PATH;
    if (this.databasePath !== ":memory:") {
      this.databasePath = path.resolve(this.databasePath);
    }
    this.masterKeyPath = path.resolve(
      options.masterKeyPath ?? DEFAULT_MASTER_KEY_PATH,
    );
    this.masterKeyInput = options.masterKey;
    this.env = options.env ?? process.env;
    this.database = null;
    this.masterKey = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return this;
    }

    if (this.masterKeyInput !== undefined) {
      this.masterKey = parseMasterKey(this.masterKeyInput);
    } else {
      this.masterKey = await loadMasterKey({
        env: this.env,
        keyPath: this.masterKeyPath,
      });
    }

    if (this.databasePath !== ":memory:") {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
    }

    try {
      this.database = new DatabaseSync(this.databasePath);
      this.database.exec("PRAGMA foreign_keys = ON;");
      this.database.exec("PRAGMA busy_timeout = 5000;");
      if (this.databasePath !== ":memory:") {
        this.database.exec("PRAGMA journal_mode = WAL;");
        this.database.exec("PRAGMA synchronous = NORMAL;");
      }
      this.runMigrations();
      this.initialized = true;
      return this;
    } catch (error) {
      if (this.database) {
        try {
          this.database.close();
        } catch {
          // The original initialization error is more useful.
        }
      }
      this.database = null;
      if (this.masterKey) {
        this.masterKey.fill(0);
        this.masterKey = null;
      }
      throw error;
    }
  }

  async close() {
    if (this.database) {
      this.database.close();
      this.database = null;
    }
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    this.initialized = false;
  }

  ensureInitialized() {
    if (!this.initialized || !this.database || !this.masterKey) {
      throw new Error("OdysseusDatabase.init() must be called before use.");
    }
  }

  runMigrations() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const appliedRows = this.database
      .prepare("SELECT version FROM schema_migrations")
      .all();
    const applied = new Set(appliedRows.map((row) => Number(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, timestamp());
        this.database.exec(`PRAGMA user_version = ${migration.version};`);
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }

    const currentVersion = Number(
      this.database.prepare("PRAGMA user_version").get().user_version,
    );
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`,
      );
    }
  }

  async createUser({ username, passwordHash }) {
    this.ensureInitialized();
    const normalizedUsername = normalizeUsername(username);
    validatePasswordHash(passwordHash);
    const now = timestamp();

    let result;
    try {
      result = this.database
        .prepare(`
          INSERT INTO users(username, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(normalizedUsername, passwordHash, now, now);
    } catch (error) {
      if (
        error.code === "ERR_SQLITE_ERROR"
        && /UNIQUE constraint failed: users\.username/.test(error.message)
      ) {
        throw new DatabaseConflictError("Username is already registered.", error);
      }
      throw error;
    }

    return this.getUserById(insertedId(result));
  }

  async getUserByUsername(username) {
    this.ensureInitialized();
    const normalizedUsername = normalizeUsername(username);
    const row = this.database
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(normalizedUsername);
    return mapUser(row);
  }

  async getUserById(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const row = this.database
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(userId);
    return mapUser(row);
  }

  async createSession(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(ttlMs)
      || ttlMs < MIN_SESSION_TTL_MS
      || ttlMs > MAX_SESSION_TTL_MS
    ) {
      throw new DatabaseValidationError(
        `Session ttlMs must be between ${MIN_SESSION_TTL_MS} and ${MAX_SESSION_TTL_MS}.`,
      );
    }

    const nowDate = new Date();
    const now = timestamp(nowDate);
    const expiresAt = timestamp(nowDate.getTime() + ttlMs);
    const credentials = createSessionCredentials();
    const result = this.database
      .prepare(`
        INSERT INTO sessions(
          user_id,
          token_hash,
          csrf_hash,
          created_at,
          last_seen_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        userId,
        credentials.tokenHash,
        credentials.csrfHash,
        now,
        now,
        expiresAt,
      );
    const sessionId = insertedId(result);

    const sessionValue = credentials.token;
    const antiCsrfValue = credentials.csrfToken;
    return {
      session: mapSession(
        this.database
          .prepare(`
            SELECT
              id AS session_id,
              user_id,
              csrf_hash,
              created_at AS session_created_at,
              last_seen_at,
              expires_at,
              step_up_until,
              behavior_verified_until
            FROM sessions
            WHERE id = ?
          `)
          .get(sessionId),
      ),
      token: sessionValue,
      csrfToken: antiCsrfValue,
    };
  }

  async getSessionWithUser(rawToken) {
    this.ensureInitialized();
    if (typeof rawToken !== "string" || rawToken.length < 20) {
      return null;
    }

    const row = this.database
      .prepare(`
        SELECT
          sessions.id AS session_id,
          sessions.user_id,
          sessions.csrf_hash,
          sessions.created_at AS session_created_at,
          sessions.last_seen_at,
          sessions.expires_at,
          sessions.step_up_until,
          sessions.behavior_verified_until,
          users.id AS joined_user_id,
          users.username,
          users.password_hash,
          users.created_at AS user_created_at,
          users.updated_at AS user_updated_at,
          users.disabled_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.expires_at > ?
          AND users.disabled_at IS NULL
      `)
      .get(sha256(rawToken), timestamp());

    if (!row) {
      return null;
    }

    const credentialHash = row.password_hash;
    return {
      session: mapSession(row),
      user: {
        id: Number(row.joined_user_id),
        username: row.username,
        passwordHash: credentialHash,
        createdAt: row.user_created_at,
        updatedAt: row.user_updated_at,
        disabledAt: row.disabled_at ?? null,
      },
    };
  }

  async touchSession(sessionId) {
    this.ensureInitialized();
    positiveInteger(sessionId, "sessionId");
    const result = this.database
      .prepare(`
        UPDATE sessions
        SET last_seen_at = ?
        WHERE id = ? AND expires_at > ?
      `)
      .run(timestamp(), sessionId, timestamp());
    return affectedRows(result) > 0;
  }

  async setStepUpUntil(sessionId, until) {
    return this.setSessionTimestamp(sessionId, "step_up_until", until);
  }

  async setBehaviorVerifiedUntil(sessionId, until) {
    return this.setSessionTimestamp(
      sessionId,
      "behavior_verified_until",
      until,
    );
  }

  async setSessionTimestamp(sessionId, column, until) {
    this.ensureInitialized();
    positiveInteger(sessionId, "sessionId");
    const allowedColumns = new Set([
      "behavior_verified_until",
      "step_up_until",
    ]);
    if (!allowedColumns.has(column)) {
      throw new DatabaseValidationError("Session timestamp column is invalid.");
    }

    const result = this.database
      .prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`)
      .run(timestamp(until, true), sessionId);
    return affectedRows(result) > 0;
  }

  async deleteSession(tokenOrSessionId) {
    this.ensureInitialized();
    let result;
    if (Number.isSafeInteger(tokenOrSessionId) && tokenOrSessionId > 0) {
      result = this.database
        .prepare("DELETE FROM sessions WHERE id = ?")
        .run(tokenOrSessionId);
    } else if (typeof tokenOrSessionId === "string") {
      result = this.database
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(sha256(tokenOrSessionId));
    } else {
      throw new DatabaseValidationError(
        "Session identifier must be a raw session token or positive integer ID.",
      );
    }
    return affectedRows(result) > 0;
  }

  async purgeExpiredSessions(before = new Date()) {
    this.ensureInitialized();
    const result = this.database
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(timestamp(before));
    return affectedRows(result);
  }

  async setProfile(userId, profileId, template) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedProfileId = validateProfileId(profileId);
    validateProfileTemplate(template);
    const additionalData = profileAdditionalData(userId, normalizedProfileId);
    const encrypted = encryptJson(template, this.masterKey, { additionalData });
    const now = timestamp();
    const enrolledAt = timestamp(template.enrolledAt ?? now);
    const templateVersion = Number.isSafeInteger(template.version)
      ? template.version
      : 1;
    const sampleCount = Number.isSafeInteger(template.sampleCount)
      ? template.sampleCount
      : 0;
    const featureCount = Array.isArray(template.featureKeys)
      ? template.featureKeys.length
      : 0;

    this.database
      .prepare(`
        INSERT INTO behavior_profiles(
          user_id,
          profile_id,
          template_ciphertext,
          template_iv,
          template_auth_tag,
          template_version,
          sample_count,
          feature_count,
          enrolled_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, profile_id) DO UPDATE SET
          template_ciphertext = excluded.template_ciphertext,
          template_iv = excluded.template_iv,
          template_auth_tag = excluded.template_auth_tag,
          template_version = excluded.template_version,
          sample_count = excluded.sample_count,
          feature_count = excluded.feature_count,
          enrolled_at = excluded.enrolled_at,
          updated_at = excluded.updated_at
      `)
      .run(
        userId,
        normalizedProfileId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        templateVersion,
        sampleCount,
        featureCount,
        enrolledAt,
        now,
      );

    const row = this.database
      .prepare(`
        SELECT
          profile_id,
          sample_count,
          feature_count,
          enrolled_at,
          updated_at,
          template_version
        FROM behavior_profiles
        WHERE user_id = ? AND profile_id = ?
      `)
      .get(userId, normalizedProfileId);
    return mapProfileMetadata(row);
  }

  async getProfile(userId, profileId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedProfileId = validateProfileId(profileId);
    const row = this.database
      .prepare(`
        SELECT *
        FROM behavior_profiles
        WHERE user_id = ? AND profile_id = ?
      `)
      .get(userId, normalizedProfileId);

    if (!row) {
      return null;
    }

    const template = decryptJson(
      {
        ciphertext: Buffer.from(row.template_ciphertext),
        iv: Buffer.from(row.template_iv),
        authTag: Buffer.from(row.template_auth_tag),
      },
      this.masterKey,
      {
        additionalData: profileAdditionalData(userId, normalizedProfileId),
      },
    );

    return {
      ...mapProfileMetadata(row),
      template,
    };
  }

  async listProfiles(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const rows = this.database
      .prepare(`
        SELECT
          profile_id,
          sample_count,
          feature_count,
          enrolled_at,
          updated_at,
          template_version
        FROM behavior_profiles
        WHERE user_id = ?
        ORDER BY profile_id
      `)
      .all(userId);
    return rows.map(mapProfileMetadata);
  }

  async deleteProfile(userId, profileId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedProfileId = validateProfileId(profileId);
    const result = this.database
      .prepare(`
        DELETE FROM behavior_profiles
        WHERE user_id = ? AND profile_id = ?
      `)
      .run(userId, normalizedProfileId);
    return affectedRows(result) > 0;
  }

  getOwnedDeviceRow(userId, deviceId, options = {}) {
    positiveInteger(userId, "userId");
    positiveInteger(deviceId, "deviceId");
    const revokedClause = options.includeRevoked ? "" : "AND revoked_at IS NULL";
    return this.database
      .prepare(`
        SELECT *
        FROM devices
        WHERE id = ? AND user_id = ? ${revokedClause}
      `)
      .get(deviceId, userId);
  }

  getOwnedProfileRow(userId, profileId) {
    const normalizedProfileId = validateProfileId(profileId);
    return this.database
      .prepare(`
        SELECT id, user_id, profile_id
        FROM behavior_profiles
        WHERE user_id = ? AND profile_id = ?
      `)
      .get(userId, normalizedProfileId);
  }

  async registerDevice(userId, input) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainValidationError("Device registration must be an object.");
    }

    const label = normalizeDeviceLabel(input.label);
    const descriptor = normalizeDeviceDescriptor(input.descriptor);
    const fingerprintDigest = accountScopedFingerprintDigest(
      userId,
      descriptor,
      this.masterKey,
    );
    const clientFingerprint = normalizeFingerprintVisitorId(
      input.clientFingerprint,
      { nullable: true },
    );
    const clientFingerprintDigest = clientFingerprint === null
      ? null
      : accountScopedClientFingerprintDigest(
        userId,
        clientFingerprint,
        this.masterKey,
      );
    const token =
      generateOpaqueToken(32);
    const tokenTtlMs =
      validateDeviceTokenTtl(input.ttlMs);
    const nowDate = new Date();
    const now = timestamp(nowDate);
    const tokenExpiresAt =
      timestamp(nowDate.getTime() + tokenTtlMs);
    const result = this.database
      .prepare(`
        INSERT INTO devices(
          user_id,
          label,
          token_hash,
          fingerprint_digest,
          client_fingerprint_digest,
          descriptor_json,
          created_at,
          last_seen_at,
          token_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        userId,
        label,
        sha256(token),
        fingerprintDigest,
        clientFingerprintDigest,
        JSON.stringify(descriptor),
        now,
        now,
        tokenExpiresAt,
      );
    const deviceId = insertedId(result);

    if (input.profileId !== undefined && input.profileId !== null) {
      await this.associateDeviceProfile(
        userId,
        deviceId,
        input.profileId,
        { relationship: "primary" },
      );
    }

    return {
      device: mapDevice(
        this.database.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId),
      ),
      token,
    };
  }

  async getDeviceByToken(rawToken) {
    this.ensureInitialized();
    if (typeof rawToken !== "string" || rawToken.length < 20) {
      return null;
    }
    const row = this.database
      .prepare(`
        SELECT *
        FROM devices
        WHERE token_hash = ?
          AND revoked_at IS NULL
          AND token_expires_at > ?
      `)
      .get(sha256(rawToken), timestamp());
    return mapDevice(row);
  }

  async getDevice(userId, deviceId, options = {}) {
    this.ensureInitialized();
    return mapDevice(this.getOwnedDeviceRow(userId, deviceId, options));
  }

  async listDevices(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const includeRevoked = options.includeRevoked === true;
    const rows = this.database
      .prepare(`
        SELECT *
        FROM devices
        WHERE user_id = ? ${includeRevoked ? "" : "AND revoked_at IS NULL"}
        ORDER BY created_at DESC, id DESC
      `)
      .all(userId);
    return rows.map(mapDevice);
  }

  async evaluateDeviceSignals(
    userId,
    deviceId,
    descriptor,
    clientFingerprint,
  ) {
    this.ensureInitialized();
    const row = this.getOwnedDeviceRow(userId, deviceId);
    if (!row) {
      return null;
    }

    const coarseDigest = accountScopedFingerprintDigest(
      userId,
      descriptor,
      this.masterKey,
    );
    const coarseMatch = timingSafeDigestEqual(
      Buffer.from(row.fingerprint_digest),
      coarseDigest,
    );
    const normalizedClientFingerprint = normalizeFingerprintVisitorId(
      clientFingerprint,
      { nullable: true },
    );

    let clientFingerprintState = "unavailable";
    if (
      row.client_fingerprint_digest !== null
      && row.client_fingerprint_digest !== undefined
      && normalizedClientFingerprint !== null
    ) {
      const candidateDigest = accountScopedClientFingerprintDigest(
        userId,
        normalizedClientFingerprint,
        this.masterKey,
      );
      clientFingerprintState = timingSafeDigestEqual(
        Buffer.from(row.client_fingerprint_digest),
        candidateDigest,
      )
        ? "matched"
        : "changed";
    }

    return {
      coarseMatch,
      clientFingerprintState,
    };
  }

  async touchDevice(userId, deviceId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(deviceId, "deviceId");
    const result = this.database
      .prepare(`
        UPDATE devices
        SET last_seen_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `)
      .run(timestamp(), deviceId, userId);
    return affectedRows(result) > 0;
  }

  async renameDevice(userId, deviceId, label) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(deviceId, "deviceId");
    const normalizedLabel = normalizeDeviceLabel(label);
    const result = this.database
      .prepare(`
        UPDATE devices
        SET label = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `)
      .run(normalizedLabel, deviceId, userId);
    return affectedRows(result) > 0;
  }

  async rotateDeviceToken(userId, deviceId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(deviceId, "deviceId");
    const tokenTtlMs =
      validateDeviceTokenTtl(options.ttlMs);
    const token =
      generateOpaqueToken(32);
    const expiresAt = timestamp(Date.now() + tokenTtlMs);
    const result = this.database
      .prepare(`
        UPDATE devices
        SET token_hash = ?, token_expires_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `)
      .run(sha256(token), expiresAt, deviceId, userId);
    if (affectedRows(result) !== 1) {
      return null;
    }
    return {
      token,
      expiresAt,
      device: mapDevice(
        this.database.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId),
      ),
    };
  }

  async revokeDevice(userId, deviceId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(deviceId, "deviceId");
    const now = timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.database
        .prepare(`
          UPDATE devices
          SET revoked_at = ?
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        `)
        .run(now, deviceId, userId);
      if (affectedRows(result) > 0) {
        this.database
          .prepare(`
            UPDATE profile_transfers
            SET state = 'cancelled', cancelled_at = ?
            WHERE user_id = ?
              AND state = 'pending'
              AND (source_device_id = ? OR target_device_id = ?)
          `)
          .run(now, userId, deviceId, deviceId);
      }
      this.database.exec("COMMIT;");
      return affectedRows(result) > 0;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async associateDeviceProfile(userId, deviceId, profileId, options = {}) {
    this.ensureInitialized();
    const device = this.getOwnedDeviceRow(userId, deviceId);
    if (!device) {
      throw new DatabaseValidationError("Active device was not found.");
    }
    const profile = this.getOwnedProfileRow(userId, profileId);
    if (!profile) {
      throw new DatabaseValidationError("Behavior profile was not found.");
    }

    const relationship = boundedString(
      options.relationship ?? "secondary",
      "relationship",
      { maximum: 16 },
    ).toLowerCase();
    if (!new Set(["primary", "secondary", "transferred"]).has(relationship)) {
      throw new DomainValidationError("Device profile relationship is invalid.");
    }

    let sourceDeviceId = null;
    if (options.sourceDeviceId !== undefined && options.sourceDeviceId !== null) {
      sourceDeviceId = positiveInteger(options.sourceDeviceId, "sourceDeviceId");
      if (!this.getOwnedDeviceRow(userId, sourceDeviceId, { includeRevoked: true })) {
        throw new DatabaseValidationError("Source device was not found.");
      }
    }
    const transferId = options.transferId === undefined || options.transferId === null
      ? null
      : positiveInteger(options.transferId, "transferId");
    if (transferId !== null) {
      const transfer = this.database
        .prepare(`
          SELECT *
          FROM profile_transfers
          WHERE id = ?
            AND user_id = ?
            AND behavior_profile_id = ?
            AND state = 'completed'
        `)
        .get(transferId, userId, profile.id);
      if (!transfer) {
        throw new DatabaseValidationError(
          "Completed account-scoped profile transfer was not found.",
        );
      }
      if (
        sourceDeviceId !== null
        && Number(transfer.source_device_id) !== sourceDeviceId
      ) {
        throw new DatabaseValidationError(
          "Source device does not match the profile transfer.",
        );
      }
    }
    const now = timestamp();

    this.database
      .prepare(`
        INSERT INTO device_profile_links(
          device_id,
          behavior_profile_id,
          relationship,
          source_device_id,
          transfer_id,
          associated_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, behavior_profile_id) DO UPDATE SET
          relationship = excluded.relationship,
          source_device_id = excluded.source_device_id,
          transfer_id = excluded.transfer_id,
          updated_at = excluded.updated_at
      `)
      .run(
        deviceId,
        profile.id,
        relationship,
        sourceDeviceId,
        transferId,
        now,
        now,
      );

    return {
      deviceId,
      profileId: profile.profile_id,
      relationship,
      sourceDeviceId,
      transferId,
      associatedAt: now,
    };
  }

  async listDeviceProfileAssociations(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const clauses = ["devices.user_id = ?"];
    const parameters = [userId];
    if (options.deviceId !== undefined) {
      clauses.push("devices.id = ?");
      parameters.push(positiveInteger(options.deviceId, "deviceId"));
    }
    if (options.profileId !== undefined) {
      clauses.push("behavior_profiles.profile_id = ?");
      parameters.push(validateProfileId(options.profileId));
    }
    const rows = this.database
      .prepare(`
        SELECT
          device_profile_links.*,
          behavior_profiles.profile_id
        FROM device_profile_links
        JOIN devices ON devices.id = device_profile_links.device_id
        JOIN behavior_profiles
          ON behavior_profiles.id = device_profile_links.behavior_profile_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY device_profile_links.associated_at DESC
      `)
      .all(...parameters);
    return rows.map((row) => ({
      deviceId: Number(row.device_id),
      profileId: row.profile_id,
      relationship: row.relationship,
      sourceDeviceId: row.source_device_id === null
        ? null
        : Number(row.source_device_id),
      transferId: row.transfer_id === null ? null : Number(row.transfer_id),
      associatedAt: row.associated_at,
      updatedAt: row.updated_at,
    }));
  }

  async createProfileTransfer(userId, input) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainValidationError("Profile transfer must be an object.");
    }
    const sourceDeviceId = positiveInteger(
      input.sourceDeviceId,
      "sourceDeviceId",
    );
    if (!this.getOwnedDeviceRow(userId, sourceDeviceId)) {
      throw new DatabaseValidationError("Active source device was not found.");
    }
    const profile = this.getOwnedProfileRow(userId, input.profileId);
    if (!profile) {
      throw new DatabaseValidationError("Behavior profile was not found.");
    }

    let targetDeviceId = null;
    if (input.targetDeviceId !== undefined && input.targetDeviceId !== null) {
      targetDeviceId = positiveInteger(input.targetDeviceId, "targetDeviceId");
      if (targetDeviceId === sourceDeviceId) {
        throw new DomainValidationError(
          "Source and target devices must be different.",
        );
      }
      if (!this.getOwnedDeviceRow(userId, targetDeviceId)) {
        throw new DatabaseValidationError("Active target device was not found.");
      }
    }

    const ttlMs = validateEphemeralTtl(
      input.ttlMs,
      "Profile transfer ttlMs",
      DEFAULT_DEVICE_TRANSFER_TTL_MS,
    );
    const metadata = normalizeTransferMetadata(input.metadata);
    const token =
      generateOpaqueToken(32);
    const nowDate = new Date();
    const now = timestamp(nowDate);
    const expiresAt = timestamp(nowDate.getTime() + ttlMs);
    const result = this.database
      .prepare(`
        INSERT INTO profile_transfers(
          user_id,
          behavior_profile_id,
          source_device_id,
          target_device_id,
          token_hash,
          state,
          metadata_json,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(
        userId,
        profile.id,
        sourceDeviceId,
        targetDeviceId,
        sha256(token),
        metadata.json,
        now,
        expiresAt,
      );
    const transfer = this.database
      .prepare(`
        SELECT profile_transfers.*, behavior_profiles.profile_id
        FROM profile_transfers
        JOIN behavior_profiles
          ON behavior_profiles.id = profile_transfers.behavior_profile_id
        WHERE profile_transfers.id = ?
      `)
      .get(insertedId(result));
    return { transfer: mapTransfer(transfer), token };
  }

  async consumeProfileTransfer(rawToken, targetDeviceId) {
    this.ensureInitialized();
    if (typeof rawToken !== "string" || rawToken.length < 20) {
      return null;
    }
    positiveInteger(targetDeviceId, "targetDeviceId");
    const now = timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(`
          SELECT profile_transfers.*, behavior_profiles.profile_id
          FROM profile_transfers
          JOIN behavior_profiles
            ON behavior_profiles.id = profile_transfers.behavior_profile_id
          WHERE token_hash = ?
        `)
        .get(sha256(rawToken));
      if (
        !row
        || row.state !== "pending"
        || row.expires_at <= now
        || (
          row.target_device_id !== null
          && Number(row.target_device_id) !== targetDeviceId
        )
        || !this.getOwnedDeviceRow(Number(row.user_id), targetDeviceId)
      ) {
        if (row && row.state === "pending" && row.expires_at <= now) {
          this.database
            .prepare(`
              UPDATE profile_transfers
              SET state = 'expired'
              WHERE id = ? AND state = 'pending'
            `)
            .run(row.id);
        }
        this.database.exec("COMMIT;");
        return null;
      }

      const update = this.database
        .prepare(`
          UPDATE profile_transfers
          SET
            state = 'completed',
            target_device_id = ?,
            completed_at = ?
          WHERE id = ? AND state = 'pending' AND expires_at > ?
        `)
        .run(targetDeviceId, now, row.id, now);
      if (affectedRows(update) !== 1) {
        this.database.exec("ROLLBACK;");
        return null;
      }

      this.database
        .prepare(`
          INSERT INTO device_profile_links(
            device_id,
            behavior_profile_id,
            relationship,
            source_device_id,
            transfer_id,
            associated_at,
            updated_at
          ) VALUES (?, ?, 'transferred', ?, ?, ?, ?)
          ON CONFLICT(device_id, behavior_profile_id) DO UPDATE SET
            relationship = 'transferred',
            source_device_id = excluded.source_device_id,
            transfer_id = excluded.transfer_id,
            updated_at = excluded.updated_at
        `)
        .run(
          targetDeviceId,
          row.behavior_profile_id,
          row.source_device_id,
          row.id,
          now,
          now,
        );
      const completed = this.database
        .prepare(`
          SELECT profile_transfers.*, behavior_profiles.profile_id
          FROM profile_transfers
          JOIN behavior_profiles
            ON behavior_profiles.id = profile_transfers.behavior_profile_id
          WHERE profile_transfers.id = ?
        `)
        .get(row.id);
      this.database.exec("COMMIT;");
      return mapTransfer(completed);
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async cancelProfileTransfer(userId, transferId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(transferId, "transferId");
    const result = this.database
      .prepare(`
        UPDATE profile_transfers
        SET state = 'cancelled', cancelled_at = ?
        WHERE id = ? AND user_id = ? AND state = 'pending'
      `)
      .run(timestamp(), transferId, userId);
    return affectedRows(result) > 0;
  }

  async listProfileTransfers(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const limit = safeInteger(options.limit ?? 50, "limit", {
      minimum: 1,
      maximum: 200,
    });
    const parameters = [userId];
    let stateClause = "";
    if (options.state !== undefined) {
      const state = boundedString(options.state, "transfer state", {
        maximum: 16,
      }).toLowerCase();
      if (!new Set(["cancelled", "completed", "expired", "pending"]).has(state)) {
        throw new DomainValidationError("Transfer state is invalid.");
      }
      stateClause = "AND profile_transfers.state = ?";
      parameters.push(state);
    }
    parameters.push(limit);
    const rows = this.database
      .prepare(`
        SELECT profile_transfers.*, behavior_profiles.profile_id
        FROM profile_transfers
        JOIN behavior_profiles
          ON behavior_profiles.id = profile_transfers.behavior_profile_id
        WHERE profile_transfers.user_id = ? ${stateClause}
        ORDER BY profile_transfers.created_at DESC, profile_transfers.id DESC
        LIMIT ?
      `)
      .all(...parameters);
    return rows.map(mapTransfer);
  }

  async purgeExpiredProfileTransfers(before = new Date()) {
    this.ensureInitialized();
    const result = this.database
      .prepare(`
        UPDATE profile_transfers
        SET state = 'expired'
        WHERE state = 'pending' AND expires_at <= ?
      `)
      .run(timestamp(before));
    return affectedRows(result);
  }

  async createWebAuthnCredential(userId, input) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const credential = normalizeCredential(input);
    const now = timestamp();
    let result;
    try {
      result = this.database
        .prepare(`
          INSERT INTO webauthn_credentials(
            user_id,
            credential_id,
            public_key,
            sign_count,
            aaguid,
            transports_json,
            name,
            user_verified,
            backup_eligible,
            backup_state,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          userId,
          credential.credentialId,
          credential.publicKey,
          credential.counter,
          credential.aaguid,
          JSON.stringify(credential.transports),
          credential.name,
          Number(credential.userVerified),
          Number(credential.backupEligible),
          Number(credential.backupState),
          now,
        );
    } catch (error) {
      if (
        error.code === "ERR_SQLITE_ERROR"
        && /UNIQUE constraint failed: webauthn_credentials\.credential_id/.test(
          error.message,
        )
      ) {
        throw new DatabaseConflictError(
          "WebAuthn credential is already registered.",
          error,
        );
      }
      throw error;
    }
    return mapWebAuthnCredential(
      this.database
        .prepare("SELECT * FROM webauthn_credentials WHERE id = ?")
        .get(insertedId(result)),
    );
  }

  async getWebAuthnCredential(credentialId) {
    this.ensureInitialized();
    const normalizedId = normalizeCredentialId(credentialId);
    const row = this.database
      .prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
      .get(normalizedId);
    return mapWebAuthnCredential(row);
  }

  async listWebAuthnCredentials(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const rows = this.database
      .prepare(`
        SELECT *
        FROM webauthn_credentials
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
      `)
      .all(userId);
    return rows.map(mapWebAuthnCredential);
  }

  async updateWebAuthnCredentialUsage(credentialId, assertion) {
    this.ensureInitialized();
    if (
      assertion === null
      || typeof assertion !== "object"
      || Array.isArray(assertion)
    ) {
      throw new DomainValidationError("WebAuthn assertion state must be an object.");
    }
    const normalizedId = normalizeCredentialId(credentialId);
    const counter = safeInteger(assertion.counter, "counter");
    const row = this.database
      .prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
      .get(normalizedId);
    if (!row) {
      return null;
    }
    const storedCounter = Number(row.sign_count);
    if (
      (storedCounter > 0 || counter > 0)
      && counter <= storedCounter
    ) {
      throw new DatabaseConflictError(
        "WebAuthn signature counter did not increase.",
      );
    }

    const userVerified = strictBoolean(
      assertion.userVerified,
      "userVerified",
      Boolean(row.user_verified),
    );
    const backupState = strictBoolean(
      assertion.backupState,
      "backupState",
      Boolean(row.backup_state),
    );
    if (backupState && !Boolean(row.backup_eligible)) {
      throw new DomainValidationError(
        "backupState cannot be true for a non-backup-eligible credential.",
      );
    }
    this.database
      .prepare(`
        UPDATE webauthn_credentials
        SET
          sign_count = ?,
          user_verified = ?,
          backup_state = ?,
          last_used_at = ?
        WHERE credential_id = ?
      `)
      .run(
        counter,
        Number(userVerified),
        Number(backupState),
        timestamp(),
        normalizedId,
      );
    return this.getWebAuthnCredential(normalizedId);
  }

  async renameWebAuthnCredential(userId, credentialId, name) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedId = normalizeCredentialId(credentialId);
    const normalizedName = boundedString(name, "credential name", {
      maximum: 80,
    });
    const result = this.database
      .prepare(`
        UPDATE webauthn_credentials
        SET name = ?
        WHERE user_id = ? AND credential_id = ?
      `)
      .run(normalizedName, userId, normalizedId);
    return affectedRows(result) > 0;
  }

  async deleteWebAuthnCredential(userId, credentialId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedId = normalizeCredentialId(credentialId);
    const result = this.database
      .prepare(`
        DELETE FROM webauthn_credentials
        WHERE user_id = ? AND credential_id = ?
      `)
      .run(userId, normalizedId);
    return affectedRows(result) > 0;
  }

  async createWebAuthnChallenge(input) {
    this.ensureInitialized();
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainValidationError("WebAuthn challenge input must be an object.");
    }
    const userId = input.userId === null || input.userId === undefined
      ? null
      : positiveInteger(input.userId, "userId");
    const ceremony = normalizeCeremony(input.ceremony);
    if (ceremony === "registration" && userId === null) {
      throw new DomainValidationError(
        "Registration challenges require a userId.",
      );
    }
    const rpId = normalizeRpId(input.rpId);
    const origin = normalizeOrigin(input.origin);
    const ttlMs = validateEphemeralTtl(
      input.ttlMs,
      "WebAuthn challenge ttlMs",
      DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS,
    );
    const challenge = generateOpaqueToken(32);
    const nowDate = new Date();
    const now = timestamp(nowDate);
    const result = this.database
      .prepare(`
        INSERT INTO webauthn_challenges(
          user_id,
          challenge_hash,
          ceremony,
          rp_id,
          origin,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        userId,
        sha256(challenge),
        ceremony,
        rpId,
        origin,
        now,
        timestamp(nowDate.getTime() + ttlMs),
      );
    const record = this.database
      .prepare("SELECT * FROM webauthn_challenges WHERE id = ?")
      .get(insertedId(result));
    return {
      challenge: challenge,
      record: mapWebAuthnChallenge(record),
    };
  }

  async consumeWebAuthnChallenge(rawChallenge, expected) {
    this.ensureInitialized();
    if (typeof rawChallenge !== "string" || rawChallenge.length < 20) {
      return null;
    }
    if (
      expected === null
      || typeof expected !== "object"
      || Array.isArray(expected)
    ) {
      throw new DomainValidationError(
        "Expected WebAuthn challenge context must be an object.",
      );
    }
    const ceremony = normalizeCeremony(expected.ceremony);
    const rpId = normalizeRpId(expected.rpId);
    const origin = normalizeOrigin(expected.origin);
    const now = timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(`
          SELECT *
          FROM webauthn_challenges
          WHERE challenge_hash = ?
            AND ceremony = ?
            AND rp_id = ?
            AND origin = ?
            AND used_at IS NULL
            AND expires_at > ?
        `)
        .get(sha256(rawChallenge), ceremony, rpId, origin, now);
      if (!row) {
        this.database.exec("COMMIT;");
        return null;
      }
      const updated = this.database
        .prepare(`
          UPDATE webauthn_challenges
          SET used_at = ?
          WHERE id = ? AND used_at IS NULL AND expires_at > ?
        `)
        .run(now, row.id, now);
      if (affectedRows(updated) !== 1) {
        this.database.exec("ROLLBACK;");
        return null;
      }
      this.database.exec("COMMIT;");
      return {
        ...mapWebAuthnChallenge(row),
        usedAt: now,
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async purgeWebAuthnChallenges(before = new Date()) {
    this.ensureInitialized();
    const cutoff = timestamp(before);
    const result = this.database
      .prepare(`
        DELETE FROM webauthn_challenges
        WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)
      `)
      .run(cutoff, cutoff);
    return affectedRows(result);
  }

  async replaceRecoveryCodes(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const count = validateRecoveryCodeCount(options.count ?? 10);
    const expiresAt = validateOptionalExpiry(options.expiresAt);
    const codes = [];
    const now = timestamp();

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare("DELETE FROM recovery_codes WHERE user_id = ?")
        .run(userId);
      const insert = this.database.prepare(`
        INSERT INTO recovery_codes(
          user_id,
          code_hash,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (let index = 0; index < count; index += 1) {
        const code = generateRecoveryCode();
        insert.run(userId, hashRecoveryCode(code), now, expiresAt);
        codes.push(code);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }

    return {
      codes,
      count,
      createdAt: now,
      expiresAt,
    };
  }

  async consumeRecoveryCode(userId, rawCode) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    let codeHash;
    try {
      codeHash = hashRecoveryCode(rawCode);
    } catch (error) {
      if (error instanceof DomainValidationError) {
        return false;
      }
      throw error;
    }
    const now = timestamp();
    const result = this.database
      .prepare(`
        UPDATE recovery_codes
        SET used_at = ?
        WHERE user_id = ?
          AND code_hash = ?
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `)
      .run(now, userId, codeHash, now);
    return affectedRows(result) === 1;
  }

  async getRecoveryCodeSummary(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const row = this.database
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(
            CASE
              WHEN used_at IS NULL
                AND revoked_at IS NULL
                AND (expires_at IS NULL OR expires_at > ?)
              THEN 1 ELSE 0
            END
          ) AS remaining,
          MAX(created_at) AS created_at,
          MAX(expires_at) AS expires_at
        FROM recovery_codes
        WHERE user_id = ?
      `)
      .get(timestamp(), userId);
    return {
      total: Number(row.total),
      remaining: Number(row.remaining ?? 0),
      createdAt: row.created_at ?? null,
      expiresAt: row.expires_at ?? null,
    };
  }

  async revokeRecoveryCodes(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const result = this.database
      .prepare(`
        UPDATE recovery_codes
        SET revoked_at = ?
        WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL
      `)
      .run(timestamp(), userId);
    return affectedRows(result);
  }

  async createRecoveryRequest(userId, input = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const purpose = normalizeRecoveryPurpose(
      input.purpose ?? "password_reset",
    );
    const ttlMs = validateEphemeralTtl(
      input.ttlMs,
      "Recovery request ttlMs",
      DEFAULT_RECOVERY_REQUEST_TTL_MS,
    );
    const context = boundedJson(input.context, "recovery context", 4096);
    const token =
      generateOpaqueToken(32);
    const nowDate = new Date();
    const now = timestamp(nowDate);
    const expiresAt = timestamp(nowDate.getTime() + ttlMs);

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'revoked', revoked_at = ?
          WHERE user_id = ? AND purpose = ? AND state = 'pending'
        `)
        .run(now, userId, purpose);
      const result = this.database
        .prepare(`
          INSERT INTO recovery_requests(
            user_id,
            token_hash,
            purpose,
            state,
            context_json,
            created_at,
            expires_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
        `)
        .run(
          userId,
          sha256(token),
          purpose,
          context.json,
          now,
          expiresAt,
        );
      const record = this.database
        .prepare("SELECT * FROM recovery_requests WHERE id = ?")
        .get(insertedId(result));
      this.database.exec("COMMIT;");
      return {
        token,
        request: mapRecoveryRequest(record),
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async consumeRecoveryRequest(rawToken, options = {}) {
    this.ensureInitialized();
    if (typeof rawToken !== "string" || rawToken.length < 20) {
      return null;
    }
    const purpose = normalizeRecoveryPurpose(
      options.purpose ?? "account_recovery",
    );
    const now = timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(`
          SELECT *
          FROM recovery_requests
          WHERE token_hash = ?
            AND purpose = ?
            AND state = 'pending'
            AND expires_at > ?
        `)
        .get(sha256(rawToken), purpose, now);
      if (!row) {
        this.database
          .prepare(`
            UPDATE recovery_requests
            SET state = 'expired'
            WHERE token_hash = ?
              AND state = 'pending'
              AND expires_at <= ?
          `)
          .run(sha256(rawToken), now);
        this.database.exec("COMMIT;");
        return null;
      }
      const result = this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'consumed', consumed_at = ?
          WHERE id = ? AND state = 'pending' AND expires_at > ?
        `)
        .run(now, row.id, now);
      if (affectedRows(result) !== 1) {
        this.database.exec("ROLLBACK;");
        return null;
      }
      this.database.exec("COMMIT;");
      return {
        ...mapRecoveryRequest(row),
        state: "consumed",
        consumedAt: now,
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async completePasswordReset(rawToken, passwordHash) {
    this.ensureInitialized();
    validatePasswordHash(passwordHash);
    if (typeof rawToken !== "string" || rawToken.length < 20) {
      return null;
    }
    const now = timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.database
        .prepare(`
          SELECT *
          FROM recovery_requests
          WHERE token_hash = ?
            AND purpose = 'password_reset'
            AND state = 'pending'
            AND expires_at > ?
        `)
        .get(sha256(rawToken), now);
      if (!row) {
        this.database.exec("COMMIT;");
        return null;
      }
      const consumed = this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'consumed', consumed_at = ?
          WHERE id = ? AND state = 'pending' AND expires_at > ?
        `)
        .run(now, row.id, now);
      if (affectedRows(consumed) !== 1) {
        this.database.exec("ROLLBACK;");
        return null;
      }
      this.database
        .prepare(`
          UPDATE users
          SET password_hash = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(passwordHash, now, row.user_id);
      this.database
        .prepare("DELETE FROM sessions WHERE user_id = ?")
        .run(row.user_id);
      this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'revoked', revoked_at = ?
          WHERE user_id = ? AND state = 'pending'
        `)
        .run(now, row.user_id);
      const user = mapUser(
        this.database
          .prepare("SELECT * FROM users WHERE id = ?")
          .get(row.user_id),
      );
      this.database.exec("COMMIT;");
      return user;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async listRecoveryRequests(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const limit = safeInteger(options.limit ?? 50, "limit", {
      minimum: 1,
      maximum: 200,
    });
    const rows = this.database
      .prepare(`
        SELECT *
        FROM recovery_requests
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(userId, limit);
    return rows.map(mapRecoveryRequest);
  }

  async revokeRecoveryRequests(userId, purpose) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const normalizedPurpose = purpose === undefined
      ? null
      : normalizeRecoveryPurpose(purpose);
    const now = timestamp();
    const result = normalizedPurpose === null
      ? this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'revoked', revoked_at = ?
          WHERE user_id = ? AND state = 'pending'
        `)
        .run(now, userId)
      : this.database
        .prepare(`
          UPDATE recovery_requests
          SET state = 'revoked', revoked_at = ?
          WHERE user_id = ? AND purpose = ? AND state = 'pending'
        `)
        .run(now, userId, normalizedPurpose);
    return affectedRows(result);
  }

  async purgeExpiredRecoveryState(before = new Date()) {
    this.ensureInitialized();
    const cutoff = timestamp(before);
    this.database
      .prepare(`
        UPDATE recovery_requests
        SET state = 'expired'
        WHERE state = 'pending' AND expires_at <= ?
      `)
      .run(cutoff);
    const requestResult = this.database
      .prepare(`
        DELETE FROM recovery_requests
        WHERE state IN ('consumed', 'revoked', 'expired')
          AND COALESCE(consumed_at, revoked_at, expires_at) <= ?
      `)
      .run(cutoff);
    const codeResult = this.database
      .prepare(`
        DELETE FROM recovery_codes
        WHERE (expires_at IS NOT NULL AND expires_at <= ?)
          OR (used_at IS NOT NULL AND used_at <= ?)
          OR (revoked_at IS NOT NULL AND revoked_at <= ?)
      `)
      .run(cutoff, cutoff, cutoff);
    return {
      recoveryRequests: affectedRows(requestResult),
      recoveryCodes: affectedRows(codeResult),
    };
  }

  async createSecurityNotification(userId, input) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainValidationError("Security notification must be an object.");
    }
    const type = boundedString(input.type, "notification type", {
      maximum: 80,
      pattern: /^[A-Za-z][A-Za-z0-9._-]*$/,
    }).toLowerCase();
    const severity = validateSeverity(input.severity);
    const title = boundedString(input.title, "notification title", {
      maximum: 120,
    });
    const body = boundedString(input.body, "notification body", {
      maximum: 1000,
    });
    const metadata = boundedJson(
      input.metadata,
      "notification metadata",
      8192,
    );
    const result = this.database
      .prepare(`
        INSERT INTO security_notifications(
          user_id,
          type,
          severity,
          title,
          body,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        userId,
        type,
        severity,
        title,
        body,
        metadata.json,
        timestamp(),
      );
    return mapNotification(
      this.database
        .prepare("SELECT * FROM security_notifications WHERE id = ?")
        .get(insertedId(result)),
    );
  }

  async listSecurityNotifications(userId, options = {}) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const limit = safeInteger(options.limit ?? 50, "limit", {
      minimum: 1,
      maximum: 200,
    });
    const includeDismissed = options.includeDismissed === true;
    const unreadOnly = options.unreadOnly === true;
    const clauses = ["user_id = ?"];
    if (!includeDismissed) {
      clauses.push("dismissed_at IS NULL");
    }
    if (unreadOnly) {
      clauses.push("read_at IS NULL");
    }
    const rows = this.database
      .prepare(`
        SELECT *
        FROM security_notifications
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(userId, limit);
    return rows.map(mapNotification);
  }

  async countUnreadSecurityNotifications(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM security_notifications
        WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL
      `)
      .get(userId);
    return Number(row.count);
  }

  async markSecurityNotificationRead(userId, notificationId, read = true) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(notificationId, "notificationId");
    if (typeof read !== "boolean") {
      throw new DomainValidationError("read must be a boolean.");
    }
    const result = this.database
      .prepare(`
        UPDATE security_notifications
        SET read_at = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(read ? timestamp() : null, notificationId, userId);
    return affectedRows(result) > 0;
  }

  async dismissSecurityNotification(userId, notificationId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    positiveInteger(notificationId, "notificationId");
    const now = timestamp();
    const result = this.database
      .prepare(`
        UPDATE security_notifications
        SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ? AND dismissed_at IS NULL
      `)
      .run(now, now, notificationId, userId);
    return affectedRows(result) > 0;
  }

  async deleteAccount(userId) {
    this.ensureInitialized();
    positiveInteger(userId, "userId");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const user = this.database
        .prepare("SELECT id FROM users WHERE id = ?")
        .get(userId);
      if (!user) {
        this.database.exec("COMMIT;");
        return null;
      }
      const counts = {
        sessions: Number(
          this.database
            .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
            .get(userId).count,
        ),
        profiles: Number(
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM behavior_profiles
              WHERE user_id = ?
            `)
            .get(userId).count,
        ),
        devices: Number(
          this.database
            .prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ?")
            .get(userId).count,
        ),
        webAuthnCredentials: Number(
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM webauthn_credentials
              WHERE user_id = ?
            `)
            .get(userId).count,
        ),
        notifications: Number(
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM security_notifications
              WHERE user_id = ?
            `)
            .get(userId).count,
        ),
        auditEvents: Number(
          this.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM audit_events
              WHERE user_id = ?
                OR session_id IN (
                  SELECT id FROM sessions WHERE user_id = ?
                )
            `)
            .get(userId, userId).count,
        ),
      };

      this.database
        .prepare(`
          DELETE FROM audit_events
          WHERE user_id = ?
            OR session_id IN (
              SELECT id FROM sessions WHERE user_id = ?
            )
        `)
        .run(userId, userId);
      this.database.prepare("DELETE FROM users WHERE id = ?").run(userId);
      this.database.exec("COMMIT;");
      return {
        deleted: true,
        userId,
        deletedRecords: counts,
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async getAdminOverview(options = {}) {
    this.ensureInitialized();
    const since = options.since === undefined
      ? timestamp(new Date(0))
      : timestamp(options.since);
    const now = timestamp();
    const scalar = (sql, ...parameters) => Number(
      this.database.prepare(sql).get(...parameters).count,
    );
    return {
      generatedAt: now,
      since,
      users: {
        total: scalar("SELECT COUNT(*) AS count FROM users"),
        active: scalar(
          "SELECT COUNT(*) AS count FROM users WHERE disabled_at IS NULL",
        ),
        createdSince: scalar(
          "SELECT COUNT(*) AS count FROM users WHERE created_at >= ?",
          since,
        ),
      },
      sessions: {
        active: scalar(
          "SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?",
          now,
        ),
      },
      behaviorProfiles: {
        total: scalar("SELECT COUNT(*) AS count FROM behavior_profiles"),
      },
      devices: {
        active: scalar(
          "SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NULL",
        ),
        revoked: scalar(
          "SELECT COUNT(*) AS count FROM devices WHERE revoked_at IS NOT NULL",
        ),
      },
      webAuthnCredentials: {
        total: scalar("SELECT COUNT(*) AS count FROM webauthn_credentials"),
      },
      securityNotifications: {
        unread: scalar(`
          SELECT COUNT(*) AS count
          FROM security_notifications
          WHERE read_at IS NULL AND dismissed_at IS NULL
        `),
      },
      pendingRecoveryRequests: scalar(`
        SELECT COUNT(*) AS count
        FROM recovery_requests
        WHERE state = 'pending' AND expires_at > ?
      `, now),
      pendingProfileTransfers: scalar(`
        SELECT COUNT(*) AS count
        FROM profile_transfers
        WHERE state = 'pending' AND expires_at > ?
      `, now),
    };
  }

  async getAdminSecurityEventAggregates(options = {}) {
    this.ensureInitialized();
    const since = options.since === undefined
      ? timestamp(new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)))
      : timestamp(options.since);
    const limit = safeInteger(options.limit ?? 100, "limit", {
      minimum: 1,
      maximum: 500,
    });
    const rows = this.database
      .prepare(`
        SELECT
          substr(created_at, 1, 10) AS day,
          event_type,
          outcome,
          COUNT(*) AS event_count
        FROM audit_events
        WHERE created_at >= ?
        GROUP BY day, event_type, outcome
        ORDER BY day DESC, event_count DESC
        LIMIT ?
      `)
      .all(since, limit);
    return rows.map((row) => ({
      day: row.day,
      eventType: row.event_type,
      outcome: row.outcome,
      count: Number(row.event_count),
    }));
  }

  async appendAudit(event) {
    this.ensureInitialized();
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new DatabaseValidationError("Audit event must be an object.");
    }

    const userId = event.userId === null || event.userId === undefined
      ? null
      : positiveInteger(event.userId, "userId");
    const sessionId = event.sessionId === null || event.sessionId === undefined
      ? null
      : positiveInteger(event.sessionId, "sessionId");
    const eventType = validateAuditText(event.eventType, "eventType");
    const outcome = validateAuditText(
      event.outcome ?? "success",
      "outcome",
      { maximum: 64 },
    );
    const reasonCode = validateAuditText(event.reasonCode, "reasonCode", {
      nullable: true,
      maximum: 128,
    });
    let metadataJson = null;

    if (event.metadata !== null && event.metadata !== undefined) {
      try {
        metadataJson = JSON.stringify(event.metadata);
      } catch (error) {
        throw new DatabaseValidationError(
          "Audit metadata must be JSON serializable.",
          { cause: error.message },
        );
      }

      if (Buffer.byteLength(metadataJson, "utf8") > MAX_AUDIT_METADATA_BYTES) {
        throw new DatabaseValidationError(
          `Audit metadata must not exceed ${MAX_AUDIT_METADATA_BYTES} bytes.`,
        );
      }
    }

    const createdAt = timestamp(event.createdAt ?? new Date());
    const result = this.database
      .prepare(`
        INSERT INTO audit_events(
          user_id,
          session_id,
          event_type,
          outcome,
          reason_code,
          metadata_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        userId,
        sessionId,
        eventType,
        outcome,
        reasonCode,
        metadataJson,
        createdAt,
      );
    const row = this.database
      .prepare("SELECT * FROM audit_events WHERE id = ?")
      .get(insertedId(result));
    return mapAudit(row);
  }

  async listAudit(options = {}) {
    this.ensureInitialized();
    if (Number.isSafeInteger(options)) {
      options = { userId: options };
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new DatabaseValidationError("Audit query options must be an object.");
    }

    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new DatabaseValidationError(
        "Audit query limit must be between 1 and 500.",
      );
    }

    const clauses = [];
    const parameters = [];
    if (options.userId !== null && options.userId !== undefined) {
      clauses.push("user_id = ?");
      parameters.push(positiveInteger(options.userId, "userId"));
    }
    if (options.before !== null && options.before !== undefined) {
      clauses.push("created_at < ?");
      parameters.push(timestamp(options.before));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`
        SELECT *
        FROM audit_events
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters, limit);
    return rows.map(mapAudit);
  }

  async getApplicationMetadata(key) {
    this.ensureInitialized();
    const normalizedKey = validateAuditText(key, "metadata key");
    const row = this.database
      .prepare("SELECT value FROM app_metadata WHERE key = ?")
      .get(normalizedKey);
    return row?.value ?? null;
  }

  async setApplicationMetadata(key, value) {
    this.ensureInitialized();
    const normalizedKey = validateAuditText(key, "metadata key");
    if (typeof value !== "string" || value.length > 4096) {
      throw new DatabaseValidationError(
        "Application metadata value must be a string no longer than 4096 characters.",
      );
    }

    this.database
      .prepare(`
        INSERT INTO app_metadata(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(normalizedKey, value, timestamp());
  }
}

module.exports = {
  OdysseusDatabase,
  DEFAULT_DATABASE_PATH,
  DEFAULT_DEVICE_TOKEN_TTL_MS,
  DEFAULT_DEVICE_TRANSFER_TTL_MS,
  DEFAULT_RECOVERY_REQUEST_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_WEBAUTHN_CHALLENGE_TTL_MS,
  DatabaseConflictError,
  DatabaseValidationError,
  MAX_DEVICE_TOKEN_TTL_MS,
  MAX_EPHEMERAL_TTL_MS,
  MAX_SESSION_TTL_MS,
  MIN_DEVICE_TOKEN_TTL_MS,
  MIN_EPHEMERAL_TTL_MS,
  MIN_SESSION_TTL_MS,
  SCHEMA_VERSION,
};
