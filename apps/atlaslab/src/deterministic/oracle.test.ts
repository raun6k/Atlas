import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCase, extractAllInMinor, quoteCart } from "./oracle.js";
import { BANANA_SKU, BEV_PROMO_ID, BEV_SKU, DEFAULT_LOCATION_ID, PRODUCE_PROMO_ID, loadFixtureWorld } from "./world.js";

test("oracle quotes banana without calling Atlas", () => {
  const world = loadFixtureWorld();
  const q = quoteCart(world, DEFAULT_LOCATION_ID, [{ sku_id: BANANA_SKU, quantity: 1 }], []);
  assert.equal(q.merchandise_minor, 5650);
  assert.equal(q.discounts_minor, 0);
  assert.equal(q.delivery_fee_minor, 3000);
  assert.equal(q.small_order_fee_minor, 3000);
  assert.equal(q.handling_fee_minor, 3012);
  assert.equal(q.tax_minor, 0);
  assert.equal(q.all_in_minor, 5650 + 3000 + 12 + 3000);
});

test("oracle applies only declared beverage basket promo", () => {
  const world = loadFixtureWorld();
  const q = quoteCart(world, DEFAULT_LOCATION_ID, [{ sku_id: BEV_SKU, quantity: 2 }], [BEV_PROMO_ID]);
  assert.equal(q.merchandise_minor, 6600);
  assert.equal(q.discounts_minor, 6500);
  assert.deepEqual(q.applied_promotion_ids, [BEV_PROMO_ID]);
  const none = quoteCart(world, DEFAULT_LOCATION_ID, [{ sku_id: BEV_SKU, quantity: 2 }], []);
  assert.equal(none.discounts_minor, 0);
});

test("declared produce basket on two bananas matches Core PriceCart stacking", () => {
  const world = loadFixtureWorld();
  const q = quoteCart(world, DEFAULT_LOCATION_ID, [{ sku_id: BANANA_SKU, quantity: 2 }], [PRODUCE_PROMO_ID]);
  assert.equal(q.merchandise_minor, 11300);
  assert.equal(q.discounts_minor, 7000);
  assert.equal(q.all_in_minor, 4300 + 3000 + 12 + 3000);
});

test("extractAllInMinor reads Atlas breakdown money objects", () => {
  assert.equal(
    extractAllInMinor({
      cart: { breakdown: { merchandise: { amount_minor: 5650 }, all_in_total: { amount_minor: 11662 } } },
    }),
    11662,
  );
});

test("search_sku oracle requires seeded banana id in MCP payload", () => {
  const world = loadFixtureWorld();
  const pass = evaluateCase({
    case_id: "search_sku",
    dimension: "COMMERCE",
    world,
    traces: [{ tool: "search_catalog", arguments: {}, result_code: "OK", payload: { results: [{ sku_id: BANANA_SKU }] } }],
  });
  assert.equal(pass.result, "PASS");
  const fail = evaluateCase({
    case_id: "search_sku",
    dimension: "COMMERCE",
    world,
    traces: [{ tool: "search_catalog", arguments: {}, result_code: "OK", payload: { results: [{ sku_id: "QM-OTHER" }] } }],
  });
  assert.equal(fail.result, "FAIL");
});

test("requote hook skip is NOT_EVALUATED", () => {
  const world = loadFixtureWorld();
  const skipped = evaluateCase({
    case_id: "requote",
    dimension: "STATE_SAFETY",
    world,
    traces: [],
    skipReason: "HOOK_UNAVAILABLE",
  });
  assert.equal(skipped.result, "NOT_EVALUATED");
  assert.equal(skipped.reason, "HOOK_UNAVAILABLE");
});
