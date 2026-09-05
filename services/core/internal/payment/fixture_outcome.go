package payment

import (
	"context"
	"strings"

	"atlas.dev/core/internal/provider"
)

// ApplyFixtureOutcome drives payment-attempt state through Core fabric records.
// It inserts authenticated provider-event and fetch-match evidence, then applies
// the same confirm/fail/unknown transitions as webhook+fetch reconciliation.
func (s *Service) ApplyFixtureOutcome(ctx context.Context, attemptID, outcome string) error {
	switch outcome {
	case "SUCCESS", "AMBIGUOUS_THEN_SUCCESS", "FAILURE", "AMBIGUOUS_THEN_FAILURE", "AMBIGUOUS":
	default:
		return Err("INVALID_ARGUMENT", "unknown payment fixture outcome")
	}
	if outcome == "AMBIGUOUS" || outcome == "AMBIGUOUS_THEN_SUCCESS" || outcome == "AMBIGUOUS_THEN_FAILURE" {
		if err := s.MarkUnknown(ctx, attemptID, "LAB_PAYMENT_FIXTURE_AMBIGUOUS"); err != nil {
			return err
		}
		if outcome == "AMBIGUOUS" {
			return nil
		}
	}
	terminalSuccess := outcome == "SUCCESS" || outcome == "AMBIGUOUS_THEN_SUCCESS"
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		payID := a.RazorpayPaymentID
		if payID == "" {
			payID = "pay_lab_" + a.PaymentAttemptID
		}
		orderID := a.RazorpayOrderID
		if orderID == "" {
			orderID = "order_lab_" + a.PaymentAttemptID
		}
		a.RazorpayOrderID = orderID
		a.RazorpayPaymentID = payID
		a.HasWebhookBinding = true
		evt := ProviderEvent{
			RowID:             NewEventRowID(),
			ProviderEventID:   "evt_lab_" + a.PaymentAttemptID + "_" + outcome,
			EventType:         "payment.captured",
			BodyDigest:        "lab_fixture",
			SignatureValid:    true,
			RazorpayOrderID:   orderID,
			RazorpayPaymentID: payID,
			AmountMinor:       a.Amount.AmountMinor,
			Currency:          a.Amount.Currency,
			ProviderStatus:    "captured",
			ReceivedAt:        tx.Now(),
			SourceOccurredAt:  tx.Now(),
			PaymentAttemptID:  a.PaymentAttemptID,
		}
		if !terminalSuccess {
			evt.EventType = "payment.failed"
			evt.ProviderStatus = "failed"
		}
		if err := tx.InsertProviderEvent(evt); err != nil && !strings.Contains(err.Error(), "duplicate") {
			return err
		}
		p := provider.Payment{
			ID:       payID,
			OrderID:  orderID,
			Amount:   a.Amount.AmountMinor,
			Currency: a.Amount.Currency,
			Status:   "captured",
			Captured: true,
		}
		ord := provider.Order{ID: orderID, Amount: a.Amount.AmountMinor, Currency: a.Amount.Currency, Status: "paid"}
		if terminalSuccess {
			if err := s.recordReconcile(tx, a, "captured", "MATCH", "lab fixture fetch match"); err != nil {
				return err
			}
			return s.confirmCaptured(tx, a, p, ord)
		}
		if err := s.recordReconcile(tx, a, "failed", "MATCH", "lab fixture fetch match"); err != nil {
			return err
		}
		return s.failVerified(tx, a, StateFailedVerified)
	})
}

// MarkUnknown freezes retries and fulfillment pending provider fetch.
func (s *Service) MarkUnknown(ctx context.Context, attemptID, reason string) error {
	return s.markUnknown(ctx, attemptID, reason)
}
