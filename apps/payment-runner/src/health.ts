import { createServer } from "node:http";
import { loadConfig, type RunnerConfig } from "./config.js";

export type HealthComponents = {
  process: boolean;
  gateway: boolean;
  claim_credential: boolean;
  browser_executor: boolean;
  active_job: boolean;
  callback_report: boolean;
};

export type HealthState = {
  activeJob: boolean;
  lastHeartbeatAt?: string | null;
  lastJobPollAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  currentJob?: string | null;
};

export type HealthSnapshot = {
  status: "ok" | "not_ready";
  process: string;
  components: HealthComponents;
  last_heartbeat_at: string | null;
  last_job_poll_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  current_job: string | null;
  operator_assisted: true;
};

export async function probeReadiness(cfg: RunnerConfig, state: HealthState): Promise<HealthSnapshot> {
  const components: HealthComponents = {
    process: true,
    gateway: false,
    claim_credential: Boolean(cfg.executorCredential),
    browser_executor: false,
    active_job: state.activeJob,
    callback_report: Boolean(cfg.endpoint) && Boolean(cfg.executorCredential),
  };
  try {
    const url = new URL("/health/live", cfg.endpoint);
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) });
    components.gateway = res.ok || res.status === 404;
  } catch {
    components.gateway = false;
  }
  try {
    await import("playwright");
    components.browser_executor = true;
  } catch {
    components.browser_executor = false;
  }
  const ready =
    components.process &&
    components.gateway &&
    components.claim_credential &&
    components.browser_executor &&
    components.callback_report;
  return {
    status: ready ? "ok" : "not_ready",
    process: "payment-runner",
    components,
    last_heartbeat_at: state.lastHeartbeatAt ?? new Date().toISOString(),
    last_job_poll_at: state.lastJobPollAt ?? null,
    last_success_at: state.lastSuccessAt ?? null,
    last_failure_at: state.lastFailureAt ?? null,
    current_job: state.currentJob ?? null,
    operator_assisted: true,
  };
}

export function startHealthServer(
  addr: string,
  probe?: () => Promise<HealthSnapshot> | HealthSnapshot,
): ReturnType<typeof createServer> {
  const [host, portRaw] = addr.includes(":") ? addr.split(":") : ["127.0.0.1", addr];
  const port = Number(portRaw);
  const server = createServer((req, res) => {
    if (req.url === "/health/live") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", process: "payment-runner" }));
      return;
    }
    if (req.url === "/health/ready") {
      void (async () => {
        const snap = probe
          ? await probe()
          : await probeReadiness(loadConfig(), { activeJob: false });
        res.statusCode = snap.status === "ok" ? 200 : 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(snap));
      })();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, host);
  return server;
}
