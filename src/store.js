"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { hashPassword } = require("./auth");
const {
  OdysseusDatabase,
  DEFAULT_DATABASE_PATH,
  SCHEMA_VERSION,
} = require("./database");
const {
  generateOpaqueToken,
  restrictFilePermissions,
} = require("./crypto");

const STORE_VERSION = SCHEMA_VERSION;
const DEFAULT_STORE_PATH = DEFAULT_DATABASE_PATH;
const LEGACY_IMPORT_MARKER = "legacy_templates_v1_imported";
const LEGACY_USERNAME = "legacy-local";

async function fileStartsWithJsonObject(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8").trimStart();
    return prefix.startsWith("{");
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readLegacyProfiles(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(contents);
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.version !== 1
    || parsed.profiles === null
    || typeof parsed.profiles !== "object"
    || Array.isArray(parsed.profiles)
  ) {
    throw new Error("Legacy template store has an invalid structure.");
  }
  return Object.entries(parsed.profiles);
}

class TemplateStore {
  constructor(filePath = DEFAULT_STORE_PATH, options = {}) {
    if (filePath !== undefined && typeof filePath === "object") {
      options = filePath;
      filePath = options.filePath ?? DEFAULT_STORE_PATH;
    }

    this.requestedPath = path.resolve(filePath);
    this.filePath = this.requestedPath;
    this.options = options;
    this.database = null;
    this.userId = null;
    this.cache = new Map();
    this.initialized = false;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (this.initialized) {
      return this;
    }

    let legacyJsonPath = this.options.legacyJsonPath;
    if (legacyJsonPath !== undefined && legacyJsonPath !== null) {
      legacyJsonPath = path.resolve(legacyJsonPath);
    } else if (
      this.requestedPath === path.resolve(DEFAULT_DATABASE_PATH)
    ) {
      legacyJsonPath = path.join(
        path.dirname(DEFAULT_DATABASE_PATH),
        "templates.json",
      );
    } else if (await fileStartsWithJsonObject(this.requestedPath)) {
      legacyJsonPath = this.requestedPath;
      this.filePath = `${this.requestedPath}.sqlite`;
    } else if (await fileExists(`${this.requestedPath}.sqlite`)) {
      this.filePath = `${this.requestedPath}.sqlite`;
    }

    this.database = new OdysseusDatabase({
      databasePath: this.filePath,
      masterKey: this.options.masterKey,
      masterKeyPath: this.options.masterKeyPath
        ?? path.join(path.dirname(this.filePath), "master.key"),
      env: this.options.env,
    });

    await this.database.init();
    try {
      await this.ensureLegacyUser();
      await this.importLegacyProfiles(legacyJsonPath);
      await this.loadCache();
      this.initialized = true;
    } finally {
      await this.database.close();
    }

    return this;
  }

  async ensureLegacyUser() {
    let user = await this.database.getUserByUsername(LEGACY_USERNAME);
    if (!user) {
      const migrationOnlyCredential = `Aa1!${generateOpaqueToken(48)}`;
      const passwordHash = await hashPassword(migrationOnlyCredential);
      try {
        user = await this.database.createUser({
          username: LEGACY_USERNAME,
          passwordHash,
        });
      } catch (error) {
        if (error.code !== "DATABASE_CONFLICT") {
          throw error;
        }
        user = await this.database.getUserByUsername(LEGACY_USERNAME);
      }
    }
    this.userId = user.id;
  }

  async importLegacyProfiles(legacyJsonPath) {
    if (await this.database.getApplicationMetadata(LEGACY_IMPORT_MARKER)) {
      return;
    }

    let importedProfiles = 0;
    let backupPath = null;
    if (legacyJsonPath && await fileStartsWithJsonObject(legacyJsonPath)) {
      const entries = await readLegacyProfiles(legacyJsonPath);
      for (const [profileId, template] of entries) {
        await this.database.setProfile(this.userId, profileId, template);
        importedProfiles += 1;
      }

      backupPath = [
        legacyJsonPath,
        Date.now(),
        crypto.randomUUID(),
        "migrated-backup",
      ].join(".");
      await fs.rename(legacyJsonPath, backupPath);
      await restrictFilePermissions(backupPath);
    }

    await this.database.setApplicationMetadata(
      LEGACY_IMPORT_MARKER,
      JSON.stringify({
        completedAt: new Date().toISOString(),
        importedProfiles,
        backupPath,
      }),
    );
  }

  async loadCache() {
    this.cache.clear();
    const profiles = await this.database.listProfiles(this.userId);
    for (const profile of profiles) {
      const result = await this.database.getProfile(
        this.userId,
        profile.profileId,
      );
      this.cache.set(profile.profileId, result.template);
    }
  }

  ensureInitialized() {
    if (!this.initialized) {
      throw new Error("TemplateStore.init() must be called before use.");
    }
  }

  get(profileId) {
    this.ensureInitialized();
    return this.cache.get(profileId) ?? null;
  }

  has(profileId) {
    this.ensureInitialized();
    return this.cache.has(profileId);
  }

  list() {
    this.ensureInitialized();
    return [...this.cache.entries()];
  }

  async withDatabase(operation) {
    await this.database.init();
    try {
      return await operation();
    } finally {
      await this.database.close();
    }
  }

  async set(profileId, template) {
    this.ensureInitialized();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.withDatabase(() => (
          this.database.setProfile(this.userId, profileId, template)
        ));
        this.cache.set(profileId, template);
        return template;
      });
    return this.writeQueue;
  }

  async delete(profileId) {
    this.ensureInitialized();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const deleted = await this.withDatabase(() => (
          this.database.deleteProfile(this.userId, profileId)
        ));
        if (deleted) {
          this.cache.delete(profileId);
        }
        return deleted;
      });
    return this.writeQueue;
  }

  async close() {
    await this.writeQueue.catch(() => undefined);
    await this.database?.close();
  }
}

module.exports = {
  DEFAULT_STORE_PATH,
  LEGACY_IMPORT_MARKER,
  STORE_VERSION,
  TemplateStore,
};
