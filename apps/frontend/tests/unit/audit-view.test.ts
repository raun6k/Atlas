import { describe, expect, it } from "vitest";
import { projectAuditView, unwrapAtlasLabEnvelope } from "@/lib/audit-view";

describe("canonical audit projection", () => {
  it("unwraps AtlasLab envelopes and retains analytics provenance", () => {
    const envelope = {
      request_id: "req_analytics",
      generated_at: "2026-09-05T12:00:00Z",
      projection_version: "proof_v1",
      data: {
        cohort: "BENCHMARK_ELIGIBLE",
        numerator: 2,
        denominator: 3,
        stages: [{ stage: "ORDER_CONFIRMED", passed: 2, eligible: 3, exclusions: 1 }],
      },
    };

    expect(unwrapAtlasLabEnvelope(envelope).data).toEqual(envelope.data);
    const view = projectAuditView({ analytics: envelope });
    expect(view.sellability.cohort).toBe("BENCHMARK_ELIGIBLE");
    expect(view.sellability.stages.value?.[0]).toEqual({
      stage: "ORDER_CONFIRMED",
      passed: 2,
      eligible: 3,
      exclusions: 1,
    });
    expect(view.sellability.stages.provenance).toMatchObject({
      source: "atlaslab",
      request_id: "req_analytics",
      projection_version: "proof_v1",
    });
  });

  it("selects only canonical report kinds and tags report provenance", () => {
    const view = projectAuditView({
      reports: {
        request_id: "req_reports",
        items: [
          { kind: "CONTRACT", report_id: "contract_1", run_id: "run_1", report: { score: 100 } },
          { kind: "AGENT_COMPATIBILITY", report_id: "compat_1", run_id: "run_2", report: { success: true } },
          {
            kind: "COMMERCIAL_UPLIFT",
            report_id: "uplift_1",
            run_id: "run_3",
            report: {
              provenance: { content_digest: "sha256:abc" },
              portfolio: { eligible_pairs: 0, delta_minor: null },
              proof: {
                eligible_pairs: 0,
                excluded_pairs: [],
                confirmed_orders_by_arm: { control: 0, treatment: 0 },
                captured_revenue_by_arm: { control: 0, treatment: 0 },
                task_success_by_arm: { control: null, treatment: null },
                safety_failures: 0,
                unresolved_payment_count: 0,
                confidence_intervals: { status: "unavailable", reason: "n too small" },
              },
            },
          },
          { kind: "EVALUATION_SITTING", report_id: "ignored" },
        ],
      },
    });

    expect(view.sellability.contract_report.value).toEqual({ score: 100 });
    expect(view.sellability.compatibility_report.value).toEqual({ success: true });
    expect(view.growth.report.provenance).toMatchObject({
      report_id: "uplift_1",
      run_id: "run_3",
      content_digest: "sha256:abc",
    });
    expect(view.growth.proof.state).toBe("available");
    expect(view.growth.proof.value?.eligible_pairs).toBe(0);
    expect(view.growth.portfolio.value).toEqual({ eligible_pairs: 0, delta_minor: null });
    expect(view.growth.uplift_state).toBe("unresolved");
  });

  it("distinguishes missing, unavailable, and unresolved evidence", () => {
    const missing = projectAuditView({});
    expect(missing.growth.report.state).toBe("missing");
    expect(missing.merchant.products.state).toBe("missing");

    const unavailable = projectAuditView({
      error: { state: "unavailable", message: "Core unavailable" },
    });
    expect(unavailable.merchant.profile.state).toBe("unavailable");
    expect(unavailable.merchant.profile.message).toBe("Core unavailable");

    const unavailableBodies = projectAuditView({
      reports: { code: "UNAVAILABLE", message: "AtlasLab offline" },
      products: { code: "UNAVAILABLE", message: "Core offline" },
    });
    expect(unavailableBodies.growth.report.state).toBe("unavailable");
    expect(unavailableBodies.growth.uplift_state).toBe("unavailable");
    expect(unavailableBodies.merchant.products.state).toBe("unavailable");

    const unresolved = projectAuditView({
      payments: [{ assurance: { payment_attempt_id: "pat_1", evidence_status: "UNRESOLVED" } }],
    });
    expect(unresolved.trust.payments.state).toBe("unresolved");
  });

  it("flattens Core order assurance and keeps live merchant data without defaults", () => {
    const view = projectAuditView({
      profile: { envelope: { request_id: "core_1" }, profile: { display_name: "Live Shop", currency: "INR" } },
      products: { products: [{ product_id: "prod_1", name: "Tea" }] },
      inventory: { rows: [{ location_id: "loc_1", sku_id: "sku_1", sellable_quantity: 4 }] },
      payments: [{
        order: { merchant_order_id: "ord_1" },
        detail: {
          envelope: {
            correlation: {
              payment_attempt_id: "pat_1",
              provider_payment_id: "pay_1",
              evidence_status: "CONFIRMED",
            },
          },
          order: { merchant_order_id: "ord_1" },
        },
      }],
    });

    expect(view.merchant.profile.value?.display_name).toBe("Live Shop");
    expect(view.merchant.products.value).toHaveLength(1);
    expect(view.merchant.inventory.value?.[0].sellable_quantity).toBe(4);
    expect(view.trust.payments.value?.[0]).toEqual({
      order: { merchant_order_id: "ord_1" },
      assurance: {
        payment_attempt_id: "pat_1",
        provider_payment_id: "pay_1",
        evidence_status: "CONFIRMED",
      },
    });
    expect(view.merchant.locations.state).toBe("missing");
  });
});
