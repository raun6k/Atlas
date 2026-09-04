import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ATLAS_FRONTEND_PORT ?? 3000);
const baseURL = process.env.ATLAS_FRONTEND_BASE_URL ?? `http://127.0.0.1:${port}`;

const frontendEnv = {
  ATLAS_ADMIN_API_URL: process.env.ATLAS_ADMIN_API_URL ?? "http://127.0.0.1:8080",
  ATLASLAB_API_URL: process.env.ATLASLAB_API_URL ?? "http://127.0.0.1:8090",
  ATLAS_FRONTEND_OPERATOR_SESSION_SECRET:
    process.env.ATLAS_FRONTEND_OPERATOR_SESSION_SECRET ?? "test-session-secret-32chars-minimum!!",
  ATLAS_ADMIN_SERVICE_TOKEN: process.env.ATLAS_ADMIN_SERVICE_TOKEN ?? "canary-admin-token-DO-NOT-LEAK-xyz",
  ATLASLAB_SERVICE_TOKEN: process.env.ATLASLAB_SERVICE_TOKEN ?? "canary-lab-token-DO-NOT-LEAK-abc",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx next dev --port ${port}`,
    url: `${baseURL}/health/live`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: frontendEnv,
  },
});
