"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  chromium,
  defineConfig,
  devices,
  firefox,
  webkit,
} = require("@playwright/test");

const HOST = "127.0.0.1";
const PORT = 3217;
const baseURL = `http://localhost:${PORT}`;
const runId = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const runtimeDirectory = path.join(
  os.tmpdir(),
  `odysseus-playwright-${runId}`
);

function browserIsInstalled(browserType) {
  try {
    return fs.existsSync(browserType.executablePath());
  } catch (_error) {
    return false;
  }
}

const projects = [];

if (browserIsInstalled(chromium)) {
  projects.push({
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  });
}

if (browserIsInstalled(firefox)) {
  projects.push({
    name: "firefox",
    use: { ...devices["Desktop Firefox"] },
  });
}

if (browserIsInstalled(webkit)) {
  projects.push({
    name: "webkit",
    use: { ...devices["Desktop Safari"] },
  });
}

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [["list"]],
  outputDir: path.join(os.tmpdir(), `odysseus-playwright-output-${runId}`),
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects,
  webServer: {
    command: "node server.js",
    url: `${baseURL}/api/health`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST,
      PORT: String(PORT),
      ODYSSEUS_DATABASE_PATH: path.join(runtimeDirectory, "odysseus.sqlite"),
      ODYSSEUS_MASTER_KEY: crypto.randomBytes(32).toString("base64"),
      ODYSSEUS_ALLOWED_ORIGINS: baseURL,
      ODYSSEUS_WEBAUTHN_ORIGINS: baseURL,
      ODYSSEUS_WEBAUTHN_RP_ID: "localhost",
      ODYSSEUS_EXPOSE_RECOVERY_TOKENS: "true",
    },
  },
});
