"use strict";

const { expect, test } = require("@playwright/test");

const {
  GENERIC_SIGN_IN_FAILURE,
  TEST_PASSWORD,
  captureSignInRefusal,
  completeMockQuestionnaire,
  expectNoBehaviorDisclosure,
  observePageFailures,
  openOdysseus,
  registerAccount,
  uniqueUsername,
} = require("./helpers");

// A denied login response. The console must react to it exactly as it reacts
// to a wrong password: nothing in this payload may reach the page.
const DENIED_LOGIN_BODY = Object.freeze({
  error: {
    code: "BEHAVIOR_LOGIN_DENIED",
    message: "Behavioral review required.",
  },
  behaviorDecision: {
    decision: "deny",
    classification: "suspicious_identity",
    identitySimilarity: {
      classification: "different_from_baseline",
      trustPercent: 22,
      normalizedDistance: 3.2,
      reasonCodes: ["IDENTITY_DISTANCE_TOO_HIGH"],
    },
    automationRisk: {
      classification: "human_like_interaction",
    },
    simulatedIpRestriction: {
      displayed: true,
      enforced: false,
    },
    amendment: {
      applied: false,
      status: "not_applied",
    },
  },
});

const CREDENTIAL_FAILURE_BODY = Object.freeze({
  error: {
    code: "INVALID_CREDENTIALS",
    message: "The username or password is incorrect.",
  },
});

test("boots without browser errors", async ({ page }) => {
  const failures = observePageFailures(page);

  await openOdysseus(page);
  await expect(page.getByRole("heading", {
    name: /Enter your secure workspace/i,
  })).toBeVisible();
  await expect(page.locator("#auth-status")).not.toContainText("unavailable", {
    ignoreCase: true,
  });

  expect(failures).toEqual([]);
});

test("bootstraps an anonymous CSRF token", async ({ context, page }) => {
  await openOdysseus(page);

  const cookies = await context.cookies();
  const csrf = cookies.find((cookie) => cookie.name === "odysseus_csrf");

  expect(csrf).toBeDefined();
  expect(csrf.value.length).toBeGreaterThan(20);
  expect(csrf.httpOnly).toBe(false);
  expect(csrf.sameSite).toBe("Strict");
});

test("registers with an exact six character test password", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "sixchar");

  await expect(page.locator("#session-workspace")).toBeVisible();
  await expect(page.locator("#enrollment-input")).toBeEnabled();
  await expect(page.locator(".profile-bar")).toBeHidden();
  await expect(page.locator(".trust-panel")).toBeHidden();
  await expect(page.locator(".verification-panel")).toBeHidden();
  await expect(page.locator("#enrollment-board")).toBeHidden();

  // A "2 of 5" counter or a round tag would tell the user that a behavioral
  // baseline is being assembled, so neither is rendered.
  await expect(page.locator("#enrollment-round-tag")).toBeHidden();
  await expect(page.locator("#enrollment-progress")).toBeHidden();
  await expect(page.locator("#enrollment-progress-label")).toBeHidden();
  await expect(page.locator("#enrollment-status")).toBeHidden();
});

test("signs out and creates a fresh account without a CSRF failure", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "before_logout");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#auth-form")).toBeVisible();
  await expect(page.locator("#auth-status")).toContainText("Signed out");

  const freshUsername = uniqueUsername(testInfo, "after_logout");
  const authForm = page.locator("#auth-form");
  await page.locator("#auth-mode").selectOption("register");
  await authForm.getByLabel("Username", { exact: true }).fill(freshUsername);
  await authForm.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await authForm.getByRole("button", { name: "Create account" }).click();

  await expect(page.locator("#current-user")).toHaveText(freshUsername);
  await expect(page.locator("#auth-status")).not.toContainText("CSRF", {
    ignoreCase: true,
  });
});

test("accepts a sufficiently complete security response", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "guided");

  const guided = page.locator("#enrollment-input");

  await guided.pressSequentially("my note", { delay: 2 });
  await expect(page.locator("#enrollment-text-status")).toHaveText(
    /characters left/
  );
  await expect(guided).not.toHaveAttribute("readonly");

  await guided.pressSequentially(" for review", { delay: 2 });
  await expect(page.locator("#enrollment-text-status")).toHaveText(
    "Response ready"
  );
  await expect(guided).toHaveAttribute("readonly");
});

test("reserves the longer free response for the final setup round", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "free_typing");

  const freeTyping = page.locator("#enrollment-free-input");
  await expect(freeTyping).toBeHidden();
  await expect(freeTyping).toBeDisabled();
  await expect(page.locator("#enrollment-free-status")).toHaveText(
    "Open response later"
  );
});

test("opens the stock dashboard after the mock questionnaire", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "dashboard_flow");
  await completeMockQuestionnaire(page);

  await expect(page.locator("#dashboard-overview")).toBeVisible();
  await expect(page.locator("#dashboard-title")).toHaveText("Dashboard");
  await expect(page.locator("#session-workspace")).toBeHidden();
  await expect(page).toHaveURL("/");

  // Reaching the dashboard is the only feedback the check produces. The trust
  // score, decision reason, automation card, raw signal metrics, and the
  // technical report stay hidden even after a successful comparison.
  await expect(page.locator(".trust-panel")).toBeHidden();
  await expect(page.locator("#trust-score")).toBeHidden();
  await expect(page.locator("#decision-reason")).toBeHidden();
  await expect(page.locator("#automation-card")).toBeHidden();
  await expect(page.locator("#security-report")).toBeHidden();
});

test("registers and lists the current device", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "device");
  await completeMockQuestionnaire(page, "device setup response");

  await expect(page.locator("#current-device-summary")).not.toContainText(
    "Collecting"
  );
  await expect(page.locator("#device-kind")).not.toHaveText("Unavailable");

  await page.getByRole("button", { name: "Account security" }).click();
  await expect(page.locator("#account-workspace")).toBeVisible();
  await page.locator("#security-center > details > summary").click();
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/devices")
    && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "Register this device" }).click();
  const response = await responsePromise;

  expect(response.ok()).toBe(true);
  await expect(page.locator("#device-status")).toContainText(
    /1 managed device returned/i
  );
  await expect(page.locator("#device-list li")).toHaveCount(1);
  await expect(page.locator("#device-list")).toContainText("Current session");
});

test("explains passkey capability limits without opening hardware UI", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
  });
  await openOdysseus(page);

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.locator("#passkey-login-status")).toHaveText(
    /Passkeys require WebAuthn support and a compatible secure browser context/i
  );
});

test("handles unavailable or gated providers without breaking local auth", async ({
  page,
}, testInfo) => {
  const failures = observePageFailures(page);
  await openOdysseus(page);

  await expect(page.locator("#turnstile-container")).toBeHidden();
  await registerAccount(page, testInfo, "providers_off");
  await completeMockQuestionnaire(page, "provider setup response");
  await page.getByRole("button", { name: "Account security" }).click();
  await expect(page.locator("#account-workspace")).toBeVisible();
  await page.locator("#security-center > details > summary").click();

  // The advisory Gemini explanation is a behavioral verdict in prose, so the
  // control that requested it is no longer offered anywhere in the console.
  // It stays in the DOM because account.js binds it during start-up.
  await expect(page.locator("#explanation-request")).toHaveCount(1);
  await expect(page.locator("#explanation-request")).toBeHidden();
  await expect(page.locator("#explanation-text")).toBeHidden();
  await expect(page.locator("#explanation-status")).toBeHidden();
  await expect(page.getByRole("button", {
    name: "Explain this result",
  })).toBeHidden();

  // Unconfigured providers must not break the parts of the account view that
  // a user can still reach.
  await expect(page.getByRole("button", {
    name: "Register this device",
  })).toBeVisible();
  await expectNoBehaviorDisclosure(page);
  expect(failures).toEqual([]);
});

test("serves both local account report pages", async ({
  page,
}) => {
  const failures = observePageFailures(page);

  // Both viewers are served only while ODYSSEUS_DEMO_ADMIN_BYPASS is set (see
  // playwright.config.js) and only to a loopback client. The form itself takes
  // the account's own username and password, not the bypass value.
  await page.goto("/admin");
  await expect(page.getByRole("heading", {
    name: "Inspect one account fingerprint",
  })).toBeVisible();
  await expect(page.getByLabel("Account username")).toBeVisible();
  await expect(page.getByLabel("Account password")).toBeVisible();

  const testPage = await page.goto("/admin/test");
  expect(testPage.ok()).toBe(true);
  await expect(page.getByRole("heading", {
    name: "Build a stronger comparison report",
  })).toBeVisible();
  await expect(page.getByLabel("Account name")).toBeVisible();
  await expect(page.getByLabel("Account password")).toBeVisible();
  expect(failures).toEqual([]);
});

test("renders saved decisions, contributions, and update history", async ({
  page,
}) => {
  await page.route("**/api/demo-admin/report", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        report: {
          generatedAt: "2026-07-25T12:00:00.000Z",
          account: {
            username: "person_a",
            createdAt: "2026-07-25T10:00:00.000Z",
          },
          interpretation: {
            separation: "Identity similarity and automation risk are separate.",
            caution: "This demo does not prove identity.",
            identityQuestion: "Does this resemble the saved baseline?",
            automationQuestion: "Does this resemble automation?",
          },
          securityPosture: {
            registeredDevices: 1,
            passkeys: 0,
            credentialAutomationFlags: 1,
          },
          fingerprints: [],
          comparisons: [{
            comparisonLabel: "Comparison 1",
            claimedSubject: "Unlabeled session",
            profileId: "person_a",
            evaluatedAt: "2026-07-25T11:00:00.000Z",
            identitySimilarity: {
              decision: "deny",
              trustPercent: 22,
              normalizedDistance: 3.2,
              acceptanceThreshold: 1,
              reasonCodes: ["IDENTITY_DISTANCE_TOO_HIGH"],
            },
            automationRisk: {
              classification: "human_like_interaction",
            },
            sampleCounts: {
              dwell: 18,
              flight: 17,
              pointer: 5,
            },
            featureDeltas: [{
              name: "dwellMean",
              normalizedDelta: 2.4,
            }],
          }],
          strongTests: [],
          updateHistory: [{
            createdAt: "2026-07-25T11:30:00.000Z",
            profileId: "person_a",
            status: "applied",
            samplesAdded: 3,
            source: "admin_test",
          }],
          recentActivity: [],
        },
      }),
    });
  });

  await page.goto("/admin");
  await page.getByLabel("Account username").fill("person_a");
  await page.getByLabel("Account password").fill(TEST_PASSWORD);
  await page.getByRole("button", {
    name: "Prepare account report",
  }).click();

  await expect(page.locator("#admin-report")).toBeVisible();
  await expect(page.getByText("Identity Distance Too High")).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Feature and component contributions",
  })).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "Fingerprint update history",
  })).toBeVisible();
  await expect(page.locator("#admin-report")).toContainText("Applied");
});

test("sends text-free login behavior evidence and discloses nothing", async ({
  page,
}) => {
  const username = "person_a_login";
  const password = TEST_PASSWORD;
  let loginBody = null;

  await page.route("**/api/auth/login", async (route) => {
    loginBody = route.request().postDataJSON();
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify(DENIED_LOGIN_BODY),
    });
  });

  await openOdysseus(page);
  const authForm = page.locator("#auth-form");
  await authForm.getByLabel("Username", { exact: true }).pressSequentially(
    username,
    { delay: 8 },
  );
  await authForm.getByLabel("Password", { exact: true }).pressSequentially(
    password,
    { delay: 8 },
  );
  await authForm.getByRole("button", { name: "Sign in" }).click();

  // The console lands back on an ordinary, unexplained sign-in refusal. The
  // retired review panel, and the simulated-restriction notice it contained,
  // must stay hidden even though the response asked for both.
  await expect(page.locator("#auth-status")).toHaveText(
    GENERIC_SIGN_IN_FAILURE,
  );
  await expect(page.locator("#auth-form")).toBeVisible();
  await expect(page.locator("#auth-username")).toBeFocused();
  await expect(page.locator("#auth-password")).toHaveValue("");
  await expect(page.locator("#behavior-access-warning")).toBeHidden();
  await expect(page.locator("#simulated-ip-warning")).toBeHidden();
  await expect(page.getByRole("button", {
    name: "Return to sign in",
  })).toBeHidden();

  // Nothing from behaviorDecision reaches the page: no trust score, no
  // decision, no reason code, no automation verdict, no profiling progress.
  await expectNoBehaviorDisclosure(page, { strictText: true });
  const visibleText = await page.locator("body").innerText();
  for (const leaked of [
    "22",
    "3.2",
    "IDENTITY_DISTANCE_TOO_HIGH",
    "Identity Distance Too High",
    "suspicious_identity",
    "human_like_interaction",
    "different_from_baseline",
    "Behavioral review required.",
  ]) {
    expect(visibleText).not.toContain(leaked);
  }

  // The evidence still travels, and still carries no text or key identity.
  expect(loginBody.behaviorEvidence.profileId).toBe(username);
  expect(["ready", "insufficient_evidence"]).toContain(
    loginBody.behaviorEvidence.status,
  );
  if (loginBody.behaviorEvidence.status === "ready") {
    expect(loginBody.behaviorEvidence.diagnostics.missionId).toBe(
      "steady-session",
    );
    expect(loginBody.behaviorEvidence.sampleCounts).toEqual(
      loginBody.behaviorEvidence.interactionEvidence.sampleCounts,
    );
  }
  const serializedEvidence = JSON.stringify(loginBody.behaviorEvidence);
  expect(serializedEvidence).not.toContain(password);
  expect(serializedEvidence).not.toMatch(
    /"(key|keys|keyCode|keyCodes|code|codes|char|chars|text|value|content|transcript)"\s*:/i,
  );
});

test("makes a behavioral refusal indistinguishable from a wrong password", async ({
  page,
}) => {
  // Same 403 the server sends when the behavioral comparison denies access.
  const behavioral = await captureSignInRefusal(page, DENIED_LOGIN_BODY, 403);
  // A second behavioral outcome: sparse evidence, no simulated restriction.
  const sparse = await captureSignInRefusal(page, {
    error: {
      code: "BEHAVIOR_LOGIN_DENIED",
      message: "More interaction is required.",
    },
    behaviorDecision: {
      decision: "review",
      classification: "insufficient_evidence",
      identitySimilarity: { classification: "insufficient_evidence" },
      automationRisk: { classification: "insufficient_evidence" },
      simulatedIpRestriction: { displayed: false, enforced: false },
    },
  }, 403);
  const credential = await captureSignInRefusal(
    page,
    CREDENTIAL_FAILURE_BODY,
    401,
  );

  // Two different behavioral verdicts produce the same message, so the user
  // cannot tell a mismatch from thin evidence, or either from a typo.
  expect(behavioral.statusText).toBe(GENERIC_SIGN_IN_FAILURE);
  expect(sparse.statusText).toBe(GENERIC_SIGN_IN_FAILURE);

  // Outside the single status line, every refusal renders identical text. Any
  // extra banner, badge, or explanation would break this equality.
  expect(behavioral.maskedText).toBe(credential.maskedText);
  expect(sparse.maskedText).toBe(credential.maskedText);
});

test("keeps ordinary credential failures generic", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify(CREDENTIAL_FAILURE_BODY),
    });
  });

  await openOdysseus(page);
  const authForm = page.locator("#auth-form");
  await authForm.getByLabel("Username", { exact: true }).fill(
    "unknown_account",
  );
  await authForm.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await authForm.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator("#auth-status")).toHaveText(
    "The username or password is incorrect.",
  );
  await expect(page.locator("#behavior-access-warning")).toBeHidden();
  await expectNoBehaviorDisclosure(page, { strictText: true });
});
