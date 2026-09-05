import { test, expect } from "@playwright/test";

test("dashboard loads without login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("merchant-data")).toBeVisible();
  await expect(page.getByTestId("merchant-name")).toContainText("QuickMart");
  await expect(page.getByTestId("commerce-strategies")).toBeVisible();
  await expect(page.getByTestId("atlaslab-framework")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Console" })).toHaveCount(0);
});

test("merchant, strategies, and AtlasLab framework are on one page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("missing-catalog")).toContainText("live products loaded");
  await expect(page.getByTestId("commerce-strategies")).toContainText("Free delivery");
  await expect(page.getByTestId("atlaslab-framework")).toContainText("Agent compatibility");
  await expect(page.getByTestId("atlaslab-framework")).toContainText("Commercial uplift");
  await expect(page.getByTestId("atlaslab-framework")).toContainText("Tight breakfast under ₹180");
});

test("shows fixture confirmed orders and eval numbers with run buttons", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("confirmed-orders")).toBeVisible();
  await expect(page.getByTestId("confirmed-order-count")).toHaveText("3");
  await expect(page.getByTestId("order-ord_qm_fixture_88421")).toContainText("Readiness");
  await expect(page.getByTestId("order-ord_qm_fixture_88421")).toContainText("Confirmed order");
  await expect(page.getByTestId("order-ord_qm_fixture_88421")).toContainText("Payment assurance");
  await expect(page.getByTestId("eval-score-deterministic")).toContainText("12 / 12");
  await expect(page.getByTestId("eval-score-compatibility")).toContainText("4 / 4");
  await expect(page.getByTestId("eval-test-score-breakfast_180")).toContainText("94");
  await expect(page.getByTestId("run-eval-deterministic")).toBeVisible();
  await expect(page.getByTestId("run-eval-compatibility")).toBeVisible();
  await expect(page.getByTestId("run-eval-commercial")).toBeVisible();
  await expect(page.getByTestId("run-eval-test-breakfast_180")).toBeVisible();

  await page.getByTestId("run-eval-deterministic").click();
  await expect(page.getByTestId("eval-run-status-deterministic")).toContainText("fixture");
});

test("retired console routes redirect to the dashboard", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
