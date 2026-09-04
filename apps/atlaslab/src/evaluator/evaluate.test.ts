import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allAssertionsHold,
  assertionHolds,
  getByPath,
  progressAssertionsHold,
  type AssertionEvidence,
} from "./evaluate.js";
import type { PublicState } from "../types.js";

const emptyEvidence = (state: PublicState = {}): AssertionEvidence => ({
  state,
  exchanges: [],
  events: [],
  consent: { max_amount_minor: 250000, currency: "INR", capability_id: "pcap_razorpay_test" },
});

test("path/equals reads projected payment_capabilities", () => {
  const assertion = { path: "payment_capabilities.0.capability_id", equals: "pcap_razorpay_test" };
  assert.equal(assertionHolds(assertion, emptyEvidence()), false);
  assert.equal(
    assertionHolds(
      assertion,
      emptyEvidence({
        payment_capabilities: [{ capability_id: "pcap_razorpay_test" }],
      }),
    ),
    true,
  );
  assert.equal(getByPath({ payment_capabilities: [{ capability_id: "pcap_razorpay_test" }] }, "payment_capabilities.0.capability_id"), "pcap_razorpay_test");
});

test("discovery progress assertions pass without an order", () => {
  const assertions = [{ path: "payment_capabilities.0.capability_id", equals: "pcap_razorpay_test" }];
  const evidence = emptyEvidence({
    payment_capabilities: [{ capability_id: "pcap_razorpay_test" }],
  });
  assert.equal(progressAssertionsHold(assertions, evidence), true);
  assert.equal(allAssertionsHold(assertions, evidence), true);
  assert.equal(Boolean(evidence.state.order), false);
});

test("breakfast still requires payment and totals", () => {
  const assertions = [{ totals_total_minor: 16700 }, { payment_status: "CAPTURED_RECONCILED" }];
  assert.equal(allAssertionsHold(assertions, emptyEvidence({ payment_capabilities: [{ capability_id: "pcap_razorpay_test" }] })), false);
  assert.equal(
    allAssertionsHold(
      assertions,
      emptyEvidence({
        totals: { merchandise_minor: 13200, delivery_minor: 3500, total_minor: 16700, currency: "INR" },
        payment_status: "CAPTURED_RECONCILED",
      }),
    ),
    true,
  );
});

test("signer_rejected_overspend is not vacuously ignoring checkout overspend", () => {
  const assertion = { signer_rejected_overspend: true };
  const consentOk = assertionHolds(assertion, emptyEvidence());
  assert.equal(consentOk, true);
  const overspent = assertionHolds(assertion, {
    state: {},
    events: [],
    consent: { max_amount_minor: 100, currency: "INR", capability_id: "pcap_razorpay_test" },
    exchanges: [
      {
        tool_name: "prepare_checkout",
        atlas_response: { totals: { total_minor: 50000 } },
      },
    ],
  });
  assert.equal(overspent, false);
});

test("overspend detection reads the real nested Gateway proposal shape", () => {
  assert.equal(
    assertionHolds(
      { signer_rejected_overspend: true },
      {
        state: {},
        events: [],
        consent: { max_amount_minor: 100, currency: "INR", capability_id: "pcap_razorpay_test" },
        exchanges: [
          {
            tool_name: "prepare_checkout",
            atlas_response: { proposal: { final_amount: { amount_minor: "500", currency: "INR" } } },
          },
        ],
      },
    ),
    false,
  );
});
