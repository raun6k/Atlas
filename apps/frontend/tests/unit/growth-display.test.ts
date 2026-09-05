import { describe, expect, it } from "vitest";
import { projectAuditView } from "@/lib/audit-view";
import { growthDisplay } from "@/lib/growth-display";

describe("growth display matches the commercial API projection", () => {
  it("renders eligible pairs, merchant net, and conversion from the live report shape", () => {
    const view = projectAuditView({
      reports: {
        items: [
          {
            kind: "COMMERCIAL_UPLIFT",
            report_id: "uplift_1",
            run_id: "run_1",
            report: {
              operator_assisted: true,
              settlement_status: "NOT_IMPLEMENTED",
              provenance: { content_digest: "sha256:abc", code_revision: "deadbeef" },
              portfolio: {
                delta_merchant_net_minor: 0,
                control_merchant_net_minor: 15462,
                treatment_merchant_net_minor: 15462,
                conversion_by_arm: { control: 1, treatment: 1 },
                aov_by_arm: { control: 15462, treatment: 15462 },
              },
              proof: {
                eligible_pairs: 1,
                excluded_pairs: [],
                confirmed_orders_by_arm: { control: 1, treatment: 1 },
                captured_revenue_by_arm: { control: 15462, treatment: 15462 },
                merchant_net_revenue_by_arm: { control: 15462, treatment: 15462 },
                conversion_by_arm: { control: 1, treatment: 1 },
                aov_by_arm: { control: 15462, treatment: 15462 },
                task_success_by_arm: { control: 0.5, treatment: 0.5 },
                safety_failures: 0,
                unresolved_payment_count: 0,
                known_no_purchase_count: 0,
                primary_metric: "merchant_net_revenue_per_eligible_buyer_journey",
                treatment_strategy: "SMALL_ORDER",
                confidence_intervals: { status: "unavailable" },
              },
            },
          },
        ],
      },
    });

    const display = growthDisplay(view.growth);
    expect(display.eligiblePairs).toBe(1);
    expect(display.controlNet).toBe("15462");
    expect(display.treatmentNet).toBe("15462");
    expect(display.netDelta).toBe("0");
    expect(display.conversionControl).toBe("1");
    expect(display.operatorAssisted).toBe(true);
    expect(display.settlementClaimed).toBe(false);
    expect(view.growth.proof.value?.eligible_pairs).toBe(display.eligiblePairs);
    expect(String(view.growth.proof.value?.captured_revenue_by_arm.control)).toBe(display.controlGross);
  });
});
