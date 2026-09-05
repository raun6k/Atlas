const MODEL_CAPABILITY_KEYS = [
  "merchant_display_name",
  "currency",
  "locale",
  "max_page_size",
  "offer_ttl_seconds",
  "proposal_hold_ttl_seconds",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toolsForModel(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (name): name is string =>
      typeof name === "string" && name !== "get_capabilities" && !/substitut/i.test(name) && name !== "accept_offer",
  );
}

/** Payment fields the Buyer Model may see. Identity/rail fields stay on Host state. */
export function modelVisiblePayment(payment: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payment) return undefined;
  const out: Record<string, unknown> = {};
  if (payment.completion_mode != null) out.completion_mode = payment.completion_mode;
  if (payment.requires_checkout_proposal != null) out.requires_checkout_proposal = payment.requires_checkout_proposal;
  if (payment.requires_checkout_authority != null) out.requires_checkout_authority = payment.requires_checkout_authority;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function modelVisiblePaymentCapabilities(
  full: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!full?.length) return undefined;
  const slim = full.map((row) => modelVisiblePayment(row)).filter((row): row is Record<string, unknown> => Boolean(row));
  return slim.length > 0 ? slim : undefined;
}

function paymentSource(payload: Record<string, unknown>, capabilities: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = asRecord(capabilities.payment);
  if (nested) return nested;
  const listed = payload.payment_capabilities;
  if (Array.isArray(listed) && listed[0] && typeof listed[0] === "object") {
    return listed[0] as Record<string, unknown>;
  }
  return undefined;
}

function moneyMinor(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  const rec = asRecord(value);
  if (!rec) return undefined;
  return moneyMinor(rec.amount_minor);
}

function versionNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function modelVisibleCartLine(raw: unknown): Record<string, unknown> | undefined {
  const line = asRecord(raw);
  if (!line) return undefined;
  const skuId = stringField(line, "sku_id");
  if (!skuId) return undefined;
  const out: Record<string, unknown> = { sku_id: skuId };
  const lineId = stringField(line, "cart_line_id");
  if (lineId) out.cart_line_id = lineId;
  const name = stringField(line, "name");
  if (name) out.name = name;
  const qty = versionNumber(line.quantity);
  if (qty != null) out.quantity = qty;
  const unit = moneyMinor(line.unit_price) ?? moneyMinor(line.unit_price_minor);
  if (unit != null) out.unit_price_minor = unit;
  const total = moneyMinor(line.line_total) ?? moneyMinor(line.line_total_minor);
  if (total != null) out.line_total_minor = total;
  return out;
}

function modelVisibleBreakdown(cart: Record<string, unknown>): Record<string, number> | undefined {
  const breakdown = asRecord(cart.breakdown) ?? {};
  const out: Record<string, number> = {};
  const merchandise = moneyMinor(breakdown.merchandise) ?? moneyMinor(breakdown.merchandise_minor);
  const discounts = moneyMinor(breakdown.discounts) ?? moneyMinor(breakdown.discounts_minor);
  const delivery = moneyMinor(breakdown.delivery_fee) ?? moneyMinor(breakdown.delivery_fee_minor);
  const handling = moneyMinor(breakdown.handling_fee) ?? moneyMinor(breakdown.handling_fee_minor);
  const tax = moneyMinor(breakdown.tax) ?? moneyMinor(breakdown.tax_minor);
  const allIn =
    moneyMinor(breakdown.all_in_total) ??
    moneyMinor(breakdown.all_in_total_minor) ??
    moneyMinor(cart.final_amount) ??
    moneyMinor(cart.final_amount_minor);
  if (merchandise != null) out.merchandise_minor = merchandise;
  if (discounts != null) out.discounts_minor = discounts;
  if (delivery != null) out.delivery_fee_minor = delivery;
  if (handling != null) out.handling_fee_minor = handling;
  if (tax != null) out.tax_minor = tax;
  if (allIn != null) out.all_in_total_minor = allIn;
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeBreakdown(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  const a = primary ? modelVisibleBreakdown(primary) : undefined;
  const b = fallback ? modelVisibleBreakdown(fallback) : undefined;
  if (!a && !b) return undefined;
  return { ...b, ...a };
}

function modelVisibleProposalLine(
  raw: unknown,
  cart: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const line = modelVisibleCartLine(raw);
  if (!line) return undefined;
  const skuId = String(line.sku_id);
  if (!line.name) {
    const name = skuNameFromCart(cart, skuId);
    if (name) line.name = name;
  }
  delete line.cart_line_id;
  return line;
}

function modelVisibleError(resultCode: string, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { result_code: resultCode };
  if (typeof payload.message === "string") out.message = payload.message;
  const err = asRecord(payload.error);
  if (err && typeof err.message === "string") out.message = err.message;
  return out;
}

function skuNameFromCart(cart: Record<string, unknown> | undefined, skuId: string): string | undefined {
  const lines = cart && Array.isArray(cart.lines) ? cart.lines : [];
  for (const raw of lines) {
    const line = asRecord(raw);
    if (line && String(line.sku_id) === skuId && typeof line.name === "string" && line.name) return line.name;
  }
  return undefined;
}

function patchAction(patch: Record<string, unknown> | undefined, lines: Record<string, unknown>[]): string {
  const type = String(patch?.patch_type ?? patch?.Type ?? "").toUpperCase();
  if (type === "ADD_ITEMS") return "ADD_ITEMS";
  if (type === "REPLACE_ITEM" || type === "ADD_ITEM" || type === "PROMOTION" || type === "BUNDLE") {
    if (type === "ADD_ITEM" && addLines(lines).length > 1) return "ADD_ITEMS";
    return type;
  }
  const op = typeof lines[0]?.op === "string" ? String(lines[0].op).toUpperCase() : "";
  if (op === "REPLACE") return "REPLACE_ITEM";
  if (op === "REMOVE") return "REMOVE";
  if (addLines(lines).length > 1) return "ADD_ITEMS";
  return "ADD_ITEM";
}

function addLines(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => String(line.op ?? "ADD").toUpperCase() !== "REMOVE");
}

function visibleEconomics(offer: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const raw = asRecord(offer.economics) ?? asRecord(patch?.economics);
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  const itemCost = moneyMinor(raw.item_cost_minor);
  const gap = moneyMinor(raw.threshold_gap_minor);
  const saving = moneyMinor(raw.fee_saving_minor);
  if (itemCost != null) out.item_cost_minor = itemCost;
  if (gap != null) out.threshold_gap_minor = gap;
  if (saving != null) out.fee_saving_minor = saving;
  return Object.keys(out).length > 0 ? out : undefined;
}

function catalogNameCart(items: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const lines = items
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row?.sku_id))
    .map((row) => ({ sku_id: row.sku_id, name: row.name }));
  return lines.length > 0 ? { lines } : undefined;
}

/** Catalog hit the Buyer Model may see. Barcode, description, lifecycle, assortment, and sellable qty stay on Host. */
export function modelVisibleCatalogItem(raw: unknown): Record<string, unknown> | undefined {
  const sku = asRecord(raw);
  if (!sku || typeof sku.sku_id !== "string" || !sku.sku_id) return undefined;
  const out: Record<string, unknown> = { sku_id: sku.sku_id };
  if (typeof sku.product_id === "string" && sku.product_id) out.product_id = sku.product_id;
  if (typeof sku.name === "string" && sku.name) out.name = sku.name;
  if (typeof sku.brand === "string" && sku.brand) out.brand = sku.brand;
  if (typeof sku.variant === "string" && sku.variant) out.variant = sku.variant;
  const pack = versionNumber(sku.pack_size ?? sku.pack_quantity);
  if (pack != null) out.pack_quantity = pack;
  const unit = sku.unit_of_measure ?? sku.unit;
  if (typeof unit === "string" && unit) out.unit = unit;
  const price = moneyMinor(sku.selling_price ?? sku.price_minor);
  if (price != null) out.price_minor = price;
  if (typeof sku.stock_status === "string" && sku.stock_status) out.stock_status = sku.stock_status;
  return out;
}

export function modelVisibleCatalogItems(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = raw.map(modelVisibleCatalogItem).filter((row): row is Record<string, unknown> => Boolean(row));
  return out.length > 0 ? out : undefined;
}

function visibleOfferItem(
  line: Record<string, unknown> | undefined,
  cart: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!line) return undefined;
  const skuId = typeof line.sku_id === "string" && line.sku_id ? line.sku_id : typeof line.SKUID === "string" ? line.SKUID : "";
  if (!skuId) return undefined;
  const item: Record<string, unknown> = { sku_id: skuId };
  const name = (typeof line.name === "string" && line.name) || skuNameFromCart(cart, skuId);
  if (name) item.name = name;
  const qty = versionNumber(line.quantity ?? line.Quantity);
  if (qty != null) item.quantity = qty;
  return item;
}

/** Offer card the Buyer Model may see. Patch, strategy, OCC versions, and replaces_sku_id (when a cart line exists) stay on Host state. */
export function modelVisibleOffer(raw: unknown, cart?: Record<string, unknown>): Record<string, unknown> | undefined {
  const offer = asRecord(raw);
  if (!offer || typeof offer.offer_id !== "string") return undefined;
  const patch = asRecord(offer.cart_patch);
  const lines = (patch && Array.isArray(patch.lines) ? patch.lines : [])
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row));
  const added = addLines(lines);
  const primary = added[0] ?? lines[0];
  const out: Record<string, unknown> = { offer_id: offer.offer_id };
  const action = patchAction(patch, lines);
  out.action = action;
  const mapped = added.map((line) => visibleOfferItem(line, cart)).filter((row): row is Record<string, unknown> => Boolean(row));
  if (action === "ADD_ITEMS") {
    if (mapped.length > 0) out.items = mapped;
  } else {
    const item = mapped[0] ?? visibleOfferItem(primary, cart);
    if (item) out.item = item;
  }
  const sourceSku =
    (typeof patch?.source_sku_id === "string" && patch.source_sku_id) ||
    (typeof patch?.SourceSKUID === "string" && patch.SourceSKUID) ||
    "";
  const sourceLine =
    (typeof patch?.source_cart_line_id === "string" && patch.source_cart_line_id) ||
    (typeof patch?.SourceLineID === "string" && patch.SourceLineID) ||
    "";
  if (action === "REPLACE_ITEM" && sourceLine) out.replaces_cart_line_id = sourceLine;
  if (action === "REPLACE_ITEM" && !sourceLine && sourceSku) out.replaces_sku_id = sourceSku;
  if (typeof offer.grounded_reason === "string" && offer.grounded_reason) out.reason = offer.grounded_reason;
  const strategy = String(offer.strategy_type ?? offer.strategy ?? "");
  if (strategy === "BRAND_PROMO" || offer.sponsored === true) out.sponsored = true;
  const economics = visibleEconomics(offer, patch);
  if (economics) out.economics = economics;
  const delta = moneyMinor(offer.buyer_impact);
  if (delta != null) out.all_in_delta_minor = delta;
  const projected = moneyMinor(offer.projected_all_in_total);
  if (projected != null) out.projected_all_in_total_minor = projected;
  if (offer.expires_at != null) out.expires_at = offer.expires_at;
  return out;
}

export function modelVisibleOffers(raw: unknown, cart?: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = raw.map((row) => modelVisibleOffer(row, cart)).filter((row): row is Record<string, unknown> => Boolean(row));
  return out.length > 0 ? out : undefined;
}

/** Model-visible search_catalog body. Host retains envelope, public_state, and full SKU/offer rows. */
export function modelVisibleSearchCatalog(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const out: Record<string, unknown> = { result_code: resultCode };
  const items = modelVisibleCatalogItems(payload.items);
  if (items) out.items = items;
  if (typeof payload.next_cursor === "string" && payload.next_cursor) out.next_cursor = payload.next_cursor;
  const offers = modelVisibleOffers(payload.offers, catalogNameCart(payload.items));
  if (offers) out.offers = offers;
  return out;
}

/** Model-visible set_intent body. Host retains envelope, public_state, cart, and full offer patches. */
export function modelVisibleSetIntent(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const summary = asRecord(payload.session_summary) ?? {};
  const cart = asRecord(payload.cart) ?? {};
  const budget = moneyMinor(summary.planning_budget) ?? moneyMinor(summary.planning_budget_minor);
  const intent: Record<string, unknown> = { budget_scope: "ALL_IN" };
  if (typeof summary.mission === "string") intent.mission = summary.mission;
  if (budget != null) intent.budget_minor = budget;
  if (typeof summary.currency === "string" && summary.currency) intent.currency = summary.currency;
  const breakdown = modelVisibleBreakdown(cart);
  const out: Record<string, unknown> = { result_code: resultCode, intent };
  if (breakdown?.all_in_total_minor != null) out.cart_all_in_total_minor = breakdown.all_in_total_minor;
  const offers = modelVisibleOffers(payload.offers, cart);
  if (offers) out.offers = offers;
  return out;
}

/** Model-visible create_session body. Host retains envelope, public_state, and Money-shaped cart. */
export function modelVisibleCreateSession(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const summary = asRecord(payload.session_summary) ?? {};
  const cart = asRecord(payload.cart) ?? {};
  const session: Record<string, unknown> = {};
  if (typeof summary.session_id === "string") session.session_id = summary.session_id;
  if (typeof summary.status === "string") session.status = summary.status;
  if (typeof summary.location_id === "string") session.location_id = summary.location_id;
  const scv = versionNumber(summary.session_context_version);
  if (scv != null) session.session_context_version = scv;
  const cartOut: Record<string, unknown> = {};
  if (typeof cart.cart_id === "string") cartOut.cart_id = cart.cart_id;
  const cv = versionNumber(cart.cart_version ?? summary.cart_version);
  if (cv != null) cartOut.cart_version = cv;
  if (typeof cart.currency === "string") cartOut.currency = cart.currency;
  cartOut.lines = Array.isArray(cart.lines) ? cart.lines : [];
  const breakdown = modelVisibleBreakdown(cart);
  if (breakdown) cartOut.breakdown = breakdown;
  const out: Record<string, unknown> = { result_code: resultCode };
  if (Object.keys(session).length > 0) out.session = session;
  if (Object.keys(cartOut).length > 0) out.cart = cartOut;
  return out;
}

/** Model-visible cart body. Host retains envelope, public_state, session, OCC versions, and full offer patches. */
export function modelVisibleGetCart(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const cart = asRecord(payload.cart) ?? {};
  const cartOut: Record<string, unknown> = {};
  if (typeof cart.cart_id === "string") cartOut.cart_id = cart.cart_id;
  if (typeof cart.currency === "string") cartOut.currency = cart.currency;
  const lines = (Array.isArray(cart.lines) ? cart.lines : [])
    .map(modelVisibleCartLine)
    .filter((row): row is Record<string, unknown> => Boolean(row));
  cartOut.lines = lines;
  const breakdown = modelVisibleBreakdown(cart);
  if (breakdown) cartOut.breakdown = breakdown;
  return {
    result_code: resultCode,
    cart: cartOut,
    offers: modelVisibleOffers(payload.offers, cart) ?? [],
    invalidated_offer_ids: Array.isArray(payload.invalidated_offer_ids)
      ? payload.invalidated_offer_ids.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
  };
}

/** Model-visible apply_offer body. Host retains envelope, public_state, patches, and regenerated offers. */
export function modelVisibleApplyOffer(
  payload: Record<string, unknown>,
  resultCode: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const cartBody = modelVisibleGetCart(payload, resultCode);
  const applied =
    (typeof args.offer_id === "string" && args.offer_id) ||
    (typeof payload.applied_offer_id === "string" && payload.applied_offer_id) ||
    "";
  const out: Record<string, unknown> = {};
  if (applied) out.applied_offer_id = applied;
  out.cart = cartBody.cart;
  return out;
}

/** Model-visible get_capabilities body. Host retains the full MCP payload on the exchange. */
export function modelVisibleGetCapabilities(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  const capabilities = asRecord(payload.capabilities) ?? payload;
  const out: Record<string, unknown> = { result_code: resultCode };
  for (const key of MODEL_CAPABILITY_KEYS) {
    if (capabilities[key] != null) out[key] = capabilities[key];
  }
  const tools = toolsForModel(capabilities.tools ?? payload.tools);
  if (tools) out.tools = tools;
  const payment = modelVisiblePayment(paymentSource(payload, capabilities));
  if (payment) out.payment = payment;
  return out;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function dietaryList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((row): row is string => typeof row === "string" && row !== "");
  return out.length > 0 ? out : undefined;
}

/** SKU card the Buyer Model may see. Lifecycle, barcode, assortment, and Money objects stay on Host state. */
export function modelVisibleSku(raw: unknown): Record<string, unknown> | undefined {
  const sku = asRecord(raw);
  if (!sku) return undefined;
  const skuId = stringField(sku, "sku_id");
  if (!skuId) return undefined;
  const out: Record<string, unknown> = { sku_id: skuId };
  const variant = stringField(sku, "variant");
  if (variant) out.variant = variant;
  const packSize = versionNumber(sku.pack_size);
  if (packSize != null) out.pack_size = packSize;
  const unit = stringField(sku, "unit_of_measure", "unit");
  if (unit) out.unit = unit;
  const price = moneyMinor(sku.selling_price) ?? moneyMinor(sku.price_minor);
  if (price != null) out.price_minor = price;
  const sellable = versionNumber(sku.sellable_quantity ?? sku.sellable);
  if (sellable != null) out.sellable = sellable;
  return out;
}

/** Model-visible prepare_checkout body. Host retains quote_hash, capability, OCC, envelope, and public_state. */
export function modelVisiblePrepareCheckout(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const proposal = asRecord(payload.checkout_proposal) ?? asRecord(payload.proposal) ?? {};
  const cart = asRecord(payload.cart) ?? {};
  const outProposal: Record<string, unknown> = {};
  const proposalId = stringField(proposal, "checkout_proposal_id");
  if (proposalId) outProposal.checkout_proposal_id = proposalId;
  const currency =
    stringField(proposal, "currency") ||
    stringField(asRecord(proposal.final_amount) ?? {}, "currency") ||
    stringField(cart, "currency");
  if (currency) outProposal.currency = currency;
  const sourceLines = Array.isArray(proposal.lines) && proposal.lines.length > 0 ? proposal.lines : cart.lines;
  const lines = (Array.isArray(sourceLines) ? sourceLines : [])
    .map((row) => modelVisibleProposalLine(row, cart))
    .filter((row): row is Record<string, unknown> => Boolean(row));
  outProposal.lines = lines;
  const breakdown = mergeBreakdown(cart, proposal);
  if (breakdown) outProposal.breakdown = breakdown;
  const expiresAt =
    proposal.expires_at ?? proposal.hold_expires_at ?? proposal.proposal_expires_at ?? payload.hold_expires_at;
  if (expiresAt != null) outProposal.expires_at = expiresAt;
  const out: Record<string, unknown> = { result_code: resultCode };
  if (Object.keys(outProposal).length > 0) out.checkout_proposal = outProposal;
  return out;
}

/** Host payment strings mapped for the Buyer Model. Atlas/public_state keep the rail values. */
export function modelVisiblePaymentStatus(raw: unknown): string | undefined {
  const status = typeof raw === "string" ? raw : "";
  if (!status) return undefined;
  if (status === "CAPTURED_RECONCILED" || status === "CONFIRMED") return "PAID";
  if (status === "FAILED_VERIFIED" || status === "CANCELLED_VERIFIED") return "FAILED";
  if (status === "OUTCOME_UNKNOWN") return "UNKNOWN";
  if (status === "PAYMENT_PROCESSING" || status === "PENDING_PAYMENT") return "PROCESSING";
  return status;
}

export function modelVisibleOrderNextAction(paymentStatus: string | undefined): string {
  if (paymentStatus === "UNKNOWN") return "WAIT";
  if (paymentStatus === "PROCESSING") return "POLL_ORDER";
  if (paymentStatus === "PAID" || paymentStatus === "FAILED") return "DONE";
  return "POLL_ORDER";
}

function applySkuNames(line: Record<string, unknown> | undefined, skuNames: Record<string, string>): Record<string, unknown> | undefined {
  if (!line) return undefined;
  const skuId = String(line.sku_id ?? "");
  if (!line.name && skuId && skuNames[skuId]) line.name = skuNames[skuId];
  return line;
}

function modelVisibleOrderLine(
  raw: unknown,
  cart: Record<string, unknown> | undefined,
  skuNames: Record<string, string>,
): Record<string, unknown> | undefined {
  return applySkuNames(modelVisibleProposalLine(raw, cart), skuNames);
}

function modelVisibleOrderBody(
  payload: Record<string, unknown>,
  skuNames: Record<string, string>,
  includeOrderId: boolean,
): { order: Record<string, unknown>; paymentStatus?: string } {
  const order = asRecord(payload.order) ?? asRecord(payload.merchant_order) ?? {};
  const cart = asRecord(payload.cart) ?? {};
  const outOrder: Record<string, unknown> = {};
  if (includeOrderId) {
    const orderId = stringField(order, "merchant_order_id") || stringField(payload, "merchant_order_id");
    if (orderId) outOrder.merchant_order_id = orderId;
  }
  const status = stringField(order, "status");
  if (status) outOrder.status = status;
  const paymentStatus = modelVisiblePaymentStatus(
    stringField(order, "payment_public_status", "payment_status") || stringField(payload, "public_status"),
  );
  if (paymentStatus) outOrder.payment_status = paymentStatus;
  const currency =
    stringField(order, "currency") ||
    stringField(asRecord(order.total) ?? {}, "currency") ||
    stringField(cart, "currency");
  if (currency) outOrder.currency = currency;
  const total = moneyMinor(order.total) ?? moneyMinor(order.total_minor);
  if (total != null) outOrder.total_minor = total;
  const sourceLines = Array.isArray(order.lines) && order.lines.length > 0 ? order.lines : cart.lines;
  const lines = (Array.isArray(sourceLines) ? sourceLines : [])
    .map((row) => modelVisibleOrderLine(row, cart, skuNames))
    .filter((row): row is Record<string, unknown> => Boolean(row));
  if (lines.length > 0) outOrder.lines = lines;
  return { order: outOrder, paymentStatus };
}

/** Model-visible complete_checkout body. Host retains envelope, public_state, rail ids, and OCC handles. */
export function modelVisibleCompleteCheckout(
  payload: Record<string, unknown>,
  resultCode: string,
  skuNames: Record<string, string> = {},
): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const { order } = modelVisibleOrderBody(payload, skuNames, true);
  const out: Record<string, unknown> = { result_code: resultCode };
  if (Object.keys(order).length > 0) out.order = order;
  out.next_action = "POLL_ORDER";
  return out;
}

/** Model-visible get_order body. Host retains envelope, public_state, rail ids, and OCC handles. */
export function modelVisibleGetOrder(
  payload: Record<string, unknown>,
  resultCode: string,
  skuNames: Record<string, string> = {},
): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const { order, paymentStatus } = modelVisibleOrderBody(payload, skuNames, false);
  const out: Record<string, unknown> = { result_code: resultCode };
  if (Object.keys(order).length > 0) out.order = order;
  out.next_action = modelVisibleOrderNextAction(paymentStatus);
  return out;
}

/** Model-visible get_product body. Host retains envelope, public_state, and the full SKU contract. */
export function modelVisibleGetProduct(payload: Record<string, unknown>, resultCode: string): Record<string, unknown> {
  if (resultCode !== "OK") return modelVisibleError(resultCode, payload);
  const product = asRecord(payload.product) ?? {};
  const outProduct: Record<string, unknown> = {};
  const productId = stringField(product, "product_id");
  if (productId) outProduct.product_id = productId;
  const name = stringField(product, "name");
  if (name) outProduct.name = name;
  const brand = stringField(product, "brand");
  if (brand) outProduct.brand = brand;
  const category = stringField(product, "category");
  if (category) outProduct.category = category;
  const subcategory = stringField(product, "subcategory");
  if (subcategory) outProduct.subcategory = subcategory;
  const description = stringField(product, "description", "canonical_description");
  if (description) outProduct.description = description;
  const dietary = dietaryList(product.dietary);
  if (dietary) outProduct.dietary = dietary;
  const skusRaw = Array.isArray(product.skus) ? product.skus : [];
  const skus = skusRaw.map((row) => modelVisibleSku(row)).filter((row): row is Record<string, unknown> => Boolean(row));
  if (skus.length > 0) outProduct.skus = skus;
  const out: Record<string, unknown> = { result_code: resultCode };
  if (Object.keys(outProduct).length > 0) out.product = outProduct;
  return out;
}

export function modelVisibleToolResult(
  tool: string,
  resultCode: string,
  payload: Record<string, unknown>,
  args: Record<string, unknown> = {},
  host: { sku_names?: Record<string, string> } = {},
): Record<string, unknown> {
  const skuNames = host.sku_names ?? {};
  if (tool === "get_capabilities") return modelVisibleGetCapabilities(payload, resultCode);
  if (tool === "create_session") return modelVisibleCreateSession(payload, resultCode);
  if (tool === "set_intent") return modelVisibleSetIntent(payload, resultCode);
  if (tool === "search_catalog") return modelVisibleSearchCatalog(payload, resultCode);
  if (tool === "get_product") return modelVisibleGetProduct(payload, resultCode);
  if (tool === "apply_offer") return modelVisibleApplyOffer(payload, resultCode, args);
  if (tool === "prepare_checkout") return modelVisiblePrepareCheckout(payload, resultCode);
  if (tool === "complete_checkout") return modelVisibleCompleteCheckout(payload, resultCode, skuNames);
  if (tool === "get_order") return modelVisibleGetOrder(payload, resultCode, skuNames);
  if (tool === "get_cart" || tool === "add_cart_item" || tool === "update_cart_item" || tool === "remove_cart_item") {
    return modelVisibleGetCart(payload, resultCode);
  }
  const { substitutions: _s, substitution: _sub, ...rest } = payload;
  return { result_code: resultCode, ...rest };
}
