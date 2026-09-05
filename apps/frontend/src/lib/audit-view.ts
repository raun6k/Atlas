export type AuditState = "available" | "missing" | "unavailable" | "unresolved";

export interface AuditProvenance {
  source: "core" | "atlaslab" | "frontend_mock";
  request_id?: string;
  generated_at?: string;
  data_freshness_at?: string;
  projection_version?: string;
  report_id?: string;
  run_id?: string;
  content_digest?: string;
}

export interface AuditValue<T> {
  state: AuditState;
  value: T | null;
  provenance: AuditProvenance;
  message?: string;
}

export interface SellabilityStage {
  stage: string;
  passed: number;
  eligible: number;
  exclusions: number;
}

export interface SellabilityProjection {
  capabilities: AuditValue<Record<string, unknown>>;
  stages: AuditValue<SellabilityStage[]>;
  numerator: number | null;
  denominator: number | null;
  cohort: string | null;
  contract_report: AuditValue<Record<string, unknown>>;
  compatibility_report: AuditValue<Record<string, unknown>>;
}

export interface CommercialProof {
  eligible_pairs: number;
  excluded_pairs: Array<Record<string, unknown>>;
  confirmed_orders_by_arm: Record<string, unknown>;
  captured_revenue_by_arm: Record<string, unknown>;
  merchant_net_revenue_by_arm?: Record<string, unknown>;
  conversion_by_arm?: Record<string, unknown>;
  aov_by_arm?: Record<string, unknown>;
  units_per_order_by_arm?: Record<string, unknown>;
  task_success_by_arm: Record<string, unknown>;
  safety_failures: number;
  unresolved_payment_count: number;
  known_no_purchase_count?: number;
  primary_metric?: string;
  treatment_strategy?: string;
  confidence_intervals: Record<string, unknown>;
}

export interface GrowthProjection {
  report: AuditValue<Record<string, unknown>>;
  proof: AuditValue<CommercialProof>;
  portfolio: AuditValue<Record<string, unknown>>;
  uplift_state: AuditState;
  caveat: string | null;
}

export interface MerchantProjection {
  profile: AuditValue<Record<string, unknown>>;
  locations: AuditValue<Array<Record<string, unknown>>>;
  products: AuditValue<Array<Record<string, unknown>>>;
  inventory: AuditValue<Array<Record<string, unknown>>>;
  promotions: AuditValue<Array<Record<string, unknown>>>;
  strategies: AuditValue<Array<Record<string, unknown>>>;
}

export interface TrustPayment {
  order: Record<string, unknown>;
  assurance: Record<string, unknown>;
}

export interface TrustProjection {
  attention: AuditValue<Record<string, unknown>>;
  payments: AuditValue<TrustPayment[]>;
  audit: AuditValue<Array<Record<string, unknown>>>;
}

export interface AuditView {
  sellability: SellabilityProjection;
  growth: GrowthProjection;
  merchant: MerchantProjection;
  trust: TrustProjection;
}

export interface AuditProjectionInput {
  source?: "live" | "mock";
  error?: unknown;
  capabilities?: unknown;
  reports?: unknown;
  analytics?: unknown;
  profile?: unknown;
  locations?: unknown;
  products?: unknown;
  inventory?: unknown;
  promotions?: unknown;
  strategies?: unknown;
  attention?: unknown;
  payments?: unknown;
  audit?: unknown;
}

interface Unwrapped {
  data: unknown;
  provenance: AuditProvenance;
  unavailable: boolean;
  message?: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const records = (value: unknown): Array<Record<string, unknown>> | null =>
  Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row !== null) : null;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unavailableFrom(raw: unknown): string | undefined {
  const row = record(raw);
  const code = text(row?.code);
  if (row?.state === "unavailable" || code === "UNAVAILABLE" || code === "UPSTREAM_UNAVAILABLE") {
    return text(row?.message) ?? code ?? "Upstream evidence is unavailable.";
  }
  return undefined;
}

function provenance(source: AuditProvenance["source"], value?: unknown): AuditProvenance {
  const row = record(value);
  const nested = record(row?.provenance);
  const envelope = record(row?.envelope);
  return {
    source,
    request_id: text(row?.request_id) ?? text(envelope?.request_id),
    generated_at: text(row?.generated_at) ?? text(envelope?.occurred_at),
    data_freshness_at: text(row?.data_freshness_at) ?? text(envelope?.occurred_at),
    projection_version: text(row?.projection_version),
    report_id: text(row?.report_id),
    run_id: text(row?.run_id),
    content_digest: text(nested?.content_digest),
  };
}

/** Unwraps the canonical AtlasLab analytics envelope while retaining its provenance. */
export function unwrapAtlasLabEnvelope(value: unknown): Unwrapped {
  const row = record(value);
  const unavailableSections = records(row?.unavailable_sections);
  if (!row) {
    return { data: null, provenance: { source: "atlaslab" }, unavailable: false };
  }
  const failure = unavailableFrom(row);
  if (failure) {
    return {
      data: null,
      provenance: provenance("atlaslab", row),
      unavailable: true,
      message: failure,
    };
  }
  if ("data" in row) {
    return {
      data: row.data,
      provenance: provenance("atlaslab", row),
      unavailable: row.partial === true && Boolean(unavailableSections?.length),
      message: unavailableSections?.map((section) => text(section.message)).filter(Boolean).join("; "),
    };
  }
  return { data: row, provenance: provenance("atlaslab", row), unavailable: false };
}

function value<T>(
  candidate: T | null,
  source: AuditProvenance["source"],
  raw?: unknown,
  unavailable = false,
  message?: string,
): AuditValue<T> {
  const upstreamMessage = unavailableFrom(raw);
  const isUnavailable = unavailable || upstreamMessage !== undefined;
  return {
    state: isUnavailable ? "unavailable" : candidate === null ? "missing" : "available",
    value: isUnavailable ? null : candidate,
    provenance: provenance(source, raw),
    message: message ?? upstreamMessage,
  };
}

function listField(raw: unknown, keys: string[]): Array<Record<string, unknown>> | null {
  const direct = records(raw);
  if (direct) return direct;
  const row = record(raw);
  for (const key of keys) {
    const found = records(row?.[key]);
    if (found) return found;
  }
  return null;
}

function coreRecord(raw: unknown, key?: string): Record<string, unknown> | null {
  const row = record(raw);
  if (!row) return null;
  if (!key) return row;
  return record(row[key]);
}

function reportsFrom(raw: unknown): {
  items: Array<Record<string, unknown>>;
  provenance: AuditProvenance;
  unavailable: boolean;
  message?: string;
} {
  const unwrapped = unwrapAtlasLabEnvelope(raw);
  const row = record(unwrapped.data);
  return {
    items: records(unwrapped.data) ?? records(row?.items) ?? [],
    provenance: unwrapped.provenance,
    unavailable: unwrapped.unavailable,
    message: unwrapped.message,
  };
}

function reportValue(
  report: Record<string, unknown> | undefined,
  inherited: AuditProvenance,
  unavailable = false,
  message?: string,
): AuditValue<Record<string, unknown>> {
  if (unavailable) return { state: "unavailable", value: null, provenance: inherited, message };
  if (!report) return { state: "missing", value: null, provenance: inherited };
  const reportBody = record(report.report) ?? report;
  const specific = provenance("atlaslab", report);
  return {
    state: "available",
    value: reportBody,
    provenance: {
      source: "atlaslab",
      request_id: specific.request_id ?? inherited.request_id,
      generated_at: specific.generated_at ?? inherited.generated_at,
      data_freshness_at: specific.data_freshness_at ?? inherited.data_freshness_at,
      projection_version: specific.projection_version ?? inherited.projection_version,
      report_id: text(report.report_id),
      run_id: text(report.run_id),
      content_digest: text(record(reportBody.provenance)?.content_digest),
    },
  };
}

function commercialProof(raw: unknown): CommercialProof | null {
  const proof = record(raw);
  if (!proof || typeof proof.eligible_pairs !== "number") return null;
  return {
    eligible_pairs: proof.eligible_pairs,
    excluded_pairs: records(proof.excluded_pairs) ?? [],
    confirmed_orders_by_arm: record(proof.confirmed_orders_by_arm) ?? {},
    captured_revenue_by_arm: record(proof.captured_revenue_by_arm) ?? {},
    merchant_net_revenue_by_arm: record(proof.merchant_net_revenue_by_arm) ?? undefined,
    conversion_by_arm: record(proof.conversion_by_arm) ?? undefined,
    aov_by_arm: record(proof.aov_by_arm) ?? undefined,
    units_per_order_by_arm: record(proof.units_per_order_by_arm) ?? undefined,
    task_success_by_arm: record(proof.task_success_by_arm) ?? {},
    safety_failures: typeof proof.safety_failures === "number" ? proof.safety_failures : 0,
    unresolved_payment_count: typeof proof.unresolved_payment_count === "number" ? proof.unresolved_payment_count : 0,
    known_no_purchase_count: typeof proof.known_no_purchase_count === "number" ? proof.known_no_purchase_count : undefined,
    primary_metric: text(proof.primary_metric),
    treatment_strategy: text(proof.treatment_strategy),
    confidence_intervals: record(proof.confidence_intervals) ?? {},
  };
}

function assuranceFrom(raw: unknown): TrustPayment | null {
  const row = record(raw);
  if (!row) return null;
  const body = record(row.detail) ?? row;
  const envelope = record(body.envelope);
  const assurance = record(row.assurance) ?? record(envelope?.correlation) ?? record(body.assurance);
  if (!assurance) return null;
  return { order: record(row.order) ?? record(body.order) ?? {}, assurance };
}

export function projectAuditView(input: AuditProjectionInput): AuditView {
  const source: AuditProvenance["source"] = input.source === "mock" ? "frontend_mock" : "core";
  const globalError = record(input.error);
  const globallyUnavailable = globalError?.state === "unavailable";
  const unavailableMessage = text(globalError?.message);

  const reportSet = reportsFrom(input.reports);
  const contract = reportSet.items.find((item) => item.kind === "CONTRACT");
  const compatibility = reportSet.items.find((item) => item.kind === "AGENT_COMPATIBILITY");
  const commercial = reportSet.items.find((item) => item.kind === "COMMERCIAL_UPLIFT");
  const contractValue = reportValue(contract, reportSet.provenance, reportSet.unavailable, reportSet.message);
  const compatibilityValue = reportValue(compatibility, reportSet.provenance, reportSet.unavailable, reportSet.message);
  const commercialValue = reportValue(commercial, reportSet.provenance, reportSet.unavailable, reportSet.message);

  const analyticsEnvelope = unwrapAtlasLabEnvelope(input.analytics);
  const analytics = record(analyticsEnvelope.data);
  const stageRows = listField(analytics?.stages, [])?.map((stage) => ({
    stage: String(stage.stage ?? ""),
    passed: Number(stage.passed ?? 0),
    eligible: Number(stage.eligible ?? 0),
    exclusions: Number(stage.exclusions ?? 0),
  })) ?? null;

  const commercialBody = commercialValue.value;
  const proof = commercialProof(commercialBody?.proof);
  const portfolio = record(commercialBody?.portfolio);
  const commercialUnavailable = commercialValue.state === "unavailable";

  const paymentRows = Array.isArray(input.payments)
    ? input.payments.map(assuranceFrom).filter((payment): payment is TrustPayment => payment !== null)
    : null;
  const unresolved = paymentRows?.some((payment) => payment.assurance.evidence_status === "UNRESOLVED") ?? false;
  const payments = value(paymentRows, source, input.payments, globallyUnavailable, unavailableMessage);
  if (unresolved && payments.state === "available") payments.state = "unresolved";

  return {
    sellability: {
      capabilities: value(coreRecord(input.capabilities, "capabilities") ?? coreRecord(input.capabilities), source, input.capabilities, globallyUnavailable, unavailableMessage),
      stages: value(stageRows, "atlaslab", input.analytics, analyticsEnvelope.unavailable, analyticsEnvelope.message),
      numerator: typeof analytics?.numerator === "number" ? analytics.numerator : null,
      denominator: typeof analytics?.denominator === "number" ? analytics.denominator : null,
      cohort: text(analytics?.cohort) ?? null,
      contract_report: contractValue,
      compatibility_report: compatibilityValue,
    },
    growth: {
      report: commercialValue,
      proof: value(proof, "atlaslab", commercial, commercialUnavailable),
      portfolio: value(portfolio, "atlaslab", commercial, commercialUnavailable),
      uplift_state: commercialValue.state === "unavailable"
        ? "unavailable"
        : commercialValue.state === "missing" || proof === null
          ? "missing"
          : proof.eligible_pairs === 0
            ? "unresolved"
            : "available",
      caveat: text(commercial?.caveat) ?? text(commercialBody?.caveat) ?? null,
    },
    merchant: {
      profile: value(coreRecord(input.profile, "profile") ?? coreRecord(input.profile), source, input.profile, globallyUnavailable, unavailableMessage),
      locations: value(listField(input.locations, ["locations"]), source, input.locations, globallyUnavailable, unavailableMessage),
      products: value(listField(input.products, ["products"]), source, input.products, globallyUnavailable, unavailableMessage),
      inventory: value(listField(input.inventory, ["rows", "inventory"]), source, input.inventory, globallyUnavailable, unavailableMessage),
      promotions: value(listField(input.promotions, ["promotions"]), source, input.promotions, globallyUnavailable, unavailableMessage),
      strategies: value(listField(input.strategies, ["strategies"]), source, input.strategies, globallyUnavailable, unavailableMessage),
    },
    trust: {
      attention: value(coreRecord(input.attention), source, input.attention, globallyUnavailable, unavailableMessage),
      payments,
      audit: value(listField(input.audit, ["events"]), source, input.audit, globallyUnavailable, unavailableMessage),
    },
  };
}
