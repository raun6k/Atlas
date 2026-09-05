import assert from "node:assert/strict";
import { test } from "node:test";
import { cannotEnterDenominator, pairEligible, pairRuns, relativeUplift } from "./framework2.js";
import type { RunRecord } from "../types.js";

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: partial.run_id ?? "run_x",
    run_type: partial.run_type ?? "BENCHMARK_MODEL",
    configuration_id: "cfg_x",
    configuration_digest: partial.configuration_digest ?? "digest_a",
    evidence_eligibility: partial.evidence_eligibility ?? "BENCHMARK_ELIGIBLE",
    state: "COMPLETED",
    fixture_snapshot_id: "fix_quickmart_v1",
    fixture_digest: partial.fixture_digest ?? "digest_fix",
    arm: partial.arm ?? null,
    pair_id: null,
    scenario_id: partial.scenario_id ?? "scn_qm_party_snacks_v1",
    scenario_version: "1",
    action_program_id: null,
    action_program_digest: null,
    custom_input_digest: null,
    requested_model_id: partial.requested_model_id ?? "or/test",
    returned_model_id: "or/test",
    terminal_reason: null,
    start_at: null,
    end_at: null,
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

test("zero control revenue leaves relative uplift undefined", () => {
  const u = relativeUplift(0, 16700);
  assert.equal(u.relative_percent, null);
  assert.equal(u.absolute_delta, 16700);
});

test("same-fixture eligible benchmark pair is accepted", () => {
  const elig = pairEligible(
    run({ run_id: "run_c", arm: "CONTROL" }),
    run({ run_id: "run_t", arm: "TREATMENT", configuration_digest: "digest_b" }),
  );
  assert.equal(elig.ok, true);
});

test("fixture digest mismatch excludes the pair", () => {
  const elig = pairEligible(run({ fixture_digest: "a" }), run({ fixture_digest: "b" }));
  assert.equal(elig.ok, false);
});

test("deterministic and custom runs cannot enter denominators", () => {
  assert.equal(cannotEnterDenominator(run({ run_type: "DETERMINISTIC_SCENARIO", evidence_eligibility: "CONTRACT_EVIDENCE_ONLY" })), true);
  assert.equal(cannotEnterDenominator(run({ run_type: "CUSTOM_MISSION", evidence_eligibility: "EXPLORATORY" })), true);
  assert.equal(
    cannotEnterDenominator(
      run({
        run_type: "BENCHMARK_MODEL",
        evidence_eligibility: "BENCHMARK_ELIGIBLE",
        scenario_id: "suite_agent_compat_v1",
      }),
    ),
    true,
  );
  assert.equal(
    cannotEnterDenominator(
      run({
        run_type: "BENCHMARK_MODEL",
        evidence_eligibility: "BENCHMARK_ELIGIBLE",
        scenario_id: "suite_commercial_uplift_v1",
      }),
    ),
    true,
  );
  assert.equal(
    pairEligible(
      run({ run_type: "DETERMINISTIC_SCENARIO", evidence_eligibility: "CONTRACT_EVIDENCE_ONLY" }),
      run(),
    ).ok,
    false,
  );
  assert.equal(
    pairEligible(run({ run_type: "CUSTOM_MISSION", evidence_eligibility: "EXPLORATORY", scenario_id: null }), run()).ok,
    false,
  );
});

test("arm-order is recorded on the pair", () => {
  const pair = pairRuns({
    pairingKey: "pair_qm_party_snacks",
    control: run({ run_id: "run_c" }),
    treatment: run({ run_id: "run_t", configuration_digest: "digest_b" }),
    firstArm: "TREATMENT",
    controlRevenueMinor: 10000,
    treatmentRevenueMinor: 12000,
  });
  assert.equal(pair.first_arm, "TREATMENT");
  assert.equal(pair.eligible, true);
  assert.equal((pair.deltas as { relative_revenue_uplift_percent: number }).relative_revenue_uplift_percent, 20);
  assert.equal((pair.deltas as { evidence_label: string }).evidence_label.includes("Test Mode"), true);
});

test("missing revenue is excluded and never coerced to zero", () => {
  const pair = pairRuns({
    pairingKey: "pair_qm_party_snacks",
    control: run({ run_id: "run_c", arm: "CONTROL" }),
    treatment: run({ run_id: "run_t", arm: "TREATMENT", configuration_digest: "digest_b" }),
    firstArm: "CONTROL",
  });
  assert.equal(pair.eligible, false);
  assert.equal(pair.exclusion_reason, "MISSING_REVENUE");
  assert.equal(pair.deltas, null);
});

test("OUTCOME_UNKNOWN excludes the pair", () => {
  const pair = pairRuns({
    pairingKey: "pair_qm_party_snacks",
    control: run({ run_id: "run_c", arm: "CONTROL" }),
    treatment: run({ run_id: "run_t", arm: "TREATMENT", configuration_digest: "digest_b" }),
    firstArm: "CONTROL",
    controlRevenueMinor: 10000,
    treatmentRevenueMinor: 12000,
    treatmentUnknown: true,
  });
  assert.equal(pair.eligible, false);
  assert.equal(pair.exclusion_reason, "OUTCOME_UNKNOWN");
  assert.equal(pair.deltas, null);
});

test("critical safety failure excludes the pair", () => {
  const pair = pairRuns({
    pairingKey: "pair_qm_party_snacks",
    control: run({ run_id: "run_c", arm: "CONTROL" }),
    treatment: run({ run_id: "run_t", arm: "TREATMENT", configuration_digest: "digest_b" }),
    firstArm: "CONTROL",
    controlRevenueMinor: 10000,
    treatmentRevenueMinor: 12000,
    criticalSafetyFailure: true,
  });
  assert.equal(pair.eligible, false);
  assert.equal(pair.exclusion_reason, "CRITICAL_SAFETY_FAILURE");
  assert.equal((pair.guardrails as { critical_safety_failure: boolean }).critical_safety_failure, true);
});
