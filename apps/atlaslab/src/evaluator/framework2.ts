import type { PairResultRecord, RunRecord } from "../types.js";

export interface RevenueArm {
  run: RunRecord;
  revenue_minor: number;
}

export function relativeUplift(controlRevenue: number, treatmentRevenue: number): { absolute_delta: number; relative_percent: number | null } {
  const absolute_delta = treatmentRevenue - controlRevenue;
  if (controlRevenue === 0) {
    return { absolute_delta, relative_percent: null };
  }
  return { absolute_delta, relative_percent: (absolute_delta / controlRevenue) * 100 };
}

export function pairEligible(control: RunRecord, treatment: RunRecord): { ok: boolean; reason?: string } {
  if (control.run_type !== "BENCHMARK_MODEL" || treatment.run_type !== "BENCHMARK_MODEL") {
    return { ok: false, reason: "only BENCHMARK_MODEL runs may enter a pair; deterministic and custom runs cannot enter benchmark denominators" };
  }
  if (control.evidence_eligibility !== "BENCHMARK_ELIGIBLE" || treatment.evidence_eligibility !== "BENCHMARK_ELIGIBLE") {
    return { ok: false, reason: "both arms must be BENCHMARK_ELIGIBLE" };
  }
  if (!control.fixture_digest || control.fixture_digest !== treatment.fixture_digest) {
    return { ok: false, reason: "fixture digest mismatch" };
  }
  if (control.requested_model_id !== treatment.requested_model_id) {
    return { ok: false, reason: "model identity mismatch" };
  }
  if (control.scenario_id !== treatment.scenario_id) {
    return { ok: false, reason: "scenario mismatch" };
  }
  if (control.arm && treatment.arm && control.arm === treatment.arm) {
    return { ok: false, reason: "arms must be opposite CONTROL and TREATMENT" };
  }
  return { ok: true };
}

export function pairRuns(opts: {
  pairingKey: string;
  control: RunRecord;
  treatment: RunRecord;
  firstArm: "CONTROL" | "TREATMENT";
  controlRevenueMinor?: number;
  treatmentRevenueMinor?: number;
  controlUnknown?: boolean;
  treatmentUnknown?: boolean;
}): PairResultRecord {
  const elig = pairEligible(opts.control, opts.treatment);
  const base: PairResultRecord = {
    pair_id: "pending",
    pairing_key: opts.pairingKey,
    control_run_id: opts.control.run_id,
    treatment_run_id: opts.treatment.run_id,
    eligible: false,
    exclusion_reason: elig.reason ?? null,
    first_arm: opts.firstArm,
    fixture_digest: opts.control.fixture_digest,
    deltas: null,
    guardrails: { critical_safety_failure: false },
    state: "EXCLUDED",
  };
  if (!elig.ok) return base;
  if (opts.controlUnknown || opts.treatmentUnknown) {
    return { ...base, exclusion_reason: "OUTCOME_UNKNOWN" };
  }
  if (opts.controlRevenueMinor === undefined || opts.treatmentRevenueMinor === undefined) {
    return { ...base, exclusion_reason: "MISSING_REVENUE" };
  }
  const deltas = relativeUplift(opts.controlRevenueMinor, opts.treatmentRevenueMinor);
  return {
    ...base,
    eligible: true,
    exclusion_reason: null,
    state: "COMPLETED",
    deltas: {
      control_revenue_minor: opts.controlRevenueMinor,
      treatment_revenue_minor: opts.treatmentRevenueMinor,
      absolute_revenue_delta_minor: deltas.absolute_delta,
      relative_revenue_uplift_percent: deltas.relative_percent,
      evidence_label: "controlled Test Mode evaluation evidence",
    },
  };
}

export function cannotEnterDenominator(run: RunRecord): boolean {
  return run.run_type !== "BENCHMARK_MODEL" || run.evidence_eligibility !== "BENCHMARK_ELIGIBLE";
}
