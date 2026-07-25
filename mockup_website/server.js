"use strict";

// Demo backend for the OptionsFlow mockup. Accounts are created and checked
// through the Odysseus account API so one set of credentials works on this
// site and on the local report viewer at /admin. Odysseus stores the accounts
// in data/odysseus.sqlite.
//
// This server keeps two things of its own:
//   * mockup_website/data/recovery.json - scrypt hashes of the optional
//     password-recovery answers (never the answers themselves), plus the
//     Odysseus recovery codes issued to accounts created here so the
//     "forgot password" flow can perform a real password reset upstream.
//   * an in-memory map of Odysseus session cookies belonging to signed-in
//     visitors, so browser telemetry can be forwarded on their behalf. The
//     browser only ever sees an opaque HttpOnly id for that map.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("path");
const { promisify } = require("node:util");
const express = require("express");

const PORT = Number(process.env.MOCKUP_PORT || 4000);
const HOST = process.env.MOCKUP_HOST || "127.0.0.1";
const ODYSSEUS_ORIGIN =
  process.env.ODYSSEUS_ORIGIN || "http://127.0.0.1:3000";

const DEMO_USERNAME = "username";
const DEMO_PASSWORD = "password";

const CSRF_COOKIE = "odysseus_csrf";
const SESSION_COOKIE = "optionsflow_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const TICKET_TTL_MS = 10 * 60 * 1_000;
const RECOVERY_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const RECOVERY_ATTEMPT_MAXIMUM = 5;
const ESCROW_CODE_COUNT = 4;

const DATA_DIRECTORY = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIRECTORY, "recovery.json");

// Same scrypt parameters and encoding as src/auth.js so the answer hashes
// look and behave like the password hashes the real backend writes.
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const HASH_PREFIX = "scrypt";

const QUESTION_KEYS = ["maidenName", "highschool", "pet", "sex"];
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

class AccountServiceDown extends Error {}

/* ------------------------------------------------------------------ *
 * Odysseus plumbing
 * ------------------------------------------------------------------ */

// Odysseus binds CSRF to a cookie, so every forwarded call starts by picking
// up a fresh cookie and token from an unauthenticated probe.
async function odysseusHandshake() {
  let response = null;
  try {
    response = await fetch(`${ODYSSEUS_ORIGIN}/api/auth/me`, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new AccountServiceDown(error.message);
  }
  return collectCookies(response);
}

// Cookies are kept as a plain name -> raw value jar so later responses can
// replace the session and CSRF pair Odysseus rotates on sign-in.
function collectCookies(response, jar = {}) {
  const next = { ...jar };
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator < 1) {
      continue;
    }
    next[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return next;
}

function cookieHeaderFrom(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function csrfTokenFrom(jar) {
  const raw = jar[CSRF_COOKIE];
  return raw ? decodeURIComponent(raw) : "";
}

async function odysseusPost(pathname, payload, jar) {
  let response = null;
  try {
    response = await fetch(`${ODYSSEUS_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": csrfTokenFrom(jar),
        Cookie: cookieHeaderFrom(jar),
        Origin: ODYSSEUS_ORIGIN,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new AccountServiceDown(error.message);
  }

  let body = {};
  try {
    body = await response.json();
  } catch (_error) {
    body = {};
  }
  return {
    status: response.status,
    body,
    jar: collectCookies(response, jar),
  };
}

// Credential calls start from a throwaway handshake; the jar comes back so
// callers that need the resulting signed-in session can hold on to it.
async function forwardCredentials(pathname, payload) {
  const jar = await odysseusHandshake();
  return odysseusPost(pathname, payload, jar);
}

/* ------------------------------------------------------------------ *
 * Visitor sessions (mockup id -> Odysseus cookies)
 * ------------------------------------------------------------------ */

const sessions = new Map();

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") {
    return "";
  }
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) {
      continue;
    }
    if (segment.slice(0, separator).trim() === name) {
      return segment.slice(separator + 1).trim();
    }
  }
  return "";
}

function pruneSessions() {
  const oldest = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < oldest) {
      sessions.delete(id);
    }
  }
}

function startSession(response, username, jar) {
  pruneSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, { username, jar, createdAt: Date.now() });
  response.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function sessionFor(request) {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) {
    return null;
  }
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  if (session.createdAt < Date.now() - SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/* ------------------------------------------------------------------ *
 * Recovery answer store
 * ------------------------------------------------------------------ */

let store = { version: 1, accounts: Object.create(null) };
let writeChain = Promise.resolve();

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (parsed && typeof parsed.accounts === "object") {
      store = {
        version: 1,
        accounts: Object.assign(Object.create(null), parsed.accounts),
      };
    }
  } catch (_error) {
    // First run, or the file was removed. Start empty.
  }
}

function saveStore() {
  const snapshot = JSON.stringify(store, null, 2);
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(DATA_DIRECTORY, { recursive: true });
      const temporary = `${STORE_PATH}.tmp`;
      await fsp.writeFile(temporary, snapshot, { mode: 0o600 });
      await fsp.rename(temporary, STORE_PATH);
    })
    .catch((error) => {
      console.error("could not save recovery answers", error);
    });
  return writeChain;
}

function normalizeUsername(value) {
  const normalized =
    typeof value === "string"
      ? value.normalize("NFKC").trim().toLowerCase()
      : "";
  return USERNAME_PATTERN.test(normalized) && normalized.length <= 64
    ? normalized
    : "";
}

// Trim, fold case, and collapse runs of whitespace so "St. Mary's  High" and
// "st. mary's high" recover the same account.
function normalizeAnswer(value) {
  return String(value).normalize("NFKC").trim().toLowerCase()
    .replace(/\s+/g, " ");
}

async function hashAnswer(answer) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(
    normalizeAnswer(answer),
    salt,
    SCRYPT_KEY_LENGTH,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: SCRYPT_MAX_MEMORY,
    },
  );
  return [
    HASH_PREFIX,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

async function verifyAnswer(answer, encodedHash) {
  if (typeof encodedHash !== "string") {
    return false;
  }
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) {
    return false;
  }
  const candidate = await scryptAsync(
    normalizeAnswer(answer),
    salt,
    SCRYPT_KEY_LENGTH,
    {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
      maxmem: SCRYPT_MAX_MEMORY,
    },
  );
  return crypto.timingSafeEqual(candidate, expected);
}

function answersFrom(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const answers = {};
  for (const key of QUESTION_KEYS) {
    const answer = typeof value[key] === "string" ? value[key].trim() : "";
    if (answer === "" || answer.length > 200) {
      return null;
    }
    answers[key] = answer;
  }
  return answers;
}

async function hashAnswers(answers) {
  const hashed = {};
  for (const key of QUESTION_KEYS) {
    hashed[key] = await hashAnswer(answers[key]);
  }
  return hashed;
}

// Every question is checked even after the first mismatch so a wrong first
// answer is not measurably faster than a wrong last one.
async function answersMatch(answers, record) {
  let matched = true;
  for (const key of QUESTION_KEYS) {
    const ok = await verifyAnswer(answers[key], record.answers?.[key]);
    matched = matched && ok;
  }
  return matched;
}

const recoveryAttempts = new Map();

function tooManyRecoveryAttempts(username) {
  const now = Date.now();
  const entry = recoveryAttempts.get(username);
  if (!entry || entry.resetAt < now) {
    recoveryAttempts.set(username, {
      count: 1,
      resetAt: now + RECOVERY_ATTEMPT_WINDOW_MS,
    });
    return false;
  }
  entry.count += 1;
  return entry.count > RECOVERY_ATTEMPT_MAXIMUM;
}

const recoveryTickets = new Map();

function issueTicket(username) {
  const now = Date.now();
  for (const [value, ticket] of recoveryTickets) {
    if (ticket.expiresAt < now) {
      recoveryTickets.delete(value);
    }
  }
  const value = crypto.randomBytes(32).toString("base64url");
  recoveryTickets.set(value, { username, expiresAt: now + TICKET_TTL_MS });
  return value;
}

// Read without spending: a rejected password should not cost the visitor the
// questions they already answered.
function readTicket(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ticket = recoveryTickets.get(value);
  if (!ticket) {
    return null;
  }
  if (ticket.expiresAt < Date.now()) {
    recoveryTickets.delete(value);
    return null;
  }
  return ticket;
}

// Odysseus only resets a password against an emailed one-time token or a
// recovery code, and demo accounts have no email address. So when an account
// is created here with recovery answers, we immediately mint recovery codes
// for it and hold them; the reset step spends one against the real
// /api/auth/recovery/reset route rather than inventing a local password path.
async function escrowRecoveryCodes(username, jar) {
  const result = await odysseusPost(
    "/api/account/recovery-codes",
    { rotate: true, count: ESCROW_CODE_COUNT },
    jar,
  );
  if (result.status !== 201 || !Array.isArray(result.body?.codes)) {
    throw new Error(
      `recovery code request returned ${result.status}`,
    );
  }
  return result.body.codes;
}

/* ------------------------------------------------------------------ *
 * Request helpers
 * ------------------------------------------------------------------ */

function credentialsFrom(request) {
  return {
    username:
      typeof request.body?.username === "string"
        ? request.body.username.trim()
        : "",
    password:
      typeof request.body?.password === "string" ? request.body.password : "",
  };
}

function serviceDown(response) {
  response.status(503).json({
    error:
      "The account service is not running. Start it with npm start, then try again.",
  });
}

const app = express();
// Matches the 100kb ceiling the Odysseus API uses, so a full telemetry batch
// survives the hop through this proxy.
app.use(express.json({ limit: "100kb" }));

app.post("/api/signup", async (request, response) => {
  const credentials = credentialsFrom(request);
  const answers = answersFrom(request.body?.answers);

  try {
    const result = await forwardCredentials(
      "/api/auth/register",
      credentials,
    );

    if (result.status === 201) {
      const username =
        result.body?.user?.username || credentials.username.toLowerCase();
      startSession(response, username, result.jar);

      if (answers) {
        const record = {
          answers: await hashAnswers(answers),
          recoveryCodes: [],
          updatedAt: new Date().toISOString(),
        };
        try {
          record.recoveryCodes = await escrowRecoveryCodes(
            username,
            result.jar,
          );
        } catch (error) {
          // Answers are still worth keeping; the reset step will explain
          // that the password cannot be changed from here.
          console.warn("could not escrow recovery codes", error.message);
        }
        store.accounts[username] = record;
        await saveStore();
      }

      response.status(201).json({ username });
      return;
    }

    if (result.status === 409) {
      response.status(409).json({ error: "That username is already taken" });
      return;
    }

    response.status(result.status === 429 ? 429 : 400).json({
      error:
        result.body?.error?.message || "Could not create the account",
    });
  } catch (error) {
    if (error instanceof AccountServiceDown) {
      serviceDown(response);
      return;
    }
    console.error("signup failed", error);
    response.status(500).json({ error: "Could not create the account" });
  }
});

app.post("/api/login", async (request, response) => {
  const credentials = credentialsFrom(request);

  try {
    const result = await forwardCredentials("/api/auth/login", credentials);

    if (result.status === 200) {
      const username =
        result.body?.user?.username || credentials.username.toLowerCase();
      startSession(response, username, result.jar);
      response.json({ username });
      return;
    }

    if (result.status === 429) {
      response.status(429).json({
        error: "Too many attempts. Wait a moment and try again.",
      });
      return;
    }

    // Odysseus checks the password before it weighs behaviour, so a
    // BEHAVIOR_LOGIN_DENIED reply means the credentials were right and only
    // the behavioural gate refused. This storefront must not tell the visitor
    // that such a gate exists, and locking them out of a demo trading site
    // over it would be worse, so they continue with no upstream session:
    // nothing signed in happens on the Odysseus side and telemetry from this
    // visit is dropped instead of relayed.
    if (result.body?.error?.code === "BEHAVIOR_LOGIN_DENIED") {
      const username =
        credentials.username.trim().toLowerCase();
      console.warn(
        `odysseus declined the session for ${username}; continuing without one`,
      );
      startSession(response, username, null);
      response.json({ username });
      return;
    }

    response.status(401).json({ error: "Invalid username or password" });
  } catch (error) {
    if (error instanceof AccountServiceDown) {
      serviceDown(response);
      return;
    }
    console.error("login failed", error);
    response.status(500).json({ error: "Could not sign you in" });
  }
});

/* ------------------------------------------------------------------ *
 * Password recovery
 * ------------------------------------------------------------------ */

const RECOVERY_REJECTED =
  "Those answers do not match the ones on file for that account.";

app.post("/api/recovery/verify", async (request, response) => {
  const username = normalizeUsername(request.body?.username);
  const answers = answersFrom(request.body?.answers);

  if (!answers) {
    response.status(400).json({ error: "Answer all four questions." });
    return;
  }
  if (username && tooManyRecoveryAttempts(username)) {
    response.status(429).json({
      error: "Too many recovery attempts. Wait a few minutes and try again.",
    });
    return;
  }

  try {
    // The reply is deliberately the same whether the account is unknown, has
    // no answers on file, or answered wrongly, so the form cannot be used to
    // test which usernames exist.
    const record = username ? store.accounts[username] : null;
    if (!record) {
      await hashAnswer(answers.maidenName);
      response.status(401).json({ error: RECOVERY_REJECTED });
      return;
    }
    if (!(await answersMatch(answers, record))) {
      response.status(401).json({ error: RECOVERY_REJECTED });
      return;
    }
    recoveryAttempts.delete(username);
    response.json({ ticket: issueTicket(username) });
  } catch (error) {
    console.error("recovery verification failed", error);
    response.status(500).json({ error: "Could not check those answers" });
  }
});

app.post("/api/recovery/reset", async (request, response) => {
  const ticketValue =
    typeof request.body?.ticket === "string" ? request.body.ticket : "";
  const ticket = readTicket(ticketValue);
  const password =
    typeof request.body?.password === "string" ? request.body.password : "";

  if (!ticket) {
    response.status(401).json({
      error: "That recovery session expired. Start again.",
    });
    return;
  }
  if (password.length < 6 || password.length > 128) {
    response.status(400).json({
      error: "Passwords must contain between 6 and 128 characters.",
    });
    return;
  }

  const record = store.accounts[ticket.username];
  const code = record?.recoveryCodes?.[0];
  if (!code) {
    recoveryTickets.delete(ticketValue);
    response.status(409).json({
      error:
        "This account cannot be reset from here. Ask an administrator to reset it.",
    });
    return;
  }

  try {
    const result = await forwardCredentials("/api/auth/recovery/reset", {
      username: ticket.username,
      code,
      newPassword: password,
    });

    if (result.status === 200) {
      recoveryTickets.delete(ticketValue);
      record.recoveryCodes = record.recoveryCodes.slice(1);
      record.updatedAt = new Date().toISOString();
      await saveStore();
      response.json({ ok: true });
      return;
    }

    if (result.status === 400) {
      // Upstream refused the password itself; the ticket stays valid so the
      // visitor can try a different one.
      response.status(400).json({
        error:
          result.body?.error?.message || "That password was not accepted.",
      });
      return;
    }

    // A rejected code is spent as far as we know; drop it so a retry uses the
    // next one instead of failing the same way forever.
    recoveryTickets.delete(ticketValue);
    record.recoveryCodes = record.recoveryCodes.slice(1);
    await saveStore();
    response.status(409).json({
      error: "Could not reset the password. Start the recovery again.",
    });
  } catch (error) {
    if (error instanceof AccountServiceDown) {
      serviceDown(response);
      return;
    }
    console.error("recovery reset failed", error);
    response.status(500).json({ error: "Could not reset the password" });
  }
});

/* ------------------------------------------------------------------ *
 * Telemetry relay
 * ------------------------------------------------------------------ */

// Nothing Odysseus says about a visitor's behaviour is allowed to reach the
// page: every outcome, including "service is down" and "rejected", answers
// with the same bare acknowledgement.
function acknowledge(response) {
  response.status(200).json({ ok: true });
}

async function relayTelemetry(request, response, pathname, payload) {
  const session = sessionFor(request);
  if (!session || !session.jar) {
    acknowledge(response);
    return;
  }
  try {
    const result = await odysseusPost(
      pathname,
      { profileId: session.username, ...payload },
      session.jar,
    );
    session.jar = result.jar;
  } catch (error) {
    if (!(error instanceof AccountServiceDown)) {
      console.error("telemetry relay failed", error);
    }
  }
  acknowledge(response);
}

app.post("/api/telemetry/enroll", async (request, response) => {
  const samples = request.body?.samples;
  if (!Array.isArray(samples)) {
    response.status(400).json({ ok: false, error: "Malformed request" });
    return;
  }
  await relayTelemetry(request, response, "/api/enroll", { samples });
});

app.post("/api/telemetry/verify", async (request, response) => {
  const vector = request.body?.vector;
  if (!vector || typeof vector !== "object") {
    response.status(400).json({ ok: false, error: "Malformed request" });
    return;
  }
  const payload = { vector };
  if (
    request.body.interactionEvidence !== undefined
    && request.body.interactionEvidence !== null
  ) {
    payload.interactionEvidence = request.body.interactionEvidence;
  }
  await relayTelemetry(request, response, "/api/verify", payload);
});

// The answer store lives inside this directory, so keep it off the static
// mount that serves the rest of the site.
app.use("/data", (_request, response) => {
  response.status(404).end();
});

app.use(
  express.static(__dirname, {
    extensions: ["html"],
    index: "login.html",
  }),
);

// Keep the demo credentials printed on the sign-in card working. A taken
// username means it already exists, which is the desired end state.
async function seedDemoAccount() {
  const result = await forwardCredentials("/api/auth/register", {
    username: DEMO_USERNAME,
    password: DEMO_PASSWORD,
  });
  if (result.status !== 201 && result.status !== 409) {
    console.warn(
      "could not seed the demo account:",
      result.body?.error?.message || result.status,
    );
  }
}

loadStore();

app.listen(PORT, HOST, () => {
  console.log(`OptionsFlow mockup at http://${HOST}:${PORT}`);
  console.log(`Accounts come from Odysseus at ${ODYSSEUS_ORIGIN}`);
  seedDemoAccount().catch((error) => {
    if (error instanceof AccountServiceDown) {
      console.warn(
        `Odysseus is not answering at ${ODYSSEUS_ORIGIN}. Start it with npm start.`,
      );
      return;
    }
    console.error("could not seed the demo account", error);
  });
});
