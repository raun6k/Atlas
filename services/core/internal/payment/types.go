package payment

import (
	"time"

	"atlas.dev/core/internal/provider"
)

const CapabilityRazorpayTest = provider.CapabilityRazorpayTest

type State string

const (
	StateCreated              State = "CREATED"
	StateProviderOrderCreated State = "PROVIDER_ORDER_CREATED"
	StateRunnerQueued         State = "RUNNER_QUEUED"
	StateCheckoutInProgress   State = "CHECKOUT_IN_PROGRESS"
	StateProviderSubmitted    State = "PROVIDER_SUBMITTED"
	StateReconciling          State = "RECONCILING"
	StateCapturedReconciled   State = "CAPTURED_RECONCILED"
	StateFailedVerified       State = "FAILED_VERIFIED"
	StateCancelledVerified    State = "CANCELLED_VERIFIED"
	StateOutcomeUnknown       State = "OUTCOME_UNKNOWN"
)

func (s State) Terminal() bool {
	return s == StateCapturedReconciled || s == StateFailedVerified || s == StateCancelledVerified
}

func (s State) Frozen() bool {
	return s == StateOutcomeUnknown || s == StateReconciling
}

type OrderState string

const (
	OrderPendingPayment OrderState = "PENDING_PAYMENT"
	OrderPaymentFailed  OrderState = "PAYMENT_FAILED"
	OrderConfirmed      OrderState = "CONFIRMED"
	OrderFulfilling     OrderState = "FULFILLING"
	OrderCompleted      OrderState = "COMPLETED"
	OrderCancelled      OrderState = "CANCELLED"
)

type PublicOrderStatus string

const (
	PublicPaymentProcessing             PublicOrderStatus = "PAYMENT_PROCESSING"
	PublicPaymentFailedVerified         PublicOrderStatus = "PAYMENT_FAILED_VERIFIED"
	PublicPaymentReconciliationRequired PublicOrderStatus = "PAYMENT_RECONCILIATION_REQUIRED"
	PublicOutcomeUnknown                PublicOrderStatus = "OUTCOME_UNKNOWN"
	PublicConfirmed                     PublicOrderStatus = "CONFIRMED"
	PublicCapturedAwaitingBinding       PublicOrderStatus = "CAPTURED_AWAITING_BINDING"
)

type Money struct {
	AmountMinor int64
	Currency    string
}

type PaymentAttempt struct {
	PaymentAttemptID         string
	CheckoutProposalID       string
	MerchantOrderID          string
	ExecutionPassportID      string
	CapabilityID             string
	State                    State
	Version                  int64
	Amount                   Money
	RazorpayOrderID          string
	RazorpayPaymentID        string
	DuplicateFrozen          bool
	FulfillmentFrozen        bool
	HoldReleaseFrozen        bool
	EffectDisposition        string
	ReasonCode               string
	HasCallbackBinding       bool
	HasWebhookBinding        bool
	IdempotencyKey           string
	HostID                   string
	OperationID              string
	RequestID                string
	ProviderIdempotencyKey   string
	ProviderRequestDigest    string
	ReconcileAttemptCount    int
	ReconcileNextAttemptAt   *time.Time
	WaitingEventBindingSince *time.Time
	CreatedAt                time.Time
	UpdatedAt                time.Time
}

func (a PaymentAttempt) HasEventBinding() bool {
	return a.HasCallbackBinding || a.HasWebhookBinding
}

type OrderLine struct {
	SKUId        string
	Quantity     int64
	AmountMinor  int64
	Currency     string
	ProductTitle string
}

type MerchantOrder struct {
	OrderID                   string
	CheckoutProposalID        string
	LocationID                string
	SessionID                 string
	CapturedPaymentAttemptID  string
	CapturedRazorpayPaymentID string
	State                     OrderState
	Amount                    Money
	Lines                     []OrderLine
	QuoteHash                 string
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type ProviderEvent struct {
	RowID             string
	ProviderEventID   string
	EventType         string
	BodyDigest        string
	SignatureValid    bool
	RazorpayOrderID   string
	RazorpayPaymentID string
	AmountMinor       int64
	Currency          string
	ProviderStatus    string
	ReceivedAt        time.Time
	SourceOccurredAt  time.Time
	PaymentAttemptID  string
}

type Reconciliation struct {
	ReconciliationID string
	PaymentAttemptID string
	FetchedAt        time.Time
	ProviderOrderID  string
	ProviderStatus   string
	SnapshotDigest   string
	Decision         string
	MismatchReason   string
}

type RunnerJob struct {
	JobID                 string
	PaymentAttemptID      string
	ExecutorToken         string // returned once on claim; never logged
	ExecutorTokenHash     string
	Status                string // ISSUED, CLAIMED, OBSERVED, EXPIRED
	RazorpayOrderID       string
	RazorpayKeyID         string
	AmountMinor           int64
	Currency              string
	CallbackOrigin        string
	Scenario              string
	CheckoutPageURL       string
	ClaimedAt             *time.Time
	ObservationSummary    string
	ObservationConfidence string
	ClaimedByIdentity     string
	CreatedAt             time.Time
}

type WorkerJob struct {
	JobID        string
	Type         string
	PayloadJSON  []byte
	DedupKey     string
	AvailableAt  time.Time
	AttemptCount int
	Done         bool
	Failed       bool
	OperationID  string
	LastError    string
}

type AuditEvent struct {
	AuditEventID     string
	Kind             string
	PaymentAttemptID string
	OrderID          string
	RefundID         string
	RecordSequence   int64
	SafeBody         map[string]any
	OccurredAt       time.Time
	OperationID      string
	RequestID        string
	Authoritative    *bool
}

const (
	JobCreateProviderOrder      = "CREATE_PROVIDER_ORDER"
	JobRunTestCheckout          = "RUN_TEST_CHECKOUT"
	JobReconcilePayment         = "RECONCILE_PAYMENT"
	JobCaptureAuthorizedPayment = "CAPTURE_AUTHORIZED_PAYMENT"
	JobRequestRefund            = "REQUEST_REFUND"
	JobReconcileRefund          = "RECONCILE_REFUND"
)

const (
	DispositionExternalUnknown  = "EXTERNAL_OUTCOME_UNKNOWN"
	ReasonPossibleSubmission    = "POSSIBLE_PROVIDER_SUBMISSION"
	ReasonTransportFailure      = "TRANSPORT_FAILURE"
	ReasonMalformedResponse     = "MALFORMED_PROVIDER_RESPONSE"
	ReasonProviderTimeout       = "PROVIDER_TIMEOUT"
	ReasonBrowserAmbiguity      = "BROWSER_AMBIGUITY"
	ReasonWebhookDelay          = "WEBHOOK_DELAY"
	ReasonWebhookTimeout        = "WEBHOOK_TIMEOUT"
	ReasonProviderMismatch      = "PROVIDER_MISMATCH"
	ReasonFetchFailure          = "FETCH_FAILURE"
	ReasonCaptureResponseLoss   = "CAPTURE_RESPONSE_LOSS"
	ReasonWaitingEventBinding   = "WAITING_EVENT_BINDING"
	ReasonReconcileExhausted    = "RECONCILE_EXHAUSTED"
	MaxReconcileAttempts        = 8
	WebhookBindingTimeout       = 15 * time.Minute
	ObservationNonAuthoritative = "browser_non_authoritative"
)
