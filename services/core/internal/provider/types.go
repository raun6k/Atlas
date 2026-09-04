package provider

// Money is integer minor units plus ISO 4217 currency. Never float.
type Money struct {
	AmountMinor int64
	Currency    string
}

func (m Money) Equal(other Money) bool {
	return m.AmountMinor == other.AmountMinor && m.Currency == other.Currency
}

// Order is a Razorpay Order snapshot from an authenticated fetch or create.
type Order struct {
	ID       string
	Amount   int64
	Currency string
	Status   string
	Receipt  string
	Notes    map[string]string
}

// Payment is a Razorpay Payment snapshot from an authenticated fetch.
type Payment struct {
	ID       string
	OrderID  string
	Amount   int64
	Currency string
	Status   string // created, authorized, captured, failed, refunded
	Captured bool
	Method   string
}

// Refund is a Razorpay Refund snapshot.
type Refund struct {
	ID        string
	PaymentID string
	Amount    int64
	Currency  string
	Status    string // pending, processed, failed
}

// CreateOrderRequest is the exact amount/currency Atlas will pay.
type CreateOrderRequest struct {
	AmountMinor    int64
	Currency       string
	Receipt        string
	PaymentCapture int
	Notes          map[string]string
}

// CaptureRequest captures an authorized payment for the exact amount.
type CaptureRequest struct {
	PaymentID   string
	AmountMinor int64
	Currency    string
}

// CreateRefundRequest refunds part or all of a captured payment.
type CreateRefundRequest struct {
	PaymentID      string
	AmountMinor    int64
	IdempotencyKey string
	Notes          map[string]string
}
