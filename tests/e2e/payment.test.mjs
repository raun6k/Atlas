#!/usr/bin/env node
/**
 * Payment contract lane: capture is decided by provider fetch + binding.
 * This lane does not claim to execute a provider payment.
 */
const key = process.env.RAZORPAY_KEY_ID || "";
const gateway = process.env.ATLAS_MCP_URL?.replace(/\/mcp$/, "") || "http://127.0.0.1:8080";
const bearer = process.env.ATLASLAB_HOST_BEARER || process.env.ATLAS_TEST_HOST_BEARER || "atlaslab-test-bearer";

const live = await fetch(`${gateway}/health/ready`).catch(() => null);
if (!live?.ok) {
  console.error("payment contract: gateway is not ready");
  process.exit(1);
}

const caps = await fetch(`${gateway}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "get_capabilities", arguments: {} } }),
});
if (!caps.ok) {
  console.error("get_capabilities http", caps.status);
  process.exit(1);
}
const body = await caps.json();
const payment = body.result?.structuredContent?.capabilities?.payment
  ?? body.result?.structuredContent?.payment
  ?? {};
const terminal = payment.terminal_success_state || payment.terminalSuccessState;
if (terminal && terminal !== "CAPTURED_RECONCILED") {
  console.error("terminal success must be CAPTURED_RECONCILED (Test Mode capture, not settlement), got", terminal);
  process.exit(1);
}
if (String(JSON.stringify(body)).toLowerCase().includes("merchant settlement")) {
  console.error("capabilities must not claim merchant settlement");
  process.exit(1);
}

if (key && !key.startsWith("rzp_test_")) {
  console.error("RAZORPAY_KEY_ID must be Test Mode");
  process.exit(1);
}

console.log("payment contract: Gateway ready and CAPTURED_RECONCILED semantics are exposed. This is not provider-backed payment proof; use make payment-test-provider.");
process.exit(0);
