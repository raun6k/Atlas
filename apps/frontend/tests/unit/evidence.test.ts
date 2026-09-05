import { describe, expect, it } from "vitest";
import { metricFromOutcome, neverZeroMissing } from "@/lib/evidence";

describe("evidence metrics", () => {
  it("does not present missing evidence as zero", () => {
    const m = metricFromOutcome({ name: "revenue_uplift", evidence: "UNAVAILABLE", value: 0, value_present: false });
    expect(m.present).toBe(false);
    expect(m.value).toBeNull();
    expect(neverZeroMissing(m)).toMatch(/not shown as 0/);
  });

  it("marks ineligible real-world uplift", () => {
    const m = metricFromOutcome({ name: "real_world_revenue_uplift", eligible: false, evidence: "INELIGIBLE" });
    expect(m.state).toBe("ineligible");
  });
});
