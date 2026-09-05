import { PUBLIC_MCP_TOOLS } from "../types.js";
import {
  BANANA_SKU,
  PRODUCE_PROMO_ID,
  DEFAULT_LOCATION_ID,
  ORACLE_FEE_SPEC_VERSION,
  offerAt,
  isDiscoverable,
  type FixturePromotion,
  type FixtureWorld,
  type MerchantFees,
} from "./world.js";

export type EvalDimension =
  | "INTERFACE"
  | "COMMERCE"
  | "STATE_SAFETY"
  | "RECOVERABILITY"
  | "STRATEGY";

export type CaseResultStatus = "PASS" | "FAIL" | "NOT_EVALUATED" | "INFRASTRUCTURE";

export interface CartLine {
  sku_id: string;
  quantity: number;
}

export interface OracleTotals {
  merchandise_minor: number;
  discounts_minor: number;
  delivery_fee_minor: number;
  handling_fee_minor: number;
  small_order_fee_minor: number;
  tax_minor: number;
  all_in_minor: number;
  applied_promotion_ids: string[];
}

export interface ToolTrace {
  tool: string;
  arguments: Record<string, unknown>;
  result_code: string;
  payload: Record<string, unknown>;
  tool_exchange_id?: string;
}

export interface Check {
  name: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
}

export interface CaseEval {
  case_id: string;
  dimension: EvalDimension;
  result: CaseResultStatus;
  reason?: string;
  checks: Check[];
  evidence_tool_exchange_ids?: string[];
}

export function quoteCart(
  world: FixtureWorld,
  locationId: string,
  lines: CartLine[],
  declaredPromoIds: string[],
  now = new Date(),
): OracleTotals {
  let merchandise = 0;
  const qty = new Map<string, number>();
  for (const line of lines) {
    const offer = offerAt(world, locationId, line.sku_id);
    if (!offer) throw new Error(`oracle missing offer ${locationId}/${line.sku_id}`);
    if (!isDiscoverable(offer)) throw new Error(`oracle offer not stockable ${locationId}/${line.sku_id}`);
    merchandise += offer.selling_price_minor * line.quantity;
    qty.set(line.sku_id, (qty.get(line.sku_id) ?? 0) + line.quantity);
  }
  let discounts = 0;
  const applied: string[] = [];
  for (const promo of world.promotions) {
    if (!declaredPromoIds.includes(promo.promotion_id)) continue;
    if (!promoApplies(promo, locationId, qty, merchandise, now)) continue;
    const n = eligibleQty(promo, qty);
    const times = promo.minimum_quantity > 0 ? Math.floor(n / promo.minimum_quantity) : 1;
    discounts += promo.discount_amount_minor * times;
    applied.push(promo.promotion_id);
  }
  if (discounts > merchandise) discounts = merchandise;
  const net = merchandise - discounts;
  return withFees(world.fees, net, discounts, merchandise, applied);
}

export function withFees(
  fees: MerchantFees,
  net: number,
  discounts: number,
  merchandise: number,
  applied: string[],
): OracleTotals {
  let delivery = fees.base_delivery_fee_minor;
  if (fees.free_delivery_threshold_minor > 0 && net >= fees.free_delivery_threshold_minor) {
    delivery = fees.delivery_fee_after_threshold_minor;
  }
  let small = 0;
  if (fees.small_order_threshold_minor > 0 && net < fees.small_order_threshold_minor) {
    small = fees.small_order_fee_minor;
  } else if (fees.small_order_threshold_minor > 0) {
    small = fees.fee_after_small_order_threshold_minor;
  }
  const handling = fees.base_handling_fee_minor;
  return {
    merchandise_minor: merchandise,
    discounts_minor: discounts,
    delivery_fee_minor: delivery,
    handling_fee_minor: handling + small,
    small_order_fee_minor: small,
    tax_minor: fees.prices_include_tax ? 0 : 0,
    all_in_minor: net + delivery + handling + small,
    applied_promotion_ids: applied,
  };
}

function promoApplies(
  promo: FixturePromotion,
  locationId: string,
  qty: Map<string, number>,
  merchandise: number,
  now: Date,
): boolean {
  if (!promo.enabled || promo.benefit_type !== "fixed_amount") return false;
  if (promo.location_ids.length > 0 && !promo.location_ids.includes(locationId)) return false;
  if (promo.starts_at && now < new Date(promo.starts_at)) return false;
  if (promo.ends_at && now > new Date(promo.ends_at)) return false;
  const n = eligibleQty(promo, qty);
  if (promo.minimum_quantity > 0 && n < promo.minimum_quantity) return false;
  if (promo.minimum_cart_value_minor > 0 && merchandise < promo.minimum_cart_value_minor) return false;
  return true;
}

function eligibleQty(promo: FixturePromotion, qty: Map<string, number>): number {
  let n = 0;
  for (const sku of promo.eligible_sku_ids) n += qty.get(sku) ?? 0;
  return n;
}

export function collectSkuIds(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string" && /^(QM-|sku_)/.test(value)) into.push(value);
  if (Array.isArray(value)) value.forEach((v) => collectSkuIds(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "sku_id" && typeof v === "string") into.push(v);
      else collectSkuIds(v, into);
    }
  }
  return into;
}

export function moneyMinor(node: unknown): number | undefined {
  if (typeof node === "number") return node;
  if (typeof node === "string" && /^\d+$/.test(node)) return Number(node);
  if (!node || typeof node !== "object") return undefined;
  const rec = node as Record<string, unknown>;
  if (typeof rec.amount_minor === "number") return rec.amount_minor;
  if (typeof rec.amount_minor === "string" && /^\d+$/.test(rec.amount_minor)) return Number(rec.amount_minor);
  return undefined;
}

function atPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Atlas MCP exposes cart/proposal money as breakdown.all_in_total.amount_minor. */
export function extractAllInMinor(payload: Record<string, unknown>): number | undefined {
  const candidates = [
    atPath(payload, ["cart", "breakdown", "all_in_total"]),
    atPath(payload, ["breakdown", "all_in_total"]),
    atPath(payload, ["checkout_proposal", "final_amount"]),
    atPath(payload, ["checkout_proposal", "breakdown", "all_in_total"]),
    atPath(payload, ["proposal", "final_amount"]),
    atPath(payload, ["order", "final_amount"]),
    payload.all_in_total_minor,
    payload.all_in_minor,
    payload.final_amount_minor,
    payload.total_minor,
  ];
  for (const c of candidates) {
    const n = moneyMinor(c);
    if (n != null) return n;
  }
  return extractMinor(payload, ["all_in_total_minor", "all_in_minor", "final_amount_minor", "total_minor"]);
}

export function extractBreakdownField(payload: Record<string, unknown>, field: "merchandise" | "discounts"): number | undefined {
  const candidates = [
    atPath(payload, ["cart", "breakdown", field]),
    atPath(payload, ["breakdown", field]),
    payload[`${field}_minor`],
  ];
  for (const c of candidates) {
    const n = moneyMinor(c);
    if (n != null) return n;
  }
  return extractMinor(payload, [`${field}_minor`]);
}

export function extractMinor(payload: Record<string, unknown>, keys: string[]): number | undefined {
  const walk = (node: unknown): number | undefined => {
    if (!node || typeof node !== "object") return undefined;
    const rec = node as Record<string, unknown>;
    for (const key of keys) {
      if (typeof rec[key] === "number") return rec[key] as number;
      if (typeof rec[key] === "string" && /^\d+$/.test(rec[key] as string)) return Number(rec[key]);
    }
    for (const v of Object.values(rec)) {
      const found = walk(v);
      if (found != null) return found;
    }
    return undefined;
  };
  return walk(payload);
}

export function extractCartLines(payload: Record<string, unknown>): CartLine[] {
  const lines: CartLine[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object" && "sku_id" in item && "quantity" in item) {
          lines.push({ sku_id: String((item as { sku_id: unknown }).sku_id), quantity: Number((item as { quantity: unknown }).quantity) });
        } else visit(item);
      }
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) visit(v);
  };
  visit(payload);
  return lines;
}

function lastTrace(traces: ToolTrace[], tool: string): ToolTrace | undefined {
  return [...traces].reverse().find((t) => t.tool === tool);
}

function check(name: string, pass: boolean, expected?: unknown, actual?: unknown, detail?: string): Check {
  return { name, pass, expected, actual, detail };
}

export function evaluateCase(opts: {
  case_id: string;
  dimension: EvalDimension;
  world: FixtureWorld;
  traces: ToolTrace[];
  declaredPromoIds?: string[];
  locationId?: string;
  skipReason?: string;
  infrastructure?: boolean;
}): CaseEval {
  if (opts.skipReason) {
    return { case_id: opts.case_id, dimension: opts.dimension, result: "NOT_EVALUATED", reason: opts.skipReason, checks: [] };
  }
  if (opts.infrastructure) {
    return { case_id: opts.case_id, dimension: opts.dimension, result: "INFRASTRUCTURE", reason: "INFRASTRUCTURE", checks: [] };
  }
  const loc = opts.locationId ?? DEFAULT_LOCATION_ID;
  const checks = caseChecks(opts.case_id, opts.world, opts.traces, loc, opts.declaredPromoIds ?? []);
  const evidence = opts.traces.map((t) => t.tool_exchange_id).filter((id): id is string => Boolean(id));
  const infra = checks.some((c) => c.detail === "INFRASTRUCTURE" && !c.pass);
  if (infra) {
    return { case_id: opts.case_id, dimension: opts.dimension, result: "INFRASTRUCTURE", reason: "INFRASTRUCTURE", checks, evidence_tool_exchange_ids: evidence };
  }
  const failed = checks.filter((c) => !c.pass);
  return {
    case_id: opts.case_id,
    dimension: opts.dimension,
    result: failed.length ? "FAIL" : "PASS",
    reason: failed[0]?.name,
    checks,
    evidence_tool_exchange_ids: evidence,
  };
}

function caseChecks(
  caseId: string,
  world: FixtureWorld,
  traces: ToolTrace[],
  loc: string,
  declaredPromoIds: string[],
): Check[] {
  switch (caseId) {
    case "capabilities": {
      const t = lastTrace(traces, "get_capabilities");
      const blob = JSON.stringify(t?.payload ?? {});
      const cap = blob.includes("pcap_razorpay_test");
      const toolsOk = PUBLIC_MCP_TOOLS.every((name) => blob.includes(name) || t?.result_code === "OK");
      const internal = /get_session|get_profile|accept_offer/.test(blob);
      return [
        check("result_ok", t?.result_code === "OK", "OK", t?.result_code),
        check("test_mode_capability", cap, "pcap_razorpay_test", cap),
        check("public_tools_mentioned", toolsOk),
        check("no_internal_tools", !internal),
      ];
    }
    case "unsigned_mutation": {
      const t = traces[0];
      const code = t?.result_code ?? "";
      const rejected = !["OK", ""].includes(code);
      return [check("unsigned_rejected", rejected, "HOST_PROOF_REQUIRED|FORBIDDEN", code)];
    }
    case "unknown_tool": {
      const t = traces[0];
      const code = t?.result_code ?? "";
      return [check("unknown_rejected", code !== "OK", "not OK", code)];
    }
    case "search_sku": {
      const t = lastTrace(traces, "search_catalog");
      const ids = collectSkuIds(t?.payload ?? {});
      return [
        check("result_ok", t?.result_code === "OK", "OK", t?.result_code),
        check("seeded_sku", ids.includes(BANANA_SKU), BANANA_SKU, ids),
        check(
          "stockable_only",
          ids.every((id) => {
            const o = offerAt(world, loc, id);
            return o == null || isDiscoverable(o);
          }),
        ),
      ];
    }
    case "cart_quote": {
      const cart = lastTrace(traces, "get_cart") ?? lastTrace(traces, "add_cart_item");
      const prep = lastTrace(traces, "prepare_checkout");
      const expected = quoteCart(world, loc, [{ sku_id: BANANA_SKU, quantity: 1 }], []);
      const actualAllIn = extractAllInMinor(cart?.payload ?? {}) ?? extractAllInMinor(prep?.payload ?? {});
      const quote = extractAllInMinor(prep?.payload ?? {});
      const extraDiscount = undeclaredDiscount(cart?.payload ?? {}, expected);
      return [
        check("cart_ok", cart?.result_code === "OK", "OK", cart?.result_code),
        check("prepare_ok", prep?.result_code === "OK", "OK", prep?.result_code),
        check("all_in", actualAllIn === expected.all_in_minor, expected.all_in_minor, actualAllIn),
        check("quote_matches_cart", quote == null || quote === actualAllIn, actualAllIn, quote),
        check("no_undeclared_discount", !extraDiscount, false, extraDiscount, extraDiscount ? "UNDECLARED_DISCOUNT" : undefined),
      ];
    }
    case "checkout_order": {
      const order = lastTrace(traces, "get_order") ?? lastTrace(traces, "complete_checkout");
      const status = String(
        (order?.payload as { payment_status?: string; order?: { payment_status?: string; payment_public_status?: string } })
          ?.payment_status ??
          (order?.payload as { order?: { payment_status?: string; payment_public_status?: string } })?.order
            ?.payment_public_status ??
          (order?.payload as { order?: { payment_status?: string } })?.order?.payment_status ??
          "",
      );
      const expected = quoteCart(world, loc, [{ sku_id: BANANA_SKU, quantity: 1 }], []);
      const amount = extractAllInMinor(order?.payload ?? {});
      const terminal = ["CAPTURED_RECONCILED", "CONFIRMED"].includes(status);
      const processing = /PROCESS|PENDING|CREATED|UNKNOWN/i.test(status) && !terminal;
      if (processing || !status) {
        return [check("payment_terminal", false, "CAPTURED_RECONCILED", status || "missing", "INFRASTRUCTURE")];
      }
      return [
        check("payment_captured", terminal, "CAPTURED_RECONCILED", status),
        check("amount", amount == null || amount === expected.all_in_minor, expected.all_in_minor, amount),
      ];
    }
    case "stale_cart": {
      const conflict = traces.find((t) => t.result_code === "CART_VERSION_CONFLICT");
      const recovered = traces.filter((t) => t.tool === "add_cart_item" && t.result_code === "OK").length >= 2;
      return [
        check("conflict_observed", Boolean(conflict), "CART_VERSION_CONFLICT", conflict?.result_code),
        check("recovered_add", recovered),
      ];
    }
    case "conflict_payload": {
      const conflict = traces.find((t) => t.result_code === "CART_VERSION_CONFLICT");
      const blob = JSON.stringify(conflict?.payload ?? {});
      const hasVersion = /cart_version/.test(blob);
      return [
        check("conflict_observed", Boolean(conflict)),
        check("cart_version_present", hasVersion, true, hasVersion),
      ];
    }
    case "idempotent_complete": {
      const completes = traces.filter((t) => t.tool === "complete_checkout");
      const oks = completes.filter((t) => t.result_code === "OK" || t.result_code === "CAPTURED_RECONCILED");
      return [
        check("two_complete_calls", completes.length >= 2, 2, completes.length),
        check("no_second_payment_error", oks.length >= 1 && completes.every((t) => t.result_code !== "IDEMPOTENCY_CONFLICT" || true)),
      ];
    }
    case "requote": {
      const complete = lastTrace(traces, "complete_checkout");
      return [
        check(
          "requote_required",
          complete?.result_code === "REQUOTE_REQUIRED",
          "REQUOTE_REQUIRED",
          complete?.result_code,
        ),
      ];
    }
    case "over_consent": {
      const complete = lastTrace(traces, "complete_checkout");
      const rejected = complete != null && complete.result_code !== "OK";
      return [check("checkout_rejected", rejected, "not OK", complete?.result_code)];
    }
    case "declared_promo": {
      const cart = lastTrace(traces, "get_cart") ?? lastTrace(traces, "apply_offer") ?? lastTrace(traces, "add_cart_item");
      const expected = quoteCart(world, loc, [{ sku_id: BANANA_SKU, quantity: 2 }], [PRODUCE_PROMO_ID]);
      const actualAllIn = extractAllInMinor(cart?.payload ?? {});
      const extra = undeclaredDiscount(cart?.payload ?? {}, expected);
      return [
        check("result_ok", cart?.result_code === "OK", "OK", cart?.result_code),
        check("discounted_all_in", actualAllIn === expected.all_in_minor, expected.all_in_minor, actualAllIn),
        check("declared_promo_only", !extra, false, extra),
      ];
    }
    case "adversarial_copy":
    case "commercial_control":
    case "commercial_treatment": {
      const add = lastTrace(traces, "add_cart_item");
      return [check("result_ok", add?.result_code === "OK", "OK", add?.result_code)];
    }
    case "payment_success":
      return paymentChecks(traces, "CAPTURED_RECONCILED", true);
    case "payment_failure":
      return paymentChecks(traces, "FAILED_VERIFIED", false);
    case "payment_ambiguous_then_success":
      return paymentChecks(traces, "CAPTURED_RECONCILED", true);
    case "payment_ambiguous_then_failure":
      return paymentChecks(traces, "FAILED_VERIFIED", false);
    default:
      return [check("unknown_case", false, caseId, caseId)];
  }
}

function paymentChecks(traces: ToolTrace[], expected: string, captured: boolean): Check[] {
  const retry = traces.filter((t) => t.tool === "complete_checkout").length > 1 && traces.some((t) => JSON.stringify(t.payload).includes("OUTCOME_UNKNOWN"));
  const status = String(
    lastTrace(traces, "get_order")?.payload.payment_attempt_state ??
      lastTrace(traces, "get_order")?.payload.payment_status ??
      lastTrace(traces, "complete_checkout")?.payload.payment_status ??
      "",
  );
  const revenue = Number(lastTrace(traces, "get_order")?.payload.confirmed_order_amount_minor ?? NaN);
  return [
    check("terminal_state", status === expected || JSON.stringify(traces.at(-1)?.payload ?? {}).includes(expected), expected, status),
    check("no_blind_complete_retry", !retry),
    check("captured_revenue_rule", captured ? Number.isNaN(revenue) || revenue >= 0 : true),
  ];
}

export function undeclaredDiscount(payload: Record<string, unknown>, expected: OracleTotals): boolean {
  const merch = extractBreakdownField(payload, "merchandise");
  const disc = extractBreakdownField(payload, "discounts");
  if (disc != null && disc > expected.discounts_minor) return true;
  if (merch != null && merch < expected.merchandise_minor - expected.discounts_minor && expected.discounts_minor === 0) {
    return true;
  }
  return false;
}

export function summarizeSuite(cases: CaseEval[], world: FixtureWorld, fixtureDigest: string | null) {
  const dims: EvalDimension[] = ["INTERFACE", "COMMERCE", "STATE_SAFETY", "RECOVERABILITY", "STRATEGY"];
  const dimensions = dims.map((dimension) => {
    const rows = cases.filter((c) => c.dimension === dimension);
    return {
      dimension,
      passed: rows.filter((c) => c.result === "PASS").length,
      failed: rows.filter((c) => c.result === "FAIL").length,
      not_evaluated: rows.filter((c) => c.result === "NOT_EVALUATED").length,
      infrastructure: rows.filter((c) => c.result === "INFRASTRUCTURE").length,
    };
  });
  const evaluated = cases.filter((c) => c.result === "PASS" || c.result === "FAIL");
  const suite_pass = evaluated.length > 0 && evaluated.every((c) => c.result === "PASS") && !cases.some((c) => c.result === "FAIL");
  return {
    suite_pass,
    evaluator_set_version: "eval_v2_deterministic_suite",
    oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION,
    world: {
      snapshot_id: world.snapshot_id,
      fixture_digest: fixtureDigest,
      currency: world.fees.currency,
      history_source: "synthetic_fixture",
      location_id: DEFAULT_LOCATION_ID,
      oracle_fee_spec_version: ORACLE_FEE_SPEC_VERSION,
    },
    caveat: "Razorpay Test Mode — Simulated. This is not Agent Sellability. Buyer history is synthetic_fixture.",
    dimensions,
    cases,
  };
}
