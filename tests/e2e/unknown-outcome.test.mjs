#!/usr/bin/env node
/**
 * Lost-response / OUTCOME_UNKNOWN recovery across the real boundary.
 * OUTCOME_UNKNOWN freezes retry and fulfillment until fetch reconciles.
 */
const gateway = "http://127.0.0.1:8080";
const lab = process.env.ATLASLAB_API_URL || "http://127.0.0.1:8090";
const labToken = process.env.ATLASLAB_API_TOKEN || process.env.ATLASLAB_SERVICE_TOKEN || "";
try {
  const live = await fetch(`${gateway}/health/live`);
  if (!live.ok) {
    console.error("unknown-outcome e2e: gateway not reachable; required live path was not executed");
    process.exit(1);
  }
} catch {
  console.error("unknown-outcome e2e: gateway not reachable; required live path was not executed");
  process.exit(1);
}

const caps = await fetch(`${gateway}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer atlaslab-test-bearer" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "get_capabilities", arguments: {} } }),
}).catch(() => null);
if (caps && caps.ok) {
  const body = await caps.json();
  const blob = JSON.stringify(body).toLowerCase();
  if (blob.includes("merchant settlement")) {
    console.error("unknown-outcome e2e: capabilities must not claim merchant settlement");
    process.exit(1);
  }
}
if (!labToken) {
  console.error("unknown-outcome e2e: ATLASLAB_API_TOKEN or ATLASLAB_SERVICE_TOKEN is required");
  process.exit(1);
}
const suiteRes = await fetch(`${lab}/lab/v1/deterministic-eval`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${labToken}`,
    "content-type": "application/json",
    accept: "application/json",
  },
});
const suite = await suiteRes.json().catch(() => ({}));
if (!suiteRes.ok) {
  console.error("unknown-outcome e2e: deterministic recovery suite failed", suiteRes.status);
  process.exit(1);
}
const recovered = suite.report?.cases?.find((row) => row.case_id === "payment_ambiguous_then_success");
const frozen = suite.report?.cases?.find((row) => row.case_id === "payment_ambiguous_then_failure");
if (recovered?.result !== "PASS" || frozen?.result !== "PASS") {
  console.error("unknown-outcome e2e: controlled freeze/reconcile cases did not pass", { recovered, frozen });
  process.exit(1);
}
console.log("OUTCOME_UNKNOWN recovery verified across live MCP/Core: retries freeze until controlled provider evidence resolves. This lane is fabric evidence, not provider-backed payment proof.");
process.exit(0);
