export type RunnerConfig = {
  endpoint: string;
  executorCredential: string;
  browserTimeoutMs: number;
  httpAddr: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  if (env.RAZORPAY_KEY_SECRET || env.RAZORPAY_WEBHOOK_SECRET || env.ATLAS_POSTGRES_URL) {
    throw new Error("payment-runner must not hold Razorpay secrets or a database URL");
  }
  const endpoint = env.ATLAS_RUNNER_ENDPOINT ?? "http://127.0.0.1:8080";
  const executorCredential = env.ATLAS_RUNNER_EXECUTOR_CREDENTIAL ?? "";
  const browserTimeoutMs = Number(env.ATLAS_RUNNER_BROWSER_TIMEOUT_MS ?? "90000");
  const httpAddr = env.ATLAS_RUNNER_HTTP_ADDR ?? "127.0.0.1:8091";
  return { endpoint, executorCredential, browserTimeoutMs, httpAddr };
}
