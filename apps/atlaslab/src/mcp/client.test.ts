import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertPublicMcpTarget, assertPublicTool, HttpMcpClient } from "./client.js";
import { LabError, PUBLIC_MCP_TOOLS } from "../types.js";

test("MCP client refuses internal gRPC, postgres, admin, and worker targets", () => {
  for (const url of [
    "grpc://127.0.0.1:9090",
    "postgres://atlas:@localhost:5432/atlas",
    "http://127.0.0.1:8080/admin/v1/merchant/profile",
    "http://127.0.0.1:8080/internal/v1/test-runner/jobs/claim",
  ]) {
    assert.throws(() => assertPublicMcpTarget(url), (err: unknown) => err instanceof LabError && err.code === "FORBIDDEN_INTERNAL_ACCESS");
  }
});

test("public MCP excludes get_session, get_profile, get_substitution, respond_to_substitution, accept_offer", () => {
  for (const tool of ["get_session", "get_profile", "get_substitution", "respond_to_substitution", "accept_offer"]) {
    assert.throws(() => assertPublicTool(tool), (err: unknown) => err instanceof LabError && err.code === "FORBIDDEN_INTERNAL_ACCESS");
  }
});

test("public MCP allows the frozen 13-tool family", () => {
  assert.doesNotThrow(() => assertPublicTool("get_capabilities"));
  assert.doesNotThrow(() => assertPublicTool("complete_checkout"));
  assert.doesNotThrow(() => assertPublicTool("apply_offer"));
});

test("Lab public tools match generated schemas/mcp/tools.json", () => {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../schemas/mcp/tools.json");
  const tools = JSON.parse(readFileSync(schemaPath, "utf8")).tools as string[];
  assert.deepEqual([...PUBLIC_MCP_TOOLS], tools);
});

test("JSON-RPC errors are never reported to the Buyer as OK", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "req_1", error: { code: -32000, message: "host request proof digest mismatch" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new HttpMcpClient("http://gateway.example/mcp", [], fetchImpl);
  const result = await client.call({
    tool: "create_session",
    arguments: { subject_reference: "buyer", delivery_serviceability_reference: "koramangala" },
    requestId: "req_1",
    idempotencyKey: "idem_1",
    hostRequestProof: "proof",
    hostBearer: "bearer",
  });
  assert.equal(result.ok, false);
  assert.equal(result.resultCode, "MCP_ERROR");
  assert.match(String((result.payload.error as { message: string }).message), /digest mismatch/);
});
