package payment

import "fmt"

type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Code + ": " + e.Message
}

func Err(code, msg string) *Error {
	return &Error{Code: code, Message: msg}
}

func ErrRetryable(code, msg string) *Error {
	return &Error{Code: code, Message: msg, Retryable: true}
}

var (
	ErrLiveMode                = Err("LIVE_MODE_REJECTED", "Razorpay Live Mode is not permitted")
	ErrCapability              = Err("PAYMENT_CAPABILITY_INVALID", "only pcap_razorpay_test is permitted")
	ErrIdempotencyConflict     = Err("IDEMPOTENCY_CONFLICT", "idempotency key reused with different input")
	ErrDuplicateEvent          = Err("PROVIDER_EVENT_DUPLICATE", "provider event id already ingested")
	ErrInvalidSignature        = Err("PROVIDER_SIGNATURE_INVALID", "provider signature verification failed")
	ErrAttemptFrozen           = Err("OUTCOME_UNKNOWN", "retry is frozen until reconciliation")
	ErrNotCaptured             = Err("PAYMENT_NOT_CAPTURED", "merchant order is not captured")
	ErrTerminal                = Err("PAYMENT_ALREADY_TERMINAL", "payment already in a verified terminal state")
	ErrFetchMismatch           = Err("PROVIDER_FETCH_MISMATCH", "provider fetch does not match expected order, amount, or currency")
	ErrBrowserNotTruth         = Err("BROWSER_NOT_PAYMENT_TRUTH", "browser success is not capture")
	ErrReservationInsufficient = Err("REFUND_BALANCE_INSUFFICIENT", "remaining refundable balance is insufficient")
	ErrRefundFrozen            = Err("REFUND_OUTCOME_UNKNOWN", "duplicate refund is frozen until reconciliation")
)

func Is(err error, code string) bool {
	if e, ok := err.(*Error); ok {
		return e.Code == code
	}
	return false
}

func Wrap(code string, err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := err.(*Error); ok {
		return e
	}
	return Err(code, fmt.Sprintf("%v", err))
}
