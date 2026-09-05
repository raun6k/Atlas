import assert from "node:assert/strict";
import { test } from "node:test";
import { BANANA_SKU, DEFAULT_LOCATION_ID, loadFixtureWorld } from "../deterministic/world.js";
import { gradeTrajectory } from "./trajectory.js";
import { evaluateMission } from "./metrics.js";
import { pairRpas, portfolioDelta } from "./rpas.js";
import {
  compatibilityMissions,
  commercialPortfolioMissions,
  expectedCommercialSessions,
  expectedCompatibilitySessions,
  isolateOneStrategyCells,
  missionById,
  sittingCommercialMission,
  DEFAULT_TREATMENT_STRATEGY,
} from "./missions.js";
import type { LiveMission } from "./missions.js";
import { quoteCart, type ToolTrace } from "../deterministic/oracle.js";
import { completeEvidence } from "../evaluator/evidence.js";
import { canonicalize } from "../canonical.js";

const breakfast = (): LiveMission => missionById("breakfast_180")!;

function tracesHappyPath(): ToolTrace[] {
  return [
    { tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} },
    {
      tool: "create_session",
      arguments: { requested_location_id: DEFAULT_LOCATION_ID },
      result_code: "OK",
      payload: { session_summary: { session_id: "ses_1", location_id: DEFAULT_LOCATION_ID } },
    },
    {
      tool: "set_intent",
      arguments: { mission: "breakfast", planning_budget_minor: 18000 },
      result_code: "OK",
      payload: {},
    },
    {
      tool: "search_catalog",
      arguments: { query: "banana" },
      result_code: "OK",
      payload: { results: [{ sku_id: BANANA_SKU }] },
    },
    {
      tool: "add_cart_item",
      arguments: { sku_id: BANANA_SKU, quantity: 1 },
      result_code: "OK",
      payload: {
        cart: {
          lines: [{ sku_id: BANANA_SKU, quantity: 1 }],
          breakdown: { all_in_total: { amount_minor: 11662 }, merchandise: { amount_minor: 5650 }, discounts: { amount_minor: 0 } },
        },
      },
    },
    {
      tool: "prepare_checkout",
      arguments: {},
      result_code: "OK",
      payload: {
        checkout_proposal: { checkout_proposal_id: "cpo_1" },
        cart: {
          lines: [{ sku_id: BANANA_SKU, quantity: 1 }],
          breakdown: { all_in_total: { amount_minor: 11662 } },
        },
      },
    },
    {
      tool: "complete_checkout",
      arguments: { checkout_proposal_id: "cpo_1" },
      result_code: "OK",
      payload: { payment_status: "CAPTURED_RECONCILED", cart: { lines: [{ sku_id: BANANA_SKU, quantity: 1 }], breakdown: { all_in_total: { amount_minor: 11662 } } } },
    },
    {
      tool: "get_order",
      arguments: {},
      result_code: "OK",
      payload: { payment_status: "CAPTURED_RECONCILED" },
    },
  ];
}

test("core live missions exclude the retired nightly set", () => {
  const ids = compatibilityMissions().map((m) => m.mission_id);
  assert.deepEqual(ids, [
    "breakfast_180",
    "cola_disambiguation",
    "vegetarian_constraint",
    "adversarial_copy",
  ]);
  assert.equal(ids.includes("occ_recovery"), false);
  assert.equal(ids.includes("crispkettle_only"), false);
  assert.deepEqual(
    commercialPortfolioMissions().map((m) => m.mission_id),
    ["breakfast_180", "party_snacks", "fee_threshold"],
  );
  assert.deepEqual(
    isolateOneStrategyCells().map((c) => c.strategy),
    ["FREE_DELIVERY", "SMALL_ORDER", "BRAND_PROMO"],
  );
  assert.equal(expectedCompatibilitySessions(), 4);
  assert.equal(expectedCommercialSessions(), 12);
  assert.ok(missionById("party_snacks"));
  assert.equal(sittingCommercialMission().mission_id, "fee_threshold");
  assert.equal(DEFAULT_TREATMENT_STRATEGY, "SMALL_ORDER");
});

test("trajectory grades grounded SKUs and paid capture", () => {
  const world = loadFixtureWorld();
  const mission = breakfast();
  const grade = gradeTrajectory({ mission, world, traces: tracesHappyPath(), consentMaxMinor: 250000 });
  assert.equal(grade.invented_sku, false);
  assert.equal(grade.paid, true);
  assert.equal(grade.captured_revenue_minor, 11662);
  assert.equal(grade.checks.find((c) => c.name === "skus_grounded")?.pass, true);
});

test("invented SKU and RPAS zeros", () => {
  const world = loadFixtureWorld();
  const mission = breakfast();
  const traces: ToolTrace[] = [
    { tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} },
    { tool: "create_session", arguments: {}, result_code: "OK", payload: {} },
    { tool: "add_cart_item", arguments: { sku_id: "QM-FAKE-9999-A", quantity: 1 }, result_code: "OK", payload: {} },
  ];
  const grade = gradeTrajectory({ mission, world, traces, consentMaxMinor: 250000 });
  assert.equal(grade.invented_sku, true);
  assert.equal(grade.captured_revenue_minor, 0);
  const failed = evaluateMission({ mission, world, grade });
  const paid = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces: tracesHappyPath(), consentMaxMinor: 250000 }),
  });
  const pair = pairRpas({ mission_id: mission.mission_id, control: failed, treatment: paid });
  assert.equal(pair.control.captured_revenue_minor, 0);
  assert.equal(pair.control.revenue_status, "KNOWN_NO_PURCHASE");
  assert.equal(pair.included_in_rpas, false);
  assert.equal(pair.exclusion_reason, "REVENUE_UNAVAILABLE");
  const port = portfolioDelta([pair]);
  assert.equal(port.control_rpas_minor, null);
  assert.equal(port.treatment_rpas_minor, null);
  assert.equal(port.revenue_status, "INSUFFICIENT_SAMPLE");
});

test("missing intent budget remains canonicalizable in a live report", () => {
  const world = loadFixtureWorld();
  const mission = breakfast();
  const grade = gradeTrajectory({
    mission,
    world,
    traces: [
      { tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} },
      { tool: "create_session", arguments: {}, result_code: "OK", payload: {} },
    ],
    consentMaxMinor: 250000,
  });

  assert.equal(grade.checks.find((c) => c.name === "set_intent_budget")?.actual, null);
  assert.doesNotThrow(() => canonicalize(grade));
});

test("known no-purchase zeros never become confirmed revenue in RPAS aggregates", () => {
  const world = loadFixtureWorld();
  const mission = breakfast();
  const traces: ToolTrace[] = [
    { tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} },
    { tool: "create_session", arguments: {}, result_code: "OK", payload: {} },
  ];
  const control = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces, consentMaxMinor: 250000 }),
  });
  const treatment = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces, consentMaxMinor: 250000 }),
  });
  const pair = pairRpas({ mission_id: mission.mission_id, control, treatment });

  assert.equal(pair.included_in_rpas, true);
  assert.equal(pair.control.revenue_status, "KNOWN_NO_PURCHASE");
  assert.equal(pair.treatment.revenue_status, "KNOWN_NO_PURCHASE");
  assert.equal(pair.revenue_status, "KNOWN_NO_PURCHASE");
  assert.equal(portfolioDelta([pair]).revenue_status, "KNOWN_NO_PURCHASE");
});

test("guardrails exclude treatment safety failures from RPAS", () => {
  const world = loadFixtureWorld();
  const mission = breakfast();
  const control = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces: tracesHappyPath(), consentMaxMinor: 250000 }),
  });
  const unsafeGrade = gradeTrajectory({
    mission,
    world,
    traces: [
      ...tracesHappyPath(),
      { tool: "complete_checkout", arguments: { checkout_proposal_id: "cpo_1" }, result_code: "OK", payload: { payment_status: "CAPTURED_RECONCILED" } },
    ],
    consentMaxMinor: 250000,
  });
  const treatment = evaluateMission({ mission, world, grade: unsafeGrade });
  assert.equal(treatment.safety_failure, true);
  const pair = pairRpas({ mission_id: mission.mission_id, control, treatment });
  assert.equal(pair.included_in_rpas, false);
  assert.equal(pair.exclusion_reason, "CRITICAL_SAFETY_FAILURE");
  assert.equal(pair.guardrails.critical_safety_failure, true);
});

test("SMALL_ORDER on fee_threshold increases merchant net versus banana-only control", () => {
  const world = loadFixtureWorld();
  const fillSku = "QM-SNK-0001-A";
  const controlQuote = quoteCart(world, DEFAULT_LOCATION_ID, [{ sku_id: BANANA_SKU, quantity: 1 }], []);
  const treatmentQuote = quoteCart(world, DEFAULT_LOCATION_ID, [
    { sku_id: BANANA_SKU, quantity: 1 },
    { sku_id: fillSku, quantity: 1 },
  ], []);
  const net = (quote: { all_in_minor: number; delivery_fee_minor: number; handling_fee_minor: number }) =>
    quote.all_in_minor - quote.delivery_fee_minor - quote.handling_fee_minor;
  assert.ok(controlQuote.small_order_fee_minor > 0, "control banana cart should pay the small-order fee");
  assert.equal(treatmentQuote.small_order_fee_minor, 0, "tea biscuits should clear the small-order threshold");
  assert.ok(net(treatmentQuote) > net(controlQuote));
  assert.ok(treatmentQuote.all_in_minor <= 20000);

  const mission = missionById("fee_threshold")!;
  const control = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces: tracesHappyPath(), consentMaxMinor: 250000 }),
    evidence: completeEvidence({
      confirmed_order_amount_minor: controlQuote.all_in_minor,
      fulfillment_cost_minor: controlQuote.delivery_fee_minor + controlQuote.handling_fee_minor,
      merchandise_minor: controlQuote.merchandise_minor,
      units: 1,
    }),
  });
  const treatment = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces: tracesHappyPath(), consentMaxMinor: 250000 }),
    evidence: completeEvidence({
      merchant_order_id: "ord_t",
      payment_attempt_id: "pat_t",
      provider_order_id: "order_t",
      provider_payment_id: "pay_t",
      confirmed_order_amount_minor: treatmentQuote.all_in_minor,
      fulfillment_cost_minor: treatmentQuote.delivery_fee_minor + treatmentQuote.handling_fee_minor,
      merchandise_minor: treatmentQuote.merchandise_minor,
      units: 2,
    }),
  });
  const pair = pairRpas({ mission_id: mission.mission_id, control, treatment });
  assert.equal(pair.included_in_rpas, true);
  assert.ok((pair.delta_merchant_net_minor ?? 0) > 0);
  assert.equal(sittingCommercialMission().mission_id, "fee_threshold");
  assert.equal(DEFAULT_TREATMENT_STRATEGY, "SMALL_ORDER");
});
