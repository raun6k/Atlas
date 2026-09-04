package payment

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type existingTxKey struct{}

// WithExistingTx attaches Kernel's open transaction so AfterPendingOrder can
// see the uncommitted pending Merchant Order (ID-509).
func WithExistingTx(ctx context.Context, tx pgx.Tx) context.Context {
	if tx == nil {
		return ctx
	}
	return context.WithValue(ctx, existingTxKey{}, tx)
}

func ExistingTx(ctx context.Context) pgx.Tx {
	tx, _ := ctx.Value(existingTxKey{}).(pgx.Tx)
	return tx
}

// Hook is the Kernel complete_checkout seam (ID-003 / ID-202 / ID-503).
// Payment Fabric must not invent CAPTURED_RECONCILED here.
type Hook interface {
	AfterPendingOrder(ctx context.Context, in PendingOrder) error
}

type PendingOrder struct {
	OrderID          string
	PaymentAttemptID string
	ProposalID       string
	AmountMinor      int64
	Currency         string
	OperationID      string
	PassportID       string
	HostID           string
	IdempotencyKey   string
	RequestID        string
	SessionID        string
	LocationID       string
	QuoteHash        string
	Scenario         string
}

var current Hook = Noop{}

func Current() Hook { return current }

func SetCurrent(h Hook) {
	if h != nil {
		current = h
	}
}

type Noop struct{}

func (Noop) AfterPendingOrder(context.Context, PendingOrder) error { return nil }

type serviceHook struct{ svc *Service }

func (h serviceHook) AfterPendingOrder(ctx context.Context, in PendingOrder) error {
	return h.svc.AfterPendingOrder(ctx, in)
}

// AfterPendingOrder records a PaymentAttempt against the Kernel pending Merchant Order
// and enqueues CREATE_PROVIDER_ORDER. It does not insert a second order aggregate.
func (s *Service) AfterPendingOrder(ctx context.Context, in PendingOrder) error {
	if in.HostID == "" {
		in.HostID = "host_atlaslab_quickmart"
	}
	if in.IdempotencyKey == "" {
		in.IdempotencyKey = in.OperationID
	}
	if in.Currency == "" {
		in.Currency = "INR"
	}
	if in.Scenario == "" {
		in.Scenario = "success"
	}
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		if existing, ok := tx.GetAttemptByID(in.PaymentAttemptID); ok {
			_ = existing
			return nil
		}
		if _, ok := tx.GetOrderByID(in.OrderID); !ok {
			return Err("NOT_FOUND", "pending merchant order not found")
		}
		now := tx.Now()
		if err := tx.InsertAttempt(PaymentAttempt{
			PaymentAttemptID:    in.PaymentAttemptID,
			CheckoutProposalID:  in.ProposalID,
			MerchantOrderID:     in.OrderID,
			ExecutionPassportID: in.PassportID,
			CapabilityID:        CapabilityRazorpayTest,
			State:               StateCreated,
			Version:             1,
			Amount:              Money{in.AmountMinor, in.Currency},
			IdempotencyKey:      in.IdempotencyKey,
			HostID:              in.HostID,
			CreatedAt:           now,
			UpdatedAt:           now,
		}); err != nil {
			return err
		}
		if err := tx.EnqueueJob(WorkerJob{
			JobID: NewJobID(), Type: JobCreateProviderOrder,
			PayloadJSON: mustJSON(map[string]string{
				"payment_attempt_id": in.PaymentAttemptID,
				"scenario":           in.Scenario,
			}),
			DedupKey:    "create-order:" + in.PaymentAttemptID,
			AvailableAt: now,
		}); err != nil {
			return err
		}
		return tx.InsertAudit(AuditEvent{
			AuditEventID: NewAuditID(), Kind: "PAYMENT_ATTEMPT_CREATED",
			PaymentAttemptID: in.PaymentAttemptID, OrderID: in.OrderID,
			SafeBody: map[string]any{
				"amount_minor": AmountString(in.AmountMinor), "currency": in.Currency,
				"capability_id": CapabilityRazorpayTest, "proposal_id": in.ProposalID,
				"not_capture": true,
			},
			OccurredAt: now,
		})
	})
}
