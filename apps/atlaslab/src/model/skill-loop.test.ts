import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { MockModelAdapter, type ModelAdapter, type ModelTurnRequest, type ModelTurnResponse } from "./adapter.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SECRET_CANARIES } from "../redaction.js";

class RecordingAdapter implements ModelAdapter {
  snapshots: Record<string, unknown>[] = [];
  histories: ModelTurnRequest["history"][] = [];
  constructor(private readonly inner: ModelAdapter) {}
  async complete(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    this.snapshots.push(req.snapshot);
    this.histories.push(req.history);
    return this.inner.complete(req);
  }
}

function withModel(adapter: ModelAdapter) {
  const cfg = loadConfig({
    openRouterApiKey: SECRET_CANARIES.OPENROUTER,
    hostBearer: SECRET_CANARIES.HOST_BEARER,
    fixtureControlCredential: SECRET_CANARIES.FIXTURE_CONTROL,
    mockMcp: true,
    mockFixtureReset: true,
    maxTurns: 8,
    maxToolCalls: 12,
    maxTokens: 1000,
    maxCostUsdMicros: 50_000,
  });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const host = new HostBoundary(generateEphemeralHostSigner(), gateway, store, cfg.hostBearer);
  const fixtures = new MockFixtureResetClient(cfg.fixtureControlCredential, () => gateway.resetFixture());
  const orchestrator = new Orchestrator(cfg, store, host, fixtures, adapter, gateway);
  return { orchestrator, store };
}

test("content-only JSON still invokes Host", async () => {
  const adapter = new MockModelAdapter([
    {
      content: '```json\n{"tool_name":"get_capabilities","parameters":{}}\n```',
    },
  ]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_discovery_v1",
    model_id: "openrouter/test-model",
  });
  const events = await store.listEvents(run.run_id);
  assert.ok(events.some((e) => e.kind === "TOOL_PROPOSED"));
  assert.ok(events.some((e) => e.kind === "TOOL_RESULT"));
  const exchanges = await store.listToolExchanges(run.run_id);
  assert.equal(exchanges.some((e) => e.tool_name === "get_capabilities"), true);
  assert.notEqual(run.terminal_reason, "turns");
});

test("snapshot carries last_action after a tool result", async () => {
  const inner = new MockModelAdapter([
    { tool: "get_capabilities", arguments: {} },
    { tool: "create_session", arguments: { requested_location_id: "loc_qm_koramangala" } },
  ]);
  const adapter = new RecordingAdapter(inner);
  const { orchestrator } = withModel(adapter);
  await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_breakfast_180_v1",
    model_id: "openrouter/test-model",
  });
  assert.ok(adapter.snapshots.length >= 2);
  const second = adapter.snapshots[1] as {
    last_action?: { tool?: string };
    payment_capabilities?: Array<Record<string, unknown>>;
  };
  assert.equal(second.last_action?.tool, "get_capabilities");
  assert.equal(second.payment_capabilities?.[0]?.capability_id, undefined);
  assert.equal(second.payment_capabilities?.[0]?.completion_mode, "asynchronous");
  const capResult = adapter.histories[1]?.[0]?.toolResult ?? {};
  assert.equal(capResult.merchant_display_name, "QuickMart");
  assert.equal(capResult.capabilities, undefined);
  assert.equal((capResult.payment as { capability_id?: string } | undefined)?.capability_id, undefined);
  assert.equal(Array.isArray(capResult.tools) && (capResult.tools as string[]).includes("get_capabilities"), false);
});

test("identical tool calls stall with NO_PROGRESS", async () => {
  const adapter = new MockModelAdapter(
    Array.from({ length: 8 }, () => ({ tool: "get_capabilities" as const, arguments: {} })),
  );
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_breakfast_180_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.terminal_reason, "NO_PROGRESS");
  const events = await store.listEvents(run.run_id);
  assert.ok(events.some((e) => e.kind === "NO_PROGRESS"));
  const inv = await store.listModelInvocations(run.run_id);
  assert.ok(inv.length < 8);
});

test("missing tool call emits NO_STRUCTURED_ACTION", async () => {
  const adapter = new MockModelAdapter([{ visibleDecisionSummary: "thinking" }, { visibleDecisionSummary: "still thinking" }]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_breakfast_180_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.terminal_reason, "NO_STRUCTURED_ACTION");
  const events = await store.listEvents(run.run_id);
  assert.ok(events.some((e) => e.kind === "NO_STRUCTURED_ACTION"));
});

test("discovery get_capabilities does not burn the turn ceiling", async () => {
  const adapter = new MockModelAdapter([{ tool: "get_capabilities", arguments: {} }]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_discovery_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.state, "COMPLETED");
  const inv = await store.listModelInvocations(run.run_id);
  assert.equal(inv.length, 1);
  const grades = await store.listGrades(run.run_id);
  const task = grades.find((g) => g.dimension === "task_completion");
  assert.equal(task?.result, "PASS");
});
