package payment

import (
	"context"
	"time"
)

type Store interface {
	RunInTx(ctx context.Context, fn func(Tx) error) error
}

type Tx interface {
	Now() time.Time
	NextRecordSequence() int64

	GetAttemptByID(id string) (PaymentAttempt, bool)
	GetAttemptByProposal(proposalID string) (PaymentAttempt, bool)
	GetAttemptByRazorpayOrder(orderID string) (PaymentAttempt, bool)
	GetAttemptByIdempotency(hostID, key string) (PaymentAttempt, bool)
	InsertAttempt(a PaymentAttempt) error
	UpdateAttempt(a PaymentAttempt) error

	GetOrderByID(id string) (MerchantOrder, bool)
	GetOrderByProposal(proposalID string) (MerchantOrder, bool)
	InsertOrder(o MerchantOrder) error
	UpdateOrder(o MerchantOrder) error

	InsertProviderEvent(e ProviderEvent) error // unique provider_event_id
	GetProviderEvent(providerEventID string) (ProviderEvent, bool)
	ListProviderEvents(attemptID string) []ProviderEvent

	InsertReconciliation(r Reconciliation) error
	ListReconciliations(attemptID string) []Reconciliation

	InsertRunnerJob(j RunnerJob) error
	GetRunnerJob(id string) (RunnerJob, bool)
	ClaimIssuedRunnerJob(tokenHash string) (RunnerJob, bool)
	UpdateRunnerJob(j RunnerJob) error

	EnqueueJob(j WorkerJob) error
	ClaimJobs(jobType string, limit int) []WorkerJob
	CompleteJob(id string) error
	ListJobs() []WorkerJob

	InsertAudit(e AuditEvent) error
	ListAudit(attemptID string) []AuditEvent

	ConvertHold(proposalID string) error
	FreezeHold(proposalID string) error
	HoldConverted(proposalID string) bool
	HoldFrozen(proposalID string) bool

	LockPaymentForRefund(attemptID string) (PaymentAttempt, error)

	InsertRefund(r Refund) error
	UpdateRefund(r Refund) error
	GetRefund(id string) (Refund, bool)
	GetRefundByIdempotency(key string) (Refund, bool)
	ListRefunds(attemptID string) []Refund
	InsertRefundReservation(rr RefundReservation) error
	UpdateRefundReservation(rr RefundReservation) error
	ListReservations(attemptID string) []RefundReservation
}

// InventoryHooks are Kernel-owned reservation transitions. Payment Fabric calls them
// inside the confirm / freeze transaction. Join stitches the real inventory package.
type InventoryHooks struct {
	ConvertHold func(ctx context.Context, proposalID string) error
	FreezeHold  func(ctx context.Context, proposalID string) error
}
