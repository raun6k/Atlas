import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AddressInfo } from "node:net";
import { createWebhookServer } from "../../../apps/gateway/src/webhooks/razorpay/http.ts";
import { verifyRazorpayWebhookSignature } from "../../../apps/gateway/src/webhooks/razorpay/verify.ts";

const secret = "whsec_test";

function sign(body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

test("invalid signature is rejected", async () => {
  const seen: string[] = [];
  const server = createWebhookServer(secret, {
    async ingestWebhook() {
      seen.push("ingested");
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({ event: "payment.captured" });
  const res = await fetch(`http://127.0.0.1:${port}/providers/razorpay/webhooks`, {
    method: "POST",
    headers: { "X-Razorpay-Signature": "deadbeef", "X-Razorpay-Event-Id": "evt_1" },
    body,
  });
  assert.equal(res.status, 401);
  assert.deepEqual(seen, []);
  server.close();
});

test("gateway still requires hmac even for unknown event types", async () => {
  const server = createWebhookServer(secret, {
    async ingestWebhook() {
      throw new Error("should not ingest invalid signature");
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({ event: "refund.processed" });
  const res = await fetch(`http://127.0.0.1:${port}/providers/razorpay/webhooks`, {
    method: "POST",
    headers: { "X-Razorpay-Signature": "deadbeef", "X-Razorpay-Event-Id": "evt_bad" },
    body,
  });
  assert.equal(res.status, 401);
  server.close();
});

test("valid signature forwards raw body and duplicate event id is acknowledged", async () => {
  const ids: string[] = [];
  const server = createWebhookServer(secret, {
    async ingestWebhook(input) {
      ids.push(input.eventId);
      if (ids.length > 1) {
        throw new Error("PROVIDER_EVENT_DUPLICATE");
      }
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });
  const headers = { "X-Razorpay-Signature": sign(body), "X-Razorpay-Event-Id": "evt_dup", "content-type": "application/json" };
  const a = await fetch(`http://127.0.0.1:${port}/providers/razorpay/webhooks`, { method: "POST", headers, body });
  const b = await fetch(`http://127.0.0.1:${port}/providers/razorpay/webhooks`, { method: "POST", headers, body });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const payload = await b.json();
  assert.equal(payload.code, "PROVIDER_EVENT_DUPLICATE");
  assert.ok(verifyRazorpayWebhookSignature(Buffer.from(body), sign(body), secret));
  server.close();
});
