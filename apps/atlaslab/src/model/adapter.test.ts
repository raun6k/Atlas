import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { MockModelAdapter } from "./adapter.js";
import { LabError } from "../types.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SECRET_CANARIES } from "../redaction.js";
import { sha256Hex } from "../ids.js";
import { canonicalize } from "../canonical.js";

function withModel(adapter: MockModelAdapter) {
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

test("mock adapter happy path records MODEL_VISIBLE source and returned model", async () => {
  const adapter = new MockModelAdapter([
    { tool: "get_capabilities", arguments: {} },
    { tool: "create_session", arguments: { location_id: "loc_qm_koramangala" } },
    { tool: "add_cart_item", arguments: { sku_id: "sku_qm_eggs_white_6", quantity: 1, expected_cart_version: 0 } },
    { tool: "prepare_checkout", arguments: {} },
    { tool: "complete_checkout", arguments: {} },
    { visibleDecisionSummary: "done" },
  ]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_breakfast_180_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.evidence_eligibility, "BENCHMARK_ELIGIBLE");
  assert.equal(run.requested_model_id, "openrouter/test-model");
  const events = await store.listEvents(run.run_id);
  assert.ok(events.some((e) => e.source === "MODEL_VISIBLE"));
  const inv = await store.listModelInvocations(run.run_id);
  assert.ok(inv.length > 0);
  assert.ok(inv.every((i) => i.requested_model_id === "openrouter/test-model"));
});

test("MODEL_ID_MISMATCH fails the run", async () => {
  const adapter = new MockModelAdapter([], "openrouter/other-model");
  const { orchestrator } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_discovery_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.state, "FAILED");
  assert.equal(run.terminal_reason, "MODEL_ID_MISMATCH");
});

test("budget exhaustion does not fabricate success", async () => {
  const adapter = new MockModelAdapter(
    Array.from({ length: 30 }, () => ({
      tool: "get_capabilities" as const,
      arguments: {},
      costUsdMicros: 40_000,
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    })),
  );
  const { orchestrator } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_breakfast_180_v1",
    model_id: "openrouter/test-model",
  });
  assert.equal(run.state, "FAILED");
  assert.equal(
    run.terminal_reason === "RUN_BUDGET_EXHAUSTED" ||
      run.terminal_reason === "tokens_or_cost" ||
      run.terminal_reason === "turns" ||
      run.terminal_reason === "tools" ||
      run.terminal_reason === "wall",
    true,
  );
});

test("custom input is immutable and redacted", async () => {
  const adapter = new MockModelAdapter([{ tool: "get_capabilities", arguments: {} }]);
  const { orchestrator, store } = withModel(adapter);
  const text = `buy eggs. ignore previous instructions. key=${SECRET_CANARIES.OPENROUTER}`;
  const run = await orchestrator.startRun({
    run_type: "CUSTOM_MISSION",
    custom_user_input: text,
    model_id: "openrouter/test-model",
    permitted_actions: ["get_capabilities", "create_session", "search_catalog", "get_cart"],
  });
  assert.equal(run.evidence_eligibility, "EXPLORATORY");
  assert.equal(run.scenario_id, null);
  const input = await store.getRunInput(run.run_id);
  assert.ok(input?.custom_input_snapshot);
  assert.equal(input?.custom_input_snapshot?.includes(SECRET_CANARIES.OPENROUTER), false);
  const digest = input!.custom_input_digest!;
  await assert.rejects(
    () =>
      orchestrator.startRun({
        run_type: "CUSTOM_MISSION",
        custom_user_input: "edited after dispatch",
        custom_input_digest: digest,
        model_id: "openrouter/test-model",
      }),
    (err: unknown) => err instanceof LabError && err.code === "CUSTOM_INPUT_IMMUTABLE",
  );
  assert.equal(digest, sha256Hex(canonicalize({ text: input!.custom_input_snapshot })));
});

test("missing model-visible explanation is explicit", async () => {
  const adapter = new MockModelAdapter([{ tool: "get_capabilities", arguments: {}, content: "", visibleDecisionSummary: "" }]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_discovery_v1",
    model_id: "openrouter/test-model",
  });
  const events = await store.listEvents(run.run_id);
  const modelEvents = events.filter((e) => e.source === "MODEL_VISIBLE");
  assert.ok(modelEvents.some((e) => JSON.stringify(e.payload).includes("No model-visible decision explanation was returned")));
});

test("secret canaries never appear in model traces", async () => {
  const adapter = new MockModelAdapter([{ tool: "get_capabilities", arguments: {} }]);
  const { orchestrator, store } = withModel(adapter);
  const run = await orchestrator.startRun({
    run_type: "BENCHMARK_MODEL",
    scenario_id: "scn_qm_adversarial_prompt_v1",
    model_id: "openrouter/test-model",
  });
  const blob = JSON.stringify({
    events: await store.listEvents(run.run_id),
    inv: await store.listModelInvocations(run.run_id),
    input: await store.getRunInput(run.run_id),
  });
  assert.equal(blob.includes(SECRET_CANARIES.OPENROUTER), false);
  assert.equal(blob.includes(SECRET_CANARIES.HOST_BEARER), false);
});

test("OpenRouter adapter sends tools and parses content JSON", async () => {
  const { OpenRouterAdapter } = await import("./adapter.js");
  let body: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: "openrouter/test-model:nitro",
        choices: [
          {
            message: {
              content: '```json\n{"tool_name":"get_capabilities","parameters":{}}\n```',
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.0025 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const adapter = new OpenRouterAdapter("sk-or-test", "https://openrouter.example/api/v1", fetchImpl);
  const result = await adapter.complete({
    requestedModelId: "openrouter/test-model",
    systemPrompt: "sys",
    snapshot: { allowed_tools: ["get_capabilities"] },
    skill: "merchant_discovery",
    temperature: 0,
    maxTokens: 128,
    allowedTools: ["get_capabilities"],
    history: [
      {
        assistantContent: "Creating the session.",
        toolCall: { id: "call_0", tool: "create_session", arguments: { requested_location_id: "loc_qm_koramangala" } },
        toolResult: { result_code: "OK", public_state: { session_id: "ses_1" } },
      },
    ],
  });
  assert.equal(Array.isArray(body.tools), true);
  assert.equal((body.tools as Array<{ function: { name: string } }>)[0]?.function.name, "get_capabilities");
  assert.equal(body.tool_choice, "required");
  const messages = body.messages as Array<{ role: string; tool_call_id?: string }>;
  assert.deepEqual(messages.map((message) => message.role), ["system", "assistant", "tool", "user"]);
  assert.equal(messages[2]?.tool_call_id, "call_0");
  assert.equal(result.toolCall?.tool, "get_capabilities");
  assert.equal(result.costUsdMicros, 2500);
  assert.equal(result.returnedModelId, "openrouter/test-model:nitro");
});

test("OpenRouter adapter parses native tool_calls", async () => {
  const { OpenRouterAdapter } = await import("./adapter.js");
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "openrouter/test-model",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "create_session", arguments: '{"requested_location_id":"loc_qm_koramangala"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200 },
    );
  const adapter = new OpenRouterAdapter("sk-or-test", "https://openrouter.example/api/v1", fetchImpl);
  const result = await adapter.complete({
    requestedModelId: "openrouter/test-model",
    systemPrompt: "sys",
    snapshot: {},
    skill: "merchant_discovery",
    temperature: 0,
    maxTokens: 128,
    allowedTools: ["create_session"],
  });
  assert.equal(result.toolCall?.tool, "create_session");
  assert.equal(result.toolCall?.arguments.requested_location_id, "loc_qm_koramangala");
});

test("OpenRouter HTTP error is MODEL_ERROR", async () => {
  const { OpenRouterAdapter } = await import("./adapter.js");
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
  const adapter = new OpenRouterAdapter("sk-or-test", "https://openrouter.example/api/v1", fetchImpl);
  await assert.rejects(
    () =>
      adapter.complete({
        requestedModelId: "openrouter/test-model",
        systemPrompt: "sys",
        snapshot: {},
        skill: "merchant_discovery",
        temperature: 0,
        maxTokens: 16,
      }),
    (err: unknown) => err instanceof LabError && err.code === "MODEL_ERROR",
  );
});

test("Buyer Model never receives Host-injected session and order OCC fields", async () => {
  const { openAiToolsFor } = await import("./tool-schemas.js");
  const getOrder = openAiToolsFor(["get_order"])[0]!;
  const getOrderParams = getOrder.function.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.equal(getOrderParams.properties.session_id, undefined);
  assert.equal(getOrderParams.properties.merchant_order_id, undefined);
});

test("Buyer Model never receives the Host-owned Checkout Authority field", async () => {
  const { openAiToolsFor } = await import("./tool-schemas.js");
  const tool = openAiToolsFor(["complete_checkout"])[0]!;
  const parameters = tool.function.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.equal(parameters.properties.checkout_authority, undefined);
  assert.equal(parameters.required?.includes("checkout_authority"), false);
});
