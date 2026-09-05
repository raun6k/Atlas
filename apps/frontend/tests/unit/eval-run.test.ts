import { describe, expect, it } from "vitest";
import { DEMO_CONFIRMED_ORDERS } from "@/lib/demo-orders";
import { fixtureEvalResult, isEvalKind, labPayload, summarizeLabResult } from "@/lib/eval-run";

describe("fixture eval numbers", () => {
  it("summarizes a completed fixture run", () => {
    const body = fixtureEvalResult("deterministic");
    expect(summarizeLabResult(body)).toContain("run_fixture_deterministic");
    expect(summarizeLabResult(body)).toContain("12 / 12 passed");
    expect(summarizeLabResult(body)).toContain("fixture result");
  });

  it("accepts known eval kinds only", () => {
    expect(isEvalKind("deterministic")).toBe(true);
    expect(isEvalKind("compatibility")).toBe(true);
    expect(isEvalKind("not-a-kind")).toBe(false);
  });

  it("sends model_id for live model evals and custom prompt for missions", () => {
    expect(labPayload("deterministic")).toEqual({});
    expect(labPayload("compatibility").model_id).toBeTruthy();
    const custom = labPayload("custom", "Buy bananas under 180");
    expect(custom.run_type).toBe("CUSTOM_MISSION");
    expect(custom.custom_user_input).toBe("Buy bananas under 180");
  });
});

describe("demo confirmed orders", () => {
  it("shows a few confirmed tickets with readiness and payment evidence", () => {
    expect(DEMO_CONFIRMED_ORDERS).toHaveLength(3);
    for (const order of DEMO_CONFIRMED_ORDERS) {
      expect(order.status).toBe("CONFIRMED");
      expect(order.readiness.gates).toHaveLength(4);
      expect(order.payment.final_state).toBe("CAPTURED_RECONCILED");
      expect(order.payment.provider_payment_id).toMatch(/^pay_rzp_test_fixture_/);
    }
  });
});
