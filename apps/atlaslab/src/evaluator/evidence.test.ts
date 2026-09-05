import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capturedRevenueMinor,
  completeEvidence,
  contributionMarginMinor,
  evidenceContradiction,
  merchantNetRevenueMinor,
  observationPaid,
  revenueEligible,
  revenueStatus,
  firstArmFromSeed,
} from "./evidence.js";
import { pairRpas, portfolioDelta } from "../model-eval/rpas.js";
import { evaluateMission } from "../model-eval/metrics.js";
import { gradeTrajectory } from "../model-eval/trajectory.js";
import { missionById } from "../model-eval/missions.js";
import { loadFixtureWorld } from "../deterministic/world.js";
import { assertCanonicalCommercialReport } from "./report-invariants.js";

test("CONFIRMED_REVENUE cannot exist without complete provider and Core evidence", () => {
  const complete = completeEvidence();
  assert.equal(revenueEligible(complete), true);
  assert.equal(observationPaid(complete), true);
  assert.equal(capturedRevenueMinor(complete), 15462);
  assert.equal(revenueStatus(complete, false), "CONFIRMED_REVENUE");
  assert.equal(evidenceContradiction(complete, true, "CONFIRMED_REVENUE"), null);

  assert.equal(evidenceContradiction(complete, false, "CONFIRMED_REVENUE"), "CONFIRMED_REVENUE with paid=false");
  assert.equal(
    evidenceContradiction(completeEvidence({ provider_payment_id: null }), true, "CONFIRMED_REVENUE"),
    "CONFIRMED_REVENUE without provider payment ID",
  );
  assert.equal(
    evidenceContradiction(completeEvidence({ core_order_confirmed: false, merchant_order_state: "PENDING_PAYMENT" }), true, "CONFIRMED_REVENUE"),
    "CONFIRMED_REVENUE without Core order confirmation",
  );
  assert.equal(
    evidenceContradiction(completeEvidence({ provider_fetch_ref: null, provider_fetch_match_status: "MATCH" }), true, "CONFIRMED_REVENUE"),
    "CONFIRMED_REVENUE without provider fetch reference",
  );
  assert.equal(revenueEligible(completeEvidence({ provider_payment_id: null })), false);
  assert.equal(capturedRevenueMinor(completeEvidence({ confirmed_order_amount_minor: 0 })), null);
});

test("positive revenue without provider payment ID is not confirmed", () => {
  const ev = completeEvidence({ provider_payment_id: null });
  assert.equal(revenueStatus(ev, false), "REVENUE_UNAVAILABLE");
  assert.equal(observationPaid(ev), false);
});

test("KNOWN_NO_PURCHASE is known zero and distinct from unknown outcomes", () => {
  assert.equal(revenueStatus(null, false, { knownNoPurchase: true }), "KNOWN_NO_PURCHASE");
  assert.equal(revenueStatus(null, true, { knownNoPurchase: true }), "OUTCOME_UNKNOWN");
  assert.equal(evidenceContradiction(null, true, "KNOWN_NO_PURCHASE"), "KNOWN_NO_PURCHASE with captured revenue");
});

test("merchant net adds sponsor funding and does not subtract merchant-funded discounts twice", () => {
  assert.equal(merchantNetRevenueMinor(null), null);
  const complete = completeEvidence({ payment_fee_minor: 200, fulfillment_cost_minor: 300, cogs_minor: 8000 });
  assert.equal(merchantNetRevenueMinor(complete), 15462 - 200 - 300);
  assert.equal(contributionMarginMinor(complete), 15462 - 200 - 300 - 8000);
  assert.equal(merchantNetRevenueMinor(completeEvidence({ provider_order_id: null })), null);
  const discounted = completeEvidence({
    confirmed_order_amount_minor: 14000,
    merchant_funded_discount_minor: 1462,
    sponsor_funded_discount_minor: 500,
    payment_fee_minor: 100,
    fulfillment_cost_minor: 200,
  });
  assert.equal(merchantNetRevenueMinor(discounted), 14000 - 100 - 200 + 500);
  const noFee = completeEvidence({ payment_fee_minor: null, fulfillment_cost_minor: 300, sponsor_funded_discount_minor: 0 });
  assert.equal(merchantNetRevenueMinor(noFee), 15462 - 300);
});

test("first arm is derived from the randomization seed", () => {
  assert.equal(firstArmFromSeed("seed_stable"), firstArmFromSeed("seed_stable"));
  assert.ok(firstArmFromSeed("seed_a") === "CONTROL" || firstArmFromSeed("seed_a") === "TREATMENT");
});

test("eligible pair with unknown outcome is rejected", () => {
  const world = loadFixtureWorld();
  const mission = missionById("breakfast_180")!;
  const unknown = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({
      mission,
      world,
      traces: [
        { tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} },
        { tool: "complete_checkout", arguments: {}, result_code: "OUTCOME_UNKNOWN", payload: { payment_status: "OUTCOME_UNKNOWN" } },
      ],
      consentMaxMinor: 250000,
    }),
  });
  const paid = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({
      mission,
      world,
      traces: [{ tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} }],
      consentMaxMinor: 250000,
    }),
    evidence: completeEvidence(),
  });
  assert.equal(unknown.unknown, true);
  assert.equal(paid.safety_failure, false);
  const pair = pairRpas({ mission_id: mission.mission_id, control: unknown, treatment: paid });
  assert.equal(pair.included_in_rpas, false);
  assert.equal(pair.exclusion_reason, "OUTCOME_UNKNOWN");
  assert.equal(pair.revenue_status, "OUTCOME_UNKNOWN");
});

test("canonical report rejects provenance unknown and aggregate/pair disagreement", () => {
  const control = evaluateMission({
    mission: missionById("breakfast_180")!,
    world: loadFixtureWorld(),
    grade: gradeTrajectory({
      mission: missionById("breakfast_180")!,
      world: loadFixtureWorld(),
      traces: [{ tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} }],
      consentMaxMinor: 250000,
    }),
    evidence: completeEvidence({ merchant_order_id: "ord_c", payment_attempt_id: "pat_c", provider_payment_id: "pay_c" }),
  });
  const treatment = evaluateMission({
    mission: missionById("breakfast_180")!,
    world: loadFixtureWorld(),
    grade: gradeTrajectory({
      mission: missionById("breakfast_180")!,
      world: loadFixtureWorld(),
      traces: [{ tool: "get_capabilities", arguments: {}, result_code: "OK", payload: {} }],
      consentMaxMinor: 250000,
    }),
    evidence: completeEvidence({ merchant_order_id: "ord_t", payment_attempt_id: "pat_t", provider_payment_id: "pay_t", confirmed_order_amount_minor: 18000 }),
  });
  const pair = pairRpas({ mission_id: "breakfast_180", control, treatment });
  const report = {
    kind: "commercial_uplift",
    evaluation_scope: "minimal_pair",
    razorpay_test_mode: true,
    pairs: [pair],
    strategy_cells: [],
    proof: {
      eligible_pairs: 1,
      excluded_pairs: [],
      confirmed_orders_by_arm: { control: 1, treatment: 1 },
      captured_revenue_by_arm: { control: 15462, treatment: 18000 },
      merchant_net_revenue_by_arm: { control: 15462, treatment: 18000 },
      task_success_by_arm: { control: null, treatment: null },
      safety_failures: 0,
      unresolved_payment_count: 0,
      known_no_purchase_count: 0,
    },
    provenance: { code_revision: "unknown", content_digest: "abc" },
  };
  assert.throws(() => assertCanonicalCommercialReport(report), /code_revision=unknown/);

  report.provenance = { code_revision: "deadbeef", content_digest: "abc" };
  assert.doesNotThrow(() => assertCanonicalCommercialReport(report));

  report.proof.captured_revenue_by_arm = { control: 1, treatment: 1 };
  assert.throws(() => assertCanonicalCommercialReport(report), /aggregate proof disagreeing/);
});

test("portfolio does not convert missing evidence into zero", () => {
  const world = loadFixtureWorld();
  const mission = missionById("breakfast_180")!;
  const failed = evaluateMission({
    mission,
    world,
    grade: gradeTrajectory({ mission, world, traces: [], consentMaxMinor: 250000 }),
  });
  const pair = pairRpas({ mission_id: mission.mission_id, control: failed, treatment: failed });
  const port = portfolioDelta([pair]);
  assert.equal(port.control_rpas_minor, null);
  assert.equal(port.treatment_rpas_minor, null);
  assert.equal(port.n, 0);
});
