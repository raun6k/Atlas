import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { Orchestrator } from "./orchestrator.js";
import { builtinScenarios } from "../scenarios/catalog.js";

test("every deterministic-supporting scenario executes against the mock Gateway", async () => {
  const cfg = loadConfig({ mockMcp: true, mockFixtureReset: true, openRouterApiKey: "" });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const host = new HostBoundary(generateEphemeralHostSigner(), gateway, store, "bearer");
  const fixtures = new MockFixtureResetClient("cred", () => gateway.resetFixture());
  const orch = new Orchestrator(cfg, store, host, fixtures, null, gateway);
  const scenarios = builtinScenarios().filter((s) => s.supported_run_types.includes("DETERMINISTIC_SCENARIO"));
  assert.ok(scenarios.length >= 8);
  for (const scn of scenarios) {
    const run = await orch.startRun({ run_type: "DETERMINISTIC_SCENARIO", scenario_id: scn.scenario_id });
    assert.ok(["COMPLETED", "FAILED"].includes(run.state), scn.scenario_id);
    assert.equal(run.evidence_eligibility, "CONTRACT_EVIDENCE_ONLY");
    assert.ok(run.fixture_digest);
  }
});
