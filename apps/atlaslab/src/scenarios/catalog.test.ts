import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinScenarios } from "./catalog.js";
import { programDigest } from "./loader.js";

test("each action program digest is stable for identical content", () => {
  for (const scn of builtinScenarios()) {
    if (!scn.action_program) continue;
    const again = programDigest({ ...scn.action_program, digest: undefined });
    assert.equal(scn.action_program.digest, again);
  }
});

test("party snacks is benchmark-only incrementality", () => {
  const scn = builtinScenarios().find((s) => s.scenario_id === "scn_qm_party_snacks_v1");
  assert.ok(scn);
  assert.deepEqual(scn?.supported_run_types, ["BENCHMARK_MODEL"]);
  assert.equal(scn?.commercial_eligibility?.pairing_key, "pair_qm_party_snacks");
  assert.equal(scn?.action_program, undefined);
});
