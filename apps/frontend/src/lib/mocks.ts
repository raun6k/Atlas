export const MOCK_CONSOLE = {
  claims: {
    banner:
      "Atlas demonstrates controlled Test Mode commercial evidence and payment reconciliation. It does not claim real-world causal revenue uplift.",
    evidence_levels: ["contract", "controlled_test_mode", "real_merchant_unavailable"],
  },
  home: {
    attention: {
      headline: "Unresolved merchant attention items exist.",
      completeness: "COMPLETE",
      items: [
        {
          category: "UNRESOLVED_MONEY",
          severity: "HIGH",
          explanation: "Payment captured at provider; webhook binding pending.",
          next_safe_action: "Inspect provider evidence; do not auto-retry.",
          retry_allowed: false,
        },
        {
          category: "INCOMPLETE_MERCHANT_DATA",
          explanation: "Merchant data incomplete — 12 products have no positive sellable offer.",
          retry_allowed: false,
        },
      ],
    },
    readiness: { state: "partial", message: "Core is ready. AtlasLab reports are partial until a live eval completes." },
    latest_order: {
      merchant_order_id: "ord_demo_confirmed",
      status: "CONFIRMED",
      payment_public_status: "CONFIRMED",
    },
    latest_evidence: { state: "confirmed", message: "Latest confirmed order is backed by provider fetch, not a browser success screen." },
  },
  sellability: {
    mcp: { tools: ["get_capabilities", "create_session", "search_catalog", "prepare_checkout", "complete_checkout", "get_order"], state: "confirmed" },
    schema: { contract: "atlas.merchant.v1", state: "confirmed" },
    buyer_journey: { state: "measured", message: "Agent run completed, but this run is excluded from the benchmark denominator." },
  },
  growth: {
    eligible_pairs: 0,
    excluded_pairs: [{ reason: "OUTCOME_UNKNOWN" }],
    revenue_uplift: {
      state: "unavailable",
      message: "Revenue uplift unavailable — 0 eligible confirmed-order pairs.",
    },
    confirmed_revenue: { state: "test_mode_only", message: "Captured revenue is Razorpay Test Mode only." },
    caveat: "Atlas demonstrates controlled Test Mode commercial evidence. It does not claim real-world causal revenue uplift.",
  },
  commerce: {
    sessions: [{ session_id: "ses_demo", status: "OPEN", mission: "breakfast under 180" }],
    offers: [{ offer_id: "off_demo", grounded_reason: "Free delivery threshold gap is ₹12.00 on this cart.", strategy_type: "FREE_DELIVERY", status: "ACTIVE" }],
    orders: [{ merchant_order_id: "ord_demo_confirmed", status: "CONFIRMED" }],
    substitutions: { label: "future", message: "Substitution is a research surface, not part of the public MCP contract." },
  },
  merchant: {
    profile: { display_name: "QuickMart Indiranagar", currency: "INR" },
    locations: [{ location_id: "loc_indiranagar", name: "Indiranagar" }],
    catalog: { products: 40, unsellable: 12, message: "Merchant data incomplete — 12 products have no positive sellable offer." },
    campaigns: { label: "future", message: "Campaigns beyond fixture promotions are labeled research." },
    strategies: [{ strategy_type: "FREE_DELIVERY", enabled: true, surface: "demo" }],
  },
  trust: {
    payments: [
      {
        payment_attempt_id: "pat_demo",
        merchant_order_id: "ord_demo_confirmed",
        provider_order_id: "order_rzp_demo",
        provider_payment_id: "pay_rzp_demo",
        webhook_bound: false,
        callback_bound: true,
        fetch_at: "2026-09-05T11:00:00.000Z",
        amount_minor: 24900,
        currency: "INR",
        amount_match: "matched",
        final_state: "CAPTURED_RECONCILED",
        hold_disposition: "converted",
        order_confirmed: true,
        evidence_status: "PARTIAL",
        message: "Payment captured at provider; webhook binding pending.",
        runner_screen_is_not_truth: true,
      },
      {
        payment_attempt_id: "pat_unresolved",
        merchant_order_id: "ord_unresolved",
        final_state: "OUTCOME_UNKNOWN",
        evidence_status: "UNRESOLVED",
        message: "Payment outcome is unknown. Do not display as paid.",
        retry_allowed: false,
        runner_screen_is_not_truth: true,
      },
    ],
    audit: [
      { audit_event_id: "aud_1", event_kind: "PROVIDER_EVIDENCE_EVALUATED", summary_sentence: "Atlas evaluated authenticated provider evidence for a Test Mode payment." },
    ],
  },
  system: {
    status: "ready",
    components: [
      { name: "database", status: "READY", evidence_status: "CONFIRMED", detail: "pool ping ok" },
      { name: "workers", status: "READY", evidence_status: "MEASURED", detail: "0 in-flight jobs" },
      { name: "payment_runner", status: "READY", evidence_status: "MEASURED", detail: "runner jobs recorded" },
      { name: "atlaslab", status: "UNKNOWN", evidence_status: "UNAVAILABLE", detail: "AtlasLab readiness is independent of Core" },
      { name: "provider", status: "READY", evidence_status: "TEST_MODE_ONLY", detail: "Razorpay Test Mode" },
    ],
  },
};

export const MOCK_REPORT = {
  kind: "commercial_uplift",
  razorpay_test_mode: true,
  forbidden_claim: "real-world causal uplift",
  proof: {
    eligible_pairs: 0,
    excluded_pairs: [{ mission_id: "breakfast_180", reason: "Agent run completed, but this run is excluded from the benchmark denominator." }],
    confirmed_orders_by_arm: { control: 0, treatment: 0 },
    captured_revenue_by_arm: { control: 0, treatment: 0 },
    task_success_by_arm: { control: null, treatment: null },
    safety_failures: 0,
    unresolved_payment_count: 1,
    confidence_intervals: { status: "unavailable", reason: "n is too small for inferential intervals." },
    next_claim_level: { current: "Revenue uplift unavailable — 0 eligible confirmed-order pairs." },
  },
  caveat: "Test Mode does not support a real-world causal uplift claim.",
};
