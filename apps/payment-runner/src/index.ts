import { loadConfig } from "./config.js";
import { startHealthServer, probeReadiness, type HealthState } from "./health.js";
import { RunnerClient } from "./client.js";
import { playwrightExecutor, type BrowserExecutor } from "./checkout.js";

const heartbeat: HealthState = {
  activeJob: false,
  lastHeartbeatAt: new Date().toISOString(),
  lastJobPollAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  currentJob: null,
};

export async function runOnce(executor: BrowserExecutor = playwrightExecutor): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.executorCredential) {
    throw new Error("ATLAS_RUNNER_EXECUTOR_CREDENTIAL is required");
  }
  const client = new RunnerClient(cfg.endpoint, cfg.executorCredential);
  heartbeat.lastHeartbeatAt = new Date().toISOString();
  heartbeat.lastJobPollAt = new Date().toISOString();
  const job = await client.claim();
  if (!job) {
    heartbeat.currentJob = null;
    return false;
  }
  heartbeat.activeJob = true;
  heartbeat.currentJob = job.job_id;
  await client.observe(job.job_id, job.executor_token, "checkout_opened");
  const screen = await executor(job, cfg.browserTimeoutMs);
  await client.observe(job.job_id, job.executor_token, screen);
  heartbeat.lastSuccessAt = new Date().toISOString();
  heartbeat.currentJob = null;
  heartbeat.activeJob = false;
  return true;
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  startHealthServer(cfg.httpAddr, () => {
    heartbeat.lastHeartbeatAt = new Date().toISOString();
    return probeReadiness(cfg, heartbeat);
  });
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      heartbeat.activeJob = false;
      heartbeat.currentJob = null;
      heartbeat.lastFailureAt = new Date().toISOString();
      console.error("runner loop error", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
