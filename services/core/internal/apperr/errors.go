package apperr

import (
	"errors"
	"fmt"
)

const (
	CartVersionConflict      = "CART_VERSION_CONFLICT"
	SessionVersionConflict   = "SESSION_VERSION_CONFLICT"
	IdempotencyConflict      = "IDEMPOTENCY_CONFLICT"
	ItemUnavailable          = "ITEM_UNAVAILABLE"
	InventoryChanged         = "INVENTORY_CHANGED"
	OfferExpired             = "OFFER_EXPIRED"
	OfferContextInvalid      = "OFFER_CONTEXT_INVALID"
	RequoteRequired          = "REQUOTE_REQUIRED"
	ReauthorizeRequired      = "REAUTHORIZE_REQUIRED"
	HostUnauthenticated      = "HOST_UNAUTHENTICATED"
	HostForbidden            = "HOST_FORBIDDEN"
	MerchantPolicyDenied     = "MERCHANT_POLICY_DENIED"
	AuthorityInvalid         = "AUTHORITY_INVALID"
	AuthorityExpired         = "AUTHORITY_EXPIRED"
	AuthorityAmountExceeded  = "AUTHORITY_AMOUNT_EXCEEDED"
	PaymentProcessing        = "PAYMENT_PROCESSING"
	PaymentFailedVerified    = "PAYMENT_FAILED_VERIFIED"
	OutcomeUnknown           = "OUTCOME_UNKNOWN"
	PaymentReconciliationReq = "PAYMENT_RECONCILIATION_REQUIRED"
	SubstitutionRequired     = "SUBSTITUTION_REQUIRED"
	RateLimited              = "RATE_LIMITED"
	TemporarilyUnavailable   = "TEMPORARILY_UNAVAILABLE"
	NotFound                 = "NOT_FOUND"
	InvalidArgument          = "INVALID_ARGUMENT"
	Unauthenticated          = "UNAUTHENTICATED"
	Forbidden                = "FORBIDDEN"
)

type E struct {
	Code       string
	Message    string
	Retryable  bool
	RetryAfter int32
	Session    any
	Cart       any
	Operation  string
	Details    map[string]string
}

func (e *E) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func New(code, message string) *E {
	return &E{Code: code, Message: message, Details: map[string]string{}}
}

func Retryable(code, message string) *E {
	e := New(code, message)
	e.Retryable = true
	return e
}

func As(err error) *E {
	var e *E
	if errors.As(err, &e) {
		return e
	}
	return nil
}

func Is(err error, code string) bool {
	e := As(err)
	return e != nil && e.Code == code
}
