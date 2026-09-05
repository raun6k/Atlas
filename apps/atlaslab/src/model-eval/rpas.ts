import { relativeUplift } from "../evaluator/framework2.js";
import { TASK_SUCCESS_MARGIN } from "./missions.js";
import type { MissionEval } from "./metrics.js";
import type { RevenueStatus } from "../types.js";

export interface ArmObservation {
  mission_id: string;
  captured_revenue_minor: number | null;
  revenue_status: RevenueStatus;
  task_success: number | null;
  constraint_violations: number;
  safety_failure: boolean;
  paid: boolean;
  unknown: boolean;
  all_in_minor: number;
  public_calls: number;
}

export interface PairRpas {
  mission_id: string;
  cell_id?: string;
  strategy?: string;
  included_in_rpas: boolean;
  exclusion_reason: string | null;
  control: ArmObservation;
  treatment: ArmObservation;
  delta_rpas_minor: number | null;
  relative_lift_percent: number | null;
  n: number;
  revenue_status: RevenueStatus;
  guardrails: {
    critical_safety_failure: boolean;
    task_success_ok: boolean;
    constraints_ok: boolean;
  };
}

export function observationFrom(evalRow: MissionEval): ArmObservation {
  const unknown = evalRow.unknown;
  const revenue = evalRow.captured_revenue_minor;
  let revenue_status: RevenueStatus = "REVENUE_UNAVAILABLE";
  if (unknown) revenue_status = "OUTCOME_UNKNOWN";
  else if (revenue == null) revenue_status = "REVENUE_UNAVAILABLE";
  else if (revenue === 0) revenue_status = "ZERO_CONFIRMED_REVENUE";
  else revenue_status = "CONFIRMED_REVENUE";
  return {
    mission_id: evalRow.mission_id,
    captured_revenue_minor: revenue,
    revenue_status,
    task_success: evalRow.metrics.task_success,
    constraint_violations: evalRow.constraint_violations.length,
    safety_failure: evalRow.safety_failure,
    paid: evalRow.paid,
    unknown: evalRow.unknown,
    all_in_minor: evalRow.all_in_minor,
    public_calls: evalRow.public_calls,
  };
}

export function pairRpas(opts: {
  mission_id: string;
  control: MissionEval;
  treatment: MissionEval;
  cell_id?: string;
  strategy?: string;
  liveSuite?: boolean;
}): PairRpas {
  const control = observationFrom(opts.control);
  const treatment = observationFrom(opts.treatment);
  const safety = treatment.safety_failure;
  const taskOk =
    treatment.task_success == null ||
    control.task_success == null ||
    treatment.task_success + TASK_SUCCESS_MARGIN >= control.task_success;
  const constraintsOk = treatment.constraint_violations <= control.constraint_violations;
  let exclusion: string | null = null;
  if (safety) exclusion = "CRITICAL_SAFETY_FAILURE";
  else if (!taskOk) exclusion = "TASK_SUCCESS_GUARDRAIL";
  else if (!constraintsOk) exclusion = "CONSTRAINT_GUARDRAIL";
  else if (control.unknown || treatment.unknown) exclusion = "OUTCOME_UNKNOWN";
  else if (control.captured_revenue_minor == null || treatment.captured_revenue_minor == null) exclusion = "REVENUE_UNAVAILABLE";
  const included = exclusion == null;
  const cRev = control.captured_revenue_minor;
  const tRev = treatment.captured_revenue_minor;
  const lift = included && cRev != null && tRev != null ? relativeUplift(cRev, tRev) : null;
  return {
    mission_id: opts.mission_id,
    cell_id: opts.cell_id,
    strategy: opts.strategy,
    included_in_rpas: included,
    exclusion_reason: exclusion,
    control,
    treatment,
    delta_rpas_minor: lift ? lift.absolute_delta : null,
    relative_lift_percent: opts.liveSuite ? null : lift?.relative_percent ?? null,
    n: included ? 1 : 0,
    revenue_status: exclusion === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : included ? "CONFIRMED_REVENUE" : exclusion === "REVENUE_UNAVAILABLE" ? "REVENUE_UNAVAILABLE" : "INSUFFICIENT_SAMPLE",
    guardrails: {
      critical_safety_failure: safety,
      task_success_ok: taskOk,
      constraints_ok: constraintsOk,
    },
  };
}

export function meanRpas(pairs: PairRpas[], arm: "control" | "treatment"): number | null {
  const included = pairs.filter((p) => p.included_in_rpas && p[arm].captured_revenue_minor != null);
  if (!included.length) return null;
  const total = included.reduce((sum, p) => sum + (p[arm].captured_revenue_minor ?? 0), 0);
  return total / included.length;
}

export function portfolioDelta(pairs: PairRpas[]): {
  control_rpas_minor: number | null;
  treatment_rpas_minor: number | null;
  delta_rpas_minor: number | null;
  relative_lift_percent: number | null;
  n: number;
  excluded: number;
  revenue_status: RevenueStatus;
} {
  const included = pairs.filter((p) => p.included_in_rpas);
  if (!included.length) {
    return {
      control_rpas_minor: null,
      treatment_rpas_minor: null,
      delta_rpas_minor: null,
      relative_lift_percent: null,
      n: 0,
      excluded: pairs.length,
      revenue_status: pairs.length === 0 ? "NO_ELIGIBLE_SESSIONS" : "INSUFFICIENT_SAMPLE",
    };
  }
  const control = meanRpas(pairs, "control");
  const treatment = meanRpas(pairs, "treatment");
  const lift = control != null && treatment != null ? relativeUplift(control, treatment) : null;
  return {
    control_rpas_minor: control,
    treatment_rpas_minor: treatment,
    delta_rpas_minor: lift?.absolute_delta ?? null,
    relative_lift_percent: null,
    n: included.length,
    excluded: pairs.length - included.length,
    revenue_status: lift ? "CONFIRMED_REVENUE" : "REVENUE_UNAVAILABLE",
  };
}
