import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Lab migration encodes discriminated run variants", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0001_init.sql"), "utf8");
  assert.match(sql, /DETERMINISTIC_SCENARIO/);
  assert.match(sql, /BENCHMARK_MODEL/);
  assert.match(sql, /CUSTOM_MISSION/);
  assert.match(sql, /run_configurations_variant_chk/);
  assert.match(sql, /runs_variant_chk/);
  assert.match(sql, /benchmark_eligible_runs/);
  assert.match(sql, /driver_steps allowed only on DETERMINISTIC_SCENARIO/);
});

test("proof migration persists stage projections", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0002_proof.sql"), "utf8");
  assert.match(sql, /run_proofs/);
  assert.match(sql, /run_stage_results/);
  assert.match(sql, /run_payment_assurance/);
});
