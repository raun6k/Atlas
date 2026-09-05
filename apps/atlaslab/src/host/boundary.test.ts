import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "./boundary.js";
import { generateEphemeralHostSigner } from "./signer.js";
import type { McpCallRequest, McpCallResult, McpClient } from "../mcp/client.js";
import { PUBLIC_MCP_TOOLS, type ConsentPolicy, type RunRecord } from "../types.js";

class CaptureMcp implements McpClient {
  last?: McpCallRequest;
  async call(req: McpCallRequest): Promise<McpCallResult> {
    this.last = req;
    return {
      ok: true,
      resultCode: "OK",
      retryable: false,
      payload: { session_summary: { session_id: "ses_1" } },
      publicStatePatch: { session_id: "ses_1" },
      requestId: req.requestId,
    };
  }
}

const consent: ConsentPolicy = { max_amount_minor: 250000, currency: "INR", capability_id: "pcap_razorpay_test" };

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "run_1",
    run_type: "BENCHMARK_MODEL",
    configuration_id: "cfg",
    configuration_digest: "d",
    evidence_eligibility: "BENCHMARK_ELIGIBLE",
    state: "RUNNING",
    fixture_snapshot_id: "fix_quickmart_v1",
    fixture_digest: "digest",
    arm: null,
    pair_id: null,
    scenario_id: "breakfast_180",
    scenario_version: "1",
    action_program_id: null,
    action_program_digest: null,
    custom_input_digest: null,
    requested_model_id: "or/test",
    returned_model_id: null,
    terminal_reason: null,
    start_at: null,
    end_at: null,
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

test("Host stamps arm, strategy allowlist, and fixture buyer; model-supplied arm is overwritten", async () => {
  const mcp = new CaptureMcp();
  const host = new HostBoundary(generateEphemeralHostSigner(), mcp, new MemoryStore(), "bearer");
  await host.invoke({
    run: run({ arm: "CONTROL" }),
    tool: "create_session",
    arguments: {
      evaluation_arm: "TREATMENT",
      strategy_allowlist: ["FBT"],
      subject_reference: "lab:injected",
      delivery_serviceability_reference: "blr_koramangala_5th_block",
      requested_location_id: "loc_qm_koramangala",
    },
    proposedBy: "MODEL_VISIBLE",
    permittedActions: [...PUBLIC_MCP_TOOLS],
    consent,
    publicState: {},
    extraSecrets: [],
    sessionPolicy: { subjectReference: "buyer_qm_01", strategyAllowlist: ["ROUTINE"] },
  });
  assert.equal(mcp.last?.arguments.evaluation_arm, "CONTROL");
  assert.deepEqual(mcp.last?.arguments.strategy_allowlist, ["ROUTINE"]);
  assert.equal(mcp.last?.arguments.subject_reference, "buyer_qm_01");
});

test("Host always sends constraints on set_intent and Host keys win", async () => {
  const mcp = new CaptureMcp();
  const host = new HostBoundary(generateEphemeralHostSigner(), mcp, new MemoryStore(), "bearer");
  await host.invoke({
    run: run(),
    tool: "set_intent",
    arguments: {
      session_id: "ses_1",
      expected_session_context_version: 0,
      mission: "bananas",
      planning_budget_minor: 18000,
      constraints: { dietary: "model" },
    },
    proposedBy: "MODEL_VISIBLE",
    permittedActions: [...PUBLIC_MCP_TOOLS],
    consent,
    publicState: { session_id: "ses_1", session_context_version: 0 },
    extraSecrets: [],
    sessionPolicy: { constraints: { dietary: "veg" } },
  });
  assert.deepEqual(mcp.last?.arguments.constraints, { dietary: "veg" });
});

test("each tool exchange records this run's child session only", async () => {
  const mcp = new CaptureMcp();
  const store = new MemoryStore();
  const host = new HostBoundary(generateEphemeralHostSigner(), mcp, store, "bearer");
  await host.invoke({
    run: run(),
    tool: "get_cart",
    arguments: { session_id: "ses_1" },
    proposedBy: "DETERMINISTIC_DRIVER",
    permittedActions: [...PUBLIC_MCP_TOOLS],
    consent,
    publicState: { session_id: "ses_1" },
    extraSecrets: [],
  });
  assert.equal(mcp.last?.correlation?.run_id, "run_1");
  const xs = await store.listToolExchanges("run_1");
  assert.equal(xs.length, 1);
  assert.equal(xs[0]?.atlas_ids?.run_id, "run_1");
  assert.equal(xs[0]?.atlas_ids?.child_session_id, "ses_1");
  assert.equal(xs[0]?.atlas_ids?.session_id, "ses_1");
});
