package app

import (
	"context"
	"fmt"

	"atlas.dev/core/internal/apperr"
)

type OutcomeMetric struct {
	Name         string
	Eligible     bool
	Evidence     string
	Value        int64
	ValuePresent bool
	Numerator    int32
	Denominator  int32
	RatioPresent bool
	Message      string
}

type PaymentAssurance struct {
	PaymentAttemptID       string
	MerchantOrderID        string
	ProviderOrderID        string
	ProviderPaymentID      string
	WebhookBound           bool
	CallbackBound          bool
	AuthenticatedEventRef  string
	ProviderFetchRef       string
	FetchAt                string
	AmountMinor            int64
	Currency               string
	AmountMatch            string
	FinalState             string
	HoldDisposition        string
	OrderStatus            string
	OrderConfirmed         bool
	RunnerScreenIsNotTruth bool
	EvidenceStatus         string
	Message                string
}

func (k *Kernel) MerchantOutcomes(ctx context.Context, m Meta) (Envelope, []OutcomeMetric, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	metrics := []OutcomeMetric{
		k.countOutcome(ctx, "confirmed_orders", `
			SELECT COUNT(*) FROM orders WHERE status='CONFIRMED' OR payment_public_status='CONFIRMED'`),
		k.countOutcome(ctx, "captured_reconciled_payments", `
			SELECT COUNT(*) FROM payment_attempts WHERE state='CAPTURED_RECONCILED'`),
		k.countOutcome(ctx, "catalog_resolution_success", `SELECT COUNT(*) FROM audit_events WHERE action='search_catalog'`),
		k.countOutcome(ctx, "cart_completion", `SELECT COUNT(*) FROM carts WHERE cart_version > 0 AND all_in_total_minor > 0`),
		k.countOutcome(ctx, "offer_exposure", `SELECT COUNT(*) FROM offer_events WHERE event_type='OFFER_SHOWN'`),
		k.countOutcome(ctx, "offer_application", `SELECT COUNT(*) FROM offers WHERE status IN ('APPLIED','RETAINED','ATTRIBUTED')`),
		k.countOutcome(ctx, "checkout_proposal_creation", `SELECT COUNT(*) FROM checkout_proposals`),
		k.countOutcome(ctx, "payment_processing", `SELECT COUNT(*) FROM payment_attempts`),
		k.unresolvedOutcome(ctx),
		k.awaitingBindingOutcome(ctx),
		k.avgRetryMetric(ctx),
		{
			Name: "real_world_revenue_uplift", Eligible: false, Evidence: "INELIGIBLE",
			Message: "Atlas demonstrates controlled Test Mode commercial evidence and payment reconciliation. It does not claim real-world causal revenue uplift.",
		},
		{
			Name: "merchant_settlement", Eligible: false, Evidence: "INELIGIBLE",
			Message: "Settlement is not implemented. Test Mode capture is not merchant settlement.",
		},
	}
	return k.withMeta(k.env(), m, ""), metrics, nil
}

func (k *Kernel) PaymentAssuranceForOrder(ctx context.Context, m Meta, orderID, attemptID string) (Envelope, PaymentAssurance, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, PaymentAssurance{}, err
	}
	if orderID == "" && attemptID == "" {
		return Envelope{}, PaymentAssurance{}, apperr.New(apperr.InvalidArgument, "order_id or payment_attempt_id is required")
	}
	row := k.Pool().QueryRow(ctx, `
		SELECT COALESCE(a.payment_attempt_id,''), COALESCE(COALESCE(a.merchant_order_id, o.order_id), ''),
		       COALESCE(a.razorpay_order_id,''), COALESCE(a.razorpay_payment_id,''),
		       COALESCE(a.has_webhook_binding,false), COALESCE(a.has_callback_binding,false),
		       COALESCE(a.amount_minor, o.total_amount_minor, 0), COALESCE(a.currency, o.currency, 'INR'),
		       COALESCE(a.state,''), COALESCE(a.effect_disposition,''), COALESCE(o.status,''),
		       COALESCE(o.payment_public_status,''),
		       COALESCE((SELECT MAX(occurred_at)::text FROM payment_audit_events e
		                 WHERE e.payment_attempt_id=a.payment_attempt_id AND e.kind='PROVIDER_EVIDENCE_EVALUATED'),''),
		       COALESCE((SELECT provider_event_id FROM provider_events e
		                 WHERE e.payment_attempt_id=a.payment_attempt_id AND e.signature_valid=TRUE
		                 ORDER BY e.received_at DESC LIMIT 1),''),
		       COALESCE((SELECT reconciliation_id FROM provider_reconciliations r
		                 WHERE r.payment_attempt_id=a.payment_attempt_id
		                 ORDER BY r.fetched_at DESC LIMIT 1),'')
		FROM orders o
		LEFT JOIN payment_attempts a ON o.order_id = a.merchant_order_id OR o.payment_attempt_id = a.payment_attempt_id
		WHERE ($1 <> '' AND (o.order_id=$1 OR a.merchant_order_id=$1))
		   OR ($2 <> '' AND a.payment_attempt_id=$2)
		LIMIT 1`, orderID, attemptID)
	var card PaymentAssurance
	var publicStatus string
	card.RunnerScreenIsNotTruth = true
	if err := row.Scan(&card.PaymentAttemptID, &card.MerchantOrderID, &card.ProviderOrderID, &card.ProviderPaymentID,
		&card.WebhookBound, &card.CallbackBound, &card.AmountMinor, &card.Currency, &card.FinalState,
		&card.HoldDisposition, &card.OrderStatus, &publicStatus, &card.FetchAt, &card.AuthenticatedEventRef,
		&card.ProviderFetchRef); err != nil {
		card.EvidenceStatus = "UNAVAILABLE"
		card.Message = "Payment assurance unavailable — no payment attempt or merchant order matched."
		return k.withMeta(k.env(), m, ""), card, nil
	}
	card.AmountMatch = "unverified"
	if card.FinalState == "CAPTURED_RECONCILED" {
		card.AmountMatch = "matched"
	}
	card.OrderConfirmed = card.OrderStatus == "CONFIRMED" || publicStatus == "CONFIRMED"
	bound := card.WebhookBound || card.CallbackBound
	switch {
	case card.FinalState == "OUTCOME_UNKNOWN":
		card.EvidenceStatus = "UNRESOLVED"
		card.Message = "Payment captured or submitted is unresolved; fulfillment stays frozen."
	case card.FinalState == "CAPTURED_RECONCILED" && !bound:
		card.EvidenceStatus = "PARTIAL"
		card.Message = "Payment captured at provider; webhook binding pending."
	case card.FinalState == "CAPTURED_RECONCILED" && card.OrderConfirmed:
		card.EvidenceStatus = "CONFIRMED"
		card.Message = "Provider fetch plus event binding confirmed the merchant order. Runner checkout screens are not payment truth."
	case card.FinalState == "CAPTURED_RECONCILED":
		card.EvidenceStatus = "MEASURED"
		card.Message = "Provider capture is reconciled. Merchant order confirmation is still pending."
	case card.FinalState == "":
		card.EvidenceStatus = "UNAVAILABLE"
		card.Message = "No payment attempt exists for this order."
	default:
		card.EvidenceStatus = "PARTIAL"
		card.Message = fmt.Sprintf("Payment attempt is %s. Do not display this as paid from a browser success screen.", card.FinalState)
	}
	return k.withMeta(k.env(), m, ""), card, nil
}

func (k *Kernel) countOutcome(ctx context.Context, name, q string) OutcomeMetric {
	var n int64
	if err := k.Pool().QueryRow(ctx, q).Scan(&n); err != nil {
		return OutcomeMetric{Name: name, Evidence: "UNAVAILABLE", Message: "Query failed; value is not zero."}
	}
	return OutcomeMetric{Name: name, Eligible: true, Evidence: "CONFIRMED", Value: n, ValuePresent: true}
}

func (k *Kernel) unresolvedOutcome(ctx context.Context) OutcomeMetric {
	var n int64
	if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM payment_attempts WHERE state IN ('OUTCOME_UNKNOWN','RECONCILING')`).Scan(&n); err != nil {
		return OutcomeMetric{Name: "unresolved_payments", Evidence: "UNAVAILABLE", Message: "Unresolved money could not be measured."}
	}
	st := "CONFIRMED"
	msg := "No unresolved payment attempts."
	if n > 0 {
		st = "UNRESOLVED"
		msg = fmt.Sprintf("%d payment attempts are unresolved. Money is not treated as zero or failed.", n)
	}
	return OutcomeMetric{Name: "unresolved_payments", Eligible: true, Evidence: st, Value: n, ValuePresent: true, Message: msg}
}

func (k *Kernel) awaitingBindingOutcome(ctx context.Context) OutcomeMetric {
	var n int64
	if err := k.Pool().QueryRow(ctx, `
		SELECT COUNT(*) FROM payment_attempts
		WHERE state='CAPTURED_RECONCILED' AND NOT (has_callback_binding OR has_webhook_binding)`).Scan(&n); err != nil {
		return OutcomeMetric{Name: "captured_awaiting_binding", Evidence: "UNAVAILABLE"}
	}
	st := "CONFIRMED"
	msg := "Captured payments have event bindings."
	if n > 0 {
		st = "PARTIAL"
		msg = fmt.Sprintf("Payment captured at provider; webhook binding pending for %d attempts.", n)
	}
	return OutcomeMetric{Name: "captured_awaiting_binding", Eligible: true, Evidence: st, Value: n, ValuePresent: true, Message: msg}
}

func (k *Kernel) avgRetryMetric(ctx context.Context) OutcomeMetric {
	var n *float64
	err := k.Pool().QueryRow(ctx, `SELECT AVG(EXTRACT(EPOCH FROM (available_at - created_at))*1000) FROM jobs WHERE status IN ('FAILED','COMPLETED','NOT_RETRYABLE') AND attempt_count > 1`).Scan(&n)
	if err != nil || n == nil {
		return OutcomeMetric{Name: "retry_and_recovery_time_ms", Eligible: false, Evidence: "MISSING", Message: "No retry intervals observed; not reported as zero."}
	}
	return OutcomeMetric{Name: "retry_and_recovery_time_ms", Eligible: true, Evidence: "COUNTED", Value: int64(*n), ValuePresent: true}
}
