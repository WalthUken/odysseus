"use strict";

// Demo backend for the OptionsFlow mockup. Accounts are created and checked
// through the Odysseus account API so one set of credentials works on this
// site and on the local report viewer at /admin. Odysseus stores them in
// data/odysseus.sqlite; this server keeps no account file of its own.

const fs = require("fs/promises");
const path = require("path");
const express = require("express");

const BEHAVIOR_FILE = path.join(__dirname, "data", "behavior.json");

// A pair of sessions is called a mismatch when the typing and pointer speeds
// are this far apart. Demo thresholds, not a validated identity test.
const MISMATCH_AVERAGE_PERCENT = 40;
const MISMATCH_SINGLE_PERCENT = 60;
const MIN_SAMPLES = 5;

const COMPARED_METRICS = [
  {
    key: "keysPerSecond",
    label: "Typing speed (keys/second)",
    unit: "keys/s",
    read: (metrics) => metrics.keyboard?.keysPerSecond,
    support: (metrics) => metrics.keyboard?.keystrokes || 0,
  },
  {
    key: "holdMean",
    label: "Mean key hold (ms)",
    unit: "ms",
    read: (metrics) => metrics.keyboard?.holdMs?.mean,
    support: (metrics) => metrics.keyboard?.holdMs?.count || 0,
  },
  {
    key: "flightMean",
    label: "Mean flight between keys (ms)",
    unit: "ms",
    read: (metrics) => metrics.keyboard?.flightMs?.mean,
    support: (metrics) => metrics.keyboard?.flightMs?.count || 0,
  },
  {
    key: "mouseSpeedMean",
    label: "Mean pointer speed (px/second)",
    unit: "px/s",
    read: (metrics) => metrics.mouse?.speedPxPerSecond?.mean,
    support: (metrics) => metrics.mouse?.speedPxPerSecond?.count || 0,
  },
  {
    key: "mouseSpeedMedian",
    label: "Median pointer speed (px/second)",
    unit: "px/s",
    read: (metrics) => metrics.mouse?.speedPxPerSecond?.median,
    support: (metrics) => metrics.mouse?.speedPxPerSecond?.count || 0,
  },
  {
    key: "directionChangeRate",
    label: "Direction changes per second",
    unit: "/s",
    read: (metrics) => metrics.mouse?.directionChangesPerSecond,
    support: (metrics) => metrics.mouse?.moveSamples || 0,
  },
];

async function readBehavior() {
  try {
    const raw = await fs.readFile(BEHAVIOR_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.profiles === "object" && parsed.profiles
      ? parsed.profiles
      : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeBehavior(profiles) {
  await fs.mkdir(path.dirname(BEHAVIOR_FILE), { recursive: true });
  await fs.writeFile(
    BEHAVIOR_FILE,
    `${JSON.stringify({ profiles }, null, 2)}\n`,
    "utf8",
  );
}

// Extracts read then write the same file, so run them one at a time.
let behaviorQueue = Promise.resolve();

function queueBehavior(task) {
  const result = behaviorQueue.then(task, task);
  behaviorQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function percentDifference(baseline, sample) {
  const reference = Math.max(Math.abs(baseline), Math.abs(sample));
  if (!Number.isFinite(reference) || reference === 0) {
    return null;
  }
  return Math.round((Math.abs(baseline - sample) / reference) * 1000) / 10;
}

function compare(baseline, sample) {
  const rows = COMPARED_METRICS.map((metric) => {
    const baselineValue = metric.read(baseline.metrics);
    const sampleValue = metric.read(sample.metrics);
    const comparable = (
      Number.isFinite(baselineValue)
      && Number.isFinite(sampleValue)
      && metric.support(baseline.metrics) >= MIN_SAMPLES
      && metric.support(sample.metrics) >= MIN_SAMPLES
    );

    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      baseline: Number.isFinite(baselineValue) ? baselineValue : null,
      sample: Number.isFinite(sampleValue) ? sampleValue : null,
      differencePercent: comparable
        ? percentDifference(baselineValue, sampleValue)
        : null,
      comparable,
    };
  });

  const scored = rows.filter(
    (row) => row.comparable && Number.isFinite(row.differencePercent),
  );
  const averageDifference = scored.length
    ? Math.round(
      (scored.reduce((total, row) => total + row.differencePercent, 0)
        / scored.length) * 10,
    ) / 10
    : null;
  const worst = scored.reduce(
    (highest, row) =>
      !highest || row.differencePercent > highest.differencePercent
        ? row
        : highest,
    null,
  );

  let verdict = "insufficient_data";
  if (scored.length > 0) {
    const mismatch = (
      averageDifference > MISMATCH_AVERAGE_PERCENT
      || (worst && worst.differencePercent > MISMATCH_SINGLE_PERCENT)
    );
    verdict = mismatch ? "different_user" : "same_user";
  }

  return {
    verdict,
    averageDifference,
    largestDifference: worst
      ? { label: worst.label, differencePercent: worst.differencePercent }
      : null,
    comparedMetrics: scored.length,
    thresholds: {
      averagePercent: MISMATCH_AVERAGE_PERCENT,
      singleMetricPercent: MISMATCH_SINGLE_PERCENT,
      minimumSamples: MIN_SAMPLES,
    },
    rows,
  };
}

const PORT = Number(process.env.MOCKUP_PORT || 4000);
const HOST = process.env.MOCKUP_HOST || "127.0.0.1";
const ODYSSEUS_ORIGIN =
  process.env.ODYSSEUS_ORIGIN || "http://127.0.0.1:3000";

const DEMO_USERNAME = "username";
const DEMO_PASSWORD = "password";

class AccountServiceDown extends Error {}

// Odysseus binds CSRF to a cookie, so every forwarded call starts by picking
// up a fresh cookie and token from an unauthenticated probe.
async function odysseusSession() {
  let response = null;
  try {
    response = await fetch(`${ODYSSEUS_ORIGIN}/api/auth/me`, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new AccountServiceDown(error.message);
  }

  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]);
  const csrfCookie = cookies.find((cookie) =>
    cookie.startsWith("odysseus_csrf="),
  );

  return {
    cookieHeader: cookies.join("; "),
    csrfToken: csrfCookie
      ? decodeURIComponent(csrfCookie.slice("odysseus_csrf=".length))
      : "",
  };
}

async function forwardCredentials(pathname, payload) {
  const session = await odysseusSession();
  let response = null;
  try {
    response = await fetch(`${ODYSSEUS_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": session.csrfToken,
        Cookie: session.cookieHeader,
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
  return { status: response.status, body };
}

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
app.use(express.json({ limit: "16kb" }));

app.post("/api/signup", async (request, response) => {
  const credentials = credentialsFrom(request);

  try {
    const result = await forwardCredentials(
      "/api/auth/register",
      credentials,
    );

    if (result.status === 201) {
      response.status(201).json({
        username: result.body?.user?.username || credentials.username,
      });
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
      response.json({
        username: result.body?.user?.username || credentials.username,
      });
      return;
    }

    if (result.status === 429) {
      response.status(429).json({
        error: "Too many attempts. Wait a moment and try again.",
      });
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

function behaviorKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validMetrics(metrics) {
  return (
    metrics
    && typeof metrics === "object"
    && typeof metrics.keyboard === "object"
    && typeof metrics.mouse === "object"
  );
}

// role "baseline" is the real-user reference, "sample" is the session being
// checked against it.
for (const role of ["baseline", "sample"]) {
  app.post(`/api/behavior/${role}`, async (request, response) => {
    const key = behaviorKey(request.body?.username);
    const metrics = request.body?.metrics;

    if (!key) {
      response.status(400).json({ error: "Sign in before extracting" });
      return;
    }
    if (!validMetrics(metrics)) {
      response.status(400).json({ error: "The recorded session was empty" });
      return;
    }

    try {
      await queueBehavior(async () => {
        const profiles = await readBehavior();
        const profile = profiles[key] || {};
        profile[role] = {
          capturedAt: new Date().toISOString(),
          metrics,
        };
        if (role === "baseline") {
          // A new reference invalidates the previous comparison.
          delete profile.sample;
        }
        profiles[key] = profile;
        await writeBehavior(profiles);
      });
      response.status(201).json({ role, username: key });
    } catch (error) {
      console.error(`could not store the ${role}`, error);
      response.status(500).json({ error: "The extract could not be saved" });
    }
  });
}

app.get("/api/behavior/report", async (request, response) => {
  const key = behaviorKey(request.query.username);
  if (!key) {
    response.status(400).json({ error: "Enter an account username" });
    return;
  }

  try {
    const profiles = await readBehavior();
    const profile = profiles[key];
    if (!profile || !profile.baseline) {
      response.status(404).json({
        error: "No real-user extract is saved for that account yet",
      });
      return;
    }

    response.json({
      username: key,
      baseline: profile.baseline,
      sample: profile.sample || null,
      comparison: profile.sample
        ? compare(profile.baseline, profile.sample)
        : null,
    });
  } catch (error) {
    console.error("could not build the behavior report", error);
    response.status(500).json({ error: "The report could not be built" });
  }
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
