import { sha256Hex } from "../ids.js";
import type { EvaluationEvidenceSnapshot, RevenueStatus } from "../types.js";

export type { EvaluationEvidenceSnapshot };

export function emptyEvidence(): EvaluationEvidenceSnapshot {
  return {
    merchant_order_id: null,
    payment_attempt_id: null,
    provider_order_id: null,
    provider_payment_id: null,
    confirmed_order_amount_minor: null,
    currency: null,
    merchant_order_state: null,
    payment_attempt_state: null,
    authenticated_provider_event_ref: null,
    provider_fetch_ref: null,
    event_binding_status: null,
    provider_fetch_match_status: null,
    strategy_revision: null,
    strategy_allowlist_digest: null,
    shown_offer_ids: [],
    applied_offer_ids: [],
    attribution_id: null,
    fixture_snapshot_id: null,
    fixture_digest: null,
    contract_version: null,
    capabilities_ok: false,
    active_location_id: null,
    sellable_sku_id: null,
    cart_version: null,
    session_context_version: null,
    checkout_proposal_id: null,
    reservations_active: false,
    core_order_confirmed: false,
    merchandise_minor: null,
    merchant_funded_discount_minor: null,
    sponsor_funded_discount_minor: null,
    payment_fee_minor: null,
    fulfillment_cost_minor: null,
    cogs_minor: null,
    units: null,
    requested_model_id: null,
    returned_model_id: null,
    prompt_version: null,
    system_prompt_version: null,
    skill_registry_version: null,
    tool_schema_digest: null,
    control_policy_digest: null,
    treatment_policy_digest: null,
    code_revision: null,
  };
}

export function mergeEvidence(base: EvaluationEvidenceSnapshot, patch: Partial<EvaluationEvidenceSnapshot>): EvaluationEvidenceSnapshot {
  return { ...base, ...patch, shown_offer_ids: patch.shown_offer_ids ?? base.shown_offer_ids, applied_offer_ids: patch.applied_offer_ids ?? base.applied_offer_ids };
}

function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function revenueEligible(ev: EvaluationEvidenceSnapshot): boolean {
  const bound = ev.event_binding_status === "BOUND" || ev.event_binding_status === "AUTHENTICATED";
  const fetchMatch = ev.provider_fetch_match_status === "MATCH";
  const captured = ev.payment_attempt_state === "CAPTURED_RECONCILED";
  const confirmed = ev.core_order_confirmed || ev.merchant_order_state === "CONFIRMED" || ev.merchant_order_state === "ORDER_CONFIRMED";
  const amountOk = ev.confirmed_order_amount_minor != null && ev.confirmed_order_amount_minor > 0;
  const currencyOk = Boolean(ev.currency);
  const oneAttribution = Boolean(ev.attribution_id) && !String(ev.attribution_id).includes(",");
  return Boolean(
    present(ev.authenticated_provider_event_ref) &&
      present(ev.provider_fetch_ref) &&
      present(ev.provider_order_id) &&
      present(ev.provider_payment_id) &&
      present(ev.payment_attempt_id) &&
      present(ev.merchant_order_id) &&
      bound &&
      fetchMatch &&
      captured &&
      confirmed &&
      amountOk &&
      currencyOk &&
      oneAttribution,
  );
}

export function capturedRevenueMinor(ev: EvaluationEvidenceSnapshot | null | undefined): number | null {
  if (!ev) return null;
  if (!revenueEligible(ev)) return null;
  return ev.confirmed_order_amount_minor;
}

/**
 * Merchant net from buyer-charged capture.
 * Captured already reflects merchant-funded discounts, so those are not subtracted again.
 * Sponsor-funded discounts are added back. Missing payment fees stay omitted (not invented).
 */
export function merchantNetRevenueMinor(ev: EvaluationEvidenceSnapshot | null | undefined): number | null {
  const gross = capturedRevenueMinor(ev);
  if (gross == null || !ev) return null;
  const fees = ev.payment_fee_minor ?? 0;
  const fulfillment = ev.fulfillment_cost_minor ?? 0;
  const sponsor = ev.sponsor_funded_discount_minor ?? 0;
  return gross - fees - fulfillment + sponsor;
}

export function firstArmFromSeed(seed: string): "CONTROL" | "TREATMENT" {
  const digest = sha256Hex(seed);
  return Number.parseInt(digest.slice(0, 8), 16) % 2 === 0 ? "CONTROL" : "TREATMENT";
}

export function contributionMarginMinor(ev: EvaluationEvidenceSnapshot | null | undefined): number | null {
  const net = merchantNetRevenueMinor(ev);
  if (net == null || !ev || ev.cogs_minor == null) return null;
  return net - ev.cogs_minor;
}

export function observationPaid(ev: EvaluationEvidenceSnapshot | null | undefined): boolean {
  return capturedRevenueMinor(ev) != null;
}

export function revenueStatus(
  ev: EvaluationEvidenceSnapshot | null | undefined,
  unknown: boolean,
  opts?: { knownNoPurchase?: boolean },
): RevenueStatus {
  if (unknown) return "OUTCOME_UNKNOWN";
  if (ev?.payment_attempt_state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (opts?.knownNoPurchase && !present(ev?.payment_attempt_id ?? null)) return "KNOWN_NO_PURCHASE";
  if (!ev) return "REVENUE_UNAVAILABLE";
  if (!revenueEligible(ev)) return "REVENUE_UNAVAILABLE";
  if ((ev.confirmed_order_amount_minor ?? 0) === 0) return "ZERO_CONFIRMED_REVENUE";
  return "CONFIRMED_REVENUE";
}

export function evidenceContradiction(
  ev: EvaluationEvidenceSnapshot | null | undefined,
  paid: boolean,
  status: RevenueStatus,
): string | null {
  if (status === "CONFIRMED_REVENUE") {
    if (!paid) return "CONFIRMED_REVENUE with paid=false";
    if (!ev) return "CONFIRMED_REVENUE without evidence snapshot";
    if ((ev.confirmed_order_amount_minor ?? 0) <= 0) return "CONFIRMED_REVENUE with non-positive captured revenue";
    if (!present(ev.provider_payment_id)) return "CONFIRMED_REVENUE without provider payment ID";
    if (!present(ev.provider_order_id)) return "CONFIRMED_REVENUE without provider order ID";
    if (!present(ev.authenticated_provider_event_ref)) return "CONFIRMED_REVENUE without authenticated provider event";
    if (!present(ev.provider_fetch_ref)) return "CONFIRMED_REVENUE without provider fetch reference";
    if (!ev.core_order_confirmed && ev.merchant_order_state !== "CONFIRMED" && ev.merchant_order_state !== "ORDER_CONFIRMED") {
      return "CONFIRMED_REVENUE without Core order confirmation";
    }
    if (!revenueEligible(ev)) return "CONFIRMED_REVENUE without complete provider and Core evidence";
  }
  if (status === "OUTCOME_UNKNOWN" && paid) return "OUTCOME_UNKNOWN with paid=true";
  if (status === "KNOWN_NO_PURCHASE" && (paid || (ev?.confirmed_order_amount_minor ?? 0) > 0)) {
    return "KNOWN_NO_PURCHASE with captured revenue";
  }
  if (paid && status !== "CONFIRMED_REVENUE" && status !== "ZERO_CONFIRMED_REVENUE") {
    return "paid=true without confirmed revenue status";
  }
  return null;
}

export function allowlistDigest(ids: string[]): string {
  return sha256Hex(JSON.stringify([...ids].sort()));
}

export async function fetchAtlasEvidence(opts: {
  atlasOrigin: string;
  hostBearer: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<EvaluationEvidenceSnapshot | null> {
  const url = new URL("/eval/v1/evidence", opts.atlasOrigin);
  url.searchParams.set("session_id", opts.sessionId);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${opts.hostBearer}`, accept: "application/json" },
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const raw = (await res.json()) as EvaluationEvidenceSnapshot & {
    authenticated_provider_event_reference?: string | null;
    provider_fetch_reference?: string | null;
  };
  return mergeEvidence(emptyEvidence(), {
    ...raw,
    authenticated_provider_event_ref:
      raw.authenticated_provider_event_ref ?? raw.authenticated_provider_event_reference ?? null,
    provider_fetch_ref: raw.provider_fetch_ref ?? raw.provider_fetch_reference ?? null,
  });
}

export function originFromMcp(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  return `${u.protocol}//${u.host}`;
}

export function completeEvidence(overrides: Partial<EvaluationEvidenceSnapshot> = {}): EvaluationEvidenceSnapshot {
  return mergeEvidence(emptyEvidence(), {
    merchant_order_id: "ord_qm_1",
    payment_attempt_id: "pat_qm_1",
    provider_order_id: "order_rzp_1",
    provider_payment_id: "pay_rzp_1",
    confirmed_order_amount_minor: 15462,
    currency: "INR",
    merchant_order_state: "CONFIRMED",
    payment_attempt_state: "CAPTURED_RECONCILED",
    authenticated_provider_event_ref: "evt_qm_1",
    provider_fetch_ref: "recon_qm_1",
    event_binding_status: "BOUND",
    provider_fetch_match_status: "MATCH",
    attribution_id: "attr_qm_1",
    fixture_snapshot_id: "fix_quickmart_v1",
    fixture_digest: "digest_fix",
    core_order_confirmed: true,
    merchandise_minor: 15462,
    merchant_funded_discount_minor: 0,
    sponsor_funded_discount_minor: 0,
    fulfillment_cost_minor: 0,
    cogs_minor: 8000,
    units: 2,
    ...overrides,
  });
}
