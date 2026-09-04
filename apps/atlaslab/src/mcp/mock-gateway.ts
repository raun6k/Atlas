import { sha256Hex } from "../ids.js";
import type { McpCallRequest, McpCallResult, McpClient } from "./client.js";
import { assertPublicTool } from "./client.js";
import { LabError, type PaymentSimulation, type PublicState } from "../types.js";

interface MockSession {
  session_id: string;
  cart_id: string;
  session_context_version: number;
  cart_version: number;
  location_id: string;
  lines: Array<{ sku_id: string; quantity: number; line_id: string }>;
  lastIdempotency?: { key: string; digest: string; result: McpCallResult };
  proposal?: Record<string, unknown>;
  order?: Record<string, unknown>;
  payment_status?: string;
  outcome_unknown?: boolean;
  offers: Array<Record<string, unknown>>;
}

const CATALOG: Record<string, { sku_id: string; product_id: string; title: string; query: string[] }> = {
  eggs: { sku_id: "sku_qm_eggs_white_6", product_id: "prd_qm_eggs", title: "White Eggs 6 pcs", query: ["egg", "eggs"] },
  bread: { sku_id: "sku_qm_britannia_white_400g", product_id: "prd_qm_bread", title: "Britannia White Bread 400 g", query: ["bread"] },
  banana: { sku_id: "sku_qm_banana_500g", product_id: "prd_qm_banana", title: "Robusta Banana 500 g", query: ["banana", "bananas"] },
  coke_zero: { sku_id: "sku_qm_coke_zero_330ml", product_id: "prd_qm_coca_cola_zero", title: "Coke Zero 330 ml", query: ["coke zero", "coca cola zero"] },
  coke: { sku_id: "sku_qm_coke_750ml", product_id: "prd_qm_coca_cola", title: "Coca-Cola 750 ml", query: ["coke", "coca cola"] },
};

const PRICES: Record<string, number> = {
  sku_qm_eggs_white_6: 5400,
  sku_qm_britannia_white_400g: 4200,
  sku_qm_banana_500g: 3600,
  sku_qm_coke_zero_330ml: 3500,
  sku_qm_coke_750ml: 4000,
  sku_qm_eggs_brown_6: 6000,
};

export class MockGateway implements McpClient {
  sessions = new Map<string, MockSession>();
  lostOnce = new Set<string>();
  inventoryInvalidated = false;
  invalidateAfterPrepare = false;
  paymentSimulation: PaymentSimulation = "SUCCESS";
  fixtureDigest = "digest_fix_quickmart_v1_stable";
  private pollCount = new Map<string, number>();

  constructor(opts?: { paymentSimulation?: PaymentSimulation }) {
    if (opts?.paymentSimulation) this.paymentSimulation = opts.paymentSimulation;
  }

  resetFixture(): { fixture_snapshot_id: string; digest: string } {
    this.sessions.clear();
    this.lostOnce.clear();
    this.inventoryInvalidated = false;
    this.pollCount.clear();
    return { fixture_snapshot_id: "fix_quickmart_v1", digest: this.fixtureDigest };
  }

  async call(req: McpCallRequest): Promise<McpCallResult> {
    assertPublicTool(req.tool);
    if (req.tool !== "get_capabilities" && !req.hostBearer) {
      return this.err(req, "HOST_FORBIDDEN", false);
    }
    const mutating = ![
      "get_capabilities",
      "search_catalog",
      "get_product",
      "get_cart",
      "get_order",
    ].includes(req.tool);
    if (mutating && !req.hostRequestProof) {
      return this.err(req, "HOST_FORBIDDEN", false);
    }

    const sessionId = String(req.arguments.session_id ?? "");
    const session = this.sessions.get(sessionId);

    if (mutating && req.idempotencyKey && session?.lastIdempotency?.key === req.idempotencyKey) {
      const digest = sha256Hex(JSON.stringify(req.arguments));
      if (digest !== session.lastIdempotency.digest) {
        return this.err(req, "IDEMPOTENCY_CONFLICT", false);
      }
      return session.lastIdempotency.result;
    }

    if (req.tool === "add_cart_item" && req.idempotencyKey?.includes("lost") && !this.lostOnce.has(req.idempotencyKey)) {
      this.lostOnce.add(req.idempotencyKey);
      throw new LabError("TRANSPORT_TIMEOUT", "simulated lost mutation response", 504);
    }

    const result = this.dispatch(req, session);
    if (mutating && req.idempotencyKey && result.ok) {
      const sid = String(result.publicStatePatch.session_id ?? sessionId);
      const s = this.sessions.get(sid);
      if (s) {
        s.lastIdempotency = { key: req.idempotencyKey, digest: sha256Hex(JSON.stringify(req.arguments)), result };
      }
    }
    return result;
  }

  private dispatch(req: McpCallRequest, session: MockSession | undefined): McpCallResult {
    switch (req.tool) {
      case "get_capabilities":
        return this.ok(req, {
          contract_version: "atlas.merchant.v1",
          environment: "test",
          payment_capabilities: [
            {
              capability_id: "pcap_razorpay_test",
              provider: "razorpay",
              environment: "test",
              money_movement: "simulated",
            },
          ],
          tools: [
            "get_capabilities",
            "create_session",
            "set_intent",
            "search_catalog",
            "get_product",
            "get_cart",
            "add_cart_item",
            "update_cart_item",
            "remove_cart_item",
            "accept_offer",
            "apply_offer",
            "prepare_checkout",
            "complete_checkout",
            "get_order",
            "respond_to_substitution",
          ],
        });
      case "create_session": {
        const session_id = `ses_${this.sessions.size + 1}`;
        const cart_id = `cart_${this.sessions.size + 1}`;
        const location_id = String(
          req.arguments.requested_location_id ?? req.arguments.location_id ?? "loc_qm_koramangala",
        );
        const created: MockSession = {
          session_id,
          cart_id,
          session_context_version: 0,
          cart_version: 0,
          location_id,
          lines: [],
          offers: [],
        };
        this.sessions.set(session_id, created);
        return this.ok(req, this.sessionPayload(created));
      }
      case "set_intent": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        session.session_context_version += 1;
        return this.ok(req, this.sessionPayload(session));
      }
      case "search_catalog": {
        const q = String(req.arguments.query ?? "").toLowerCase();
        const hits = Object.values(CATALOG).filter((item) => item.query.some((term) => q.includes(term)));
        return this.ok(req, { results: hits });
      }
      case "get_product": {
        const productId = String(req.arguments.product_id ?? "");
        const skus = Object.values(CATALOG).filter((item) => item.product_id === productId);
        return this.ok(req, { product_id: productId, skus });
      }
      case "get_cart": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        return this.ok(req, this.sessionPayload(session));
      }
      case "add_cart_item": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        if (req.arguments.expected_cart_version != null && Number(req.arguments.expected_cart_version) !== session.cart_version) {
          return this.err(req, "CART_VERSION_CONFLICT", false, this.sessionPayload(session));
        }
        const sku_id = String(req.arguments.sku_id);
        const quantity = Number(req.arguments.quantity ?? 1);
        const existing = session.lines.find((l) => l.sku_id === sku_id);
        if (existing) existing.quantity += quantity;
        else session.lines.push({ sku_id, quantity, line_id: `ln_${session.lines.length + 1}` });
        session.cart_version += 1;
        this.maybeOffer(session);
        return this.ok(req, this.sessionPayload(session));
      }
      case "update_cart_item":
      case "remove_cart_item": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        if (req.arguments.expected_cart_version != null && Number(req.arguments.expected_cart_version) !== session.cart_version) {
          return this.err(req, "CART_VERSION_CONFLICT", false, this.sessionPayload(session));
        }
        const sku_id = String(req.arguments.sku_id ?? req.arguments.line_id);
        if (req.tool === "remove_cart_item") {
          session.lines = session.lines.filter((l) => l.sku_id !== sku_id && l.line_id !== sku_id);
        } else {
          const line = session.lines.find((l) => l.sku_id === sku_id || l.line_id === sku_id);
          if (line) line.quantity = Number(req.arguments.quantity ?? line.quantity);
        }
        session.cart_version += 1;
        return this.ok(req, this.sessionPayload(session));
      }
      case "accept_offer": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        const offer = session.offers.find((o) => o.offer_id === req.arguments.offer_id);
        if (offer) offer.status = "ACCEPTED";
        return this.ok(req, this.sessionPayload(session));
      }
      case "apply_offer": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        const offer = session.offers.find((o) => o.offer_id === req.arguments.offer_id);
        if (offer?.status === "ACCEPTED") {
          const sku = String(offer.sku_id ?? "sku_qm_coke_750ml");
          const line = session.lines.find((l) => l.sku_id === sku);
          if (line) line.quantity = 3;
          else session.lines.push({ sku_id: sku, quantity: 3, line_id: `ln_${session.lines.length + 1}` });
          session.cart_version += 1;
          offer.status = "APPLIED";
        }
        return this.ok(req, this.sessionPayload(session));
      }
      case "prepare_checkout": {
        if (!session) return this.err(req, "NOT_FOUND", false);
        if (
          (req.arguments.expected_cart_version != null && Number(req.arguments.expected_cart_version) !== session.cart_version) ||
          (req.arguments.expected_session_context_version != null &&
            Number(req.arguments.expected_session_context_version) !== session.session_context_version)
        ) {
          return this.err(req, "CART_VERSION_CONFLICT", false, this.sessionPayload(session));
        }
        if (this.inventoryInvalidated) {
          return this.err(req, "REQUOTE_REQUIRED", false);
        }
        const totals = this.totals(session);
        const proposal = {
          checkout_proposal_id: `cpo_${session.session_id}`,
          merchant_profile_id: "mrc_quickmart",
          session_id: session.session_id,
          session_context_version: session.session_context_version,
          cart_id: session.cart_id,
          cart_version: session.cart_version,
          quote_hash: sha256Hex(JSON.stringify(session.lines) + totals.total_minor),
          final_amount_minor: totals.total_minor,
          currency: "INR",
          payment_capability_id: "pcap_razorpay_test",
          status: "ACTIVE",
          expiry: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        session.proposal = proposal;
        if (this.invalidateAfterPrepare) this.inventoryInvalidated = true;
        return this.ok(req, { ...this.sessionPayload(session), checkout_proposal: proposal });
      }
      case "complete_checkout": {
        if (!session?.proposal) return this.err(req, "REQUOTE_REQUIRED", false);
        if (this.inventoryInvalidated) return this.err(req, "REQUOTE_REQUIRED", false);
        if (!req.checkoutAuthority && !req.arguments.checkout_authority) {
          return this.err(req, "REQUIRE_APPROVAL", false);
        }
        const order_id = `ord_${session.session_id}`;
        if (this.paymentSimulation === "AMBIGUOUS_THEN_SUCCESS" || this.paymentSimulation === "AMBIGUOUS_THEN_FAILURE") {
          session.outcome_unknown = true;
          session.payment_status = "OUTCOME_UNKNOWN";
          session.order = { order_id, status: "PENDING_PAYMENT", payment_status: "OUTCOME_UNKNOWN" };
        } else if (this.paymentSimulation === "FAILURE") {
          session.payment_status = "FAILED_VERIFIED";
          session.order = { order_id, status: "PENDING_PAYMENT", payment_status: "FAILED_VERIFIED" };
        } else {
          session.payment_status = "CAPTURED_RECONCILED";
          session.order = {
            order_id,
            status: "CONFIRMED",
            payment_status: "CAPTURED_RECONCILED",
            revenue_minor: this.totals(session).total_minor,
            currency: "INR",
          };
        }
        return this.ok(req, { ...this.sessionPayload(session), order: session.order });
      }
      case "get_order": {
        if (!session?.order) return this.err(req, "NOT_FOUND", false);
        const n = (this.pollCount.get(session.session_id) ?? 0) + 1;
        this.pollCount.set(session.session_id, n);
        if (session.outcome_unknown && n >= 2) {
          if (this.paymentSimulation === "AMBIGUOUS_THEN_FAILURE") {
            session.payment_status = "FAILED_VERIFIED";
            session.order = { ...session.order, status: "PENDING_PAYMENT", payment_status: "FAILED_VERIFIED" };
          } else {
            session.payment_status = "CAPTURED_RECONCILED";
            session.order = {
              ...session.order,
              status: "CONFIRMED",
              payment_status: "CAPTURED_RECONCILED",
              revenue_minor: this.totals(session).total_minor,
              currency: "INR",
            };
          }
          session.outcome_unknown = false;
        }
        const substitution =
          session.location_id === "loc_qm_hsr" && session.lines.some((l) => l.sku_id === "sku_qm_eggs_white_6")
            ? {
                substitution_request_id: "sub_eggs_hsr",
                options: [{ sku_id: "sku_qm_eggs_brown_6", price_delta_minor: 600 }],
              }
            : undefined;
        return this.ok(req, { ...this.sessionPayload(session), order: session.order, substitution });
      }
      case "respond_to_substitution": {
        if (!session?.order) return this.err(req, "NOT_FOUND", false);
        return this.ok(req, {
          ...this.sessionPayload(session),
          substitution_response: { status: "APPLIED", selected_sku_id: req.arguments.sku_id ?? null },
        });
      }
      default:
        return this.err(req, "UNKNOWN_TOOL", false);
    }
  }

  private maybeOffer(session: MockSession): void {
    const coke = session.lines.find((l) => l.sku_id === "sku_qm_coke_750ml");
    if (coke && coke.quantity >= 2 && !session.offers.some((o) => o.offer_id === "off_coke_buy3")) {
      session.offers.push({
        offer_id: "off_coke_buy3",
        strategy: "PROMOTION",
        status: "SHOWN",
        sku_id: "sku_qm_coke_750ml",
        preview: { quantity: 3, discount_minor: 3000 },
      });
    }
  }

  private totals(session: MockSession): PublicState["totals"] & { merchandise_minor: number; delivery_minor: number; total_minor: number; currency: string } {
    const merchandise_minor = session.lines.reduce((sum, line) => sum + (PRICES[line.sku_id] ?? 0) * line.quantity, 0);
    const delivery_minor = session.lines.length === 0 ? 0 : 3500;
    return {
      merchandise_minor,
      delivery_minor,
      total_minor: merchandise_minor + delivery_minor,
      currency: "INR",
    };
  }

  private sessionPayload(session: MockSession): Record<string, unknown> {
    const totals = this.totals(session);
    return {
      session_id: session.session_id,
      session_summary: { session_id: session.session_id, session_context_version: session.session_context_version },
      cart_id: session.cart_id,
      cart_version: session.cart_version,
      location_id: session.location_id,
      lines: session.lines,
      totals,
      offers: session.offers,
      checkout_proposal: session.proposal,
      order: session.order,
      payment_status: session.payment_status,
      outcome_unknown: session.outcome_unknown,
    };
  }

  private ok(req: McpCallRequest, payload: Record<string, unknown>): McpCallResult {
    return {
      ok: true,
      resultCode: "OK",
      retryable: false,
      payload: { ...payload, request_id: req.requestId, result_code: "OK", contract_version: "atlas.merchant.v1" },
      publicStatePatch: this.patchFrom(payload),
      requestId: req.requestId,
    };
  }

  private err(req: McpCallRequest, code: string, retryable: boolean, payload: Record<string, unknown> = {}): McpCallResult {
    return {
      ok: false,
      resultCode: code,
      retryable,
      payload: { ...payload, request_id: req.requestId, result_code: code, retryable },
      publicStatePatch: this.patchFrom(payload),
      requestId: req.requestId,
    };
  }

  private patchFrom(payload: Record<string, unknown>): PublicState {
    return {
      session_id: payload.session_id as string | undefined,
      session_context_version: (payload.session_summary as { session_context_version?: number } | undefined)?.session_context_version,
      cart_id: payload.cart_id as string | undefined,
      cart_version: payload.cart_version as number | undefined,
      location_id: payload.location_id as string | undefined,
      lines: payload.lines as PublicState["lines"],
      totals: payload.totals as PublicState["totals"],
      offers: payload.offers as PublicState["offers"],
      checkout_proposal: payload.checkout_proposal as Record<string, unknown> | undefined,
      order: payload.order as Record<string, unknown> | undefined,
      payment_status: payload.payment_status as string | undefined,
      last_result_code: payload.result_code as string | undefined,
      outcome_unknown: payload.outcome_unknown as boolean | undefined,
      payment_capabilities: payload.payment_capabilities as PublicState["payment_capabilities"],
      contract_version: payload.contract_version as string | undefined,
    };
  }
}
