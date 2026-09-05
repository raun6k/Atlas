#!/usr/bin/env node
/**
 * Operator-assisted Razorpay Test Mode commercial proof.
 *
 * AtlasLab pauses between the CONTROL and TREATMENT arms while this process
 * serves a local Checkout.js page. Provider webhook/fetch evidence, never the
 * browser callback, releases each arm.
 */
import { createServer, request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lab = process.env.ATLASLAB_API_URL || "http://127.0.0.1:8090";
const token = process.env.ATLASLAB_API_TOKEN || process.env.ATLASLAB_SERVICE_TOKEN || "";
const modelId = process.env.MODEL_ID || process.env.ATLASLAB_MODEL_ID || "";
const keyId = process.env.RAZORPAY_KEY_ID || "";
const port = Number(process.env.ATLAS_PROOF_CHECKOUT_PORT || 3210);
const timeoutMs = Number(process.env.ATLAS_PROVIDER_PROOF_TIMEOUT_MS || 20 * 60_000);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`provider-commercial-proof FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

if (!token) fail("ATLASLAB_API_TOKEN or ATLASLAB_SERVICE_TOKEN is required");
if (!modelId) fail("MODEL_ID is required");
if (!keyId.startsWith("rzp_test_")) fail("RAZORPAY_KEY_ID must be a Test Mode key");

const headers = {
  accept: "application/json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
let currentPayment = null;

function postJsonLong(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(target, {
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try {
          parsed = JSON.parse(text || "{}");
        } catch {
          reject(new Error(`AtlasLab returned non-JSON (HTTP ${res.statusCode})`));
          return;
        }
        resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 500, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function checkoutHtml() {
  if (!currentPayment) {
    return "<!doctype html><title>Atlas payment proof</title><h1>Waiting for the next Atlas payment arm…</h1><p>This page is an operator boundary, not payment evidence.</p><script>setTimeout(()=>location.reload(),2000)</script>";
  }
  const options = JSON.stringify({
    key: keyId,
    order_id: currentPayment.provider_order_id,
    amount: currentPayment.amount_minor,
    currency: currentPayment.currency || "INR",
    name: "QuickMart via Atlas",
    description: `${currentPayment.arm} · ${currentPayment.mission_id}`,
    handler: "(handled below)",
    theme: { color: "#2563eb" },
  }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Atlas Razorpay Test Mode</title>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script></head>
<body style="font-family:system-ui;max-width:720px;margin:4rem auto;padding:0 1rem">
<p>Razorpay Test Mode · operator-assisted boundary</p>
<h1>${currentPayment.arm} payment</h1>
<p>Provider order <code>${currentPayment.provider_order_id}</code></p>
<p>Amount ₹${(Number(currentPayment.amount_minor || 0) / 100).toFixed(2)}</p>
<button id="pay" style="font-size:1.1rem;padding:.8rem 1.2rem">Open Razorpay Test Checkout</button>
<pre id="status">Browser success is not payment truth. Atlas waits for signed webhook/provider fetch evidence.</pre>
<script>
const opts=${options};
opts.handler=function(response){
  document.getElementById("status").textContent =
    "Checkout returned " + response.razorpay_payment_id +
    ". Waiting for Atlas provider reconciliation; do not close the proof process.";
};
document.getElementById("pay").onclick=function(){
  const checkout=new Razorpay(opts);
  checkout.on("payment.failed",function(response){
    document.getElementById("status").textContent="Checkout failed: "+response.error.code;
  });
  checkout.open();
};
</script></body></html>`;
}

const checkoutServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"live"}');
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(checkoutHtml());
});
await new Promise((resolve, reject) => {
  checkoutServer.once("error", reject);
  checkoutServer.listen(port, "127.0.0.1", resolve);
});
console.log(`Operator checkout page: http://127.0.0.1:${port}`);

const startedAt = Date.now();
let completedResponse = null;
let completedError = null;
const evaluation = postJsonLong(
  `${lab}/lab/v1/commercial-uplift-eval`,
  JSON.stringify({ model_id: modelId, first_arm: "CONTROL", sitting: true }),
)
  .then((res) => {
    if (!res.ok) throw new Error(`AtlasLab returned ${res.status}: ${JSON.stringify(res.body)}`);
    completedResponse = res.body;
  })
  .catch((err) => {
    completedError = err;
  });

let runId = "";
const seenRequired = new Set();
const confirmedEvents = [];
while (!completedResponse && !completedError && Date.now() - startedAt < timeoutMs) {
  if (!runId) {
    const runsRes = await fetch(`${lab}/lab/v1/runs`, { headers });
    const runsBody = await runsRes.json().catch(() => ({}));
    const runs = Array.isArray(runsBody.items) ? runsBody.items : [];
    const run = [...runs].reverse().find((row) =>
      row.scenario_id === "suite_commercial_uplift_v1" &&
      Date.parse(row.created_at || 0) >= startedAt - 5000);
    runId = run?.run_id || "";
    if (runId) console.log(`Commercial run: ${runId}`);
  }
  if (runId) {
    const eventsRes = await fetch(`${lab}/lab/v1/runs/${encodeURIComponent(runId)}/events`, { headers });
    const eventsBody = await eventsRes.json().catch(() => ({}));
    const events = Array.isArray(eventsBody.items) ? eventsBody.items : [];
    for (const event of events) {
      const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
      if (event.kind === "OPERATOR_PAYMENT_REQUIRED" && !seenRequired.has(event.event_id || event.record_sequence)) {
        seenRequired.add(event.event_id || event.record_sequence);
        currentPayment = payload;
        console.log(`${payload.arm} requires provider payment: ${payload.provider_order_id}`);
        console.log(`Open http://127.0.0.1:${port} and use Razorpay Test Mode payment details.`);
      }
      if (event.kind === "OPERATOR_PAYMENT_CONFIRMED" &&
          !confirmedEvents.some((row) => row.child_run_id === payload.child_run_id)) {
        confirmedEvents.push(payload);
        currentPayment = null;
        console.log(`${payload.arm} confirmed by provider evidence: ${payload.provider_payment_id}`);
      }
      if (event.kind === "OPERATOR_PAYMENT_TIMEOUT") {
        completedError = new Error(`${payload.arm || "commercial arm"} payment timed out`);
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
await evaluation;
if (runId) {
  const eventsRes = await fetch(`${lab}/lab/v1/runs/${encodeURIComponent(runId)}/events`, { headers });
  const eventsBody = await eventsRes.json().catch(() => ({}));
  const events = Array.isArray(eventsBody.items) ? eventsBody.items : [];
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (event.kind === "OPERATOR_PAYMENT_CONFIRMED" &&
        !confirmedEvents.some((row) => row.child_run_id === payload.child_run_id)) {
      confirmedEvents.push(payload);
    }
  }
}
await new Promise((resolve) => checkoutServer.close(resolve));

if (completedError) fail(completedError.message);
if (!completedResponse) fail("commercial proof timed out");
const report = completedResponse.report || {};
if (Number(report.proof?.eligible_pairs || 0) < 1) {
  fail("commercial report has no eligible provider-backed confirmed-order pair");
}
if (confirmedEvents.length < 2 || confirmedEvents.some((event) =>
  !event.provider_payment_id || !event.provider_fetch_ref || !event.authenticated_provider_event_ref || !event.core_order_confirmed)) {
  fail("both arms must contain provider event, provider fetch, payment ID, and confirmed-order evidence");
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const artifact = {
  generated_at: new Date().toISOString(),
  git_revision: revision,
  provider_backed: true,
  razorpay_test_mode: true,
  operator_assisted: true,
  settlement_status: "NOT_IMPLEMENTED",
  real_world_causal_uplift_claimed: false,
  report_id: `uplift_${completedResponse.run?.run_id || runId}`,
  run_id: completedResponse.run?.run_id || runId,
  model_id: report.model_id,
  fixture_digest: report.fixture_digest,
  content_digest: report.provenance?.content_digest,
  proof: report.proof,
  portfolio: report.portfolio,
  provider_evidence: confirmedEvents,
};
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(join(root, "artifacts/provider-commercial-proof.json"), JSON.stringify(artifact, null, 2));
console.log("provider-commercial-proof OK: wrote artifacts/provider-commercial-proof.json");
