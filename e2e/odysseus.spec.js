"use strict";

const { expect, test } = require("@playwright/test");

const {
  TEST_PASSWORD,
  observePageFailures,
  openOdysseus,
  registerAccount,
  uniqueUsername,
} = require("./helpers");

test("boots without browser errors", async ({ page }) => {
  const failures = observePageFailures(page);

  await openOdysseus(page);
  await expect(page.getByRole("heading", {
    name: "Trust that adapts to how you interact",
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

  await expect(page.locator("#security-center")).toBeVisible();
  await expect(page.locator("#enrollment-input")).toBeEnabled();
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

test("accepts the guided phrase only after the final character", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "guided");

  const guided = page.locator("#enrollment-input");
  const freeTyping = page.getByLabel("Free typing").first();
  const phrase = (await page.locator("#enrollment-phrase").innerText()).trim();

  await guided.pressSequentially(phrase.slice(0, -1), { delay: 2 });
  await expect(page.locator("#enrollment-text-status")).toHaveText(
    /1 character(?:s)? left/
  );
  await expect(guided).not.toHaveAttribute("readonly");

  await guided.pressSequentially(phrase.slice(-1), { delay: 2 });
  await expect(page.locator("#enrollment-text-status")).toHaveText(
    "Phrase accepted"
  );
  await expect(guided).toHaveAttribute("readonly");
  await expect(freeTyping).toBeFocused();
});

test("provides a usable free typing diagnostic", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "free_typing");

  const freeTyping = page.getByLabel("Free typing").first();
  await expect(freeTyping).toBeEnabled();
  await expect(page.locator("#enrollment-free-help")).toContainText(
    "Write anything natural"
  );

  await freeTyping.pressSequentially("four calm words written freely", {
    delay: 2,
  });
  await expect(page.locator("#enrollment-free-status")).toHaveText(
    "Free typing ready"
  );
});

test("registers and lists the current device", async ({
  page,
}, testInfo) => {
  await openOdysseus(page);
  await registerAccount(page, testInfo, "device");

  await expect(page.locator("#current-device-summary")).not.toContainText(
    "Collecting"
  );
  await expect(page.locator("#device-kind")).not.toHaveText("Unavailable");

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

test("handles disabled external providers without breaking local auth", async ({
  page,
}, testInfo) => {
  const failures = observePageFailures(page);
  await openOdysseus(page);

  await expect(page.locator("#turnstile-container")).toBeHidden();
  await registerAccount(page, testInfo, "providers_off");
  await page.getByRole("button", {
    name: "Explain current signals",
  }).click();

  await expect(page.locator("#explanation-status")).toContainText(
    /(not enabled|unavailable|disabled|not configured|received)/i
  );
  await expect(page.locator("#explanation-text")).not.toBeEmpty();
  expect(failures).toEqual([]);
});
