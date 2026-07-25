"use strict";

const { expect } = require("@playwright/test");

const TEST_PASSWORD = "abc123";

// The only refusal text the console is allowed to show after a behavioral
// denial. app.js routes every behavioral outcome through this single string.
const GENERIC_SIGN_IN_FAILURE =
  "We could not complete this sign-in. Check your details and try again.";

// Phrases that only a behavioral verdict would produce. None of them may
// appear in rendered page text anywhere outside the bypass-gated /admin
// report. Checked against visible text only, so copy inside the permanently
// hidden markup that app.js still binds does not trip them.
const BEHAVIOR_VERDICT_PATTERN = new RegExp(
  [
    "behaviou?ral",
    "biometric",
    "keystroke",
    "trust (score|level|state|panel)",
    "identity (similarity|distance|match)",
    "automation (risk|verdict|level|likelihood)",
    "decision reason",
    "reason code",
    "session (outlook|decision)",
    "different from (your )?baseline",
    "setup progress",
    "round \\d+ of \\d+",
    "\\d+ of 5",
  ].join("|"),
  "i",
);

// The refusal screen is held to a stricter bar than an authenticated view: a
// signed-out visitor has no legitimate reason to read any of this vocabulary,
// so near-misses count as leaks too.
const BEHAVIOR_LEAK_PATTERN = new RegExp(
  [
    BEHAVIOR_VERDICT_PATTERN.source,
    "trust",
    "automation",
    "automated",
    "similarity",
    "fingerprint",
    "profil(e|ing)",
    "baseline",
    "score",
    "decision",
    "risk",
    "suspicious",
    "anomal",
    "flagged",
    "restrict",
    "ip address",
    "distance",
    "sample",
  ].join("|"),
  "i",
);

// Elements that render behavioral output. They exist in the DOM only because
// app.js aborts start-up when one of its bound ids is missing; none of them
// may ever be shown to a signed-in or refused user.
const BEHAVIOR_OUTPUT_SELECTORS = Object.freeze([
  "#behavior-access-warning",
  "#simulated-ip-warning",
  ".trust-panel",
  "#trust-state",
  "#trust-score",
  "#decision-reason",
  "#automation-card",
  "#automation-level",
  "#automation-explanation",
  "#metric-dwell",
  "#metric-flight",
  "#metric-pointer",
  "#security-report",
  "#enrollment-progress",
  "#enrollment-progress-label",
  "#enrollment-round-tag",
  "#enrollment-status",
  "#explanation-request",
  "#explanation-text",
]);

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

// Signs in against a stubbed /api/auth/login response and returns everything
// needed to compare one refusal against another: the rendered page text with
// the status line masked out, the status line itself, and the focused element.
async function captureSignInRefusal(page, responseBody, status) {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(responseBody),
    });
  });

  try {
    await openOdysseus(page);
    const authForm = page.locator("#auth-form");
    await authForm.getByLabel("Username", { exact: true }).fill("person_a");
    await authForm.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
    await authForm.getByRole("button", { name: "Sign in" }).click();

    // The refusal has landed once the working message has been replaced.
    await expect(page.locator("#auth-status")).toHaveAttribute(
      "data-state",
      "error",
    );
    await expect(page.locator("#auth-form")).toBeVisible();

    const statusText = await page.locator("#auth-status").innerText();
    const visibleText = await page.locator("body").innerText();
    return {
      statusText,
      focusedElementId: await page.evaluate(
        () => (document.activeElement || {}).id || "",
      ),
      // Masking the one line that is allowed to differ leaves the rest of the
      // page as the thing that must be identical between refusal kinds.
      maskedText: visibleText.split(statusText).join("<status>"),
      visibleText,
    };
  } finally {
    await page.unroute("**/api/auth/login");
  }
}

// Nothing behavioral may be rendered, whatever the outcome of the check.
// `strictText` applies the wider near-miss vocabulary; it suits the signed-out
// refusal screen, where no behavioral wording is legitimate. Authenticated
// views are scanned with the verdict-only pattern, because ordinary account
// copy legitimately says things like "profiles" and "a small sample set".
async function expectNoBehaviorDisclosure(page, options) {
  const strictText = (options || {}).strictText === true;
  for (const selector of BEHAVIOR_OUTPUT_SELECTORS) {
    await expect(
      page.locator(selector),
      `${selector} must never be shown to a user`,
    ).toBeHidden();
  }
  const visibleText = await page.locator("body").innerText();
  expect(
    visibleText,
    "rendered text leaked a behavioral term",
  ).not.toMatch(strictText ? BEHAVIOR_LEAK_PATTERN : BEHAVIOR_VERDICT_PATTERN);
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
  BEHAVIOR_LEAK_PATTERN,
  BEHAVIOR_OUTPUT_SELECTORS,
  BEHAVIOR_VERDICT_PATTERN,
  GENERIC_SIGN_IN_FAILURE,
  TEST_PASSWORD,
  captureSignInRefusal,
  completeMockQuestionnaire,
  expectNoBehaviorDisclosure,
  isExpectedResourceError,
  observePageFailures,
  openOdysseus,
  registerAccount,
  uniqueUsername,
};
