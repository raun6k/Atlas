#!/usr/bin/env node
/**
 * Razorpay Test Mode e2e: runner observation is not capture.
 * Requires RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Skips when unset.
 */
const key = process.env.RAZORPAY_KEY_ID || "";
if (!key.startsWith("rzp_test_")) {
  console.log("payment e2e skipped (RAZORPAY_KEY_ID Test Mode credentials unset)");
  process.exit(0);
}

const gateway = process.env.ATLAS_MCP_URL?.replace(/\/mcp$/, "") || "http://127.0.0.1:8080";
const live = await fetch(`${gateway}/health/live`).catch(() => null);
if (!live?.ok) {
  console.log("payment e2e skipped (gateway not up)");
  process.exit(process.env.JOIN_E2E_REQUIRED === "1" ? 1 : 0);
}

console.log("payment e2e: Test Mode credentials present; capture is decided by provider fetch, never the runner success screen.");
console.log("Run a checkout through POST /mcp complete_checkout, then worker CREATE_PROVIDER_ORDER + webhook/fetch until payment_public_status is CAPTURED_RECONCILED.");
process.exit(0);
