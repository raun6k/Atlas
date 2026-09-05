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

test("deterministic suite migration keeps DETERMINISTIC_SCENARIO run_type", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0003_deterministic_suite.sql"), "utf8");
  assert.match(sql, /suite_qm_v1/);
  assert.match(sql, /0003_deterministic_suite/);
});

test("model eval suite migration keeps BENCHMARK_MODEL run_type", () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0004_model_eval_suites.sql"), "utf8");
  assert.match(sql, /suite_agent_compat_v1/);
  assert.match(sql, /suite_commercial_uplift_v1/);
});

test("release-repair migrations persist sittings, leases, and live suite types", () => {
  const enums = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0005_release_enums.sql"), "utf8");
  assert.match(enums, /DETERMINISTIC_SUITE/);
  assert.match(enums, /LIVE_COMPATIBILITY_SUITE/);
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../db/atlaslab/migrations/0006_release_repair.sql"), "utf8");
  assert.match(sql, /eval_sittings/);
  assert.match(sql, /fixture_leases/);
});
