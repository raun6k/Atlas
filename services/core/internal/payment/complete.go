package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"atlas.dev/core/internal/provider"
)

// Service is the Payment Fabric domain. Kernel calls it through Register hooks.
// It never prices, ranks offers, or treats browser success as capture.
type Service struct {
	Store                 Store
	Client                *provider.Client
	Cfg                   provider.Config
	RunnerCredentialHash  string
	RunnerIdentity        string
	OperatorAssisted      bool
	RetryBase             time.Duration
	WebhookBindingTimeout time.Duration
}

type CompleteCheckoutCommand struct {
	HostID              string
	IdempotencyKey      string
	RequestID           string
	CheckoutProposalID  string
	SessionID           string
	LocationID          string
	ExecutionPassportID string
	QuoteHash           string
	AmountMinor         int64
	Currency            string
	CapabilityID        string
	Lines               []OrderLine
	Scenario            string // success | failure | authorized — Test Mode runner hint
	CheckoutPageURL     string // optional local mock page for runner tests
}

type CompleteCheckoutResult struct {
	MerchantOrderID  string
	PaymentAttemptID string
	OperationID      string
	PublicStatus     PublicOrderStatus
	PollAfterMS      []int
}

func (s *Service) CompleteCheckout(ctx context.Context, cmd CompleteCheckoutCommand) (CompleteCheckoutResult, error) {
	if err := s.Cfg.Validate(); err != nil {
		return CompleteCheckoutResult{}, ErrLiveMode
	}
	if cmd.CapabilityID != CapabilityRazorpayTest {
		return CompleteCheckoutResult{}, ErrCapability
	}
	if cmd.Currency == "" || cmd.AmountMinor < 0 {
		return CompleteCheckoutResult{}, Err("AMOUNT_INVALID", "amount must be non-negative integer minor units")
	}

	var result CompleteCheckoutResult
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		if existing, ok := tx.GetAttemptByIdempotency(cmd.HostID, cmd.IdempotencyKey); ok {
			stored := SnapshotDigest(existing.CheckoutProposalID, AmountString(existing.Amount.AmountMinor), existing.Amount.Currency, existing.CapabilityID)
			if stored != canonicalCheckout(cmd) {
				return ErrIdempotencyConflict
			}
			order, _ := tx.GetOrderByID(existing.MerchantOrderID)
			result = CompleteCheckoutResult{
				MerchantOrderID: order.OrderID, PaymentAttemptID: existing.PaymentAttemptID,
				OperationID: existing.PaymentAttemptID, PublicStatus: publicStatus(existing, order),
				PollAfterMS: []int{1000, 2000, 5000},
			}
			return nil
		}
		now := tx.Now()
		orderID := NewOrderID()
		attemptID := NewPaymentAttemptID()
		opID := NewOperationID()
		order := MerchantOrder{
			OrderID: orderID, CheckoutProposalID: cmd.CheckoutProposalID, LocationID: cmd.LocationID,
			SessionID: cmd.SessionID, State: OrderPendingPayment, Amount: Money{cmd.AmountMinor, cmd.Currency},
			Lines: cmd.Lines, QuoteHash: cmd.QuoteHash, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.InsertOrder(order); err != nil {
			return err
		}
		attempt := PaymentAttempt{
			PaymentAttemptID: attemptID, CheckoutProposalID: cmd.CheckoutProposalID, MerchantOrderID: orderID,
			ExecutionPassportID: cmd.ExecutionPassportID, CapabilityID: cmd.CapabilityID, State: StateCreated,
			Version: 1, Amount: Money{cmd.AmountMinor, cmd.Currency}, IdempotencyKey: cmd.IdempotencyKey,
			HostID: cmd.HostID, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.InsertAttempt(attempt); err != nil {
			return err
		}
		if err := tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobCreateProviderOrder,
			PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": attemptID, "scenario": cmd.Scenario, "checkout_page_url": cmd.CheckoutPageURL}),
			DedupKey:    "create-order:" + attemptID, AvailableAt: now,
		}); err != nil {
			return err
		}
		if err := tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "PAYMENT_ATTEMPT_CREATED", PaymentAttemptID: attemptID, OrderID: orderID,
			SafeBody: map[string]any{
				"amount_minor": AmountString(cmd.AmountMinor), "currency": cmd.Currency,
				"capability_id": cmd.CapabilityID, "proposal_id": cmd.CheckoutProposalID,
				"not_settlement": true, "rail": "razorpay_test_mode_capture",
			},
			OccurredAt: now,
		}); err != nil {
			return err
		}
		result = CompleteCheckoutResult{
			MerchantOrderID: orderID, PaymentAttemptID: attemptID, OperationID: opID,
			PublicStatus: PublicPaymentProcessing, PollAfterMS: []int{1000, 2000, 5000},
		}
		return nil
	})
	return result, err
}

func canonicalCheckout(cmd CompleteCheckoutCommand) string {
	return SnapshotDigest(cmd.CheckoutProposalID, AmountString(cmd.AmountMinor), cmd.Currency, cmd.CapabilityID)
}

func publicStatus(a PaymentAttempt, o MerchantOrder) PublicOrderStatus {
	switch {
	case a.State == StateCapturedReconciled && o.State == OrderConfirmed:
		return PublicConfirmed
	case a.State == StateFailedVerified || a.State == StateCancelledVerified:
		return PublicPaymentFailedVerified
	case a.ReasonCode == ReasonWaitingEventBinding || a.ReasonCode == ReasonWebhookTimeout:
		return PublicCapturedAwaitingBinding
	case a.State == StateOutcomeUnknown:
		return PublicOutcomeUnknown
	case a.State == StateReconciling:
		return PublicPaymentReconciliationRequired
	default:
		return PublicPaymentProcessing
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func payloadString(raw []byte, key string) string {
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	return m[key]
}

func (s *Service) HandleCreateProviderOrder(ctx context.Context, job WorkerJob) error {
	attemptID := payloadString(job.PayloadJSON, "payment_attempt_id")
	scenario := payloadString(job.PayloadJSON, "scenario")
	pageURL := payloadString(job.PayloadJSON, "checkout_page_url")
	if scenario == "" {
		scenario = "success"
	}

	var attempt PaymentAttempt
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.ProviderIdempotencyKey == "" {
			a.ProviderIdempotencyKey = ProviderCreateOrderKey(a.PaymentAttemptID)
			a.ProviderRequestDigest = SnapshotDigest(
				AmountString(a.Amount.AmountMinor), a.Amount.Currency, a.CheckoutProposalID, a.MerchantOrderID, "create_order",
			)
			if err := tx.UpdateAttempt(a); err != nil {
				return err
			}
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
	if attempt.RazorpayOrderID != "" {
		return nil
	}
	if err := s.Cfg.Validate(); err != nil {
		return ErrLiveMode
	}

	order, err := s.Client.CreateOrder(ctx, provider.CreateOrderRequest{
		AmountMinor:    attempt.Amount.AmountMinor,
		Currency:       attempt.Amount.Currency,
		Receipt:        attempt.CheckoutProposalID,
		PaymentCapture: s.Cfg.PaymentCaptureFlag(),
		IdempotencyKey: attempt.ProviderIdempotencyKey,
		Notes: map[string]string{
			"payment_attempt_id": attempt.PaymentAttemptID,
			"merchant_order_id":  attempt.MerchantOrderID,
		},
	})
	if err != nil {
		return s.markUnknown(ctx, attemptID, classifyProviderError(err, ReasonTransportFailure))
	}
	if order.Amount != attempt.Amount.AmountMinor || order.Currency != attempt.Amount.Currency {
		return s.markUnknown(ctx, attemptID, ReasonProviderMismatch)
	}

	token := NewExecutorToken()
	tokenHash := HashToken(token)
	runnerJobID := NewRunnerJobID()

	return s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		a.RazorpayOrderID = order.ID
		a.DuplicateFrozen = false
		a.FulfillmentFrozen = false
		a.HoldReleaseFrozen = false
		a.EffectDisposition = ""
		a.ReasonCode = ""
		a.State = StateProviderOrderCreated
		if err := tx.UpdateAttempt(a); err != nil {
			return err
		}
		if !s.OperatorAssisted {
			a.State = StateRunnerQueued
			if err := tx.UpdateAttempt(a); err != nil {
				return err
			}
			if err := tx.InsertRunnerJob(RunnerJob{
				JobID: runnerJobID, PaymentAttemptID: attemptID, ExecutorToken: token, ExecutorTokenHash: tokenHash,
				Status: "ISSUED", RazorpayOrderID: order.ID, RazorpayKeyID: s.Cfg.KeyID,
				AmountMinor: attempt.Amount.AmountMinor, Currency: attempt.Amount.Currency,
				CallbackOrigin: s.Cfg.CallbackOrigin, Scenario: scenario, CheckoutPageURL: pageURL,
				CreatedAt: tx.Now(),
			}); err != nil {
				return err
			}
			if err := tx.EnqueueJob(WorkerJob{
				JobID: NewJobID(), Type: JobRunTestCheckout,
				PayloadJSON: mustJSON(map[string]string{
					"payment_attempt_id": attemptID, "runner_job_id": runnerJobID, "executor_token": token,
				}),
				DedupKey: "run-checkout:" + attemptID, AvailableAt: tx.Now(),
			}); err != nil {
				return err
			}
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "PROVIDER_ORDER_CREATED", PaymentAttemptID: attemptID, OrderID: a.MerchantOrderID,
			SafeBody: map[string]any{
				"razorpay_order_id": order.ID, "amount_minor": AmountString(order.Amount), "currency": order.Currency,
				"provider_idempotency_key_present": true, "not_settlement": true,
			},
			OccurredAt: tx.Now(),
		})
	})
}

// ClaimRunnerJob is the Core side of POST /internal/v1/test-runner/jobs/claim.
// executorCredential authenticates the runner process. The one-action token is returned once.
func (s *Service) ClaimRunnerJob(ctx context.Context, executorCredential string) (RunnerJob, error) {
	if err := s.verifyRunnerCredential(executorCredential); err != nil {
		return RunnerJob{}, err
	}
	var job RunnerJob
	err := s.Store.RunInTx(ctx, func(tx Tx) error {
		j, ok := tx.ClaimIssuedRunnerJob("")
		if !ok {
			return Err("RUNNER_JOB_NOT_FOUND", "no issued runner job")
		}
		j.ClaimedByIdentity = s.runnerIdentity()
		_ = tx.UpdateRunnerJob(j)
		job = j
		return nil
	})
	return job, err
}

type RunnerObservation struct {
	JobID                 string
	ExecutorToken         string
	ExecutorCredential    string
	ObservedScreen        string // checkout_opened | possible_submission | success_screen | failure_screen | timeout
	RazorpayOrderID       string
	RazorpayPaymentID     string
	ObservationConfidence string
}

// RecordRunnerObservation stores what the private executor saw.
// A success screen never confirms the merchant order and never skips provider fetch.
func (s *Service) RecordRunnerObservation(ctx context.Context, obs RunnerObservation) error {
	if err := s.verifyRunnerCredential(obs.ExecutorCredential); err != nil {
		return err
	}
	if obs.RazorpayPaymentID != "" && !validRazorpayPaymentID(obs.RazorpayPaymentID) {
		return Err("RUNNER_OBSERVATION_INVALID", "razorpay payment id format is invalid")
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		j, ok := tx.GetRunnerJob(obs.JobID)
		if !ok {
			return Err("NOT_FOUND", "runner job not found")
		}
		if HashToken(obs.ExecutorToken) != j.ExecutorTokenHash {
			return Err("RUNNER_FORBIDDEN", "executor token mismatch")
		}
		if obs.RazorpayOrderID != "" && obs.RazorpayOrderID != j.RazorpayOrderID {
			return Err("RUNNER_OBSERVATION_MISMATCH", "reported razorpay order id does not match issued job")
		}
		confidence := obs.ObservationConfidence
		if confidence == "" {
			confidence = ObservationNonAuthoritative
		}
		j.Status = "OBSERVED"
		j.ObservationSummary = obs.ObservedScreen
		j.ObservationConfidence = confidence
		if err := tx.UpdateRunnerJob(j); err != nil {
			return err
		}
		a, ok := tx.GetAttemptByID(j.PaymentAttemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.State.Terminal() {
			return tx.InsertAudit(AuditEvent{
				AuditEventID: NewAuditID(), Kind: "RUNNER_OBSERVATION", PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
				SafeBody: map[string]any{
					"screen": obs.ObservedScreen, "not_capture": true, "already_terminal": true,
					"observation_confidence": confidence, "not_authoritative": true,
					"observed_provider_order_id": obs.RazorpayOrderID, "observed_provider_payment_id": obs.RazorpayPaymentID,
				},
				OccurredAt: tx.Now(), OperationID: a.OperationID, RequestID: a.RequestID,
			})
		}
		switch obs.ObservedScreen {
		case "checkout_opened", "failure_screen":
			if CanTransition(a.State, StateCheckoutInProgress) && !a.State.Terminal() {
				a.State = StateCheckoutInProgress
				if err := tx.UpdateAttempt(a); err != nil {
					return err
				}
			}
		case "success_screen":
			if CanTransition(a.State, StateProviderSubmitted) {
				a.State = StateProviderSubmitted
				if err := tx.UpdateAttempt(a); err != nil {
					return err
				}
			}
			if err := tx.EnqueueJob(WorkerJob{
				JobID: NewJobID(), Type: JobReconcilePayment,
				PayloadJSON: mustJSON(map[string]string{"payment_attempt_id": a.PaymentAttemptID}),
				DedupKey:    fmt.Sprintf("reconcile-obs:%s", a.PaymentAttemptID),
				AvailableAt: tx.Now(),
			}); err != nil {
				return err
			}
		case "possible_submission", "timeout":
			return s.applyUnknown(tx, a, ReasonBrowserAmbiguity)
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "RUNNER_OBSERVATION", PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
			SafeBody: map[string]any{
				"screen": obs.ObservedScreen, "not_capture": true,
				"observation_confidence": confidence, "not_authoritative": true,
				"observed_provider_order_id": obs.RazorpayOrderID, "observed_provider_payment_id": obs.RazorpayPaymentID,
			},
			OccurredAt: tx.Now(), OperationID: a.OperationID, RequestID: a.RequestID,
		})
	})
}

func (s *Service) markUnknown(ctx context.Context, attemptID, reason string) error {
	if reason == "" {
		reason = ReasonPossibleSubmission
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		return s.applyUnknown(tx, a, reason)
	})
}

func (s *Service) applyUnknown(tx Tx, a PaymentAttempt, reason string) error {
	if a.State.Terminal() {
		return nil
	}
	if reason == "" {
		reason = ReasonPossibleSubmission
	}
	a.State = StateOutcomeUnknown
	a.DuplicateFrozen = true
	a.FulfillmentFrozen = true
	a.HoldReleaseFrozen = true
	a.EffectDisposition = DispositionExternalUnknown
	a.ReasonCode = reason
	if err := tx.UpdateAttempt(a); err != nil {
		return err
	}
	if err := tx.FreezeHold(a.CheckoutProposalID); err != nil {
		return err
	}
	if err := s.scheduleFollowUp(tx, a); err != nil {
		return err
	}
	if err := tx.InsertAudit(AuditEvent{
		AuditEventID: NewAuditID(), Kind: "OUTCOME_UNKNOWN", PaymentAttemptID: a.PaymentAttemptID, OrderID: a.MerchantOrderID,
		SafeBody: map[string]any{
			"effect_disposition": DispositionExternalUnknown, "reason_code": reason,
			"duplicate_attempt_frozen": true, "fulfillment_frozen": true, "hold_release_frozen": true,
			"not_settlement": true,
		},
		OccurredAt: tx.Now(),
	}); err != nil {
		return err
	}
	return recordAsyncDecision(tx, a, "OUTCOME_UNKNOWN", "Atlas froze this Test Mode payment because the provider outcome is unknown.", map[string]any{
		"effect_disposition": DispositionExternalUnknown, "reason_code": reason,
	})
}
