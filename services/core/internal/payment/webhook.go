package payment

import (
	"context"
	"encoding/json"
	"time"

	"atlas.dev/core/internal/provider"
)

var allowedWebhookEvents = map[string]bool{
	"payment.captured":   true,
	"payment.failed":     true,
	"payment.authorized": true,
	"order.paid":         true,
}

type WebhookIngest struct {
	RawBody   []byte
	Signature string
	EventID   string
}

type webhookPayload struct {
	Event   string `json:"event"`
	Created int64  `json:"created_at"`
	Payload struct {
		Payment struct {
			Entity struct {
				ID       string `json:"id"`
				OrderID  string `json:"order_id"`
				Amount   int64  `json:"amount"`
				Currency string `json:"currency"`
				Status   string `json:"status"`
			} `json:"entity"`
		} `json:"payment"`
		Order struct {
			Entity struct {
				ID       string `json:"id"`
				Amount   int64  `json:"amount"`
				Currency string `json:"currency"`
			} `json:"entity"`
		} `json:"order"`
		Refund struct {
			Entity struct {
				ID        string `json:"id"`
				PaymentID string `json:"payment_id"`
				Amount    int64  `json:"amount"`
				Status    string `json:"status"`
			} `json:"entity"`
		} `json:"refund"`
	} `json:"payload"`
}

// IngestWebhook verifies the raw body, dedupes by provider event id, stores safe fields,
// and schedules reconciliation. It never confirms capture from the webhook alone.
func (s *Service) IngestWebhook(ctx context.Context, in WebhookIngest) error {
	if err := provider.VerifyWebhookHMAC(in.RawBody, in.Signature, s.Cfg.WebhookSecret); err != nil {
		return ErrInvalidSignature
	}
	if in.EventID == "" {
		return Err("PROVIDER_EVENT_ID_MISSING", "X-Razorpay-Event-Id is required")
	}
	var parsed webhookPayload
	if err := json.Unmarshal(in.RawBody, &parsed); err != nil {
		return Err("PROVIDER_PAYLOAD_INVALID", "webhook json is invalid")
	}
	now := time.Now().UTC()
	occurred := now
	if parsed.Created > 0 {
		occurred = time.Unix(parsed.Created, 0).UTC()
		if occurred.After(now.Add(5 * time.Minute)) {
			return Err("PROVIDER_EVENT_TIMESTAMP_INVALID", "webhook created_at is too far in the future")
		}
	}
	digest := provider.BodyDigest(in.RawBody)
	orderID := parsed.Payload.Payment.Entity.OrderID
	if orderID == "" {
		orderID = parsed.Payload.Order.Entity.ID
	}
	paymentID := parsed.Payload.Payment.Entity.ID
	amount := parsed.Payload.Payment.Entity.Amount
	currency := parsed.Payload.Payment.Entity.Currency
	status := parsed.Payload.Payment.Entity.Status

	return s.Store.RunInTx(ctx, func(tx Tx) error {
		if _, exists := tx.GetProviderEvent(in.EventID); exists {
			return ErrDuplicateEvent
		}
		attempt, ok := tx.GetAttemptByRazorpayOrder(orderID)
		attemptID := ""
		if ok {
			attemptID = attempt.PaymentAttemptID
		}
		ev := ProviderEvent{
			RowID: NewEventRowID(), ProviderEventID: in.EventID, EventType: parsed.Event,
			BodyDigest: digest, SignatureValid: true, RazorpayOrderID: orderID, RazorpayPaymentID: paymentID,
			AmountMinor: amount, Currency: currency, ProviderStatus: status,
			ReceivedAt: tx.Now(), SourceOccurredAt: occurred,
			PaymentAttemptID: attemptID,
		}
		if err := tx.InsertProviderEvent(ev); err != nil {
			return err
		}
		if !allowedWebhookEvents[parsed.Event] {
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_IGNORED",
				PaymentAttemptID: attemptID, OrderID: "",
				SafeBody:   map[string]any{"provider_event_id": in.EventID, "event_type": parsed.Event, "reason": "event_type_not_allowlisted"},
				OccurredAt: tx.Now(),
			})
		}
		if parsed.Created > 0 && now.Sub(occurred) > 15*time.Minute {
			_ = tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_STALE",
				PaymentAttemptID: attemptID,
				SafeBody:         map[string]any{"provider_event_id": in.EventID, "created_at": parsed.Created},
				OccurredAt:       tx.Now(),
			})
		}
		if !ok {
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_UNBOUND",
				SafeBody:   map[string]any{"provider_event_id": in.EventID, "event_type": parsed.Event, "razorpay_order_id": orderID},
				OccurredAt: tx.Now(),
			})
		}
		if paymentID != "" && !validRazorpayPaymentID(paymentID) {
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_REJECTED",
				PaymentAttemptID: attempt.PaymentAttemptID, OrderID: attempt.MerchantOrderID,
				SafeBody:   map[string]any{"reason": "payment_id_format", "provider_event_id": in.EventID},
				OccurredAt: tx.Now(),
			})
		}
		if amount != 0 && (amount != attempt.Amount.AmountMinor || (currency != "" && currency != attempt.Amount.Currency)) {
			if err := tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_REJECTED",
				PaymentAttemptID: attempt.PaymentAttemptID, OrderID: attempt.MerchantOrderID,
				SafeBody:   map[string]any{"reason": "amount_currency_mismatch", "provider_event_id": in.EventID, "not_capture": true},
				OccurredAt: tx.Now(),
			}); err != nil {
				return err
			}
			return s.scheduleReconcileNow(tx, attempt.PaymentAttemptID, "mismatch-"+in.EventID)
		}
		if attempt.State.Terminal() {
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "PROVIDER_EVENT_IGNORED_TERMINAL",
				PaymentAttemptID: attempt.PaymentAttemptID, OrderID: attempt.MerchantOrderID,
				SafeBody:   map[string]any{"provider_event_id": in.EventID, "event_type": parsed.Event},
				OccurredAt: tx.Now(),
			})
		}
		attempt.HasWebhookBinding = true
		if paymentID != "" && attempt.RazorpayPaymentID == "" {
			attempt.RazorpayPaymentID = paymentID
		}
		if !attempt.State.Terminal() && attempt.State != StateOutcomeUnknown {
			attempt.State = StateReconciling
		}
		if err := tx.UpdateAttempt(attempt); err != nil {
			return err
		}
		if err := tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobReconcilePayment,
			PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": attempt.PaymentAttemptID}),
			DedupKey:    "reconcile:" + attempt.PaymentAttemptID + ":" + in.EventID,
			AvailableAt: tx.Now(),
		}); err != nil {
			return err
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "PROVIDER_WEBHOOK_BOUND",
			PaymentAttemptID: attempt.PaymentAttemptID, OrderID: attempt.MerchantOrderID,
			SafeBody: map[string]any{
				"provider_event_id": in.EventID, "event_type": parsed.Event,
				"razorpay_order_id": orderID, "not_capture": true, "not_settlement": true,
			},
			OccurredAt: tx.Now(),
		})
	})
}

type CallbackIngest struct {
	RazorpayOrderID   string
	RazorpayPaymentID string
	Signature         string
}

// IngestCallback verifies the Checkout callback signature and binds identifiers.
// It does not establish captured status.
func (s *Service) IngestCallback(ctx context.Context, in CallbackIngest) error {
	if err := provider.VerifyCheckoutCallbackHMAC(in.RazorpayOrderID, in.RazorpayPaymentID, in.Signature, s.Cfg.KeySecret); err != nil {
		return ErrInvalidSignature
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		attempt, ok := tx.GetAttemptByRazorpayOrder(in.RazorpayOrderID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found for callback order")
		}
		if attempt.State.Terminal() {
			return nil
		}
		attempt.HasCallbackBinding = true
		if in.RazorpayPaymentID != "" {
			attempt.RazorpayPaymentID = in.RazorpayPaymentID
		}
		if attempt.State != StateOutcomeUnknown {
			attempt.State = StateReconciling
		}
		if err := tx.UpdateAttempt(attempt); err != nil {
			return err
		}
		if err := tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobReconcilePayment,
			PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": attempt.PaymentAttemptID}),
			DedupKey:    "reconcile-callback:" + attempt.PaymentAttemptID,
			AvailableAt: tx.Now(),
		}); err != nil {
			return err
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "PROVIDER_CALLBACK_BOUND",
			PaymentAttemptID: attempt.PaymentAttemptID, OrderID: attempt.MerchantOrderID,
			SafeBody:   map[string]any{"razorpay_order_id": in.RazorpayOrderID, "razorpay_payment_id": in.RazorpayPaymentID, "not_capture": true},
			OccurredAt: tx.Now(),
		})
	})
}
