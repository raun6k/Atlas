export interface AssuranceView {
  payment_attempt_id?: string;
  provider_order_id?: string;
  provider_payment_id?: string;
  authenticated_provider_event_ref?: string;
  provider_fetch_ref?: string;
  event_binding_status?: string;
  webhook_bound?: string | boolean;
  callback_bound?: string | boolean;
  fetch_at?: string;
  amount_match?: string;
  final_state?: string;
  reconciliation_state?: string;
  hold_disposition?: string;
  evidence_status?: string;
  assurance_message?: string;
  message?: string;
  runner_screen_is_not_truth?: string | boolean;
  order_confirmed?: string | boolean;
  retry_allowed?: string | boolean;
  settlement_status?: string;
  assurance_projection_version?: string;
}

export function PaymentAssuranceCard({ card }: { card: AssuranceView | null | undefined }) {
  if (!card) {
    return (
      <article className="card" data-testid="payment-assurance">
        <p className="kicker">unavailable</p>
        <h3>Payment assurance</h3>
        <p>No provider-backed payment evidence is loaded. Browser success is never treated as paid.</p>
      </article>
    );
  }
  const bound = String(card.webhook_bound) === "true";
  return (
    <article className="card" data-testid="payment-assurance">
      <p className="kicker">{(card.evidence_status ?? "partial").toLowerCase()}</p>
      <h3>Payment assurance</h3>
      <dl className="grid">
        <dt>Payment attempt</dt>
        <dd>{card.payment_attempt_id || "unavailable"}</dd>
        <dt>Provider order</dt>
        <dd>{card.provider_order_id || "unavailable"}</dd>
        <dt>Provider payment</dt>
        <dd>{card.provider_payment_id || "unavailable"}</dd>
        <dt>Authenticated provider event</dt>
        <dd>{card.authenticated_provider_event_ref || "unavailable"}</dd>
        <dt>Provider fetch evidence</dt>
        <dd>{card.provider_fetch_ref || "unavailable"}</dd>
        <dt>Webhook binding</dt>
        <dd>{bound ? "present" : "pending"}</dd>
        <dt>Callback binding</dt>
        <dd>{String(card.callback_bound) === "true" ? "present" : "absent"}</dd>
        <dt>Fetch timestamp</dt>
        <dd>{card.fetch_at || "unavailable"}</dd>
        <dt>Amount / currency match</dt>
        <dd>{card.amount_match || "unverified"}</dd>
        <dt>Final state</dt>
        <dd>{card.final_state || "unavailable"}</dd>
        <dt>Reconciliation</dt>
        <dd>{card.reconciliation_state || "unavailable"}</dd>
        <dt>Hold disposition</dt>
        <dd>{card.hold_disposition || "unavailable"}</dd>
        <dt>Order confirmation</dt>
        <dd>{String(card.order_confirmed) === "true" || card.final_state === "CAPTURED_RECONCILED" ? "see Core status" : "not confirmed from runner"}</dd>
        <dt>Settlement</dt>
        <dd>{card.settlement_status === "NOT_IMPLEMENTED" ? "not implemented — capture is not settlement" : "not claimed"}</dd>
      </dl>
      <p className="muted">{card.assurance_message || card.message || "Runner checkout screens are not payment truth."}</p>
    </article>
  );
}
