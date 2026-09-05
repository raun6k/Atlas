import assert from "node:assert/strict";
import { test } from "node:test";
import { BANANA_SKU, BEV_SKU, DEFAULT_LOCATION_ID, isDiscoverable, loadFixtureWorld, offerAt } from "./world.js";

test("fixture world loads Quickmart pack fees and banana offer", () => {
  const world = loadFixtureWorld();
  assert.equal(world.snapshot_id, "fix_quickmart_v1");
  assert.match(world.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(world.fees.currency, "INR");
  assert.equal(world.fees.base_delivery_fee_minor, 3000);
  assert.equal(world.fees.base_handling_fee_minor, 12);
  assert.equal(world.fees.small_order_fee_minor, 3000);
  assert.equal(world.fees.prices_include_tax, true);
  const banana = offerAt(world, DEFAULT_LOCATION_ID, BANANA_SKU);
  assert.ok(banana);
  assert.equal(banana?.selling_price_minor, 5650);
  const bev = offerAt(world, DEFAULT_LOCATION_ID, BEV_SKU);
  assert.equal(bev?.selling_price_minor, 3300);
  assert.ok(world.promotions.some((p) => p.promotion_id === "promo_qm_bev_basket_02"));
  const bananaSku = world.skus.get(BANANA_SKU);
  const product = bananaSku ? world.products.get(bananaSku.product_id) : undefined;
  assert.equal(product?.brand, "GreenBasket");
  assert.equal(product?.category, "fresh_produce");
  assert.equal(isDiscoverable(banana!), true);
  assert.ok(world.offers.some((o) => o.assorted && !isDiscoverable(o)));
});
