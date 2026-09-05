import type { McpCallResult } from "../mcp/client.js";
import { newPrefixedId } from "../ids.js";
import type { LabStore } from "../db/store.js";
import type { PublicState } from "../types.js";
import type { PublicMcpTool } from "../types.js";
import { compactToolSchema } from "../model/tool-schemas.js";

export const DEFAULT_LOCATION_ID = "loc_qm_koramangala";
export const DEFAULT_SERVICEABILITY = "blr_koramangala_5th_block";

function stripSubstitutionFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSubstitutionFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/substitut/i.test(key)) continue;
      out[key] = stripSubstitutionFields(nested);
    }
    return out;
  }
  return value;
}

export function mergePublicState(current: PublicState, patch: PublicState, resultCode: string): PublicState {
  const next: PublicState = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    last_result_code: resultCode,
  };
  if (resultCode === "OUTCOME_UNKNOWN" || patch.outcome_unknown || patch.payment_status === "OUTCOME_UNKNOWN") {
    next.outcome_unknown = true;
    next.effectful_payment_frozen = true;
  }
  if (patch.payment_status && ["CAPTURED_RECONCILED", "FAILED_VERIFIED", "CANCELLED_VERIFIED", "PAYMENT_FAILED_VERIFIED"].includes(patch.payment_status)) {
    next.outcome_unknown = false;
    next.effectful_payment_frozen = false;
  }
  if (patch.sku_names) {
    next.sku_names = { ...(current.sku_names ?? {}), ...patch.sku_names };
  }
  if (resultCode === "CART_VERSION_CONFLICT" && patch.cart_version != null) {
    next.cart_version = patch.cart_version;
  }
  return next;
}

export async function persistProjection(store: LabStore, runId: string, state: PublicState, exchangeId?: string): Promise<void> {
  await store.insertProjection({
    projection_id: newPrefixedId("prj"),
    run_id: runId,
    after_exchange_id: exchangeId ?? null,
    public_state: state,
  });
}

export function resolveArgumentRefs(args: Record<string, unknown> | string, state: PublicState): Record<string, unknown> {
  if (typeof args === "string") {
    return interpolate(args, state) as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = interpolate(v, state);
  }
  return out;
}

function interpolate(value: unknown, state: PublicState): unknown {
  if (typeof value === "string" && value.startsWith("$state.")) {
    const path = value.slice("$state.".length).split(".");
    let cur: unknown = state;
    for (const part of path) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
      else return undefined;
    }
    return cur;
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, state)]));
  }
  return value;
}

function rememberSkuName(names: Record<string, string>, skuId: unknown, name: unknown): void {
  if (typeof skuId === "string" && skuId && typeof name === "string" && name) names[skuId] = name;
}

function skuNamesFromPayload(payload: Record<string, unknown>): Record<string, string> {
  const names: Record<string, string> = {};
  const cart = payload.cart as { lines?: Array<{ sku_id?: unknown; name?: unknown }> } | undefined;
  for (const line of cart?.lines ?? []) rememberSkuName(names, line.sku_id, line.name);
  const items = payload.items;
  if (Array.isArray(items)) {
    for (const raw of items) {
      if (raw && typeof raw === "object") {
        const row = raw as { sku_id?: unknown; name?: unknown };
        rememberSkuName(names, row.sku_id, row.name);
      }
    }
  }
  const product = payload.product as { skus?: Array<{ sku_id?: unknown; name?: unknown }> } | undefined;
  for (const sku of product?.skus ?? []) rememberSkuName(names, sku.sku_id, sku.name);
  const order = (payload.order ?? payload.merchant_order) as
    | { lines?: Array<{ sku_id?: unknown; name?: unknown }> }
    | undefined;
  for (const line of order?.lines ?? []) rememberSkuName(names, line.sku_id, line.name);
  return names;
}

export function publicFactsFromPayload(payload: Record<string, unknown>): PublicState {
  const patch: PublicState = {};
  const session = payload.session_summary as
    | { session_id?: string; session_context_version?: number; cart_id?: string; cart_version?: number; location_id?: string }
    | undefined;
  const cart = payload.cart as
    | {
        cart_id?: string;
        cart_version?: number;
        lines?: Array<{ sku_id: string; quantity: number }>;
        totals?: PublicState["totals"];
        currency?: string;
        breakdown?: {
          merchandise?: { amount_minor?: number | string };
          delivery_fee?: { amount_minor?: number | string };
          all_in_total?: { amount_minor?: number | string };
        };
      }
    | undefined;
  const capabilities = payload.capabilities as
    | { payment?: Record<string, unknown>; contract_version?: string }
    | undefined;
  if (Array.isArray(payload.payment_capabilities)) {
    patch.payment_capabilities = payload.payment_capabilities as Array<Record<string, unknown>>;
  } else if (capabilities?.payment && typeof capabilities.payment === "object") {
    patch.payment_capabilities = [capabilities.payment];
  }
  const envelope = payload.envelope as { contract_version?: string } | undefined;
  const contract =
    (typeof payload.contract_version === "string" && payload.contract_version) ||
    (typeof capabilities?.contract_version === "string" && capabilities.contract_version) ||
    (typeof envelope?.contract_version === "string" && envelope.contract_version) ||
    undefined;
  if (contract) patch.contract_version = contract;
  if (typeof payload.session_id === "string") patch.session_id = payload.session_id;
  if (typeof payload.cart_id === "string") patch.cart_id = payload.cart_id;
  if (typeof payload.location_id === "string") patch.location_id = payload.location_id;
  if (typeof payload.cart_version === "number") patch.cart_version = payload.cart_version;
  if (typeof payload.payment_status === "string") patch.payment_status = payload.payment_status;
  if (typeof payload.merchant_order_id === "string") patch.merchant_order_id = payload.merchant_order_id;
  if (session?.session_context_version != null) patch.session_context_version = Number(session.session_context_version);
  if (session?.session_id && !patch.session_id) patch.session_id = String(session.session_id);
  if ((session?.cart_id || cart?.cart_id) && !patch.cart_id) patch.cart_id = String(session?.cart_id ?? cart?.cart_id);
  if (session?.location_id && !patch.location_id) patch.location_id = String(session.location_id);
  if (session?.cart_version != null || cart?.cart_version != null) {
    patch.cart_version = Number(session?.cart_version ?? cart?.cart_version);
  }
  if (Array.isArray(cart?.lines)) {
    patch.lines = cart.lines.map((line) => ({ sku_id: String(line.sku_id), quantity: Number(line.quantity) }));
  }
  if (cart?.totals) {
    patch.totals = {
      merchandise_minor: Number(cart.totals.merchandise_minor),
      delivery_minor: Number(cart.totals.delivery_minor),
      total_minor: Number(cart.totals.total_minor),
      currency: String(cart.totals.currency),
    };
  } else if (cart?.breakdown) {
    patch.totals = {
      merchandise_minor: Number(cart.breakdown.merchandise?.amount_minor ?? 0),
      delivery_minor: Number(cart.breakdown.delivery_fee?.amount_minor ?? 0),
      total_minor: Number(cart.breakdown.all_in_total?.amount_minor ?? 0),
      currency: String(cart.currency ?? "INR"),
    };
  }
  if (Array.isArray(payload.offers)) patch.offers = payload.offers as Array<Record<string, unknown>>;
  const proposal = (payload.checkout_proposal ?? payload.proposal) as Record<string, unknown> | undefined;
  if (proposal && typeof proposal === "object") {
    const finalAmount = proposal.final_amount as { amount_minor?: number | string; currency?: string } | undefined;
    const proposalBreakdown = proposal.breakdown as
      | { all_in_total?: { amount_minor?: number | string; currency?: string } }
      | undefined;
    patch.checkout_proposal = {
      ...proposal,
      ...(proposal.session_context_version != null ? { session_context_version: Number(proposal.session_context_version) } : {}),
      ...(proposal.cart_version != null ? { cart_version: Number(proposal.cart_version) } : {}),
      ...(
        proposal.final_amount_minor != null || finalAmount?.amount_minor != null || proposalBreakdown?.all_in_total?.amount_minor != null
          ? {
              final_amount_minor: Number(
                proposal.final_amount_minor ?? finalAmount?.amount_minor ?? proposalBreakdown?.all_in_total?.amount_minor,
              ),
            }
          : {}
      ),
      ...(
        proposal.currency != null || finalAmount?.currency != null || proposalBreakdown?.all_in_total?.currency != null
          ? { currency: String(proposal.currency ?? finalAmount?.currency ?? proposalBreakdown?.all_in_total?.currency) }
          : {}
      ),
    };
  }
  const order = (payload.order ?? payload.merchant_order) as Record<string, unknown> | undefined;
  if (order && typeof order === "object") {
    const orderRest = stripSubstitutionFields(order) as Record<string, unknown>;
    patch.order = orderRest;
    if (typeof orderRest.merchant_order_id === "string") patch.merchant_order_id = orderRest.merchant_order_id;
    const publicStatus = String(orderRest.payment_public_status ?? orderRest.status ?? "");
    if (publicStatus === "CONFIRMED" || publicStatus === "CAPTURED_RECONCILED") patch.payment_status = "CAPTURED_RECONCILED";
    else if (publicStatus) patch.payment_status = publicStatus;
  }
  const skuNames = skuNamesFromPayload(payload);
  if (Object.keys(skuNames).length > 0) patch.sku_names = skuNames;
  const publicState = payload.public_state;
  if (publicState && typeof publicState === "object") {
    const overlay = stripSubstitutionFields(
      Object.fromEntries(Object.entries(publicState as PublicState).filter(([, v]) => v !== undefined)),
    ) as PublicState;
    return { ...overlay, ...patch };
  }
  return patch;
}

export function applyResultToState(state: PublicState, result: McpCallResult): PublicState {
  const fromPayload = publicFactsFromPayload(result.payload ?? {});
  // HttpMcpClient exposes Gateway's public_state directly, where protobuf int64
  // values are JSON strings. The normalized projection must win so later Host
  // proofs bind numeric versions exactly as Core reconstructs them.
  return mergePublicState(state, stripSubstitutionFields({ ...result.publicStatePatch, ...fromPayload }) as PublicState, result.resultCode);
}

const CART_ID_TOOLS = new Set([
  "add_cart_item",
  "update_cart_item",
  "remove_cart_item",
  "prepare_checkout",
]);
const CART_VERSION_TOOLS = new Set([
  "add_cart_item",
  "update_cart_item",
  "remove_cart_item",
  "apply_offer",
  "prepare_checkout",
]);
const SESSION_VERSION_TOOLS = new Set([
  "set_intent",
  "apply_offer",
  "prepare_checkout",
]);

export function enrichPublicToolArgs(opts: {
  tool: string;
  args: Record<string, unknown>;
  state: PublicState;
  runId: string;
  mission?: string;
  subjectReference?: string;
  constraints?: Record<string, string>;
}): Record<string, unknown> {
  const args = { ...opts.args };
  if (args.location_id != null && args.requested_location_id == null) {
    args.requested_location_id = args.location_id;
  }
  if (args.delivery_ref != null && args.delivery_serviceability_reference == null) {
    args.delivery_serviceability_reference = args.delivery_ref;
  }
  if (args.budget_minor != null && args.planning_budget_minor == null) {
    args.planning_budget_minor = args.budget_minor;
  }
  if (opts.state.session_id && opts.tool !== "get_capabilities" && opts.tool !== "create_session") {
    args.session_id = opts.state.session_id;
  }
  if (opts.state.cart_id && CART_ID_TOOLS.has(opts.tool)) args.cart_id = opts.state.cart_id;
  if (opts.state.cart_version != null && CART_VERSION_TOOLS.has(opts.tool)) {
    args.expected_cart_version = opts.state.cart_version;
  }
  if (opts.state.session_context_version != null && SESSION_VERSION_TOOLS.has(opts.tool)) {
    args.expected_session_context_version = opts.state.session_context_version;
  }
  if (opts.tool === "complete_checkout" && opts.state.checkout_proposal) {
    delete args.checkout_authority;
    const proposal = opts.state.checkout_proposal as { checkout_proposal_id?: string };
    args.checkout_proposal_id ??= proposal.checkout_proposal_id;
    args.checkout_proposal ??= opts.state.checkout_proposal;
  }
  if (opts.tool === "get_order" && opts.state.merchant_order_id) {
    args.merchant_order_id = opts.state.merchant_order_id;
  }
  if (opts.tool === "create_session") {
    if (args.subject_reference == null) args.subject_reference = opts.subjectReference ?? `lab:${opts.runId}`;
    if (args.locale == null) args.locale = "";
  }
  if (opts.tool === "set_intent") {
    if (args.mission == null && opts.mission) args.mission = opts.mission;
    if (args.mission == null) args.mission = "";
    if (args.planning_budget_minor == null && args.budget_minor != null) args.planning_budget_minor = args.budget_minor;
    if (args.currency === "") delete args.currency;
    if (opts.constraints) {
      const existing =
        args.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)
          ? (args.constraints as Record<string, unknown>)
          : {};
      args.constraints = { ...existing, ...opts.constraints };
    }
  }
  if (opts.tool === "search_catalog") {
    for (const key of ["brand", "category", "cursor"]) {
      if (args[key] === "") delete args[key];
    }
  }
  const schema = compactToolSchema(opts.tool as PublicMcpTool);
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => key in properties));
}
