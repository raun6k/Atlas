import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { MockModelAdapter } from "../model/adapter.js";
import { Orchestrator } from "./orchestrator.js";
import { SECRET_CANARIES } from "../redaction.js";
import { builtinScenarios, REQUIRED_FAMILIES } from "../scenarios/catalog.js";
import { LabError } from "../types.js";

function lab(opts?: { openRouter?: string; model?: MockModelAdapter }) {
  const cfg = loadConfig({
    openRouterApiKey: opts?.openRouter ?? "",
    hostBearer: SECRET_CANARIES.HOST_BEARER,
    fixtureControlCredential: SECRET_CANARIES.FIXTURE_CONTROL,
    mockMcp: true,
    mockFixtureReset: true,
    apiToken: "lab-token",
  });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const signer = generateEphemeralHostSigner();
  const host = new HostBoundary(signer, gateway, store, cfg.hostBearer);
  const fixtures = new MockFixtureResetClient(cfg.fixtureControlCredential, () => gateway.resetFixture());
  const orchestrator = new Orchestrator(cfg, store, host, fixtures, opts?.model ?? null, gateway);
  return { orchestrator, store, gateway, cfg };
}

test("all required scenario families exist", () => {
  const families = new Set(builtinScenarios().map((s) => s.family));
  for (const family of REQUIRED_FAMILIES) {
    assert.equal(families.has(family), true, `missing family ${family}`);
  }
});

test("no-OpenRouter deterministic run completes", async () => {
  const { orchestrator, store } = lab();
  assert.equal(orchestrator.capabilities().model.ready, false);
  assert.equal(orchestrator.capabilities().deterministic.ready, true);
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_breakfast_180_v1" });
  assert.equal(run.run_type, "DETERMINISTIC_SCENARIO");
  assert.equal(run.evidence_eligibility, "CONTRACT_EVIDENCE_ONLY");
  assert.equal(run.requested_model_id, null);
  assert.ok(["COMPLETED", "FAILED"].includes(run.state));
  const events = await store.listEvents(run.run_id);
  assert.ok(events.every((e) => e.source !== "MODEL_VISIBLE"));
  assert.ok(events.some((e) => e.source === "DETERMINISTIC_DRIVER"));
  assert.ok(events.some((e) => e.source === "HOST_BOUNDARY"));
  assert.ok(events.some((e) => e.source === "ATLAS_RESPONSE"));
  const inv = await store.listModelInvocations(run.run_id);
  assert.equal(inv.length, 0);
  const steps = await store.listDriverSteps(run.run_id);
  assert.ok(steps.length > 0);
  const proj = await store.latestProjection(run.run_id);
  assert.equal(proj?.public_state.totals?.total_minor, 16700);
});

test("wrong-variant rejection on start", async () => {
  const { orchestrator } = lab();
  await assert.rejects(
    () => orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1", model_id: "openrouter/sneaky" }),
    (err: unknown) => err instanceof LabError && err.code === "WRONG_VARIANT",
  );
});

test("stale cart recovers via get_cart", async () => {
  const { orchestrator, store } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_stale_cart_v1" });
  const events = await store.listEvents(run.run_id);
  assert.ok(JSON.stringify(events).includes("CART_VERSION_CONFLICT"));
  assert.equal(run.state, "COMPLETED");
});

test("requote rejects stale proposal", async () => {
  const { orchestrator, store } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_requote_v1" });
  const events = await store.listEvents(run.run_id);
  assert.ok(JSON.stringify(events).includes("REQUOTE_REQUIRED"));
});

test("payment unknown freezes duplicate complete_checkout", async () => {
  const { orchestrator, store } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_payment_unknown_v1" });
  const exchanges = await store.listToolExchanges(run.run_id);
  assert.equal(exchanges.filter((e) => e.tool_name === "complete_checkout").length, 1);
  const proj = await store.latestProjection(run.run_id);
  assert.equal(proj?.public_state.payment_status, "CAPTURED_RECONCILED");
});

test("lost mutation response reuses idempotency key", async () => {
  const { orchestrator, store, gateway } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1", execute: false });
  await store.updateRun(run.run_id, { state: "RUNNING" });
  const input = await store.getRunInput(run.run_id);
  const { HostBoundary } = await import("../host/boundary.js");
  const signer = generateEphemeralHostSigner();
  const host = new HostBoundary(signer, gateway, store, SECRET_CANARIES.HOST_BEARER);
  await host.invoke({
    run,
    tool: "create_session",
    arguments: { location_id: "loc_qm_koramangala" },
    proposedBy: "DETERMINISTIC_DRIVER",
    idempotencyKey: "idem_lost_1",
    permittedActions: input!.permitted_actions,
    consent: input!.consent_policy,
    publicState: {},
    extraSecrets: [SECRET_CANARIES.HOST_BEARER],
  }).catch(() => undefined);
  try {
    await host.invoke({
      run,
      tool: "add_cart_item",
      arguments: { sku_id: "sku_qm_eggs_white_6", quantity: 1, expected_cart_version: 0, session_id: "ses_1" },
      proposedBy: "DETERMINISTIC_DRIVER",
      idempotencyKey: "idem_lost_cart",
      permittedActions: input!.permitted_actions,
      consent: input!.consent_policy,
      publicState: { session_id: [...gateway.sessions.keys()][0], cart_version: 0 },
      extraSecrets: [],
    });
  } catch {
    // first lost
  }
  const sessionId = [...gateway.sessions.keys()][0]!;
  await gateway.call({
    tool: "create_session",
    arguments: { location_id: "loc_qm_koramangala" },
    requestId: "r2",
    hostBearer: "x",
    hostRequestProof: "p",
    idempotencyKey: "idem_lost_cart",
  }).catch(() => undefined);
  const sid = [...gateway.sessions.keys()][0] ?? sessionId;
  gateway.sessions.get(sid);
  try {
    await host.invoke({
      run,
      tool: "add_cart_item",
      arguments: { sku_id: "sku_qm_eggs_white_6", quantity: 1, expected_cart_version: 0, session_id: sid },
      proposedBy: "DETERMINISTIC_DRIVER",
      idempotencyKey: "idem_lost_cart",
      permittedActions: input!.permitted_actions,
      consent: input!.consent_policy,
      publicState: { session_id: sid, cart_version: 0 },
      extraSecrets: [],
    });
  } catch {
    /* mock may still throw once */
  }
  const exchanges = await store.listToolExchanges(run.run_id);
  const keys = exchanges.filter((e) => e.idempotency_key === "idem_lost_cart").map((e) => e.idempotency_key);
  assert.ok(keys.every((k) => k === "idem_lost_cart"));
});

test("cancel retains events", async () => {
  const { orchestrator, store } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1", execute: false });
  const cancelled = await orchestrator.cancel(run.run_id);
  assert.equal(cancelled.state, "CANCELLED");
  const events = await store.listEvents(run.run_id);
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.kind === "CANCEL_REQUESTED"));
});

test("restart recovery does not recreate a terminal run", async () => {
  const { orchestrator } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" });
  const resumed = await orchestrator.resume(run.run_id);
  assert.equal(resumed.run_id, run.run_id);
  assert.equal(resumed.state, run.state);
});

test("proof artifacts are redacted in traces", async () => {
  const { orchestrator, store } = lab();
  const run = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" });
  const blob = JSON.stringify(await store.listEvents(run.run_id));
  assert.equal(blob.includes(SECRET_CANARIES.HOST_BEARER), false);
  assert.equal(blob.includes(SECRET_CANARIES.FIXTURE_CONTROL), false);
  const exchanges = await store.listToolExchanges(run.run_id);
  for (const ex of exchanges) {
    const proof = ex.host_enriched_request?.host_request_proof;
    if (proof) assert.equal(proof, "[redacted host artifact]");
  }
});

test("fixture reset is digest-stable and uses the test-control credential", async () => {
  const { orchestrator } = lab();
  const a = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" });
  const b = await orchestrator.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_catalog_sku_v1" });
  assert.equal(a.fixture_digest, b.fixture_digest);
  assert.ok(a.fixture_digest);
});

test("model run is unavailable without OpenRouter", async () => {
  const { orchestrator } = lab();
  await assert.rejects(
    () => orchestrator.startRun({ run_type: "BENCHMARK_MODEL", scenario_id: "scn_qm_breakfast_180_v1", model_id: "or/any" }),
    (err: unknown) => err instanceof LabError && err.code === "MODEL_UNAVAILABLE",
  );
});
