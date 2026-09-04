import { createServer, IncomingMessage, ServerResponse } from "node:http";

export const RUNNER_CLAIM_PATH = "/internal/v1/test-runner/jobs/claim";

export type RunnerJob = {
  job_id: string;
  payment_attempt_id: string;
  executor_token: string;
  razorpay_order_id: string;
  razorpay_key_id: string;
  amount_minor: string;
  currency: string;
  callback_origin?: string;
  scenario: string;
  checkout_page_url?: string;
};

export type RunnerObservation = {
  executor_token: string;
  observed_screen: string;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
  not_capture?: boolean;
};

export type RunnerCore = {
  claimJob(executorCredential: string): Promise<RunnerJob | null>;
  recordObservation(jobId: string, observation: RunnerObservation): Promise<void>;
};

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

export async function handleRunnerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedCredential: string,
  core: RunnerCore,
): Promise<void> {
  if (bearer(req) !== expectedCredential) {
    res.statusCode = 401;
    res.end(JSON.stringify({ code: "HOST_UNAUTHENTICATED" }));
    return;
  }
  if (req.method === "POST" && req.url === RUNNER_CLAIM_PATH) {
    const job = await core.claimJob(expectedCredential);
    if (!job) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(job));
    return;
  }
  const observe = req.url?.match(/^\/internal\/v1\/test-runner\/jobs\/([^/]+)\/observations$/);
  if (req.method === "POST" && observe) {
    const body = (await readJson(req)) as RunnerObservation;
    body.not_capture = true;
    await core.recordObservation(decodeURIComponent(observe[1]), body);
    res.statusCode = 202;
    res.end(JSON.stringify({ accepted: true, not_capture: true }));
    return;
  }
  res.statusCode = 404;
  res.end();
}

export function createRunnerServer(expectedCredential: string, core: RunnerCore) {
  return createServer((req, res) => {
    if (req.url === "/health/live" || req.url === "/health/ready") {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    void handleRunnerRequest(req, res, expectedCredential, core);
  });
}
