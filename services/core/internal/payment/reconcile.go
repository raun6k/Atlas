package payment

import (
	"context"
	"fmt"

	"atlas.dev/core/internal/provider"
)

// ReconcilePayment fetches the provider order and payments. Terminal success requires
// an authenticated fetch of a captured payment with exact order/amount/currency plus
// at least one authenticated event binding. Browser success is ignored here.
func (s *Service) ReconcilePayment(ctx context.Context, attemptID string) error {
	var attempt PaymentAttempt
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.DuplicateFrozen && a.State != StateOutcomeUnknown && a.State != StateReconciling && !a.State.Terminal() {
			return ErrAttemptFrozen
		}
		attempt = a
		return nil
	})
	if err != nil {
		return err
	}
	if attempt.State.Terminal() {
		return nil
	}
	if attempt.RazorpayOrderID == "" {
		return Err("PROVIDER_ORDER_MISSING", "cannot reconcile without a provider order")
	}

	fetchedOrder, err := s.Client.FetchOrder(ctx, attempt.RazorpayOrderID)
	if err != nil {
		return s.Store.RunInTx(ctx, func(tx Tx) error {
			a, _ := tx.GetAttemptByID(attemptID)
			return s.recordReconcile(tx, a, "", "FETCH_FAILED", err.Error())
		})
	}
	payments, err := s.Client.FetchOrderPayments(ctx, attempt.RazorpayOrderID)
	if err != nil {
		return s.Store.RunInTx(ctx, func(tx Tx) error {
			a, _ := tx.GetAttemptByID(attemptID)
			return s.recordReconcile(tx, a, fetchedOrder.Status, "FETCH_FAILED", err.Error())
		})
	}

	return s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.State.Terminal() {
			return nil
		}

		if fetchedOrder.ID != a.RazorpayOrderID || fetchedOrder.Amount != a.Amount.AmountMinor || fetchedOrder.Currency != a.Amount.Currency {
			if err := s.recordReconcile(tx, a, fetchedOrder.Status, "MISMATCH", "order amount/currency/id mismatch"); err != nil {
				return err
			}
			a.State = StateReconciling
			return tx.UpdateAttempt(a)
		}

		var captured *provider.Payment
		var authorized *provider.Payment
		var failedOnly = true
		for i := range payments {
			p := payments[i]
			if p.OrderID != a.RazorpayOrderID {
				continue
			}
			if p.Status != "failed" && p.Status != "" {
				failedOnly = failedOnly && false
			}
			if p.Captured || p.Status == "captured" {
				if p.Amount != a.Amount.AmountMinor || p.Currency != a.Amount.Currency {
					if err := s.recordReconcile(tx, a, p.Status, "MISMATCH", "captured payment amount/currency mismatch"); err != nil {
						return err
					}
					a.State = StateReconciling
					return tx.UpdateAttempt(a)
				}
				cp := p
				captured = &cp
			}
			if p.Status == "authorized" && !p.Captured {
				ap := p
				authorized = &ap
			}
			if p.Status != "failed" {
				failedOnly = false
			}
		}
		if len(payments) == 0 {
			failedOnly = false
		}

		if captured != nil {
			if !a.HasEventBinding() {
				if err := s.recordReconcile(tx, a, captured.Status, "WAITING_EVENT_BINDING", "fetch shows captured but no authenticated callback/webhook binding"); err != nil {
					return err
				}
				if err := recordEvidence(tx, a, "WAITING_EVENT_BINDING", "fetch shows captured but no authenticated callback/webhook binding", captured.Status); err != nil {
					return err
				}
				if a.State != StateOutcomeUnknown {
					a.State = StateReconciling
				}
				return tx.UpdateAttempt(a)
			}
			return s.confirmCaptured(tx, a, *captured, fetchedOrder)
		}

		if authorized != nil {
			a.RazorpayPaymentID = authorized.ID
			if s.Cfg.CaptureModeOrDefault() == provider.CaptureModeAutomatic || s.Cfg.PaymentCaptureFlag() == 1 {
				if err := s.recordReconcile(tx, a, authorized.Status, "AUTHORIZED_CAPTURE_SCHEDULED", ""); err != nil {
					return err
				}
				a.State = StateReconciling
				if err := tx.UpdateAttempt(a); err != nil {
					return err
				}
				return tx.EnqueueJob(WorkerJob{
					JobID: NewJobID(), Type: JobCaptureAuthorizedPayment,
					PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": a.PaymentAttemptID, "razorpay_payment_id": authorized.ID}),
					DedupKey:    "capture:" + a.PaymentAttemptID + ":" + authorized.ID,
					AvailableAt: tx.Now(),
				})
			}
			if err := s.recordReconcile(tx, a, authorized.Status, "AUTHORIZED_ONLY", "not captured; fulfillment frozen"); err != nil {
				return err
			}
			a.FulfillmentFrozen = true
			a.State = StateReconciling
			return tx.UpdateAttempt(a)
		}

		if len(payments) > 0 && failedOnly && a.HasEventBinding() {
			if err := s.recordReconcile(tx, a, "failed", "FAILED_VERIFIED", "provider fetch proves no captured payment"); err != nil {
				return err
			}
			return s.failVerified(tx, a, StateFailedVerified)
		}

		if fetchedOrder.Status == "cancelled" || fetchedOrder.Status == "expired" {
			if len(payments) == 0 || failedOnly {
				if err := s.recordReconcile(tx, a, fetchedOrder.Status, "CANCELLED_VERIFIED", "provider fetch proves no captured payment"); err != nil {
					return err
				}
				return s.failVerified(tx, a, StateCancelledVerified)
			}
		}

		if err := s.recordReconcile(tx, a, fetchedOrder.Status, "PENDING", fmt.Sprintf("payments=%d", len(payments))); err != nil {
			return err
		}
		if a.State != StateOutcomeUnknown {
			a.State = StateReconciling
		}
		return tx.UpdateAttempt(a)
	})
}

func (s *Service) confirmCaptured(tx Tx, a PaymentAttempt, p provider.Payment, order provider.Order) error {
	a.RazorpayPaymentID = p.ID
	a.State = StateCapturedReconciled
	a.DuplicateFrozen = false
	a.FulfillmentFrozen = false
	a.HoldReleaseFrozen = false
	a.EffectDisposition = ""
	a.ReasonCode = ""
	if err := tx.UpdateAttempt(a); err != nil {
		return err
	}
	mo, ok := tx.GetOrderByID(a.MerchantOrderID)
	if !ok {
		return Err("NOT_FOUND", "merchant order not found")
	}
	mo.State = OrderConfirmed
	mo.CapturedPaymentAttemptID = a.PaymentAttemptID
	mo.CapturedRazorpayPaymentID = p.ID
	mo.UpdatedAt = tx.Now()
	if err := tx.UpdateOrder(mo); err != nil {
		return err
	}
	if err := tx.ConvertHold(a.CheckoutProposalID); err != nil {
		return err
	}
	if err := s.recordReconcile(tx, a, p.Status, "CAPTURED_RECONCILED", ""); err != nil {
		return err
	}
	if err := recordEvidence(tx, a, "CAPTURED_RECONCILED", "", p.Status); err != nil {
		return err
	}
	if err := recordAsyncDecision(tx, a, "", "Atlas applied a captured Test Mode payment after provider fetch and event binding.", map[string]any{
		"razorpay_payment_id": p.ID, "order_id": mo.OrderID,
	}); err != nil {
		return err
	}
	return tx.InsertAudit(AuditEvent{
		AuditEventID: NewAuditID(), Kind: "ORDER_CONFIRMED",
		PaymentAttemptID: a.PaymentAttemptID, OrderID: mo.OrderID,
		SafeBody: map[string]any{
			"razorpay_order_id": order.ID, "razorpay_payment_id": p.ID,
			"amount_minor": AmountString(p.Amount), "currency": p.Currency,
			"binding": a.HasEventBinding(),
		},
		OccurredAt: tx.Now(),
	})
}

func (s *Service) failVerified(tx Tx, a PaymentAttempt, terminal State) error {
	a.State = terminal
	a.DuplicateFrozen = false
	a.FulfillmentFrozen = false
	a.HoldReleaseFrozen = false
	if err := tx.UpdateAttempt(a); err != nil {
		return err
	}
	mo, ok := tx.GetOrderByID(a.MerchantOrderID)
	if ok {
		mo.State = OrderPaymentFailed
		mo.UpdatedAt = tx.Now()
		if err := tx.UpdateOrder(mo); err != nil {
			return err
		}
	}
	if err := tx.InsertAudit(AuditEvent{
		AuditEventID: NewAuditID(), Kind: string(terminal),
		PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
		SafeBody:   map[string]any{"proven_no_captured_payment": true},
		OccurredAt: tx.Now(),
	}); err != nil {
		return err
	}
	if err := recordEvidence(tx, a, string(terminal), "provider fetch proves no captured payment", string(terminal)); err != nil {
		return err
	}
	return recordAsyncDecision(tx, a, "", "Atlas applied a verified Test Mode payment failure.", map[string]any{
		"proven_no_captured_payment": true, "terminal": string(terminal),
	})
}

func (s *Service) recordReconcile(tx Tx, a PaymentAttempt, providerStatus, decision, mismatch string) error {
	return tx.InsertReconciliation(Reconciliation{
		ReconciliationID: NewReconcileID(), PaymentAttemptID: a.PaymentAttemptID,
		FetchedAt: tx.Now(), ProviderOrderID: a.RazorpayOrderID, ProviderStatus: providerStatus,
		SnapshotDigest: SnapshotDigest(a.RazorpayOrderID, providerStatus, decision, mismatch),
		Decision:       decision, MismatchReason: mismatch,
	})
}

// CaptureAuthorizedPayment captures the exact authorized Test Mode payment, then fetches again.
func (s *Service) CaptureAuthorizedPayment(ctx context.Context, attemptID, paymentID string) error {
	var attempt PaymentAttempt
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.State.Terminal() {
			return ErrTerminal
		}
		attempt = a
		return nil
	})
	if err != nil {
		return err
	}
	_, err = s.Client.CapturePayment(ctx, provider.CaptureRequest{
		PaymentID: paymentID, AmountMinor: attempt.Amount.AmountMinor, Currency: attempt.Amount.Currency,
	})
	if err != nil {
		return s.markUnknown(ctx, attemptID, "capture possible submission: "+err.Error())
	}
	return s.ReconcilePayment(ctx, attemptID)
}

func (s *Service) GetOrder(ctx context.Context, orderID string) (MerchantOrder, PaymentAttempt, PublicOrderStatus, error) {
	var order MerchantOrder
	var attempt PaymentAttempt
	var status PublicOrderStatus
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		o, ok := tx.GetOrderByID(orderID)
		if !ok {
			return Err("NOT_FOUND", "order not found")
		}
		found, okA := tx.GetAttemptByProposal(o.CheckoutProposalID)
		if !okA {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		order, attempt, status = o, found, publicStatus(found, o)
		return nil
	})
	return order, attempt, status, err
}

func (s *Service) loadAttempt(ctx context.Context, id string) (PaymentAttempt, error) {
	var a PaymentAttempt
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		got, ok := tx.GetAttemptByID(id)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		a = got
		return nil
	})
	return a, err
}
