import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedToolsForSkill, buildSnapshot, selectSkill } from "./skills.js";
import { modelVisibleToolSchema } from "./tool-schemas.js";

test("offer_decision is selected when offers exist even with an empty cart", () => {
  assert.equal(selectSkill({ session_id: "ses_1", offers: [{ offer_id: "off_1" }], lines: [] }, 2), "offer_decision");
});

test("catalog_resolution may apply_offer before the first line", () => {
  assert.equal(allowedToolsForSkill("catalog_resolution", false).includes("apply_offer"), true);
});

test("snapshot does not leak experiment arm or pairing metadata", () => {
  const snap = buildSnapshot({
    runId: "run_1",
    runType: "BENCHMARK_MODEL",
    scenarioId: "breakfast_180",
    turn: 1,
    mission: "buy bananas",
    consent: { currency: "INR", max_amount_minor: 250000 },
    state: { session_id: "ses_1" },
    remaining: {},
    allowedTools: ["create_session", "get_capabilities"],
  });
  assert.equal("arm" in snap, false);
  assert.equal("evaluation_arm" in snap, false);
  assert.equal("pairing_key" in snap, false);
  const schema = snap.allowed_tool_schemas as Record<string, { properties?: Record<string, unknown> }>;
  assert.equal(schema.create_session?.properties?.evaluation_arm, undefined);
  assert.equal(schema.create_session?.properties?.strategy_allowlist, undefined);
});

test("model-visible create_session schema strips Host-injected experiment fields", () => {
  const schema = modelVisibleToolSchema("create_session") as { properties?: Record<string, unknown> };
  assert.equal(schema.properties?.evaluation_arm, undefined);
  assert.equal(schema.properties?.strategy_allowlist, undefined);
});
