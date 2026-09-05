import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modelVisibleApplyOffer,
  modelVisibleCompleteCheckout,
  modelVisibleCreateSession,
  modelVisibleGetCart,
  modelVisibleGetCapabilities,
  modelVisibleGetOrder,
  modelVisibleGetProduct,
  modelVisiblePaymentCapabilities,
  modelVisiblePrepareCheckout,
  modelVisibleSearchCatalog,
  modelVisibleSetIntent,
  modelVisibleToolResult,
} from "./visible.js";

test("get_capabilities model view drops Host rail identity", () => {
  const visible = modelVisibleGetCapabilities(
    {
      result_code: "OK",
      request_id: "req_1",
      public_state: {},
      envelope: { contract_version: "atlas.merchant.v1", request_id: "req_1" },
      capabilities: {
        contract_family: "atlas.merchant.v1",
        contract_version: "atlas.merchant.v1",
        merchant_display_name: "QuickMart",
        currency: "INR",
        locale: "en-IN",
        tools: ["get_capabilities", "create_session", "get_order", "respond_to_substitution"],
        max_page_size: 25,
        offer_ttl_seconds: 300,
        proposal_hold_ttl_seconds: 120,
        payment: {
          capability_id: "pcap_razorpay_test",
          provider: "razorpay",
          environment: "test",
          money_movement: "simulated",
          completion_mode: "asynchronous",
          requires_checkout_proposal: true,
          requires_checkout_authority: true,
          supports_buyer_agent_raw_instrument_access: false,
          terminal_success_state: "CAPTURED_RECONCILED",
        },
      },
    },
    "OK",
  );
  assert.deepEqual(visible, {
    result_code: "OK",
    merchant_display_name: "QuickMart",
    currency: "INR",
    locale: "en-IN",
    tools: ["create_session", "get_order"],
    max_page_size: 25,
    offer_ttl_seconds: 300,
    proposal_hold_ttl_seconds: 120,
    payment: {
      completion_mode: "asynchronous",
      requires_checkout_proposal: true,
      requires_checkout_authority: true,
    },
  });
});

test("create_session model view drops envelope and public_state", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: "0",
      cart_version: "0",
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:01.000Z",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: "0",
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: "0",
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: "0",
      currency: "INR",
      lines: [],
      breakdown: {
        merchandise: { amount_minor: 0, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 3012, currency: "INR" },
      },
    },
  };
  assert.deepEqual(modelVisibleCreateSession(payload, "OK"), {
    result_code: "OK",
    session: {
      session_id: "ses_01HZX",
      status: "ACTIVE",
      location_id: "loc_qm_koramangala",
      session_context_version: 0,
    },
    cart: {
      cart_id: "crt_01HZX",
      cart_version: 0,
      currency: "INR",
      lines: [],
      breakdown: {
        merchandise_minor: 0,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 3012,
      },
    },
  });
  assert.equal("envelope" in modelVisibleToolResult("create_session", "OK", payload), false);
  assert.equal("public_state" in modelVisibleToolResult("create_session", "OK", payload), false);
});

test("create_session model view on failure is result_code only", () => {
  assert.deepEqual(
    modelVisibleCreateSession(
      {
        public_state: {},
        envelope: { request_id: "req_1" },
        error: { message: "delivery location is required" },
      },
      "INVALID_ARGUMENT",
    ),
    { result_code: "INVALID_ARGUMENT", message: "delivery location is required" },
  );
});

test("get_order model view drops Host envelope and rail ids", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      merchant_order_id: "ord_01HZX",
      payment_status: "CAPTURED_RECONCILED",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:20.000Z",
    },
    order: {
      merchant_order_id: "ord_01HZX",
      session_id: "ses_01HZX",
      checkout_proposal_id: "prp_01HZX",
      status: "CONFIRMED",
      total: { amount_minor: 11912, currency: "INR" },
      payment_attempt_id: "pay_01HZX",
      payment_public_status: "CAPTURED_RECONCILED",
      location_id: "loc_qm_koramangala",
      created_at: "2026-09-05T04:50:12Z",
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          quantity: 1,
          unit_price: { amount_minor: 8900, currency: "INR" },
          line_total: { amount_minor: 8900, currency: "INR" },
        },
      ],
      substitutions: [{ substitution_request_id: "sub_01HZX", status: "OPEN" }],
    },
  };
  const skuNames = {
    "QM-SNK-0001-B": "Tea Biscuits Plain - family pack",
  };
  const visible = {
    result_code: "OK",
    order: {
      status: "CONFIRMED",
      payment_status: "PAID",
      currency: "INR",
      total_minor: 11912,
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price_minor: 8900,
          line_total_minor: 8900,
        },
      ],
    },
    next_action: "DONE",
  };
  assert.deepEqual(modelVisibleGetOrder(payload, "OK", skuNames), visible);
  assert.deepEqual(modelVisibleToolResult("get_order", "OK", payload, {}, { sku_names: skuNames }), visible);
  assert.equal("envelope" in modelVisibleGetOrder(payload, "OK", skuNames), false);
  assert.equal("public_state" in modelVisibleGetOrder(payload, "OK", skuNames), false);
  assert.equal("merchant_order_id" in (modelVisibleGetOrder(payload, "OK", skuNames).order as object), false);
  assert.equal(JSON.stringify(modelVisibleGetOrder(payload, "OK", skuNames)).toLowerCase().includes("substitut"), false);
});

test("complete_checkout model view keeps order facts and drops Host rail ids", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      merchant_order_id: "ord_01HZX",
      payment_status: "PAYMENT_PROCESSING",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:12.000Z",
      operation_id: "op_01HZX",
    },
    merchant_order_id: "ord_01HZX",
    payment_attempt_id: "pay_01HZX",
    operation_id: "op_01HZX",
    public_status: "PAYMENT_PROCESSING",
    cart: {
      lines: [{ sku_id: "QM-SNK-0001-B", name: "Tea Biscuits Plain - family pack", quantity: 1 }],
    },
    order: {
      merchant_order_id: "ord_01HZX",
      session_id: "ses_01HZX",
      checkout_proposal_id: "prp_01HZX",
      status: "PENDING_PAYMENT",
      total: { amount_minor: 11912, currency: "INR" },
      payment_attempt_id: "pay_01HZX",
      payment_public_status: "PAYMENT_PROCESSING",
      location_id: "loc_qm_koramangala",
      created_at: "2026-09-05T04:50:12Z",
      operation_id: "op_01HZX",
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          quantity: 1,
          unit_price: { amount_minor: 8900, currency: "INR" },
          line_total: { amount_minor: 8900, currency: "INR" },
        },
      ],
    },
  };
  const visible = {
    result_code: "OK",
    order: {
      merchant_order_id: "ord_01HZX",
      status: "PENDING_PAYMENT",
      payment_status: "PROCESSING",
      currency: "INR",
      total_minor: 11912,
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price_minor: 8900,
          line_total_minor: 8900,
        },
      ],
    },
    next_action: "POLL_ORDER",
  };
  assert.deepEqual(modelVisibleCompleteCheckout(payload, "OK"), visible);
  assert.deepEqual(modelVisibleToolResult("complete_checkout", "OK", payload), visible);
});

test("complete_checkout model errors stay a short result_code", () => {
  assert.deepEqual(
    modelVisibleCompleteCheckout({ envelope: { operation_id: "op_1" }, message: "proposal expired" }, "REQUOTE_REQUIRED"),
    { result_code: "REQUOTE_REQUIRED", message: "proposal expired" },
  );
});

test("get_cart model view flattens cart money and slims offers", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 1,
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:06.000Z",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: 1,
      planning_budget: { amount_minor: 25000, currency: "INR" },
      mission: "Buy tea biscuits under ₹250 all-in",
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: 1,
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZX",
          sku_id: "QM-SNK-0001-A",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          name: "Tea Biscuits Plain - standard pack",
          quantity: 1,
          unit_price: { amount_minor: 4900, currency: "INR" },
          line_total: { amount_minor: 4900, currency: "INR" },
        },
      ],
      breakdown: {
        merchandise: { amount_minor: 4900, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 7912, currency: "INR" },
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZZ",
        strategy_type: "FREE_DELIVERY",
        session_context_version: 1,
        cart_version: 1,
        expires_at: "2026-09-05T04:55:06.000Z",
        status: "SHOWN",
        grounded_reason: "Spend ₹150 more on merchandise to unlock free delivery.",
        terms: "Free delivery over ₹199",
        cart_patch: {
          patch_type: "ADD_ITEM",
          lines: [{ sku_id: "QM-SNK-0002-A", quantity: 1, op: "ADD" }],
        },
        buyer_impact: { amount_minor: 1900, currency: "INR" },
        base_all_in_total: { amount_minor: 7912, currency: "INR" },
        projected_all_in_total: { amount_minor: 9812, currency: "INR" },
      },
    ],
  };
  const visible = modelVisibleGetCart(payload, "OK");
  assert.deepEqual(visible, {
    result_code: "OK",
    cart: {
      cart_id: "crt_01HZX",
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZX",
          sku_id: "QM-SNK-0001-A",
          name: "Tea Biscuits Plain - standard pack",
          quantity: 1,
          unit_price_minor: 4900,
          line_total_minor: 4900,
        },
      ],
      breakdown: {
        merchandise_minor: 4900,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 7912,
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZZ",
        action: "ADD_ITEM",
        item: { sku_id: "QM-SNK-0002-A", quantity: 1 },
        reason: "Spend ₹150 more on merchandise to unlock free delivery.",
        incremental_cost_minor: 1900,
        projected_all_in_total_minor: 9812,
        expires_at: "2026-09-05T04:55:06.000Z",
      },
    ],
    invalidated_offer_ids: [],
  });
  const routed = modelVisibleToolResult("get_cart", "OK", payload);
  assert.equal("envelope" in routed, false);
  assert.equal("public_state" in routed, false);
  assert.equal("session_summary" in routed, false);
  assert.equal("session_id" in (routed.cart as Record<string, unknown>), false);
  assert.equal("cart_version" in (routed.cart as Record<string, unknown>), false);
  const line = ((routed.cart as Record<string, unknown>).lines as Array<Record<string, unknown>>)[0] ?? {};
  assert.equal("product_id" in line, false);
  assert.equal("unit_price" in line, false);
  const offer = (routed.offers as Array<Record<string, unknown>>)[0] ?? {};
  assert.equal("strategy_type" in offer, false);
  assert.equal("cart_patch" in offer, false);
  assert.equal("status" in offer, false);
  assert.equal("terms" in offer, false);
});

test("get_cart model view on failure is result_code only", () => {
  assert.deepEqual(
    modelVisibleGetCart({ envelope: {}, error: { message: "session not found" } }, "NOT_FOUND"),
    { result_code: "NOT_FOUND", message: "session not found" },
  );
});

test("snapshot payment_capabilities omit capability_id", () => {
  const slim = modelVisiblePaymentCapabilities([
    {
      capability_id: "pcap_razorpay_test",
      completion_mode: "asynchronous",
      requires_checkout_proposal: true,
      requires_checkout_authority: true,
    },
  ]);
  assert.deepEqual(slim, [
    {
      completion_mode: "asynchronous",
      requires_checkout_proposal: true,
      requires_checkout_authority: true,
    },
  ]);
});

test("set_intent model view keeps intent, all-in, and slim offers", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 0,
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:02.000Z",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: 0,
      planning_budget: { amount_minor: 25000, currency: "INR" },
      mission: "Buy tea biscuits under ₹250 all-in",
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: 0,
      currency: "INR",
      lines: [],
      breakdown: {
        merchandise: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        all_in_total: { amount_minor: 3012, currency: "INR" },
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZX",
        strategy_type: "REORDER",
        session_context_version: 1,
        cart_version: 0,
        expires_at: "2026-09-05T04:55:02.000Z",
        status: "SHOWN",
        grounded_reason: "Add Tea Biscuits Plain - standard pack — you usually repurchase this about every 14 days.",
        terms: "Buy again · qty 1",
        cart_patch: {
          patch_type: "ADD_ITEM",
          lines: [{ sku_id: "QM-SNK-0001-A", name: "Tea Biscuits Plain - standard pack", quantity: 1, op: "ADD" }],
        },
        buyer_impact: { amount_minor: 4900, currency: "INR" },
        base_all_in_total: { amount_minor: 3012, currency: "INR" },
        projected_all_in_total: { amount_minor: 7912, currency: "INR" },
      },
    ],
  };
  const visible = modelVisibleSetIntent(payload, "OK");
  assert.deepEqual(visible, {
    result_code: "OK",
    intent: {
      budget_scope: "ALL_IN",
      mission: "Buy tea biscuits under ₹250 all-in",
      budget_minor: 25000,
      currency: "INR",
    },
    cart_all_in_total_minor: 3012,
    offers: [
      {
        offer_id: "ofr_01HZX",
        action: "ADD_ITEM",
        item: { sku_id: "QM-SNK-0001-A", name: "Tea Biscuits Plain - standard pack", quantity: 1 },
        reason: "Add Tea Biscuits Plain - standard pack — you usually repurchase this about every 14 days.",
        incremental_cost_minor: 4900,
        projected_all_in_total_minor: 7912,
        expires_at: "2026-09-05T04:55:02.000Z",
      },
    ],
  });
  const routed = modelVisibleToolResult("set_intent", "OK", payload);
  assert.equal("public_state" in routed, false);
  assert.equal("envelope" in routed, false);
  assert.equal("session_summary" in routed, false);
  assert.equal("cart" in routed, false);
  assert.equal("strategy_type" in ((routed.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("cart_patch" in ((routed.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
});

test("search_catalog model view keeps slim items and offers", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {},
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:03.000Z",
    },
    items: [
      {
        sku_id: "QM-SNK-0001-A",
        product_id: "prd_qm_crispkettle_tea_biscuits_plain",
        name: "Tea Biscuits Plain - standard pack",
        brand: "CrispKettle",
        variant: "standard pack",
        pack_size: 100,
        unit_of_measure: "g",
        barcode: "8900000000000",
        canonical_description: "Crunchy ready-to-eat snack for tea breaks, travel, sharing and quick hunger occasions.",
        lifecycle: "active",
        selling_price: { amount_minor: 4900, currency: "INR" },
        sellable_quantity: 40,
        stock_status: "IN_STOCK",
        assorted: true,
      },
      {
        sku_id: "QM-SNK-0001-B",
        product_id: "prd_qm_crispkettle_tea_biscuits_plain",
        name: "Tea Biscuits Plain - family pack",
        brand: "CrispKettle",
        variant: "family pack",
        pack_size: 200,
        unit_of_measure: "g",
        lifecycle: "active",
        selling_price: { amount_minor: 8900, currency: "INR" },
        sellable_quantity: 22,
        stock_status: "IN_STOCK",
        assorted: true,
      },
    ],
    next_cursor: "QM-SNK-0001-B",
    offers: [
      {
        offer_id: "ofr_01HZY",
        strategy_type: "LARGER_PACK",
        session_context_version: 1,
        cart_version: 0,
        expires_at: "2026-09-05T04:55:03.000Z",
        status: "SHOWN",
        grounded_reason: "Family pack offers better unit value than the standard pack.",
        terms: "Larger pack",
        cart_patch: {
          patch_type: "REPLACE_ITEM",
          source_sku_id: "QM-SNK-0001-A",
          lines: [{ sku_id: "QM-SNK-0001-B", quantity: 1, op: "ADD" }],
        },
        buyer_impact: { amount_minor: 4000, currency: "INR" },
        base_all_in_total: { amount_minor: 7912, currency: "INR" },
        projected_all_in_total: { amount_minor: 11912, currency: "INR" },
      },
    ],
  };
  const visible = modelVisibleSearchCatalog(payload, "OK");
  assert.deepEqual(visible, {
    result_code: "OK",
    items: [
      {
        sku_id: "QM-SNK-0001-A",
        product_id: "prd_qm_crispkettle_tea_biscuits_plain",
        name: "Tea Biscuits Plain - standard pack",
        brand: "CrispKettle",
        variant: "standard pack",
        pack_quantity: 100,
        unit: "g",
        price_minor: 4900,
        stock_status: "IN_STOCK",
      },
      {
        sku_id: "QM-SNK-0001-B",
        product_id: "prd_qm_crispkettle_tea_biscuits_plain",
        name: "Tea Biscuits Plain - family pack",
        brand: "CrispKettle",
        variant: "family pack",
        pack_quantity: 200,
        unit: "g",
        price_minor: 8900,
        stock_status: "IN_STOCK",
      },
    ],
    next_cursor: "QM-SNK-0001-B",
    offers: [
      {
        offer_id: "ofr_01HZY",
        action: "REPLACE_ITEM",
        item: { sku_id: "QM-SNK-0001-B", name: "Tea Biscuits Plain - family pack", quantity: 1 },
        replaces_sku_id: "QM-SNK-0001-A",
        reason: "Family pack offers better unit value than the standard pack.",
        incremental_cost_minor: 4000,
        projected_all_in_total_minor: 11912,
        expires_at: "2026-09-05T04:55:03.000Z",
      },
    ],
  });
  const routed = modelVisibleToolResult("search_catalog", "OK", payload);
  assert.equal("envelope" in routed, false);
  assert.equal("public_state" in routed, false);
  assert.equal("barcode" in ((routed.items as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("canonical_description" in ((routed.items as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("lifecycle" in ((routed.items as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("assorted" in ((routed.items as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("sellable_quantity" in ((routed.items as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("strategy_type" in ((routed.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("cart_patch" in ((routed.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal("terms" in ((routed.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
});

test("search_catalog model view on failure is result_code only", () => {
  assert.deepEqual(
    modelVisibleSearchCatalog({ envelope: {}, error: { message: "session not found" } }, "NOT_FOUND"),
    { result_code: "NOT_FOUND", message: "session not found" },
  );
});

test("get_product model view keeps a slim catalog card", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {},
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:04.000Z",
    },
    product: {
      product_id: "prd_qm_crispkettle_tea_biscuits_plain",
      name: "Tea Biscuits Plain",
      brand: "CrispKettle",
      category: "snacks",
      subcategory: "biscuits_chips_namkeen",
      canonical_description: "Crunchy ready-to-eat snack for tea breaks, travel, sharing and quick hunger occasions.",
      dietary: ["vegetarian"],
      lifecycle: "active",
      skus: [
        {
          sku_id: "QM-SNK-0001-A",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          name: "Tea Biscuits Plain - standard pack",
          brand: "CrispKettle",
          variant: "standard pack",
          pack_size: 100,
          unit_of_measure: "g",
          lifecycle: "active",
          selling_price: { amount_minor: 4900, currency: "INR" },
          sellable_quantity: 40,
          stock_status: "IN_STOCK",
          assorted: true,
        },
        {
          sku_id: "QM-SNK-0001-B",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          name: "Tea Biscuits Plain - family pack",
          brand: "CrispKettle",
          variant: "family pack",
          pack_size: 200,
          unit_of_measure: "g",
          lifecycle: "active",
          selling_price: { amount_minor: 8900, currency: "INR" },
          sellable_quantity: 22,
          stock_status: "IN_STOCK",
          assorted: true,
        },
      ],
    },
  };
  const visible = modelVisibleGetProduct(payload, "OK");
  assert.deepEqual(visible, {
    result_code: "OK",
    product: {
      product_id: "prd_qm_crispkettle_tea_biscuits_plain",
      name: "Tea Biscuits Plain",
      brand: "CrispKettle",
      category: "snacks",
      subcategory: "biscuits_chips_namkeen",
      description: "Crunchy ready-to-eat snack for tea breaks, travel, sharing and quick hunger occasions.",
      dietary: ["vegetarian"],
      skus: [
        {
          sku_id: "QM-SNK-0001-A",
          variant: "standard pack",
          pack_size: 100,
          unit: "g",
          price_minor: 4900,
          sellable: 40,
        },
        {
          sku_id: "QM-SNK-0001-B",
          variant: "family pack",
          pack_size: 200,
          unit: "g",
          price_minor: 8900,
          sellable: 22,
        },
      ],
    },
  });
  const routed = modelVisibleToolResult("get_product", "OK", payload);
  assert.equal("envelope" in routed, false);
  assert.equal("public_state" in routed, false);
  assert.equal("lifecycle" in (routed.product as Record<string, unknown>), false);
  const firstSku = ((routed.product as Record<string, unknown>).skus as Array<Record<string, unknown>>)[0] ?? {};
  assert.equal("product_id" in firstSku, false);
  assert.equal("name" in firstSku, false);
  assert.equal("brand" in firstSku, false);
  assert.equal("selling_price" in firstSku, false);
  assert.equal("stock_status" in firstSku, false);
  assert.equal("assorted" in firstSku, false);
});

test("get_product model view on failure is result_code only", () => {
  assert.deepEqual(
    modelVisibleGetProduct({ envelope: {}, error: { message: "product not found" } }, "NOT_FOUND"),
    { result_code: "NOT_FOUND", message: "product not found" },
  );
});

test("set_intent model view on failure is result_code only", () => {
  assert.deepEqual(
    modelVisibleSetIntent({ envelope: {}, error: { message: "stale session context version" } }, "SESSION_VERSION_CONFLICT"),
    { result_code: "SESSION_VERSION_CONFLICT", message: "stale session context version" },
  );
});

test("add_cart_item model view matches get_cart, keeps invalidated ids, and drops Host OCC", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 1,
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: 1,
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: 1,
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZX",
          sku_id: "QM-SNK-0001-A",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          name: "Tea Biscuits Plain - standard pack",
          quantity: 1,
          unit_price: { amount_minor: 4900, currency: "INR" },
          line_total: { amount_minor: 4900, currency: "INR" },
        },
      ],
      breakdown: {
        merchandise: { amount_minor: 4900, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 7912, currency: "INR" },
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZZ",
        strategy_type: "LARGER_PACK",
        session_context_version: 1,
        cart_version: 1,
        expires_at: "2026-09-05T04:55:05.000Z",
        status: "SHOWN",
        grounded_reason: "Switch to the family pack for a lower unit price.",
        terms: "Replace with larger pack",
        cart_patch: {
          patch_type: "REPLACE_ITEM",
          source_cart_line_id: "cln_01HZX",
          source_sku_id: "QM-SNK-0001-A",
          lines: [{ sku_id: "QM-SNK-0001-B", name: "Tea Biscuits Plain - family pack", quantity: 1, op: "ADD" }],
        },
        buyer_impact: { amount_minor: 4000, currency: "INR" },
        base_all_in_total: { amount_minor: 7912, currency: "INR" },
        projected_all_in_total: { amount_minor: 11912, currency: "INR" },
      },
    ],
    invalidated_offer_ids: ["ofr_01HZX"],
  };
  const visible = modelVisibleToolResult("add_cart_item", "OK", payload);
  assert.deepEqual(visible, {
    result_code: "OK",
    cart: {
      cart_id: "crt_01HZX",
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZX",
          sku_id: "QM-SNK-0001-A",
          name: "Tea Biscuits Plain - standard pack",
          quantity: 1,
          unit_price_minor: 4900,
          line_total_minor: 4900,
        },
      ],
      breakdown: {
        merchandise_minor: 4900,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 7912,
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZZ",
        action: "REPLACE_ITEM",
        item: { sku_id: "QM-SNK-0001-B", name: "Tea Biscuits Plain - family pack", quantity: 1 },
        replaces_cart_line_id: "cln_01HZX",
        reason: "Switch to the family pack for a lower unit price.",
        incremental_cost_minor: 4000,
        projected_all_in_total_minor: 11912,
        expires_at: "2026-09-05T04:55:05.000Z",
      },
    ],
    invalidated_offer_ids: ["ofr_01HZX"],
  });
  assert.equal("envelope" in visible, false);
  assert.equal("public_state" in visible, false);
  assert.equal("session_summary" in visible, false);
  assert.equal("replaces_sku_id" in ((visible.offers as Array<Record<string, unknown>>)[0] ?? {}), false);
  for (const tool of ["update_cart_item", "remove_cart_item"] as const) {
    assert.deepEqual(modelVisibleToolResult(tool, "OK", payload), visible);
  }
});

test("apply_offer model view is applied_offer_id plus slim cart", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 2,
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:10.000Z",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: 2,
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: 2,
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZY",
          sku_id: "QM-SNK-0001-B",
          product_id: "prd_qm_crispkettle_tea_biscuits_plain",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price: { amount_minor: 8900, currency: "INR" },
          line_total: { amount_minor: 8900, currency: "INR" },
        },
      ],
      breakdown: {
        merchandise: { amount_minor: 8900, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 11912, currency: "INR" },
      },
    },
    offers: [
      {
        offer_id: "ofr_01HZA",
        strategy_type: "FBT",
        cart_patch: { patch_type: "ADD_ITEM", lines: [{ sku_id: "QM-SNK-0002-A", quantity: 1, op: "ADD" }] },
        buyer_impact: { amount_minor: 1900, currency: "INR" },
      },
    ],
    invalidated_offer_ids: ["ofr_01HZZ"],
  };
  const visible = modelVisibleApplyOffer(payload, "OK", { offer_id: "ofr_01HZZ" });
  assert.deepEqual(visible, {
    applied_offer_id: "ofr_01HZZ",
    cart: {
      cart_id: "crt_01HZX",
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZY",
          sku_id: "QM-SNK-0001-B",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price_minor: 8900,
          line_total_minor: 8900,
        },
      ],
      breakdown: {
        merchandise_minor: 8900,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 11912,
      },
    },
  });
  assert.deepEqual(modelVisibleToolResult("apply_offer", "OK", payload, { offer_id: "ofr_01HZZ" }), visible);
  assert.equal("result_code" in visible, false);
  assert.equal("offers" in visible, false);
  assert.equal("invalidated_offer_ids" in visible, false);
  assert.equal("envelope" in visible, false);
  assert.equal("public_state" in visible, false);
  assert.deepEqual(modelVisibleApplyOffer({ error: { message: "offer expired" } }, "OFFER_EXPIRED"), {
    result_code: "OFFER_EXPIRED",
    message: "offer expired",
  });
});

test("remove_cart_item empty cart still exposes flattened totals and empty offers", () => {
  const visible = modelVisibleToolResult("remove_cart_item", "OK", {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 3,
      location_id: "loc_qm_koramangala",
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:08.000Z",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "ACTIVE",
      cart_id: "crt_01HZX",
      cart_version: 3,
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      session_id: "ses_01HZX",
      cart_version: 3,
      currency: "INR",
      lines: [],
      breakdown: {
        merchandise: { amount_minor: 0, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 3012, currency: "INR" },
      },
    },
  });
  assert.deepEqual(visible, {
    result_code: "OK",
    cart: {
      cart_id: "crt_01HZX",
      currency: "INR",
      lines: [],
      breakdown: {
        merchandise_minor: 0,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 3012,
      },
    },
    offers: [],
    invalidated_offer_ids: [],
  });
});

test("prepare_checkout model view is slim proposal; quote_hash and public_state stay off the model", () => {
  const payload = {
    result_code: "OK",
    request_id: "req_01HZX",
    public_state: {
      session_id: "ses_01HZX",
      cart_id: "crt_01HZX",
      session_context_version: 1,
      cart_version: 2,
      location_id: "loc_qm_koramangala",
      checkout_proposal_id: "prp_01HZX",
      checkout_proposal: {
        checkout_proposal_id: "prp_01HZX",
        quote_hash: "a3f1c9e8b2d04f11",
        payment_capability_id: "pcap_razorpay_test",
        status: "ACTIVE",
      },
    },
    envelope: {
      contract_version: "atlas.merchant.v1",
      request_id: "req_01HZX",
      occurred_at: "2026-09-05T04:50:11.000Z",
      operation_id: "op_01HZX",
    },
    session_summary: {
      session_id: "ses_01HZX",
      session_context_version: 1,
      location_id: "loc_qm_koramangala",
      status: "CHECKOUT_HELD",
      cart_id: "crt_01HZX",
      cart_version: 2,
      currency: "INR",
    },
    cart: {
      cart_id: "crt_01HZX",
      cart_version: 2,
      currency: "INR",
      lines: [
        {
          cart_line_id: "cln_01HZY",
          sku_id: "QM-SNK-0001-B",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price: { amount_minor: 8900, currency: "INR" },
          line_total: { amount_minor: 8900, currency: "INR" },
        },
      ],
      breakdown: {
        merchandise: { amount_minor: 8900, currency: "INR" },
        discounts: { amount_minor: 0, currency: "INR" },
        delivery_fee: { amount_minor: 3000, currency: "INR" },
        handling_fee: { amount_minor: 12, currency: "INR" },
        tax: { amount_minor: 0, currency: "INR" },
        all_in_total: { amount_minor: 11912, currency: "INR" },
      },
    },
    checkout_proposal: {
      checkout_proposal_id: "prp_01HZX",
      session_id: "ses_01HZX",
      session_context_version: 1,
      cart_id: "crt_01HZX",
      cart_version: 2,
      quote_hash: "a3f1c9e8b2d04f11",
      final_amount: { amount_minor: 11912, currency: "INR" },
      payment_capability_id: "pcap_razorpay_test",
      hold_expires_at: "2026-09-05T04:52:11.000Z",
      proposal_expires_at: "2026-09-05T04:52:11.000Z",
      status: "ACTIVE",
      location_id: "loc_qm_koramangala",
      breakdown: {
        all_in_total: { amount_minor: 11912, currency: "INR" },
      },
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          quantity: 1,
          unit_price: { amount_minor: 8900, currency: "INR" },
          line_total: { amount_minor: 8900, currency: "INR" },
        },
      ],
    },
  };
  const visible = modelVisiblePrepareCheckout(payload, "OK");
  assert.deepEqual(visible, {
    result_code: "OK",
    checkout_proposal: {
      checkout_proposal_id: "prp_01HZX",
      currency: "INR",
      lines: [
        {
          sku_id: "QM-SNK-0001-B",
          name: "Tea Biscuits Plain - family pack",
          quantity: 1,
          unit_price_minor: 8900,
          line_total_minor: 8900,
        },
      ],
      breakdown: {
        merchandise_minor: 8900,
        discounts_minor: 0,
        delivery_fee_minor: 3000,
        handling_fee_minor: 12,
        tax_minor: 0,
        all_in_total_minor: 11912,
      },
      expires_at: "2026-09-05T04:52:11.000Z",
    },
  });
  assert.deepEqual(modelVisibleToolResult("prepare_checkout", "OK", payload), visible);
  assert.equal("quote_hash" in (visible.checkout_proposal as Record<string, unknown>), false);
  assert.equal("payment_capability_id" in (visible.checkout_proposal as Record<string, unknown>), false);
  assert.equal("public_state" in visible, false);
  assert.equal("envelope" in visible, false);
  assert.equal("session_summary" in visible, false);
  assert.equal("cart" in visible, false);
  assert.deepEqual(modelVisiblePrepareCheckout({ error: { message: "cart is empty" } }, "INVALID_ARGUMENT"), {
    result_code: "INVALID_ARGUMENT",
    message: "cart is empty",
  });
});
