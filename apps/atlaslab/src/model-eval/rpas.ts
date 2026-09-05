import { relativeUplift } from "../evaluator/framework2.js";
import { merchantNetRevenueMinor, observationPaid, revenueStatus } from "../evaluator/evidence.js";
import { TASK_SUCCESS_MARGIN } from "./missions.js";
import type { MissionEval } from "./metrics.js";
import type { EvaluationEvidenceSnapshot, RevenueStatus } from "../types.js";

export interface ArmObservation {
  mission_id: string;
  captured_revenue_minor: number | null;
  merchant_net_revenue_minor: number | null;
  contribution_margin_minor: number | null;
  merchant_funded_discount_minor: number | null;
  sponsor_funded_discount_minor: number | null;
  payment_fee_minor: number | null;
  fulfillment_cost_minor: number | null;
  units: number | null;
  revenue_status: RevenueStatus;
  task_success: number | null;
  constraint_violations: number;
  safety_failure: boolean;
  paid: boolean;
  unknown: boolean;
  known_no_purchase: boolean;
  all_in_minor: number;
  public_calls: number;
  merchant_order_id: string | null;
  payment_attempt_id: string | null;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  authenticated_provider_event_ref: string | null;
  provider_fetch_ref: string | null;
  payment_attempt_state: string | null;
  core_order_confirmed: boolean;
  fixture_digest: string | null;
  requested_model_id: string | null;
  returned_model_id: string | null;
  prompt_version: string | null;
  system_prompt_version: string | null;
  skill_registry_version: string | null;
  tool_schema_digest: string | null;
  control_policy_digest: string | null;
  treatment_policy_digest: string | null;
  evidence: EvaluationEvidenceSnapshot | null;
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
  delta_merchant_net_minor: number | null;
  relative_lift_percent: number | null;
  n: number;
  revenue_status: RevenueStatus;
  guardrails: {
    critical_safety_failure: boolean;
    task_success_ok: boolean;
    constraints_ok: boolean;
  };
}

function countableStatus(status: RevenueStatus): boolean {
  return status === "CONFIRMED_REVENUE" || status === "ZERO_CONFIRMED_REVENUE" || status === "KNOWN_NO_PURCHASE";
}

function confirmedStatus(status: RevenueStatus): boolean {
  return status === "CONFIRMED_REVENUE" || status === "ZERO_CONFIRMED_REVENUE";
}

function armPrimaryMinor(obs: ArmObservation): number | null {
  if (obs.revenue_status === "KNOWN_NO_PURCHASE" || obs.revenue_status === "ZERO_CONFIRMED_REVENUE") return 0;
  if (!countableStatus(obs.revenue_status)) return null;
  return obs.merchant_net_revenue_minor ?? obs.captured_revenue_minor;
}

export function observationFrom(evalRow: MissionEval): ArmObservation {
  const unknown = evalRow.unknown;
  const evidence = evalRow.evidence ?? null;
  const status = revenueStatus(evidence, unknown, { knownNoPurchase: evalRow.known_no_purchase });
  const paid = observationPaid(evidence);
  const captured = status === "KNOWN_NO_PURCHASE" ? 0 : evalRow.captured_revenue_minor;
  const merchantNet = status === "KNOWN_NO_PURCHASE" ? 0 : evalRow.merchant_net_revenue_minor ?? merchantNetRevenueMinor(evidence);
  return {
    mission_id: evalRow.mission_id,
    captured_revenue_minor: captured,
    merchant_net_revenue_minor: merchantNet,
    contribution_margin_minor: evalRow.contribution_margin_minor,
    merchant_funded_discount_minor: evalRow.merchant_funded_discount_minor,
    sponsor_funded_discount_minor: evalRow.sponsor_funded_discount_minor,
    payment_fee_minor: evalRow.payment_fee_minor,
    fulfillment_cost_minor: evalRow.fulfillment_cost_minor,
    units: evalRow.units,
    revenue_status: status,
    task_success: evalRow.metrics.task_success,
    constraint_violations: evalRow.constraint_violations.length,
    safety_failure: evalRow.safety_failure,
    paid,
    unknown,
    known_no_purchase: evalRow.known_no_purchase,
    all_in_minor: evalRow.all_in_minor,
    public_calls: evalRow.public_calls,
    merchant_order_id: evidence?.merchant_order_id ?? null,
    payment_attempt_id: evidence?.payment_attempt_id ?? null,
    provider_order_id: evidence?.provider_order_id ?? null,
    provider_payment_id: evidence?.provider_payment_id ?? null,
    authenticated_provider_event_ref: evidence?.authenticated_provider_event_ref ?? null,
    provider_fetch_ref: evidence?.provider_fetch_ref ?? null,
    payment_attempt_state: evidence?.payment_attempt_state ?? null,
    core_order_confirmed: Boolean(evidence?.core_order_confirmed),
    fixture_digest: evidence?.fixture_digest ?? null,
    requested_model_id: evidence?.requested_model_id ?? null,
    returned_model_id: evidence?.returned_model_id ?? null,
    prompt_version: evidence?.prompt_version ?? null,
    system_prompt_version: evidence?.system_prompt_version ?? null,
    skill_registry_version: evidence?.skill_registry_version ?? null,
    tool_schema_digest: evidence?.tool_schema_digest ?? null,
    control_policy_digest: evidence?.control_policy_digest ?? null,
    treatment_policy_digest: evidence?.treatment_policy_digest ?? null,
    evidence,
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
  else if (!countableStatus(control.revenue_status) || !countableStatus(treatment.revenue_status)) exclusion = "REVENUE_UNAVAILABLE";
  const included = exclusion == null;
  const cRev = armPrimaryMinor(control);
  const tRev = armPrimaryMinor(treatment);
  const lift = included && cRev != null && tRev != null ? relativeUplift(cRev, tRev) : null;
  const cGross = countableStatus(control.revenue_status) ? control.captured_revenue_minor : null;
  const tGross = countableStatus(treatment.revenue_status) ? treatment.captured_revenue_minor : null;
  const grossLift = included && cGross != null && tGross != null ? relativeUplift(cGross, tGross) : null;
  const allKnownNoPurchase = control.revenue_status === "KNOWN_NO_PURCHASE" && treatment.revenue_status === "KNOWN_NO_PURCHASE";
  const bothZeroConfirmed = control.revenue_status === "ZERO_CONFIRMED_REVENUE" && treatment.revenue_status === "ZERO_CONFIRMED_REVENUE";
  return {
    mission_id: opts.mission_id,
    cell_id: opts.cell_id,
    strategy: opts.strategy,
    included_in_rpas: included,
    exclusion_reason: exclusion,
    control,
    treatment,
    delta_rpas_minor: grossLift ? grossLift.absolute_delta : null,
    delta_merchant_net_minor: lift ? lift.absolute_delta : null,
    relative_lift_percent: opts.liveSuite ? null : lift?.relative_percent ?? null,
    n: included ? 1 : 0,
    revenue_status: exclusion === "OUTCOME_UNKNOWN"
      ? "OUTCOME_UNKNOWN"
      : included
        ? allKnownNoPurchase
          ? "KNOWN_NO_PURCHASE"
          : bothZeroConfirmed
            ? "ZERO_CONFIRMED_REVENUE"
            : confirmedStatus(control.revenue_status) || confirmedStatus(treatment.revenue_status)
              ? "CONFIRMED_REVENUE"
              : "REVENUE_UNAVAILABLE"
        : exclusion === "REVENUE_UNAVAILABLE"
          ? "REVENUE_UNAVAILABLE"
          : "INSUFFICIENT_SAMPLE",
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

export function meanMerchantNet(pairs: PairRpas[], arm: "control" | "treatment"): number | null {
  const included = pairs.filter((p) => p.included_in_rpas && armPrimaryMinor(p[arm]) != null);
  if (!included.length) return null;
  const total = included.reduce((sum, p) => sum + (armPrimaryMinor(p[arm]) ?? 0), 0);
  return total / included.length;
}

export function portfolioDelta(pairs: PairRpas[]): {
  control_rpas_minor: number | null;
  treatment_rpas_minor: number | null;
  delta_rpas_minor: number | null;
  control_merchant_net_minor: number | null;
  treatment_merchant_net_minor: number | null;
  delta_merchant_net_minor: number | null;
  relative_lift_percent: number | null;
  n: number;
  excluded: number;
  conversion_by_arm: { control: number | null; treatment: number | null };
  aov_by_arm: { control: number | null; treatment: number | null };
  units_per_order_by_arm: { control: number | null; treatment: number | null };
  revenue_status: RevenueStatus;
  primary_metric: "merchant_net_revenue_per_eligible_buyer_journey";
} {
  const included = pairs.filter((p) => p.included_in_rpas);
  if (!included.length) {
    return {
      control_rpas_minor: null,
      treatment_rpas_minor: null,
      delta_rpas_minor: null,
      control_merchant_net_minor: null,
      treatment_merchant_net_minor: null,
      delta_merchant_net_minor: null,
      relative_lift_percent: null,
      n: 0,
      excluded: pairs.length,
      conversion_by_arm: { control: null, treatment: null },
      aov_by_arm: { control: null, treatment: null },
      units_per_order_by_arm: { control: null, treatment: null },
      revenue_status: pairs.length === 0 ? "NO_ELIGIBLE_SESSIONS" : "INSUFFICIENT_SAMPLE",
      primary_metric: "merchant_net_revenue_per_eligible_buyer_journey",
    };
  }
  const control = meanRpas(pairs, "control");
  const treatment = meanRpas(pairs, "treatment");
  const controlNet = meanMerchantNet(pairs, "control");
  const treatmentNet = meanMerchantNet(pairs, "treatment");
  const lift = control != null && treatment != null ? relativeUplift(control, treatment) : null;
  const netLift = controlNet != null && treatmentNet != null ? relativeUplift(controlNet, treatmentNet) : null;
  const conversion = (arm: "control" | "treatment"): number =>
    included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE").length / included.length;
  const aov = (arm: "control" | "treatment"): number | null => {
    const paid = included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE" && p[arm].captured_revenue_minor != null);
    if (!paid.length) return null;
    return paid.reduce((sum, p) => sum + (p[arm].captured_revenue_minor ?? 0), 0) / paid.length;
  };
  const units = (arm: "control" | "treatment"): number | null => {
    const paid = included.filter((p) => p[arm].revenue_status === "CONFIRMED_REVENUE" && p[arm].units != null);
    if (!paid.length) return null;
    return paid.reduce((sum, p) => sum + (p[arm].units ?? 0), 0) / paid.length;
  };
  const includedStatuses = included.flatMap((p) => [p.control.revenue_status, p.treatment.revenue_status]);
  const allKnownNoPurchase = includedStatuses.length > 0 && includedStatuses.every((status) => status === "KNOWN_NO_PURCHASE");
  const allZeroConfirmed = includedStatuses.length > 0 && includedStatuses.every((status) => status === "ZERO_CONFIRMED_REVENUE");
  const hasConfirmedRevenue = includedStatuses.some((status) => status === "CONFIRMED_REVENUE");
  return {
    control_rpas_minor: control,
    treatment_rpas_minor: treatment,
    delta_rpas_minor: lift?.absolute_delta ?? null,
    control_merchant_net_minor: controlNet,
    treatment_merchant_net_minor: treatmentNet,
    delta_merchant_net_minor: netLift?.absolute_delta ?? null,
    relative_lift_percent: null,
    n: included.length,
    excluded: pairs.length - included.length,
    conversion_by_arm: { control: conversion("control"), treatment: conversion("treatment") },
    aov_by_arm: { control: aov("control"), treatment: aov("treatment") },
    units_per_order_by_arm: { control: units("control"), treatment: units("treatment") },
    revenue_status: allKnownNoPurchase
      ? "KNOWN_NO_PURCHASE"
      : allZeroConfirmed
        ? "ZERO_CONFIRMED_REVENUE"
        : hasConfirmedRevenue
          ? "CONFIRMED_REVENUE"
          : "REVENUE_UNAVAILABLE",
    primary_metric: "merchant_net_revenue_per_eligible_buyer_journey",
  };
}
