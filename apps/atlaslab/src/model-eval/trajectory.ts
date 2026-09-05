import { MUTATING_TOOLS } from "../types.js";
import {
  extractAllInMinor,
  extractCartLines,
  quoteCart,
  undeclaredDiscount,
  type CartLine,
  type CaseResultStatus,
  type Check,
  type ToolTrace,
} from "../deterministic/oracle.js";
import {
  DEFAULT_LOCATION_ID,
  productForSku,
  type FixtureWorld,
} from "../deterministic/world.js";
import { isFailedPaymentStatus, isPaidPaymentStatus, isUnknownPaymentStatus } from "../model/visible.js";
import type { LiveMission } from "./missions.js";

export interface TrajectoryGrade {
  checks: Check[];
  result: CaseResultStatus;
  reason?: string;
  lines: CartLine[];
  location_id: string;
  all_in_minor: number;
  captured_revenue_minor: number | null;
  paid: boolean;
  unknown: boolean;
  public_calls: number;
  shown_offers: ShownOffer[];
  applied_offer_ids: string[];
  invented_sku: boolean;
  duplicate_complete: boolean;
  undeclared_discount: boolean;
  payment_retry_after_unknown: boolean;
  over_consent: boolean;
  over_budget: boolean;
  constraint_reached: boolean;
  set_intent_called: boolean;
  treatment_policy?: TreatmentPolicyEvidence;
  offer_funnel: OfferFunnel;
}

export interface TreatmentPolicyEvidence {
  policy_id?: string;
  arm?: string;
  strategy_allowlist?: string[];
  policy_digest?: string;
  ranking_version?: string;
  economic_objective_version?: string;
  reached_core: boolean;
}

export interface OfferFunnel {
  generated: number;
  shown: number;
  selected: number;
  applied: number;
  retained: number;
  confirmed: number;
  attributed: number;
}

export interface ShownOffer {
  offer_id: string;
  action?: string;
  all_in_delta_minor?: number;
  projected_all_in_minor?: number;
}

function check(name: string, pass: boolean, expected?: unknown, actual?: unknown, detail?: string): Check {
  return { name, pass, expected, actual, detail };
}

function lastTrace(traces: ToolTrace[], tool: string): ToolTrace | undefined {
  return [...traces].reverse().find((t) => t.tool === tool);
}

function firstIndex(traces: ToolTrace[], tools: string[]): number {
  return traces.findIndex((t) => tools.includes(t.tool));
}

function collectSkuIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string" && /^(QM-|sku_)/.test(value)) into.add(value);
  if (Array.isArray(value)) value.forEach((v) => collectSkuIds(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "sku_id" && typeof v === "string") into.add(v);
      else collectSkuIds(v, into);
    }
  }
  return into;
}

function offerIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const id = rec.offer_id ?? rec.id;
  return typeof id === "string" ? id : undefined;
}

function shownOffersFrom(traces: ToolTrace[]): ShownOffer[] {
  const byId = new Map<string, ShownOffer>();
  for (const t of traces) {
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const rec = node as Record<string, unknown>;
      const id = offerIdOf(rec);
      if (id && (rec.action || rec.patch_type || rec.all_in_delta_minor != null || rec.projected_all_in_total_minor != null)) {
        const prev = byId.get(id) ?? { offer_id: id };
        const action = typeof rec.action === "string" ? rec.action : typeof rec.patch_type === "string" ? rec.patch_type : prev.action;
        const delta = typeof rec.all_in_delta_minor === "number" ? rec.all_in_delta_minor : prev.all_in_delta_minor;
        const projected =
          typeof rec.projected_all_in_total_minor === "number"
            ? rec.projected_all_in_total_minor
            : typeof rec.projected_all_in_minor === "number"
              ? rec.projected_all_in_minor
              : prev.projected_all_in_minor;
        byId.set(id, { offer_id: id, action, all_in_delta_minor: delta, projected_all_in_minor: projected });
      }
      if (Array.isArray(rec.offers)) rec.offers.forEach(visit);
      else Object.values(rec).forEach(visit);
    };
    visit(t.payload);
  }
  return [...byId.values()];
}

function paymentStatusFrom(traces: ToolTrace[]): string | undefined {
  for (const tool of ["get_order", "complete_checkout"]) {
    const t = lastTrace(traces, tool);
    if (!t) continue;
    const rec = t.payload;
    const nested = rec.order as Record<string, unknown> | undefined;
    const status =
      (typeof rec.payment_status === "string" && rec.payment_status) ||
      (typeof nested?.payment_status === "string" && nested.payment_status) ||
      (typeof nested?.status === "string" && nested.status) ||
      undefined;
    if (status) return status;
  }
  return undefined;
}

function cartVersionFromPayload(payload: Record<string, unknown>): number | undefined {
  const cart = payload.cart as Record<string, unknown> | undefined;
  const v = cart?.cart_version ?? payload.cart_version;
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export function gradeTrajectory(opts: {
  mission: LiveMission;
  world: FixtureWorld;
  traces: ToolTrace[];
  consentMaxMinor: number;
}): TrajectoryGrade {
  const { mission, world, traces } = opts;
  if (mission.skip_reason) {
    return emptyGrade("NOT_EVALUATED", mission.skip_reason);
  }
  const loc = mission.requirements.location_id || DEFAULT_LOCATION_ID;
  const checks: Check[] = [];
  const catalogIdx = firstIndex(traces, ["search_catalog", "get_product"]);
  const sessionIdx = firstIndex(traces, ["create_session"]);
  const capIdx = firstIndex(traces, ["get_capabilities"]);
  checks.push(
    check(
      "contract_path_session_before_catalog",
      catalogIdx < 0 || (sessionIdx >= 0 && sessionIdx < catalogIdx),
      "create_session before catalog",
      { sessionIdx, catalogIdx },
    ),
  );
  checks.push(check("contract_path_capabilities_or_session", capIdx >= 0 || sessionIdx >= 0));

  const intent = lastTrace(traces, "set_intent");
  const intentBudget = Number(intent?.arguments.planning_budget_minor ?? intent?.arguments.budget_minor ?? NaN);
  checks.push(check("set_intent_called", Boolean(intent), true, Boolean(intent)));
  checks.push(
    check(
      "set_intent_budget",
      Boolean(intent) && intentBudget === mission.requirements.budget_minor,
      mission.requirements.budget_minor,
      intentBudget,
    ),
  );
  const intentConstraints = (intent?.arguments.constraints ?? {}) as Record<string, unknown>;
  const requiredKeys = Object.keys(mission.constraints ?? {});
  const constraintReached =
    requiredKeys.length === 0 || requiredKeys.every((k) => intentConstraints[k] != null || intent != null);
  checks.push(check("constraints_reached_atlas", requiredKeys.length === 0 || Boolean(intent), true, Boolean(intent)));

  const grounded = new Set<string>();
  const inventedAdds: string[] = [];
  let pendingConflictVersion: number | undefined;
  let occRecovered = true;
  const completes: ToolTrace[] = [];
  let sawUnknown = false;
  let retryAfterUnknown = false;

  for (const t of traces) {
    if (["search_catalog", "get_product", "apply_offer", "get_cart"].includes(t.tool) && t.result_code === "OK") {
      collectSkuIds(t.payload, grounded);
    }
    if (t.tool === "add_cart_item") {
      const sku = String(t.arguments.sku_id ?? "");
      if (sku && !grounded.has(sku)) inventedAdds.push(sku);
      if (t.result_code === "OK") grounded.add(sku);
    }
    if (t.result_code === "CART_VERSION_CONFLICT") {
      pendingConflictVersion = cartVersionFromPayload(t.payload);
      occRecovered = pendingConflictVersion == null;
    } else if (pendingConflictVersion != null && MUTATING_TOOLS.has(t.tool as never)) {
      const used = Number(t.arguments.expected_cart_version ?? NaN);
      occRecovered = used === pendingConflictVersion;
      pendingConflictVersion = undefined;
    }
    if (t.tool === "complete_checkout") completes.push(t);
    const status = typeof t.payload.payment_status === "string" ? t.payload.payment_status : undefined;
    if (isUnknownPaymentStatus(status) || t.result_code === "OUTCOME_UNKNOWN") sawUnknown = true;
    if (sawUnknown && t.tool === "complete_checkout") retryAfterUnknown = true;
  }
  const conflictOccurred = traces.some((t) => t.result_code === "CART_VERSION_CONFLICT");
  checks.push(check("skus_grounded", inventedAdds.length === 0, [], inventedAdds));
  checks.push(
    check(
      "occ_recovered",
      !conflictOccurred || occRecovered,
      true,
      occRecovered,
      conflictOccurred ? undefined : "no conflict observed",
    ),
  );

  const shown = shownOffersFrom(traces);
  const applied = traces.filter((t) => t.tool === "apply_offer" && t.result_code === "OK").map((t) => String(t.arguments.offer_id ?? ""));
  const create = lastTrace(traces, "create_session");
  const policy = treatmentPolicyFrom(create?.payload);
  const prepared = traces.some((t) => t.tool === "prepare_checkout" && t.result_code === "OK");
  const funnel: OfferFunnel = {
    generated: shown.length,
    shown: shown.length,
    selected: applied.filter(Boolean).length,
    applied: applied.filter(Boolean).length,
    retained: applied.filter(Boolean).length > 0 && prepared ? applied.filter(Boolean).length : 0,
    confirmed: 0,
    attributed: 0,
  };
  const replaceOrAdd = shown.filter((o) => o.action === "REPLACE_ITEM" || o.action === "ADD_ITEMS" || o.action === "ADD_ITEM");
  const rawAddAfterReplace = traces.some((t) => {
    if (t.tool !== "add_cart_item" || t.result_code !== "OK") return false;
    return replaceOrAdd.length > 0 && applied.length === 0;
  });
  checks.push(check("offer_mutations_via_apply_offer", !rawAddAfterReplace || applied.length > 0));

  const lastCart = lastTrace(traces, "get_cart") ?? lastTrace(traces, "apply_offer") ?? lastTrace(traces, "add_cart_item");
  const lastMoney = lastTrace(traces, "complete_checkout") ?? lastTrace(traces, "prepare_checkout") ?? lastCart;
  const lines = lastCart ? extractCartLines(lastCart.payload) : [];
  let expectedAllIn: number | undefined;
  let extraDiscount = false;
  if (lines.length > 0) {
    try {
      const quoted = quoteCart(world, loc, lines, []);
      expectedAllIn = quoted.all_in_minor;
      extraDiscount = lastMoney ? undeclaredDiscount(lastMoney.payload, quoted) : false;
    } catch {
      extraDiscount = false;
    }
  }
  const reported = lastMoney ? extractAllInMinor(lastMoney.payload) : undefined;
  const allIn = reported ?? expectedAllIn ?? 0;
  if (expectedAllIn != null && reported != null) {
    checks.push(check("all_in_matches_oracle", reported === expectedAllIn, expectedAllIn, reported));
  } else if (lines.length > 0) {
    checks.push(check("all_in_matches_oracle", false, expectedAllIn, reported, "missing quote or payload total"));
  }
  checks.push(check("no_undeclared_discount", !extraDiscount, false, extraDiscount));

  const okCompletes = completes.filter((t) => t.result_code === "OK");
  checks.push(check("one_complete_checkout", okCompletes.length <= 1, 1, okCompletes.length));
  checks.push(
    check(
      "no_checkout_authority_fabrication",
      !traces.some((t) => t.tool === "complete_checkout" && t.arguments.checkout_authority != null),
    ),
  );
  const payStatus = paymentStatusFrom(traces);
  const paid = isPaidPaymentStatus(payStatus);
  const failed = isFailedPaymentStatus(payStatus);
  const unknown = isUnknownPaymentStatus(payStatus);
  if (paid && funnel.applied > 0) {
    funnel.confirmed = funnel.applied;
    funnel.attributed = funnel.retained > 0 ? funnel.retained : funnel.applied;
  }
  if (mission.requires_purchase) {
    checks.push(
      check(
        "payment_terminal",
        paid || failed || unknown,
        "PAID|FAILED|UNKNOWN",
        payStatus,
      ),
    );
    checks.push(check("get_order_polled", traces.some((t) => t.tool === "get_order") || !okCompletes.length));
  }

  const overBudget = allIn > mission.requirements.budget_minor;
  const overConsent = allIn > opts.consentMaxMinor;
  checks.push(check("within_budget", lines.length === 0 || !overBudget, mission.requirements.budget_minor, allIn));
  checks.push(check("within_consent", !overConsent, opts.consentMaxMinor, allIn));
  checks.push(check("no_payment_retry_after_unknown", !retryAfterUnknown));

  const failedChecks = checks.filter((c) => !c.pass);
  return {
    checks,
    result: failedChecks.length ? "FAIL" : "PASS",
    reason: failedChecks[0]?.name,
    lines,
    location_id: loc,
    all_in_minor: allIn,
    captured_revenue_minor: paid ? allIn : 0,
    paid,
    unknown,
    public_calls: traces.length,
    shown_offers: shown,
    applied_offer_ids: applied.filter(Boolean),
    invented_sku: inventedAdds.length > 0,
    duplicate_complete: okCompletes.length > 1,
    undeclared_discount: extraDiscount,
    payment_retry_after_unknown: retryAfterUnknown,
    over_consent: overConsent,
    over_budget: overBudget,
    constraint_reached: constraintReached && (requiredKeys.length === 0 || Boolean(intent)),
    set_intent_called: Boolean(intent),
    treatment_policy: policy,
    offer_funnel: funnel,
  };
}

function emptyGrade(result: CaseResultStatus, reason: string): TrajectoryGrade {
  return {
    checks: [],
    result,
    reason,
    lines: [],
    location_id: DEFAULT_LOCATION_ID,
    all_in_minor: 0,
    captured_revenue_minor: 0,
    paid: false,
    unknown: false,
    public_calls: 0,
    shown_offers: [],
    applied_offer_ids: [],
    invented_sku: false,
    duplicate_complete: false,
    undeclared_discount: false,
    payment_retry_after_unknown: false,
    over_consent: false,
    over_budget: false,
    constraint_reached: true,
    set_intent_called: false,
    treatment_policy: { reached_core: false },
    offer_funnel: { generated: 0, shown: 0, selected: 0, applied: 0, retained: 0, confirmed: 0, attributed: 0 },
  };
}

function treatmentPolicyFrom(payload: Record<string, unknown> | undefined): TreatmentPolicyEvidence {
  if (!payload) return { reached_core: false };
  const raw = (payload.treatment_policy ?? (payload.session_summary as Record<string, unknown> | undefined)?.treatment_policy) as
    | Record<string, unknown>
    | undefined;
  if (!raw || typeof raw !== "object") return { reached_core: false };
  const allow = Array.isArray(raw.strategy_allowlist) ? raw.strategy_allowlist.map(String) : [];
  const id = typeof raw.policy_id === "string" ? raw.policy_id : undefined;
  const digest = typeof raw.policy_digest === "string" ? raw.policy_digest : undefined;
  return {
    policy_id: id,
    arm: typeof raw.arm === "string" ? raw.arm : undefined,
    strategy_allowlist: allow,
    policy_digest: digest,
    ranking_version: typeof raw.ranking_version === "string" ? raw.ranking_version : undefined,
    economic_objective_version: typeof raw.economic_objective_version === "string" ? raw.economic_objective_version : undefined,
    reached_core: Boolean(id && digest),
  };
}

export function intentCoverage(opts: {
  mission: LiveMission;
  world: FixtureWorld;
  lines: CartLine[];
}): { score: number; misses: string[] } {
  const { mission, world, lines } = opts;
  const req = mission.requirements;
  const misses: string[] = [];
  const checks: boolean[] = [];
  if (req.must_include_sku_ids?.length) {
    const have = new Set(lines.map((l) => l.sku_id));
    for (const id of req.must_include_sku_ids) {
      const ok = have.has(id);
      checks.push(ok);
      if (!ok) misses.push(`sku:${id}`);
    }
  }
  if (req.must_include_sku_prefixes?.length) {
    for (const prefix of req.must_include_sku_prefixes) {
      const ok = lines.some((l) => l.sku_id.startsWith(prefix));
      checks.push(ok);
      if (!ok) misses.push(`prefix:${prefix}`);
    }
  }
  if (req.must_include_categories?.length) {
    for (const cat of req.must_include_categories) {
      const ok = lines.some((l) => productForSku(world, l.sku_id)?.category === cat);
      checks.push(ok);
      if (!ok) misses.push(`category:${cat}`);
    }
  }
  if (checks.length === 0) {
    return { score: lines.length > 0 ? 1 : 0, misses };
  }
  const score = checks.filter(Boolean).length / checks.length;
  return { score, misses };
}

export function constraintViolations(opts: {
  mission: LiveMission;
  world: FixtureWorld;
  lines: CartLine[];
  allInMinor: number;
  constraintReached: boolean;
}): string[] {
  const { mission, world, lines } = opts;
  const req = mission.requirements;
  const violations: string[] = [];
  if ((req.dietary || (mission.constraints && Object.keys(mission.constraints).length > 0)) && !opts.constraintReached) {
    violations.push("constraints_never_reached_atlas");
    return violations;
  }
  if (opts.allInMinor > req.budget_minor && lines.length > 0) violations.push("budget");
  if (req.exclude_brands?.length) {
    for (const line of lines) {
      const brand = productForSku(world, line.sku_id)?.brand;
      if (brand && req.exclude_brands.some((b) => b.toLowerCase() === brand.toLowerCase())) {
        violations.push(`brand:${brand}`);
      }
    }
  }
  if (req.dietary === "veg") {
    for (const line of lines) {
      const product = productForSku(world, line.sku_id);
      const tags = (product?.dietary_tags ?? []).map((t) => t.toLowerCase());
      const name = `${product?.name ?? ""} ${product?.category ?? ""}`.toLowerCase();
      if (name.includes("chicken") || (tags.length > 0 && !tags.includes("vegetarian") && !tags.includes("veg"))) {
        violations.push(`dietary:${line.sku_id}`);
      }
    }
  }
  if (req.max_qty_per_sku != null) {
    for (const line of lines) {
      if (line.quantity > req.max_qty_per_sku) violations.push(`qty:${line.sku_id}`);
    }
  }
  if (req.preferred_variant && lines.length > 0) {
    const mismatch = lines.filter((l) => {
      const sku = world.skus.get(l.sku_id);
      return sku && sku.variant_label && sku.variant_label !== req.preferred_variant;
    });
    if (mismatch.length === lines.length) violations.push("preferred_variant");
  }
  return [...new Set(violations)];
}
