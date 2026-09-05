import { loadConfig } from "./config.js";
import { startHealthServer, probeReadiness } from "./health.js";
import { RunnerClient } from "./client.js";
import { playwrightExecutor, type BrowserExecutor } from "./checkout.js";

export async function runOnce(executor: BrowserExecutor = playwrightExecutor): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.executorCredential) {
    throw new Error("ATLAS_RUNNER_EXECUTOR_CREDENTIAL is required");
  }
  const client = new RunnerClient(cfg.endpoint, cfg.executorCredential);
  const job = await client.claim();
  if (!job) {
    return false;
  }
  await client.observe(job.job_id, job.executor_token, "checkout_opened");
  const screen = await executor(job, cfg.browserTimeoutMs);
  await client.observe(job.job_id, job.executor_token, screen);
  return true;
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = { activeJob: false };
  startHealthServer(cfg.httpAddr, () => probeReadiness(cfg, state));
  for (;;) {
    try {
      state.activeJob = true;
      await runOnce();
      state.activeJob = false;
    } catch (err) {
      state.activeJob = false;
      console.error("runner loop error", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
