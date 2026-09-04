import { test, expect } from "@playwright/test";

test("process slot is live", async ({ request }) => {
  const res = await request.get("/health/live");
  expect(res.ok()).toBeTruthy();
  await expect(res.json()).resolves.toMatchObject({ status: "live" });
});

test("placeholder page keeps the process visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas operator console" })).toBeVisible();
  await expect(page.getByTestId("test-mode-badge")).toContainText("RAZORPAY TEST MODE");
});
