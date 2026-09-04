package payment

import "time"

type RefundState string

const (
	RefundRequested         RefundState = "REQUESTED"
	RefundSubmitting        RefundState = "SUBMITTING"
	RefundProviderSubmitted RefundState = "PROVIDER_SUBMITTED"
	RefundReconciling       RefundState = "RECONCILING"
	RefundProcessed         RefundState = "PROCESSED_RECONCILED"
	RefundFailedVerified    RefundState = "FAILED_VERIFIED"
	RefundOutcomeUnknown    RefundState = "OUTCOME_UNKNOWN"
)

type ReservationStatus string

const (
	ReservationActive    ReservationStatus = "ACTIVE"
	ReservationCommitted ReservationStatus = "COMMITTED"
	ReservationReleased  ReservationStatus = "RELEASED"
)

type Refund struct {
	RefundID          string
	PaymentAttemptID  string
	OrderID           string
	AmountMinor       int64
	Currency          string
	State             RefundState
	IdempotencyKey    string
	RazorpayRefundID  string
	ReasonCode        string
	EffectDisposition string
	DuplicateFrozen   bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type RefundReservation struct {
	ReservationID    string
	RefundID         string
	PaymentAttemptID string
	AmountMinor      int64
	Status           ReservationStatus
	CreatedAt        time.Time
}

func RemainingRefundable(capturedMinor int64, refunds []Refund, reservations []RefundReservation) int64 {
	spent := int64(0)
	reservedIDs := map[string]bool{}
	for _, rr := range reservations {
		if rr.Status == ReservationActive || rr.Status == ReservationCommitted {
			spent += rr.AmountMinor
			reservedIDs[rr.RefundID] = true
		}
	}
	for _, rf := range refunds {
		if reservedIDs[rf.RefundID] {
			continue
		}
		if rf.State == RefundProcessed || rf.State == RefundRequested || rf.State == RefundSubmitting ||
			rf.State == RefundProviderSubmitted || rf.State == RefundReconciling || rf.State == RefundOutcomeUnknown {
			spent += rf.AmountMinor
		}
	}
	rem := capturedMinor - spent
	if rem < 0 {
		return 0
	}
	return rem
}
