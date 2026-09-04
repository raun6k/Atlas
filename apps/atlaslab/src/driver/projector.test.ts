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
