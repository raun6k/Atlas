package payment

import (
	"context"

	"atlas.dev/core/internal/provider"
)

type RequestRefundCommand struct {
	OrderID        string
	AmountMinor    int64
	ReasonCode     string
	IdempotencyKey string
}

type RequestRefundResult struct {
	RefundID       string
	OperationID    string
	PublicStatus   string
	RemainingAfter int64
}

func (s *Service) RequestRefund(ctx context.Context, cmd RequestRefundCommand) (RequestRefundResult, error) {
	var result RequestRefundResult
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		if existing, ok := tx.GetRefundByIdempotency(cmd.IdempotencyKey); ok {
			if existing.AmountMinor != cmd.AmountMinor || existing.OrderID != cmd.OrderID {
				return ErrIdempotencyConflict
			}
			result = RequestRefundResult{RefundID: existing.RefundID, OperationID: existing.RefundID, PublicStatus: string(existing.State)}
			return nil
		}
		order, ok := tx.GetOrderByID(cmd.OrderID)
		if !ok {
			return Err("NOT_FOUND", "order not found")
		}
		if order.State != OrderConfirmed || order.CapturedRazorpayPaymentID == "" {
			return ErrNotCaptured
		}
		attempt, err := tx.LockPaymentForRefund(order.CapturedPaymentAttemptID)
		if err != nil {
			return err
		}
		if attempt.State != StateCapturedReconciled {
			return ErrNotCaptured
		}
		if attempt.DuplicateFrozen || attempt.State == StateOutcomeUnknown {
			return ErrAttemptFrozen
		}
		refunds := tx.ListRefunds(attempt.PaymentAttemptID)
		for _, rf := range refunds {
			if rf.State == RefundOutcomeUnknown || rf.DuplicateFrozen {
				return ErrRefundFrozen
			}
		}
		reservations := tx.ListReservations(attempt.PaymentAttemptID)
		remaining := RemainingRefundable(attempt.Amount.AmountMinor, refunds, reservations)
		if cmd.AmountMinor <= 0 || cmd.AmountMinor > remaining {
			return ErrReservationInsufficient
		}
		now := tx.Now()
		refundID := NewRefundID()
		resID := NewReservationID()
		rf := Refund{
			RefundID: refundID, PaymentAttemptID: attempt.PaymentAttemptID, OrderID: order.OrderID,
			AmountMinor: cmd.AmountMinor, Currency: attempt.Amount.Currency, State: RefundRequested,
			IdempotencyKey: cmd.IdempotencyKey, ReasonCode: cmd.ReasonCode, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.InsertRefund(rf); err != nil {
			return err
		}
		if err := tx.InsertRefundReservation(RefundReservation{
			ReservationID: resID, RefundID: refundID, PaymentAttemptID: attempt.PaymentAttemptID,
			AmountMinor: cmd.AmountMinor, Status: ReservationActive, CreatedAt: now,
		}); err != nil {
			return err
		}
		if err := tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobRequestRefund,
			PayloadJSON: mustJSON(map[string]string{"refund_id": refundID}),
			DedupKey:    "request-refund:" + refundID, AvailableAt: now,
		}); err != nil {
			return err
		}
		if err := tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "REFUND_REQUESTED", PaymentAttemptID: attempt.PaymentAttemptID,
			OrderID: order.OrderID, RefundID: refundID,
			SafeBody:   map[string]any{"amount_minor": AmountString(cmd.AmountMinor), "remaining_before": AmountString(remaining)},
			OccurredAt: now,
		}); err != nil {
			return err
		}
		result = RequestRefundResult{
			RefundID: refundID, OperationID: refundID, PublicStatus: string(RefundRequested),
			RemainingAfter: remaining - cmd.AmountMinor,
		}
		return nil
	})
	return result, err
}

func (s *Service) HandleRequestRefund(ctx context.Context, refundID string) error {
	var rf Refund
	var attempt PaymentAttempt
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		r, ok := tx.GetRefund(refundID)
		if !ok {
			return Err("NOT_FOUND", "refund not found")
		}
		a, ok := tx.GetAttemptByID(r.PaymentAttemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if r.State == RefundProcessed || r.State == RefundFailedVerified {
			return nil
		}
		r.State = RefundSubmitting
		if err := tx.UpdateRefund(r); err != nil {
			return err
		}
		rf, attempt = r, a
		return nil
	})
	if err != nil {
		return err
	}
	created, err := s.Client.CreateRefund(ctx, provider.CreateRefundRequest{
		PaymentID: attempt.RazorpayPaymentID, AmountMinor: rf.AmountMinor, IdempotencyKey: rf.IdempotencyKey,
	})
	if err != nil {
		return s.Store.RunInTx(ctx, func(tx Tx) error {
			r, _ := tx.GetRefund(refundID)
			r.State = RefundOutcomeUnknown
			r.DuplicateFrozen = true
			r.EffectDisposition = DispositionExternalUnknown
			r.ReasonCode = ReasonPossibleSubmission
			if err := tx.UpdateRefund(r); err != nil {
				return err
			}
			if err := tx.EnqueueJob(WorkerJob{
				JobID: NewJobID(), Type: JobReconcileRefund,
				PayloadJSON: mustJSON(map[string]string{"refund_id": refundID}),
				DedupKey:    "reconcile-refund-unknown:" + refundID, AvailableAt: tx.Now(),
			}); err != nil {
				return err
			}
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "REFUND_OUTCOME_UNKNOWN", RefundID: refundID,
				PaymentAttemptID: r.PaymentAttemptID, OrderID: r.OrderID,
				SafeBody:   map[string]any{"reason_code": ReasonPossibleSubmission, "duplicate_attempt_frozen": true},
				OccurredAt: tx.Now(),
			})
		})
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		r, _ := tx.GetRefund(refundID)
		r.RazorpayRefundID = created.ID
		r.State = RefundProviderSubmitted
		if err := tx.UpdateRefund(r); err != nil {
			return err
		}
		return tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobReconcileRefund,
			PayloadJSON: mustJSON(map[string]string{"refund_id": refundID}),
			DedupKey:    "reconcile-refund:" + refundID, AvailableAt: tx.Now(),
		})
	})
}

func (s *Service) ReconcileRefund(ctx context.Context, refundID string) error {
	var rf Refund
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		r, ok := tx.GetRefund(refundID)
		if !ok {
			return Err("NOT_FOUND", "refund not found")
		}
		rf = r
		return nil
	})
	if err != nil {
		return err
	}
	if rf.RazorpayRefundID == "" {
		return Err("REFUND_PROVIDER_ID_MISSING", "cannot reconcile refund without provider id")
	}
	fetched, err := s.Client.FetchRefund(ctx, rf.RazorpayRefundID)
	if err != nil {
		return err
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		r, ok := tx.GetRefund(refundID)
		if !ok {
			return Err("NOT_FOUND", "refund not found")
		}
		order, _ := tx.GetOrderByID(r.OrderID)
		switch fetched.Status {
		case "processed":
			r.State = RefundProcessed
			r.DuplicateFrozen = false
			r.EffectDisposition = ""
			if err := tx.UpdateRefund(r); err != nil {
				return err
			}
			for _, rr := range tx.ListReservations(r.PaymentAttemptID) {
				if rr.RefundID == r.RefundID && rr.Status == ReservationActive {
					rr.Status = ReservationCommitted
					if err := tx.UpdateRefundReservation(rr); err != nil {
						return err
					}
				}
			}
			if err := tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "REFUND_PROCESSED_RECONCILED", RefundID: r.RefundID,
				PaymentAttemptID: r.PaymentAttemptID, OrderID: r.OrderID,
				SafeBody:   map[string]any{"razorpay_refund_id": fetched.ID, "amount_minor": AmountString(fetched.Amount)},
				OccurredAt: tx.Now(),
			}); err != nil {
				return err
			}
			_ = order
			return nil
		case "failed":
			r.State = RefundFailedVerified
			r.DuplicateFrozen = false
			if err := tx.UpdateRefund(r); err != nil {
				return err
			}
			for _, rr := range tx.ListReservations(r.PaymentAttemptID) {
				if rr.RefundID == r.RefundID && rr.Status == ReservationActive {
					rr.Status = ReservationReleased
					if err := tx.UpdateRefundReservation(rr); err != nil {
						return err
					}
				}
			}
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "REFUND_FAILED_VERIFIED", RefundID: r.RefundID,
				PaymentAttemptID: r.PaymentAttemptID, OrderID: r.OrderID,
				SafeBody:   map[string]any{"razorpay_refund_id": fetched.ID},
				OccurredAt: tx.Now(),
			})
		default:
			r.State = RefundReconciling
			return tx.UpdateRefund(r)
		}
	})
}
