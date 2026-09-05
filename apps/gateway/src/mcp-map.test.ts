import assert from "node:assert/strict";
import test from "node:test";
import { mcpOk } from "./mcp-map.ts";

test("mcpOk omits empty offers and invalidated_offer_ids", () => {
  const out = mcpOk(
    {
      envelope: { requestId: "req-1" },
      cart: { cartId: "cart_1" },
      offers: [],
      invalidatedOfferIds: [],
    },
    "fallback",
  );
  assert.equal(out.result_code, "OK");
  assert.equal("offers" in out, false);
  assert.equal("invalidated_offer_ids" in out, false);
  assert.equal((out.cart as { cart_id: string }).cart_id, "cart_1");
});

test("mcpOk keeps non-empty offers", () => {
  const out = mcpOk(
    {
      envelope: { requestId: "req-2" },
      offers: [{ offerId: "off_1" }],
    },
    "fallback",
  );
  assert.equal(Array.isArray(out.offers), true);
  assert.equal((out.offers as Array<{ offer_id: string }>)[0].offer_id, "off_1");
});

test("mcpOk drops substitution fields from Atlas MCP JSON", () => {
  const out = mcpOk(
    {
      envelope: { requestId: "req-3" },
      order: {
        merchantOrderId: "ord_1",
        status: "CONFIRMED",
        substitutions: [{ substitutionRequestId: "sub_1", status: "OPEN" }],
        substitution: { substitutionRequestId: "sub_1" },
      },
    },
    "req-3",
  );
  const order = out.order as Record<string, unknown>;
  assert.equal(order.merchant_order_id, "ord_1");
  assert.equal("substitutions" in order, false);
  assert.equal("substitution" in order, false);
  assert.equal(JSON.stringify(out).toLowerCase().includes("substitut"), false);
});
