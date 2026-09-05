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
  };
}

export function mergeEvidence(base: EvaluationEvidenceSnapshot, patch: Partial<EvaluationEvidenceSnapshot>): EvaluationEvidenceSnapshot {
  return { ...base, ...patch, shown_offer_ids: patch.shown_offer_ids ?? base.shown_offer_ids, applied_offer_ids: patch.applied_offer_ids ?? base.applied_offer_ids };
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
    ev.authenticated_provider_event_ref &&
      ev.provider_order_id &&
      ev.payment_attempt_id &&
      ev.merchant_order_id &&
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

export function revenueStatus(ev: EvaluationEvidenceSnapshot | null | undefined, unknown: boolean): RevenueStatus {
  if (unknown) return "OUTCOME_UNKNOWN";
  if (!ev) return "REVENUE_UNAVAILABLE";
  if (ev.payment_attempt_state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (!revenueEligible(ev)) return "REVENUE_UNAVAILABLE";
  if ((ev.confirmed_order_amount_minor ?? 0) === 0) return "ZERO_CONFIRMED_REVENUE";
  return "CONFIRMED_REVENUE";
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
  return {
    ...raw,
    authenticated_provider_event_ref:
      raw.authenticated_provider_event_ref ?? raw.authenticated_provider_event_reference ?? null,
    provider_fetch_ref: raw.provider_fetch_ref ?? raw.provider_fetch_reference ?? null,
  };
}

export function originFromMcp(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  return `${u.protocol}//${u.host}`;
}
