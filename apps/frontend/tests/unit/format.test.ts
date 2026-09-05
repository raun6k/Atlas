import { describe, expect, it } from "vitest";
import { displayCell, humanize, looksLikeEnum } from "@/lib/format";

describe("humanize", () => {
  it("maps payment and attention enumerations into English", () => {
    expect(humanize("CAPTURED_RECONCILED")).toBe("Captured");
    expect(humanize("OUTCOME_UNKNOWN")).toBe("Outcome unknown");
    expect(humanize("UNRESOLVED_MONEY")).toBe("Unresolved money");
    expect(humanize("PROVIDER_EVIDENCE_EVALUATED")).toBe("Provider evidence evaluated");
    expect(humanize("FREE_DELIVERY")).toBe("Free delivery");
    expect(humanize("SMALL_ORDER")).toBe("Small order");
    expect(humanize("FAILED_VERIFIED")).toBe("Failed — verified");
  });

  it("sentence-cases unknown SCREAMING_SNAKE values", () => {
    expect(humanize("WEBHOOK_BINDING_PENDING")).toBe("Webhook binding pending");
    expect(humanize("HIGH")).toBe("High");
  });

  it("leaves operator copy and identifiers alone", () => {
    expect(humanize("ord_demo_confirmed")).toBe("ord_demo_confirmed");
    expect(humanize("merchant_net_revenue_per_eligible_buyer_journey")).toBe(
      "Merchant net revenue per eligible buyer journey",
    );
    expect(humanize("Payment captured at provider; webhook binding pending.")).toBe(
      "Payment captured at provider; webhook binding pending.",
    );
    expect(humanize(null)).toBe("unavailable");
    expect(displayCell("")).toBe("—");
  });

  it("detects enumerations without treating ids as enums", () => {
    expect(looksLikeEnum("CAPTURED_RECONCILED")).toBe(true);
    expect(looksLikeEnum("CONFIRMED")).toBe(true);
    expect(looksLikeEnum("ord_demo_confirmed")).toBe(false);
    expect(looksLikeEnum("QuickMart")).toBe(false);
  });
});
