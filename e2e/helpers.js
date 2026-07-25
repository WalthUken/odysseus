"use strict";

const { expect } = require("@playwright/test");

const TEST_PASSWORD = "abc123";

const EXPECTED_RESOURCE_ERRORS = new Map([
  [401, ["/api/auth/me"]],
  [403, ["/api/admin/summary"]],
  [409, ["/api/explanations"]],
  [
    404,
    [
      "/admin/test",
      "/api/security/summary",
      "/api/explanations",
      /^\/api\/profiles\/[^/]+$/,
    ],
  ],
  [501, ["/api/explanations"]],
]);

function uniqueUsername(testInfo, prefix) {
  const browser = String(testInfo.project.name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix || "e2e"}_${browser}_${time}_${random}`.slice(0, 64);
}

function observePageFailures(page) {
  const failures = [];

  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !isExpectedResourceError(message)
    ) {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  return failures;
}

function isExpectedResourceError(message) {
  const match = /status of (\d{3})/i.exec(message.text());
  if (!match) return false;

  const allowedPaths = EXPECTED_RESOURCE_ERRORS.get(Number(match[1]));
  if (!allowedPaths) return false;

  const locationUrl = message.location().url;
  if (!locationUrl) return false;
  try {
    const pathname = new URL(locationUrl).pathname;
    return allowedPaths.some((allowedPath) => (
      typeof allowedPath === "string"
        ? pathname === allowedPath
        : allowedPath.test(pathname)
    ));
  } catch (_error) {
    return false;
  }
}

async function openOdysseus(page) {
  await page.goto("/");
  await expect(page.locator("#api-status")).toHaveText("Engine online");
  await expect(page.locator("#auth-form")).toBeVisible();
}

async function registerAccount(page, testInfo, prefix) {
  const username = uniqueUsername(testInfo, prefix);
  const form = page.locator("#auth-form");

  await page.locator("#auth-mode").selectOption("register");
  await form.getByLabel("Username", { exact: true }).fill(username);
  await form.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();

  await expect(page.locator("#current-user")).toHaveText(username);
  await expect(page.locator("#current-user-panel")).toBeVisible();
  await expect(page.locator("#auth-status")).toContainText(
    `Account created. Signed in as ${username}`
  );
  return username;
}

async function completeMockQuestionnaire(page, prefix) {
  const response = page.locator("#enrollment-input");
  const answerPrefix = prefix || "normal account response";

  for (let round = 1; round <= 4; round += 1) {
    await response.pressSequentially(`${answerPrefix} number ${round}`, {
      delay: 4,
    });
    await expect(page.locator("#enrollment-round-tag")).toHaveText(
      `Round ${round + 1} of 5`
    );
  }

  await response.pressSequentially(`${answerPrefix} final answer`, {
    delay: 4,
  });
  const freeResponse = page.locator("#enrollment-free-input");
  await expect(freeResponse).toBeVisible();
  await freeResponse.pressSequentially(
    "review positions and check market activity",
    { delay: 4 }
  );

  await expect(page.locator("#dashboard-overview")).toBeVisible();
}

module.exports = {
  TEST_PASSWORD,
  completeMockQuestionnaire,
  isExpectedResourceError,
  observePageFailures,
  openOdysseus,
  registerAccount,
  uniqueUsername,
};
