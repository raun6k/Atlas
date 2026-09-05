import assert from "node:assert/strict";
import { test } from "node:test";
import { applyResultToState, enrichPublicToolArgs, publicFactsFromPayload } from "./projector.js";

test("live Gateway get_capabilities projects payment_capabilities", () => {
  const payload = {
    result_code: "OK",
    public_state: {},
    envelope: { contract_version: "atlas.merchant.v1" },
    capabilities: {
      payment: { capability_id: "pcap_razorpay_test", provider: "razorpay", environment: "test" },
      contract_version: "atlas.merchant.v1",
    },
  };
  const facts = publicFactsFromPayload(payload);
  assert.equal(facts.payment_capabilities?.[0]?.capability_id, "pcap_razorpay_test");
  const next = applyResultToState(
    {},
    { ok: true, resultCode: "OK", retryable: false, payload, publicStatePatch: {}, requestId: "req_1" },
  );
  assert.equal(next.payment_capabilities?.[0]?.capability_id, "pcap_razorpay_test");
  assert.equal(next.contract_version, "atlas.merchant.v1");
});

test("live Gateway nested cart and proposal remain available to the model loop", () => {
  const facts = publicFactsFromPayload({
    session_summary: {
      session_id: "ses_1",
      cart_id: "cart_1",
      session_context_version: 1,
      cart_version: 2,
      location_id: "loc_qm_koramangala",
    },
    cart: {
      cart_id: "cart_1",
      cart_version: 2,
      lines: [{ sku_id: "sku_qm_eggs_white_6", quantity: 1 }],
      totals: { merchandise_minor: 6200, delivery_minor: 3500, total_minor: 9700, currency: "INR" },
    },
    proposal: { checkout_proposal_id: "cpo_1", final_amount_minor: 9700 },
  });
  assert.equal(facts.session_id, "ses_1");
  assert.equal(facts.lines?.[0]?.sku_id, "sku_qm_eggs_white_6");
  assert.equal(facts.totals?.total_minor, 9700);
  assert.equal(facts.checkout_proposal?.checkout_proposal_id, "cpo_1");
});

test("Host enrichment keeps only arguments in the selected public tool schema", () => {
  const args = enrichPublicToolArgs({
    tool: "add_cart_item",
    args: { sku_id: "sku_qm_eggs_white_6", quantity: 1, expected_session_context_version: 4 },
    state: { session_id: "ses_1", cart_id: "cart_1", cart_version: 2, session_context_version: 4 },
    runId: "run_1",
  });
  assert.deepEqual(args, {
    sku_id: "sku_qm_eggs_white_6",
    quantity: 1,
    session_id: "ses_1",
    cart_id: "cart_1",
    expected_cart_version: 2,
  });
});

test("normalized numeric versions win over raw Gateway public_state strings", () => {
  const next = applyResultToState(
    {},
    {
      ok: true,
      resultCode: "OK",
      retryable: false,
      requestId: "req_1",
      publicStatePatch: { cart_version: "2" as unknown as number },
      payload: { cart: { cart_id: "cart_1", cart_version: "2", lines: [] } },
    },
  );
  assert.equal(next.cart_version, 2);
  assert.equal(typeof next.cart_version, "number");
});

test("complete checkout projects the order identifier for follow-up reads", () => {
  const next = publicFactsFromPayload({
    merchant_order_id: "ord_123",
    order: { merchant_order_id: "ord_123", payment_public_status: "PAYMENT_PROCESSING" },
  });
  assert.equal(next.merchant_order_id, "ord_123");
  assert.equal(next.payment_status, "PAYMENT_PROCESSING");
});

test("Host public state drops substitution fields from Atlas orders", () => {
  const facts = publicFactsFromPayload({
    order: {
      merchant_order_id: "ord_1",
      status: "CONFIRMED",
      substitutions: [{ substitution_request_id: "sub_1", status: "OPEN" }],
      substitution: { substitution_request_id: "sub_1" },
    },
  });
  assert.equal(facts.merchant_order_id, "ord_1");
  assert.equal(facts.order && "substitutions" in facts.order, false);
  assert.equal(facts.order && "substitution" in facts.order, false);
  assert.equal(JSON.stringify(facts).toLowerCase().includes("substitut"), false);
});

test("Host injects merchant_order_id onto get_order", () => {
  const args = enrichPublicToolArgs({
    tool: "get_order",
    args: { session_id: "ses_stale", merchant_order_id: "ord_stale" },
    state: { session_id: "ses_1", merchant_order_id: "ord_123" },
    runId: "run_1",
  });
  assert.deepEqual(args, { session_id: "ses_1", merchant_order_id: "ord_123" });
});

test("create_session does not invent a default neighbourhood", () => {
  const args = enrichPublicToolArgs({
    tool: "create_session",
    args: {},
    state: {},
    runId: "run_1",
  });
  assert.equal(args.subject_reference, "lab:run_1");
  assert.equal(args.delivery_serviceability_reference, undefined);
  assert.equal(args.requested_location_id, undefined);
});

test("Host overwrites stale cart versions from public_state", () => {
  const args = enrichPublicToolArgs({
    tool: "remove_cart_item",
    args: { cart_line_id: "cln_old", expected_cart_version: 0, session_id: "ses_stale" },
    state: { session_id: "ses_1", cart_id: "cart_1", cart_version: 3 },
    runId: "run_1",
  });
  assert.equal(args.session_id, "ses_1");
  assert.equal(args.cart_id, "cart_1");
  assert.equal(args.expected_cart_version, 3);
  assert.equal(args.cart_line_id, "cln_old");
});

test("create_session keeps buyer-supplied delivery refs", () => {
  const args = enrichPublicToolArgs({
    tool: "create_session",
    args: { delivery_ref: "blr_bellandur", location_id: "loc_qm_bellandur" },
    state: {},
    runId: "run_1",
  });
  assert.equal(args.delivery_serviceability_reference, "blr_bellandur");
  assert.equal(args.requested_location_id, "loc_qm_bellandur");
});

test("create_session can stamp a fixture buyer id", () => {
  const args = enrichPublicToolArgs({
    tool: "create_session",
    args: { delivery_serviceability_reference: "blr_koramangala_5th_block" },
    state: {},
    runId: "run_1",
    subjectReference: "buyer_qm_01",
  });
  assert.equal(args.subject_reference, "buyer_qm_01");
});

test("set_intent Host constraints overwrite model constraints", () => {
  const args = enrichPublicToolArgs({
    tool: "set_intent",
    args: { mission: "veg snacks", planning_budget_minor: 40000, constraints: { dietary: "model" } },
    state: { session_id: "ses_1", session_context_version: 1 },
    runId: "run_1",
    constraints: { dietary: "veg" },
  });
  assert.deepEqual(args.constraints, { dietary: "veg" });
});
