import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { evaluateProcessReadiness, paymentRailReady } from "./readiness.js";
import type { LabStore } from "./db/store.js";

test("process readiness checks only database, migration, and release auth", async () => {
  const cfg = loadConfig({
    mode: "release",
    apiReadToken: "read",
    apiWriteToken: "write",
    mockMcp: false,
    mockFixtureReset: false,
  });
  const store = {
    ping: async () => true,
    migrationVersion: async () => "0006_release_repair.sql",
  } as unknown as LabStore;

  const readiness = await evaluateProcessReadiness(cfg, store);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.diagnostics, {
    database: true,
    migrations: "0006_release_repair.sql",
    release_auth: true,
    mode: "release",
  });
});

test("payment rail delegates readiness without AtlasLab Razorpay secrets", async () => {
  const cfg = loadConfig({
    mode: "development",
    mcpUrl: "http://gateway.test:8080/mcp",
    paymentRunnerUrl: "http://runner.test:8091",
    coreWorkerHealthUrl: "http://worker.test:9092",
    razorpayKeyId: "",
    razorpayKeySecret: "",
    razorpayWebhookSecret: "",
    mockMcp: false,
    mockFixtureReset: false,
  });
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response("{}", { status: 200 });
  };
  try {
    const readiness = await paymentRailReady(cfg);
    assert.equal(readiness.ready, true);
    assert.deepEqual(requested.sort(), [
      "http://gateway.test:8080/health/ready",
      "http://runner.test:8091/health/ready",
      "http://worker.test:9092/health/ready",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
