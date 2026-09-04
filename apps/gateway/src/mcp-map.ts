/** Join MCP/admin JSON: proto camelCase -> atlas.merchant.v1 snake_case (ID-505). */

export function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`).replace(/^_/, "");
}

export function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.seconds === "number" && (rec.nanos === undefined || typeof rec.nanos === "number")) {
      const ms = rec.seconds * 1000 + Math.floor(Number(rec.nanos ?? 0) / 1e6);
      return new Date(ms).toISOString();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (v === undefined || v === null || v === "") continue;
      out[snakeKey(k)] = snake(v);
    }
    return out;
  }
  return value;
}

export function publicStateFrom(body: Record<string, unknown>): Record<string, unknown> {
  const session = (body.session_summary as Record<string, unknown>) ?? {};
  const cart = (body.cart as Record<string, unknown>) ?? {};
  const order = (body.order as Record<string, unknown>) ?? (body.merchant_order as Record<string, unknown>) ?? {};
  const proposal = body.checkout_proposal as Record<string, unknown> | undefined;
  const state: Record<string, unknown> = {};
  if (session.session_id) state.session_id = session.session_id;
  if (session.cart_id || cart.cart_id) state.cart_id = session.cart_id ?? cart.cart_id;
  if (session.session_context_version != null) state.session_context_version = session.session_context_version;
  if (session.cart_version != null || cart.cart_version != null) {
    state.cart_version = session.cart_version ?? cart.cart_version;
  }
  if (session.location_id) state.location_id = session.location_id;
  if (proposal) {
    state.checkout_proposal = proposal;
    state.checkout_proposal_id = proposal.checkout_proposal_id;
  }
  if (order && order.merchant_order_id) {
    state.merchant_order_id = order.merchant_order_id;
    const pay = String(order.payment_public_status ?? order.status ?? "");
    if (pay === "CONFIRMED" || pay === "CAPTURED_RECONCILED") {
      state.payment_status = "CAPTURED_RECONCILED";
    } else if (pay) {
      state.payment_status = pay;
    }
    if (pay === "OUTCOME_UNKNOWN") {
      state.outcome_unknown = true;
      state.effectful_payment_frozen = true;
    }
  }
  return state;
}

export function mcpOk(raw: unknown, requestId: string): Record<string, unknown> {
  const body = snake(raw) as Record<string, unknown>;
  const env = (body.envelope as Record<string, unknown>) ?? {};
  if (!Array.isArray(body.offers) || body.offers.length === 0) {
    delete body.offers;
  }
  if (!Array.isArray(body.invalidated_offer_ids) || body.invalidated_offer_ids.length === 0) {
    delete body.invalidated_offer_ids;
  }
  return {
    result_code: "OK",
    request_id: env.request_id || requestId,
    public_state: publicStateFrom(body),
    ...body,
  };
}
