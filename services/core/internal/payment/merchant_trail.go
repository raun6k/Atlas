package payment

import "atlas.dev/core/internal/audit"

type merchantTrail interface {
	MirrorMerchant(ev audit.Event) error
}

func (t *pgTx) MirrorMerchant(ev audit.Event) error {
	_, err := audit.Append(t.ctx, t.tx, ev)
	return err
}

func mirrorMerchant(tx Tx, ev audit.Event) {
	if m, ok := tx.(merchantTrail); ok {
		_ = m.MirrorMerchant(ev)
	}
}

func recordEvidence(tx Tx, a PaymentAttempt, decision, mismatch, providerStatus string) error {
	body := map[string]any{
		"decision": decision, "mismatch_reason": mismatch, "provider_status": providerStatus,
		"binding": a.HasEventBinding(), "amount_minor": AmountString(a.Amount.AmountMinor), "currency": a.Amount.Currency,
	}
	if err := tx.InsertAudit(AuditEvent{
		AuditEventID: NewAuditID(), Kind: "PROVIDER_EVIDENCE_EVALUATED",
		PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
		SafeBody: body, OccurredAt: tx.Now(), OperationID: a.OperationID, RequestID: a.RequestID,
	}); err != nil {
		return err
	}
	mirrorMerchant(tx, audit.Event{
		Kind: "PROVIDER_EVIDENCE_EVALUATED", RequestID: a.RequestID, OperationID: a.OperationID,
		PrincipalType: audit.PrincipalSystem, Channel: audit.ChannelPaymentFabric, Action: "reconcile_payment",
		ResourceType: "payment_attempt", ResourceID: a.PaymentAttemptID,
		Body: body, Summary: "Atlas evaluated authenticated provider evidence for a Test Mode payment.",
		Correlation: paymentCorrelation(a),
	})
	return nil
}

func recordAsyncDecision(tx Tx, a PaymentAttempt, attention, summary string, body map[string]any) error {
	if body == nil {
		body = map[string]any{}
	}
	body["state"] = string(a.State)
	if err := tx.InsertAudit(AuditEvent{
		AuditEventID: NewAuditID(), Kind: "ASYNC_DECISION_APPLIED",
		PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
		SafeBody: body, OccurredAt: tx.Now(), OperationID: a.OperationID, RequestID: a.RequestID,
	}); err != nil {
		return err
	}
	mirrorMerchant(tx, audit.Event{
		Kind: "ASYNC_DECISION_APPLIED", RequestID: a.RequestID, OperationID: a.OperationID,
		PrincipalType: audit.PrincipalSystem, Channel: audit.ChannelPaymentFabric, Action: "async_payment_decision",
		ResourceType: "payment_attempt", ResourceID: a.PaymentAttemptID,
		Body: body, Attention: attention, Summary: summary,
		Correlation: paymentCorrelation(a),
	})
	return nil
}

func paymentCorrelation(a PaymentAttempt) map[string]string {
	return audit.Merge(nil, map[string]string{
		"request_id":            a.RequestID,
		"operation_id":          a.OperationID,
		"host_id":               a.HostID,
		"payment_attempt_id":    a.PaymentAttemptID,
		"checkout_proposal_id":  a.CheckoutProposalID,
		"execution_passport_id": a.ExecutionPassportID,
		"merchant_order_id":     a.MerchantOrderID,
		"provider_order_id":     a.RazorpayOrderID,
		"provider_payment_id":   a.RazorpayPaymentID,
	})
}
