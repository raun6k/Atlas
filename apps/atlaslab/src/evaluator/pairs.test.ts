import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { MockModelAdapter } from "../model/adapter.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { cannotEnterDenominator } from "./framework2.js";
import { buildReport } from "../reporter/reporter.js";

test("orchestrator pairing refuses deterministic and custom runs", async () => {
  const cfg = loadConfig({ openRouterApiKey: "k", mockMcp: true, mockFixtureReset: true });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const host = new HostBoundary(generateEphemeralHostSigner(), gateway, store, "bearer");
  const fixtures = new MockFixtureResetClient("cred", () => gateway.resetFixture());
  const orch = new Orchestrator(cfg, store, host, fixtures, new MockModelAdapter([{ tool: "get_capabilities", arguments: {} }]), gateway);
  const det = await orch.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: "scn_qm_discovery_v1" });
  const custom = await orch.startRun({
    run_type: "CUSTOM_MISSION",
    custom_user_input: "explore catalog",
    model_id: "openrouter/test-model",
    permitted_actions: ["get_capabilities"],
  });
  const pair = await orch.startPair({ pairing_key: "pair_qm_party_snacks", control_run_id: det.run_id, treatment_run_id: custom.run_id });
  assert.equal(pair.eligible, false);
  assert.equal(cannotEnterDenominator(det), true);
  assert.equal(cannotEnterDenominator(custom), true);
  const arts = await buildReport(store, { kind: "sellability", runs: [det, custom] });
  const json = JSON.parse(arts[0]!.body!);
  assert.equal(json.denominator, 0);
  assert.equal(json.excluded.length, 2);
});

test("pair-first sequential arms exclude missing revenue", async () => {
  const cfg = loadConfig({ openRouterApiKey: "k", mockMcp: true, mockFixtureReset: true });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const host = new HostBoundary(generateEphemeralHostSigner(), gateway, store, "bearer");
  const fixtures = new MockFixtureResetClient("cred", () => gateway.resetFixture());
  const orch = new Orchestrator(cfg, store, host, fixtures, new MockModelAdapter([{ tool: "get_capabilities", arguments: {} }]), gateway);
  const pair = await orch.startPair({
    pairing_key: "pair_qm_party_snacks",
    scenario_id: "scn_qm_discovery_v1",
    model_id: "openrouter/test-model",
    first_arm: "CONTROL",
  });
  assert.equal(pair.first_arm, "CONTROL");
  assert.ok(pair.control_run_id);
  assert.ok(pair.treatment_run_id);
  assert.equal(pair.eligible, false);
  assert.equal(pair.exclusion_reason, "MISSING_REVENUE");
  assert.equal(pair.deltas, null);
});
