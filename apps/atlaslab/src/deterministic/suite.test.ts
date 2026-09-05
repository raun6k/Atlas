import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { MemoryStore } from "../db/memory-store.js";
import { HostBoundary } from "../host/boundary.js";
import { generateEphemeralHostSigner } from "../host/signer.js";
import { MockGateway } from "../mcp/mock-gateway.js";
import { MockFixtureResetClient } from "../fixtures/reset-client.js";
import { SECRET_CANARIES } from "../redaction.js";
import { LabError } from "../types.js";
import { runDeterministicSuite } from "./suite.js";
import { suiteCases } from "./cases.js";

test("suite cases cover five dimensions without baked totals", () => {
  const cases = suiteCases();
  const dims = new Set(cases.map((c) => c.dimension));
  assert.deepEqual([...dims].sort(), ["COMMERCE", "INTERFACE", "RECOVERABILITY", "STATE_SAFETY", "STRATEGY"]);
  const blob = JSON.stringify(cases);
  assert.equal(blob.includes("11662"), false);
  assert.equal(blob.includes("sku_qm_eggs"), false);
  assert.ok(cases.some((c) => c.case_id === "unsigned_mutation"));
  assert.ok(cases.some((c) => c.case_id === "requote" && c.needsInvalidate));
});

test("deterministic suite refuses mock MCP", async () => {
  const cfg = loadConfig({
    mockMcp: true,
    mockFixtureReset: true,
    hostBearer: SECRET_CANARIES.HOST_BEARER,
    fixtureControlCredential: SECRET_CANARIES.FIXTURE_CONTROL,
  });
  const store = new MemoryStore();
  const gateway = new MockGateway();
  const signer = generateEphemeralHostSigner();
  const host = new HostBoundary(signer, gateway, store, cfg.hostBearer);
  const fixtures = new MockFixtureResetClient(cfg.fixtureControlCredential, () => gateway.resetFixture());
  await assert.rejects(
    () => runDeterministicSuite({ cfg, store, host, fixtures, extraSecrets: [] }),
    (err: unknown) => err instanceof LabError && err.code === "ATLAS_REQUIRED" && err.status === 409,
  );
});
