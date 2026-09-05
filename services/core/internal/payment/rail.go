package payment

import (
	"context"
	"crypto/subtle"
	"fmt"
	"strings"
	"time"

	"atlas.dev/core/internal/provider"
)

func ProviderCreateOrderKey(attemptID string) string {
	return SnapshotDigest("create_order", attemptID)
}

func ProviderCaptureKey(attemptID, paymentID string) string {
	return SnapshotDigest("capture", attemptID, paymentID)
}

func classifyProviderError(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	if provider.IsAmbiguous(err) {
		return ReasonMalformedResponse
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline") {
		return ReasonProviderTimeout
	}
	if strings.Contains(msg, "transport") || strings.Contains(msg, "connection") {
		return ReasonTransportFailure
	}
	return fallback
}

func (s *Service) retryDelay(attempt int) time.Duration {
	if s.RetryBase < 0 {
		return 0
	}
	base := s.RetryBase
	if base == 0 {
		base = 2 * time.Second
	}
	if attempt < 1 {
		attempt = 1
	}
	d := base
	for i := 1; i < attempt && d < 5*time.Minute; i++ {
		d *= 2
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

func (s *Service) bindingTimeout() time.Duration {
	if s.WebhookBindingTimeout > 0 {
		return s.WebhookBindingTimeout
	}
	return WebhookBindingTimeout
}

func (s *Service) runnerIdentity() string {
	if s.RunnerIdentity != "" {
		return s.RunnerIdentity
	}
	return "test-runner"
}

func (s *Service) verifyRunnerCredential(got string) error {
	if s.RunnerCredentialHash == "" || got == "" {
		return Err("RUNNER_FORBIDDEN", "runner credential required")
	}
	want := []byte(s.RunnerCredentialHash)
	have := []byte(HashToken(got))
	if len(want) != len(have) || subtle.ConstantTimeCompare(want, have) != 1 {
		return Err("RUNNER_FORBIDDEN", "runner credential mismatch")
	}
	return nil
}

func validRazorpayPaymentID(id string) bool {
	return strings.HasPrefix(id, "pay_") && len(id) > 4
}

func (s *Service) scheduleFollowUp(tx Tx, a PaymentAttempt) error {
	if a.ReconcileAttemptCount >= MaxReconcileAttempts {
		a.ReasonCode = ReasonReconcileExhausted
		if err := tx.UpdateAttempt(a); err != nil {
			return err
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "RECONCILE_EXHAUSTED",
			PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
			SafeBody: map[string]any{
				"reason_code": ReasonReconcileExhausted, "operator_attention": true,
				"duplicate_attempt_frozen": true, "not_capture": true, "not_settlement": true,
			},
			OccurredAt: tx.Now(),
		})
	}
	n := a.ReconcileAttemptCount + 1
	a.ReconcileAttemptCount = n
	next := tx.Now().Add(s.retryDelay(n))
	a.ReconcileNextAttemptAt = &next
	if err := tx.UpdateAttempt(a); err != nil {
		return err
	}
	jobType := JobReconcilePayment
	payload := map[string]string{"payment_attempt_id": a.PaymentAttemptID}
	if a.RazorpayOrderID == "" {
		jobType = JobCreateProviderOrder
		payload["scenario"] = "success"
	}
	return tx.EnqueueJob(WorkerJob{
		JobID: NewJobID(), Type: jobType, PayloadJSON: mustJSON(payload),
		DedupKey: fmt.Sprintf("retry:%s:%s:%d", jobType, a.PaymentAttemptID, n), AvailableAt: next,
	})
}

func (s *Service) scheduleReconcileNow(tx Tx, attemptID string, suffix string) error {
	return tx.EnqueueJob(WorkerJob{
		JobID: NewJobID(), Type: JobReconcilePayment,
		PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": attemptID}),
		DedupKey:    "reconcile:" + attemptID + ":" + suffix,
		AvailableAt: tx.Now(),
	})
}

// OperatorReconcile retries provider fetch for an existing attempt. It never creates a new payment.
func (s *Service) OperatorReconcile(ctx context.Context, operationOrAttemptID string) error {
	var attemptID string
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		if a, ok := tx.GetAttemptByID(operationOrAttemptID); ok {
			attemptID = a.PaymentAttemptID
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "OPERATOR_RECONCILE_SCHEDULED",
				PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
				SafeBody:   map[string]any{"creates_payment": false, "not_settlement": true},
				OccurredAt: tx.Now(),
			})
		}
		return Err("NOT_FOUND", "payment attempt not found")
	})
	if err != nil {
		return err
	}
	return s.ReconcilePayment(ctx, attemptID)
}
