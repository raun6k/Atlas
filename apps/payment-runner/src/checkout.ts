import type { ClaimedJob } from "./client.js";

export type BrowserExecutor = (job: ClaimedJob, timeoutMs: number) => Promise<"success_screen" | "failure_screen" | "timeout" | "possible_submission">;

/**
 * Playwright executor. Browser success is reported as an observation only.
 * Atlas Core still must fetch the provider to confirm capture.
 */
export const playwrightExecutor: BrowserExecutor = async (job, timeoutMs) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = job.checkout_page_url;
    if (!url) {
      return "possible_submission";
    }
    await page.goto(url, { timeout: timeoutMs });
    if (job.scenario === "failure") {
      await page.getByTestId("fail").click({ timeout: timeoutMs }).catch(() => undefined);
      return "failure_screen";
    }
    await page.getByTestId("success").click({ timeout: timeoutMs }).catch(() => undefined);
    const success = await page.getByTestId("success-done").isVisible().catch(() => false);
    if (success) {
      return "success_screen";
    }
    return "possible_submission";
  } catch {
    return "timeout";
  } finally {
    await browser.close();
  }
};
