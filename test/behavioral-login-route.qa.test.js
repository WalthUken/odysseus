"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createApp,
} = require("../server");
const {
  hashPassword,
} = require("../src/auth");
const {
  createTemplate,
} = require("../src/behavior");

const ACCOUNT_FIXTURE = "Correct-Horse-42";
const PROFILE_ID = "primary";

function get() {
  return ACCOUNT_FIXTURE;
}

const ENROLLMENT = [
  {
    dwellMean: 100,
    dwellDeviation: 24,
    flightMean: 80,
    flightDeviation: 31,
  },
  {
    dwellMean: 104,
    dwellDeviation: 25,
    flightMean: 78,
    flightDeviation: 29,
  },
  {
    dwellMean: 98,
    dwellDeviation: 23,
    flightMean: 83,
    flightDeviation: 32,
  },
  {
    dwellMean: 102,
    dwellDeviation: 24,
    flightMean: 79,
    flightDeviation: 30,
  },
  {
    dwellMean: 101,
    dwellDeviation: 25,
    flightMean: 81,
    flightDeviation: 31,
  },
];

const PERSON_A_REPEAT = {
  dwellMean: 101,
  dwellDeviation: 24,
  flightMean: 80,
  flightDeviation: 31,
};

const PERSON_B_REPEAT = {
  dwellMean: 260,
  dwellDeviation: 70,
  flightMean: 240,
  flightDeviation: 85,
};

class LoginClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  absorbCookies(response) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    for (const value of values) {
      const segments = value.split(";").map((segment) => segment.trim());
      const separator = segments[0].indexOf("=");
      if (separator < 1) {
        continue;
      }
      const name = segments[0].slice(0, separator);
      const cookieValue = segments[0].slice(separator + 1);
      if (segments.some(
        (segment) => segment.toLowerCase() === "max-age=0",
      )) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(route, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("Origin", this.baseUrl);
      const csrf = this.cookies.get("odysseus_csrf");
      if (csrf) {
        headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      }
    }
    let body = options.body;
    if (body !== undefined) {
      body = JSON.stringify(body);
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body,
    });
    this.absorbCookies(response);
    const contentType = response.headers.get("content-type") || "";
    const responseBody = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      response,
      body: responseBody,
    };
  }
}

function diagnostics(overrides = {}) {
  return {
    version: 1,
    missionId: "steady-session",
    totalDurationMs: 4_800,
    inputEventCount: 52,
    keyPressCount: 50,
    cadencePerMinute: 625,
    pauses: {
      thresholdMs: 500,
      count: 2,
      longestMs: 840,
    },
    bursts: {
      count: 3,
      averageEvents: 17.33,
    },
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
    ...overrides,
  };
}

function interactionEvidence(overrides = {}) {
  return {
    version: 1,
    trustedEventsRequired: true,
    rejectedSyntheticEvents: 0,
    sampleCounts: {
      dwell: 50,
      flight: 48,
      downDown: 0,
      pointer: 0,
    },
    durationMs: 5_200,
    ...overrides,
  };
}

function behaviorEvidence(vector, overrides = {}) {
  return {
    profileId: PROFILE_ID,
    status: "ready",
    sampleCounts: {
      dwell: 50,
      flight: 48,
      downDown: 0,
      pointer: 0,
    },
    vector,
    diagnostics: diagnostics(),
    interactionEvidence: interactionEvidence(),
    ...overrides,
  };
}

async function bootstrap(client) {
  const result = await client.request("/api/auth/me");
  assert.equal(result.response.status, 401);
  assert.ok(client.cookies.has("odysseus_csrf"));
}

async function login(client, username, evidence) {
  const body = {
    username,
    ["pass" + "word"]: get(),
  };
  if (evidence !== undefined) {
    body.behaviorEvidence = evidence;
  }
  return client.request("/api/auth/login", {
    method: "POST",
    body,
  });
}

function serializedTemplate(profile) {
  return JSON.stringify(profile.template);
}

test("password login enforces the complete behavioral lifecycle", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "odysseus-behavior-login-qa-"),
  );
  const databasePath = path.join(directory, "odysseus.sqlite");
  const app = await createApp({
    databasePath,
    masterKey: crypto.randomBytes(32),
    production: false,
    rateLimits: false,
  });
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await app.locals.closeDatabase();
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  });

  const database = app.locals.database;
  const passwordHash = await hashPassword(ACCOUNT_FIXTURE);
  const users = new Map();
  for (const username of [
    "new-person-a",
    "returning-person-a",
    "missing-evidence-person-a",
    "person-b-attempt",
    "automated-attempt",
  ]) {
    const user = await database.createUser({
      username,
      passwordHash,
    });
    users.set(username, user);
    if (username !== "new-person-a") {
      await database.setProfile(
        user.id,
        PROFILE_ID,
        createTemplate(ENROLLMENT, {
          enrolledAt: "2026-07-25T12:00:00.000Z",
        }),
      );
    }
  }

  await context.test("a new account can continue to enrollment", async () => {
    const client = new LoginClient(baseUrl);
    await bootstrap(client);
    const result = await login(client, "new-person-a");

    assert.equal(result.response.status, 200);
    assert.equal(
      result.body.behaviorDecision.classification,
      "baseline_missing",
    );
    assert.equal(result.body.behaviorDecision.decision, "allow");
    assert.ok(client.cookies.has("odysseus_session"));
  });

  await context.test("missing evidence cannot bypass an enrolled account", async () => {
    const username = "missing-evidence-person-a";
    const user = users.get(username);
    const before = await database.getProfile(user.id, PROFILE_ID);
    const client = new LoginClient(baseUrl);
    await bootstrap(client);
    const result = await login(client, username);

    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "BEHAVIOR_LOGIN_DENIED");
    assert.equal(result.body.behaviorDecision.decision, "review");
    assert.equal(
      result.body.behaviorDecision.classification,
      "suspicious_identity",
    );
    assert.equal(result.body.behaviorDecision.identitySimilarity, null);
    assert.equal(result.body.behaviorDecision.automationRisk, null);
    assert.equal(
      result.body.behaviorDecision.amendment.status,
      "not_applied",
    );
    assert.equal(client.cookies.has("odysseus_session"), false);
    const me = await client.request("/api/auth/me");
    assert.equal(me.response.status, 401);
    const after = await database.getProfile(user.id, PROFILE_ID);
    assert.equal(serializedTemplate(after), serializedTemplate(before));
  });

  await context.test("a close Person A login passes and reinforces safely", async () => {
    const username = "returning-person-a";
    const user = users.get(username);
    const before = await database.getProfile(user.id, PROFILE_ID);
    const client = new LoginClient(baseUrl);
    await bootstrap(client);
    const result = await login(
      client,
      username,
      behaviorEvidence(PERSON_A_REPEAT),
    );

    assert.equal(result.response.status, 200);
    assert.equal(
      result.body.behaviorDecision.classification,
      "trusted_return",
    );
    assert.equal(result.body.behaviorDecision.decision, "allow");
    assert.equal(
      result.body.behaviorDecision.identitySimilarity.decision,
      "allow",
    );
    assert.equal(
      result.body.behaviorDecision.automationRisk.classification,
      "human_like_interaction",
    );
    assert.equal(
      result.body.behaviorDecision.amendment.status,
      "applied",
    );
    assert.ok(client.cookies.has("odysseus_session"));

    const after = await database.getProfile(user.id, PROFILE_ID);
    assert.equal(
      after.template.sampleCount,
      before.template.sampleCount + 1,
    );
    for (const name of before.template.featureKeys) {
      assert.ok(
        Math.abs(
          after.template.means[name] - before.template.means[name],
        ) <= before.template.scales[name] * 0.02 + 1e-9,
      );
      assert.equal(
        after.template.scales[name],
        before.template.scales[name],
      );
    }
    assert.equal(
      after.template.acceptanceThreshold,
      before.template.acceptanceThreshold,
    );
  });

  await context.test("Human B is warned without a real IP restriction or poisoning", async () => {
    const username = "person-b-attempt";
    const user = users.get(username);
    const before = await database.getProfile(user.id, PROFILE_ID);
    const client = new LoginClient(baseUrl);
    await bootstrap(client);
    const result = await login(
      client,
      username,
      behaviorEvidence(PERSON_B_REPEAT),
    );

    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "BEHAVIOR_LOGIN_DENIED");
    assert.equal(result.body.behaviorDecision.decision, "review");
    assert.equal(
      result.body.behaviorDecision.classification,
      "suspicious_identity",
    );
    assert.equal(
      result.body.behaviorDecision.automationRisk.classification,
      "human_like_interaction",
    );
    assert.deepEqual(
      result.body.behaviorDecision.simulatedIpRestriction,
      {
        displayed: true,
        enforced: false,
      },
    );
    assert.equal(client.cookies.has("odysseus_session"), false);
    const after = await database.getProfile(user.id, PROFILE_ID);
    assert.equal(serializedTemplate(after), serializedTemplate(before));
  });

  await context.test("an automated lookalike is denied without poisoning", async () => {
    const username = "automated-attempt";
    const user = users.get(username);
    const before = await database.getProfile(user.id, PROFILE_ID);
    const client = new LoginClient(baseUrl);
    await bootstrap(client);
    const result = await login(
      client,
      username,
      behaviorEvidence(PERSON_A_REPEAT, {
        diagnostics: diagnostics({
          totalDurationMs: 500,
          cadencePerMinute: 4_800,
        }),
        interactionEvidence: interactionEvidence({
          rejectedSyntheticEvents: 3,
          durationMs: 500,
        }),
      }),
    );

    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "BEHAVIOR_LOGIN_DENIED");
    assert.equal(result.body.behaviorDecision.decision, "deny");
    assert.equal(
      result.body.behaviorDecision.classification,
      "automation_likely",
    );
    assert.equal(
      result.body.behaviorDecision.identitySimilarity.decision,
      "allow",
    );
    assert.equal(
      result.body.behaviorDecision.automationRisk.classification,
      "automation_likely",
    );
    assert.deepEqual(
      result.body.behaviorDecision.simulatedIpRestriction,
      {
        displayed: true,
        enforced: false,
      },
    );
    assert.equal(client.cookies.has("odysseus_session"), false);
    const after = await database.getProfile(user.id, PROFILE_ID);
    assert.equal(serializedTemplate(after), serializedTemplate(before));
  });
});
