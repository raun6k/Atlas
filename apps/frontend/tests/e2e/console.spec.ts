import { test, expect } from "@playwright/test";

const mockMode = process.env.ATLAS_FRONTEND_ENABLE_MOCKS !== "0";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill("merchant@quickmart.example");
  const password =
    process.env.ATLAS_SEED_OPERATOR_MERCHANT_PASSWORD ||
    process.env.ATLAS_TEST_ADMIN_BEARER;
  if (!password) {
    throw new Error("ATLAS_SEED_OPERATOR_MERCHANT_PASSWORD or ATLAS_TEST_ADMIN_BEARER is required");
  }
  await page.getByTestId("login-password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("test-mode-badge")).toBeVisible();
}

test("dashboard loads with authenticated operator session", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByTestId("claim-banner")).toContainText("does not claim real-world causal revenue uplift");
});

test("attention, sellability, merchant, offer, order, unresolved, audit, growth, missing data, disabled retry", async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId("attention-state")).toBeVisible();
  await expect(page.getByTestId("latest-order")).toBeVisible();

  await page.goto("/sellability");
  await expect(page.getByTestId("sellability-evidence")).toBeVisible();
  await expect(page.getByTestId("buyer-journey")).toContainText("Agent compatibility report exists");

  await page.goto("/merchant");
  await expect(page.getByTestId("merchant-data")).toBeVisible();
  await expect(page.getByTestId("missing-catalog")).toContainText("live products loaded");

  await page.goto("/commerce");
  await expect(page.getByTestId("offer-explanation")).toContainText(/threshold|Adding this item/);

  await page.goto("/trust");
  await expect(page.getByTestId("payment-assurance").first()).toContainText("Provider order");
  await expect(page.getByTestId("audit-timeline")).toContainText("PROVIDER_EVIDENCE");
  if (mockMode) {
    await expect(page.getByTestId("unresolved-payment")).toContainText("unknown");
    await expect(page.getByTestId("retry-disabled")).toBeDisabled();
  } else {
    await expect(page.getByTestId("payment-assurance").first()).toContainText("FAILED_VERIFIED");
    await expect(page.getByTestId("retry-disabled")).toBeDisabled();
    await expect(page.getByTestId("retry-disabled")).toContainText("No unsafe retry");
  }

  await page.goto("/growth");
  await expect(page.getByTestId("revenue-uplift")).toHaveAttribute("data-evidence-state", mockMode ? "unresolved" : "measured");
  await expect(page.getByTestId("growth-report")).toContainText(mockMode ? "0 eligible confirmed-order pairs" : "Eligible pairs1");
  await expect(page.getByTestId("control-treatment")).toContainText("control");
  await expect(page.getByTestId("orders-by-arm")).toBeVisible();
  await expect(page.getByTestId("growth-caveat")).toContainText(/does not (support|establish) (a )?real-world causal uplift/);

  await page.goto("/demo");
  await expect(page.getByTestId("not-claimed")).toContainText("Merchant settlement");
});
