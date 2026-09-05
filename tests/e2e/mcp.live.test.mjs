#!/usr/bin/env node
/**
 * Live MCP through Gateway: public family is 13 tools; Host bearer required; no get_session.
 */
const base = process.env.ATLAS_GATEWAY_HTTP_ADDR
  ? `http://${process.env.ATLAS_GATEWAY_HTTP_ADDR.replace(/^http:\/\//, "")}`
  : "http://127.0.0.1:8080";
const bearer = process.env.ATLASLAB_HOST_BEARER || process.env.ATLAS_TEST_HOST_BEARER || "atlaslab-test-bearer";

async function mcp(method, params, token) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  return { status: res.status, body: await res.json() };
}

try {
  const live = await fetch(`${base}/health/live`);
  if (!live.ok) {
    console.log("mcp live test skipped (gateway not up)");
    process.exit(process.env.JOIN_E2E_REQUIRED === "1" ? 1 : 0);
  }
} catch {
  console.log("mcp live test skipped (gateway not up)");
  process.exit(process.env.JOIN_E2E_REQUIRED === "1" ? 1 : 0);
}

const listed = await mcp("tools/list");
const tools = listed.body.result?.tools?.map((t) => t.name) ?? [];
if (tools.length !== 13) {
  console.error("expected 13 public tools, got", tools);
  process.exit(1);
}
for (const forbidden of ["get_session", "get_profile", "get_substitution", "respond_to_substitution", "accept_offer"]) {
  if (tools.includes(forbidden)) {
    console.error(forbidden, "must not be public MCP");
    process.exit(1);
  }
}
const denied = await mcp("tools/call", { name: "create_session", arguments: {} });
if (denied.status !== 401) {
  console.error("create_session without bearer must be 401, got", denied.status);
  process.exit(1);
}
const caps = await mcp("tools/call", { name: "get_capabilities", arguments: {} }, bearer);
const code = caps.body.result?.structuredContent?.result_code;
if (caps.status !== 200 || (code && code !== "OK")) {
  console.error("get_capabilities failed", caps.status, caps.body);
  process.exit(1);
}
console.log("live MCP ok: 13 tools, Host bearer enforced, get_capabilities OK");
