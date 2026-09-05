import type { CommercialProof, GrowthProjection } from "./audit-view";

export interface GrowthDisplay {
  eligiblePairs: number | null;
  excludedPairs: number | null;
  unresolvedPayments: number | null;
  knownNoPurchases: number | null;
  controlGross: string;
  treatmentGross: string;
  controlNet: string;
  treatmentNet: string;
  netDelta: string | null;
  conversionControl: string;
  conversionTreatment: string;
  aovControl: string;
  aovTreatment: string;
  primaryMetric: string;
  treatmentStrategy: string;
  operatorAssisted: boolean;
  settlementClaimed: boolean;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arm(record: Record<string, unknown> | undefined, key: string): string {
  if (!record || record[key] === null || record[key] === undefined) return "—";
  return String(record[key]);
}

export function growthDisplay(growth: GrowthProjection | null | undefined): GrowthDisplay {
  const proof = growth?.proof.value ?? null;
  const portfolio = growth?.portfolio.value ?? null;
  const report = growth?.report.value ?? null;
  const captured = proof?.captured_revenue_by_arm ?? {};
  const net = (proof as CommercialProof & { merchant_net_revenue_by_arm?: Record<string, unknown> })?.merchant_net_revenue_by_arm
    ?? (portfolio?.control_merchant_net_minor != null
      ? { control: portfolio.control_merchant_net_minor, treatment: portfolio.treatment_merchant_net_minor }
      : {});
  const conversion = (proof as { conversion_by_arm?: Record<string, unknown> })?.conversion_by_arm
    ?? (portfolio?.conversion_by_arm as Record<string, unknown> | undefined)
    ?? {};
  const aov = (proof as { aov_by_arm?: Record<string, unknown> })?.aov_by_arm
    ?? (portfolio?.aov_by_arm as Record<string, unknown> | undefined)
    ?? {};
  const netDelta = num(portfolio?.delta_merchant_net_minor) ?? num(portfolio?.delta_rpas_minor);
  return {
    eligiblePairs: proof ? proof.eligible_pairs : null,
    excludedPairs: proof ? proof.excluded_pairs.length : null,
    unresolvedPayments: proof ? proof.unresolved_payment_count : null,
    knownNoPurchases: num((proof as { known_no_purchase_count?: unknown })?.known_no_purchase_count),
    controlGross: arm(captured, "control"),
    treatmentGross: arm(captured, "treatment"),
    controlNet: arm(net, "control"),
    treatmentNet: arm(net, "treatment"),
    netDelta: netDelta == null ? null : String(netDelta),
    conversionControl: arm(conversion, "control"),
    conversionTreatment: arm(conversion, "treatment"),
    aovControl: arm(aov, "control"),
    aovTreatment: arm(aov, "treatment"),
    primaryMetric: String((proof as { primary_metric?: unknown })?.primary_metric || "merchant_net_revenue_per_eligible_buyer_journey"),
    treatmentStrategy: String((proof as { treatment_strategy?: unknown })?.treatment_strategy || report?.demo_strategies || "SMALL_ORDER"),
    operatorAssisted: report?.operator_assisted !== false,
    settlementClaimed: String((proof as { settlement_status?: unknown })?.settlement_status || report?.settlement_status) !== "NOT_IMPLEMENTED" && Boolean(report?.settlement_status),
  };
}
