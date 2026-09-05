import assert from "node:assert/strict";
import { test } from "node:test";
import { SECRET_CANARIES } from "../redaction.js";
import type { PublicState, ToolExchangeRecord } from "../types.js";
import {
  buildTrajectory,
  computeProof,
  evaluateStages,
  extractRevenueMinor,
  paymentAssurance,
} from "./proof.js";

const ex = (tool: string): ToolExchangeRecord => ({
  tool_exchange_id: `tex_${tool}`,
  run_id: "run_x",
  tool_name: tool,
  canonical_argument_digest: "d",
  idempotency_key: null,
  request_status: "OK",
  result_status: "OK",
  latency_ms: 1,
  atlas_ids: null,
  proposed_arguments: {},
  host_enriched_request: null,
  atlas_response: {},
  returned_to_driver: null,
});

test("nine stages; offer is N/A when unused", () => {
  const state: PublicState = { lines: [{ sku_id: "sku_a", quantity: 1 }], payment_status: "CAPTURED_RECONCILED", order: { order_id: "ord_1" } };
  const stages = evaluateStages(
    ["get_capabilities", "search_catalog", "add_cart_item", "prepare_checkout", "complete_checkout", "get_order"].map(ex),
    state,
  );
  assert.equal(stages.length, 9);
  assert.equal(stages.find((s) => s.stage === "REVENUE_ELIGIBLE")?.result, "NOT_REACHED");
  assert.equal(stages.find((s) => s.stage === "OFFER_DECISION")?.result, "NOT_APPLICABLE");
  assert.equal(stages.find((s) => s.stage === "PAYMENT_RECONCILED")?.result, "PASS");
});

test("OUTCOME_UNKNOWN is unresolved, not failed", () => {
  const assurance = paymentAssurance({ outcome_unknown: true, payment_status: "OUTCOME_UNKNOWN", effectful_payment_frozen: true });
  assert.equal(assurance.display_state, "UNRESOLVED");
  assert.equal(assurance.frozen, true);
  const proof = computeProof({
    run: { run_id: "run_u" } as never,
    state: { outcome_unknown: true, checkout_proposal: {} },
    exchanges: ["get_capabilities", "search_catalog", "add_cart_item", "prepare_checkout", "complete_checkout"].map(ex),
    events: [],
  });
  assert.equal(proof.commerce_outcome, "UNRESOLVED");
  assert.equal(proof.failures.some((f) => f.domain === "EXTERNAL_PROVIDER_UNCERTAINTY"), true);
});

test("missing events stay UNAVAILABLE_SOURCE_EVIDENCE", () => {
  const proof = computeProof({
    run: { run_id: "run_empty" } as never,
    state: {},
    exchanges: [],
    events: [],
  });
  assert.equal(proof.source, "UNAVAILABLE_SOURCE_EVIDENCE");
});

test("missing revenue is undefined, never zero-filled", () => {
  assert.equal(extractRevenueMinor({}), undefined);
  assert.equal(extractRevenueMinor({ payment_status: "CAPTURED_RECONCILED", totals: { merchandise_minor: 1, delivery_minor: 0, total_minor: 0, currency: "INR" } }), undefined);
  assert.equal(extractRevenueMinor({ outcome_unknown: true, totals: { merchandise_minor: 1, delivery_minor: 0, total_minor: 16700, currency: "INR" } }), undefined);
});

test("trajectory redacts host secrets", () => {
  const steps = buildTrajectory(
    [
      {
        event_id: "evt_1",
        run_id: "run_x",
        record_sequence: 1,
        source: "HOST_BOUNDARY",
        kind: "SIGNED",
        occurred_at: "2026-09-04T00:00:00Z",
        payload: { host_bearer: SECRET_CANARIES.HOST_BEARER, tool: "create_session" },
      },
    ],
    [SECRET_CANARIES.HOST_BEARER],
  );
  assert.equal(steps[0]?.lane, "HOST");
  assert.equal(JSON.stringify(steps).includes(SECRET_CANARIES.HOST_BEARER), false);
  assert.equal(JSON.stringify(steps).includes("[REDACTED]"), true);
});
