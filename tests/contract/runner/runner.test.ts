import assert from "node:assert/strict";
import test from "node:test";
import { AddressInfo } from "node:net";
import { createRunnerServer, type RunnerJob } from "../../../apps/gateway/src/internal/test-runner/http.ts";

const cred = "executor-credential";

test("claim and observe do not treat browser success as capture", async () => {
  let issued: RunnerJob | null = {
    job_id: "rjob_1",
    payment_attempt_id: "pay_1",
    executor_token: "one-action",
    razorpay_order_id: "order_1",
    razorpay_key_id: "rzp_test_x",
    amount_minor: "24900",
    currency: "INR",
    scenario: "success",
  };
  const screens: string[] = [];
  const server = createRunnerServer(cred, {
    async claimJob() {
      const job = issued;
      issued = null;
      return job;
    },
    async recordObservation(_jobId, observation) {
      screens.push(observation.observed_screen);
      assert.equal(observation.not_capture, true);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const live = await fetch(`http://127.0.0.1:${port}/health/live`);
  assert.equal(live.status, 200);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/internal/v1/test-runner/jobs/claim`, { method: "POST" });
  assert.equal(unauthorized.status, 401);

  const claimed = await fetch(`http://127.0.0.1:${port}/internal/v1/test-runner/jobs/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${cred}` },
  });
  assert.equal(claimed.status, 200);
  const job = (await claimed.json()) as RunnerJob;
  assert.equal(job.razorpay_key_id.startsWith("rzp_test_"), true);

  const obs = await fetch(`http://127.0.0.1:${port}/internal/v1/test-runner/jobs/${job.job_id}/observations`, {
    method: "POST",
    headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
    body: JSON.stringify({ executor_token: job.executor_token, observed_screen: "success_screen" }),
  });
  assert.equal(obs.status, 202);
  const body = await obs.json();
  assert.equal(body.not_capture, true);
  assert.deepEqual(screens, ["success_screen"]);

  const empty = await fetch(`http://127.0.0.1:${port}/internal/v1/test-runner/jobs/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${cred}` },
  });
  assert.equal(empty.status, 204);
  server.close();
});
