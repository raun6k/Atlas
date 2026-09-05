import { evidenceContradiction } from "./evidence.js";
import type { EvaluationEvidenceSnapshot, RevenueStatus } from "../types.js";

export interface CanonicalArm {
  paid: boolean;
  unknown: boolean;
  revenue_status: RevenueStatus;
  captured_revenue_minor: number | null;
  merchant_net_revenue_minor?: number | null;
  merchant_order_id?: string | null;
  payment_attempt_id?: string | null;
  provider_order_id?: string | null;
  provider_payment_id?: string | null;
  authenticated_provider_event_ref?: string | null;
  provider_fetch_ref?: string | null;
  core_order_confirmed?: boolean;
  evidence?: EvaluationEvidenceSnapshot | null;
}

export interface CanonicalPair {
  included_in_rpas: boolean;
  revenue_status: RevenueStatus;
  control: CanonicalArm;
  treatment: CanonicalArm;
}

export interface CanonicalCommercialReport {
  proof: {
    eligible_pairs: number;
    confirmed_orders_by_arm: { control: number; treatment: number };
    captured_revenue_by_arm: { control: number; treatment: number };
    merchant_net_revenue_by_arm?: { control: number; treatment: number };
    unresolved_payment_count: number;
    known_no_purchase_count?: number;
  };
  pairs: CanonicalPair[];
  provenance?: { code_revision?: string | null; content_digest?: string | null };
}

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim() !== "unknown";
}

export function assertCanonicalCommercialReport(report: CanonicalCommercialReport): void {
  const provenance = report.provenance;
  if (report.proof.eligible_pairs > 0 && (!provenance || !present(provenance.code_revision))) {
    throw new Error("measured commercial report has code_revision=unknown");
  }
  const included = report.pairs.filter((pair) => pair.included_in_rpas);
  if (included.length !== report.proof.eligible_pairs) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: eligible_pairs");
  }
  let controlGross = 0;
  let treatmentGross = 0;
  let controlNet = 0;
  let treatmentNet = 0;
  let controlPaid = 0;
  let treatmentPaid = 0;
  let knownNoPurchase = 0;
  for (const pair of report.pairs) {
    if (pair.included_in_rpas && (pair.control.unknown || pair.treatment.unknown || pair.revenue_status === "OUTCOME_UNKNOWN")) {
      throw new Error("eligible pair with unknown outcome");
    }
    for (const arm of ["control", "treatment"] as const) {
      const row = pair[arm];
      const contradiction = evidenceContradiction(row.evidence ?? null, row.paid, row.revenue_status);
      if (contradiction) throw new Error(`${arm}: ${contradiction}`);
      if (row.revenue_status === "CONFIRMED_REVENUE") {
        if (!row.merchant_order_id || !row.payment_attempt_id || !row.provider_order_id || !row.provider_payment_id) {
          throw new Error(`${arm} CONFIRMED_REVENUE missing order or payment identifiers`);
        }
        if (!row.authenticated_provider_event_ref || !row.provider_fetch_ref || !row.core_order_confirmed) {
          throw new Error(`${arm} CONFIRMED_REVENUE missing reconciliation reference`);
        }
      }
    }
    if (pair.control.revenue_status === "KNOWN_NO_PURCHASE" || pair.treatment.revenue_status === "KNOWN_NO_PURCHASE") {
      knownNoPurchase += 1;
    }
    if (!pair.included_in_rpas) continue;
    controlGross += pair.control.captured_revenue_minor ?? 0;
    treatmentGross += pair.treatment.captured_revenue_minor ?? 0;
    controlNet += pair.control.merchant_net_revenue_minor ?? pair.control.captured_revenue_minor ?? 0;
    treatmentNet += pair.treatment.merchant_net_revenue_minor ?? pair.treatment.captured_revenue_minor ?? 0;
    if (pair.control.paid) controlPaid += 1;
    if (pair.treatment.paid) treatmentPaid += 1;
  }
  const captured = report.proof.captured_revenue_by_arm;
  if (captured.control !== controlGross || captured.treatment !== treatmentGross) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: captured_revenue_by_arm");
  }
  if (report.proof.confirmed_orders_by_arm.control !== controlPaid || report.proof.confirmed_orders_by_arm.treatment !== treatmentPaid) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: confirmed_orders_by_arm");
  }
  const net = report.proof.merchant_net_revenue_by_arm;
  if (net && (net.control !== controlNet || net.treatment !== treatmentNet)) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: merchant_net_revenue_by_arm");
  }
  const unknownPairCount = report.pairs.filter((pair) => pair.control.unknown || pair.treatment.unknown || pair.revenue_status === "OUTCOME_UNKNOWN").length;
  if (report.proof.unresolved_payment_count !== unknownPairCount) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: unresolved_payment_count");
  }
  if (report.proof.known_no_purchase_count != null && report.proof.known_no_purchase_count !== knownNoPurchase) {
    throw new Error("aggregate proof disagreeing with pair-level evidence: known_no_purchase_count");
  }
}
