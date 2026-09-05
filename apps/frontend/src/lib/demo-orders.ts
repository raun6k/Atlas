export interface DemoReadinessGate {
  label: string;
  state: "ready" | "partial";
}

export interface DemoOrder {
  merchant_order_id: string;
  status: "CONFIRMED";
  amount_minor: number;
  currency: "INR";
  location: string;
  items: string[];
  confirmed_at: string;
  readiness: {
    score: string;
    gates: DemoReadinessGate[];
  };
  payment: {
    public_status: "CONFIRMED";
    final_state: "CAPTURED_RECONCILED";
    evidence_status: "CONFIRMED" | "PARTIAL";
    provider_order_id: string;
    provider_payment_id: string;
    amount_match: string;
    webhook_bound: boolean;
    callback_bound: boolean;
    evidence_digest: string;
    message: string;
  };
}

/** Demo checkout tickets. Labeled fixture — not live Razorpay capture. */
export const DEMO_CONFIRMED_ORDERS: DemoOrder[] = [
  {
    merchant_order_id: "ord_qm_fixture_88421",
    status: "CONFIRMED",
    amount_minor: 17640,
    currency: "INR",
    location: "QuickMart Koramangala Dark Store",
    items: ["Robusta bananas", "CrispKettle tea biscuits"],
    confirmed_at: "2026-09-05T08:14:00.000Z",
    readiness: {
      score: "4 / 4",
      gates: [
        { label: "Sellable inventory", state: "ready" },
        { label: "Bound quote", state: "ready" },
        { label: "Fulfilment location", state: "ready" },
        { label: "Payment intent", state: "ready" },
      ],
    },
    payment: {
      public_status: "CONFIRMED",
      final_state: "CAPTURED_RECONCILED",
      evidence_status: "CONFIRMED",
      provider_order_id: "order_rzp_test_fixture_88421",
      provider_payment_id: "pay_rzp_test_fixture_88421",
      amount_match: "matched",
      webhook_bound: true,
      callback_bound: true,
      evidence_digest: "sha256:a41c9e2b7d1f",
      message: "Provider fetch captured this Test Mode payment. The checkout screen is not the evidence.",
    },
  },
  {
    merchant_order_id: "ord_qm_fixture_88418",
    status: "CONFIRMED",
    amount_minor: 21400,
    currency: "INR",
    location: "QuickMart Koramangala Dark Store",
    items: ["FizzyLeaf Sparkling Cola 750 ml"],
    confirmed_at: "2026-09-05T07:41:00.000Z",
    readiness: {
      score: "4 / 4",
      gates: [
        { label: "Sellable inventory", state: "ready" },
        { label: "Bound quote", state: "ready" },
        { label: "Fulfilment location", state: "ready" },
        { label: "Payment intent", state: "ready" },
      ],
    },
    payment: {
      public_status: "CONFIRMED",
      final_state: "CAPTURED_RECONCILED",
      evidence_status: "PARTIAL",
      provider_order_id: "order_rzp_test_fixture_88418",
      provider_payment_id: "pay_rzp_test_fixture_88418",
      amount_match: "matched",
      webhook_bound: false,
      callback_bound: true,
      evidence_digest: "sha256:c0e8d44a91b3",
      message: "Captured at provider; webhook binding pending. Still a confirmed Test Mode order.",
    },
  },
  {
    merchant_order_id: "ord_qm_fixture_88412",
    status: "CONFIRMED",
    amount_minor: 38950,
    currency: "INR",
    location: "QuickMart Indiranagar Dark Store",
    items: ["CrispKettle tea biscuits", "QuickMart party snack pack"],
    confirmed_at: "2026-09-04T18:22:00.000Z",
    readiness: {
      score: "4 / 4",
      gates: [
        { label: "Sellable inventory", state: "ready" },
        { label: "Bound quote", state: "ready" },
        { label: "Fulfilment location", state: "ready" },
        { label: "Payment intent", state: "ready" },
      ],
    },
    payment: {
      public_status: "CONFIRMED",
      final_state: "CAPTURED_RECONCILED",
      evidence_status: "CONFIRMED",
      provider_order_id: "order_rzp_test_fixture_88412",
      provider_payment_id: "pay_rzp_test_fixture_88412",
      amount_match: "matched",
      webhook_bound: true,
      callback_bound: true,
      evidence_digest: "sha256:91f3b6aa02ce",
      message: "Provider fetch, amount match, and Core confirmation agree.",
    },
  },
];
