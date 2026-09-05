import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loadConfig } from "./config.js";
import { startHealthServer } from "./health.js";
import { runOnce } from "./index.js";

test("runner config rejects secrets and database urls", () => {
  assert.throws(() => loadConfig({ RAZORPAY_KEY_SECRET: "nope" }));
  assert.throws(() => loadConfig({ ATLAS_POSTGRES_URL: "postgres://x" }));
  const cfg = loadConfig({
    ATLAS_RUNNER_ENDPOINT: "http://127.0.0.1:8080",
    ATLAS_RUNNER_EXECUTOR_CREDENTIAL: "tok",
    ATLAS_RUNNER_HTTP_ADDR: "127.0.0.1:0",
  });
  assert.equal(cfg.endpoint, "http://127.0.0.1:8080");
});

test("health live vs ready components", async () => {
  const liveOnly = startHealthServer("127.0.0.1:0", async () => ({
    status: "not_ready",
    process: "payment-runner",
    components: {
      process: true,
      gateway: false,
      claim_credential: false,
      browser_executor: false,
      active_job: false,
      callback_report: false,
    },
    last_heartbeat_at: null,
    last_job_poll_at: null,
    last_success_at: null,
    last_failure_at: null,
    current_job: null,
    operator_assisted: true,
  }));
  if (!liveOnly.listening) {
    await new Promise<void>((resolve) => liveOnly.once("listening", resolve));
  }
  const addr = liveOnly.address();
  if (!addr || typeof addr === "string") {
    throw new Error("no addr");
  }
  const live = await fetch(`http://127.0.0.1:${addr.port}/health/live`);
  const ready = await fetch(`http://127.0.0.1:${addr.port}/health/ready`);
  assert.equal(live.status, 200);
  assert.equal(ready.status, 503);
  const body = await ready.json();
  assert.equal(body.components.process, true);
  liveOnly.close();
});

test("success screen observation is not capture", async () => {
  const jobs = [
    {
      job_id: "rjob_1",
      payment_attempt_id: "pay_1",
      executor_token: "one",
      razorpay_order_id: "order_1",
      razorpay_key_id: "rzp_test_x",
      amount_minor: "24900",
      currency: "INR",
      scenario: "success",
    },
  ];
  const observations: string[] = [];
  const gateway = createServer((req, res) => {
    if (req.url === "/internal/v1/test-runner/jobs/claim") {
      const job = jobs.shift();
      if (!job) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(job));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      observations.push(body.observed_screen);
      assert.equal(body.not_capture, true);
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted: true, not_capture: true }));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const addr = gateway.address();
  if (!addr || typeof addr === "string") {
    throw new Error("no addr");
  }
  process.env.ATLAS_RUNNER_ENDPOINT = `http://127.0.0.1:${addr.port}`;
  process.env.ATLAS_RUNNER_EXECUTOR_CREDENTIAL = "tok";
  await runOnce(async () => "success_screen");
  assert.ok(observations.includes("success_screen"));
  assert.ok(observations.includes("checkout_opened"));
  gateway.close();
});
