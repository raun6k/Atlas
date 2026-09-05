package payment

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

type MemoryStore struct {
	mu sync.Mutex

	attempts        map[string]PaymentAttempt
	byProposal      map[string]string
	byRazorpayOrder map[string]string
	byIdempotency   map[string]string

	orders           map[string]MerchantOrder
	orderByProposal  map[string]string
	capturedPayments map[string]string // razorpay payment id -> order id

	events          map[string]ProviderEvent
	eventsByAttempt map[string][]string
	reconciliations map[string][]Reconciliation
	runnerJobs      map[string]RunnerJob
	jobs            map[string]WorkerJob
	audits          []AuditEvent
	seq             int64

	holdsConverted map[string]bool
	holdsFrozen    map[string]bool

	refunds      map[string]Refund
	refundByIdem map[string]string
	reservations map[string]RefundReservation

	Hooks InventoryHooks
	now   func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		attempts:         map[string]PaymentAttempt{},
		byProposal:       map[string]string{},
		byRazorpayOrder:  map[string]string{},
		byIdempotency:    map[string]string{},
		orders:           map[string]MerchantOrder{},
		orderByProposal:  map[string]string{},
		capturedPayments: map[string]string{},
		events:           map[string]ProviderEvent{},
		eventsByAttempt:  map[string][]string{},
		reconciliations:  map[string][]Reconciliation{},
		runnerJobs:       map[string]RunnerJob{},
		jobs:             map[string]WorkerJob{},
		holdsConverted:   map[string]bool{},
		holdsFrozen:      map[string]bool{},
		refunds:          map[string]Refund{},
		refundByIdem:     map[string]string{},
		reservations:     map[string]RefundReservation{},
		now:              func() time.Time { return time.Now().UTC() },
	}
}

func (s *MemoryStore) RunInTx(ctx context.Context, fn func(Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx := &memTx{store: s, ctx: ctx}
	return fn(tx)
}

type memTx struct {
	store *MemoryStore
	ctx   context.Context
}

func (t *memTx) Now() time.Time { return t.store.now() }

func (t *memTx) NextRecordSequence() int64 {
	t.store.seq++
	return t.store.seq
}

func (t *memTx) GetAttemptByID(id string) (PaymentAttempt, bool) {
	a, ok := t.store.attempts[id]
	return a, ok
}

func (t *memTx) GetAttemptByProposal(proposalID string) (PaymentAttempt, bool) {
	id, ok := t.store.byProposal[proposalID]
	if !ok {
		return PaymentAttempt{}, false
	}
	return t.GetAttemptByID(id)
}

func (t *memTx) GetAttemptByRazorpayOrder(orderID string) (PaymentAttempt, bool) {
	id, ok := t.store.byRazorpayOrder[orderID]
	if !ok {
		return PaymentAttempt{}, false
	}
	return t.GetAttemptByID(id)
}

func (t *memTx) GetAttemptByIdempotency(hostID, key string) (PaymentAttempt, bool) {
	id, ok := t.store.byIdempotency[hostID+"|"+key]
	if !ok {
		return PaymentAttempt{}, false
	}
	return t.GetAttemptByID(id)
}

func (t *memTx) InsertAttempt(a PaymentAttempt) error {
	if _, exists := t.store.byProposal[a.CheckoutProposalID]; exists {
		return Err("IDEMPOTENCY_CONFLICT", "one payment attempt per consumed proposal")
	}
	if a.IdempotencyKey != "" {
		k := a.HostID + "|" + a.IdempotencyKey
		if _, exists := t.store.byIdempotency[k]; exists {
			return ErrIdempotencyConflict
		}
		t.store.byIdempotency[k] = a.PaymentAttemptID
	}
	t.store.attempts[a.PaymentAttemptID] = a
	t.store.byProposal[a.CheckoutProposalID] = a.PaymentAttemptID
	if a.RazorpayOrderID != "" {
		t.store.byRazorpayOrder[a.RazorpayOrderID] = a.PaymentAttemptID
	}
	return nil
}

func (t *memTx) UpdateAttempt(a PaymentAttempt) error {
	prev, ok := t.store.attempts[a.PaymentAttemptID]
	if !ok {
		return Err("NOT_FOUND", "payment attempt not found")
	}
	if prev.State.Terminal() && a.State != prev.State {
		return ErrTerminal
	}
	if !CanTransition(prev.State, a.State) {
		return Err("ILLEGAL_TRANSITION", "cannot move from "+string(prev.State)+" to "+string(a.State))
	}
	a.Version = prev.Version + 1
	a.UpdatedAt = t.Now()
	t.store.attempts[a.PaymentAttemptID] = a
	if a.RazorpayOrderID != "" {
		t.store.byRazorpayOrder[a.RazorpayOrderID] = a.PaymentAttemptID
	}
	return nil
}

func (t *memTx) GetOrderByID(id string) (MerchantOrder, bool) {
	o, ok := t.store.orders[id]
	return o, ok
}

func (t *memTx) GetOrderByProposal(proposalID string) (MerchantOrder, bool) {
	id, ok := t.store.orderByProposal[proposalID]
	if !ok {
		return MerchantOrder{}, false
	}
	return t.GetOrderByID(id)
}

func (t *memTx) InsertOrder(o MerchantOrder) error {
	if _, exists := t.store.orderByProposal[o.CheckoutProposalID]; exists {
		return Err("ORDER_PROPOSAL_UNIQUE", "unique merchant order per checkout proposal")
	}
	if o.CapturedRazorpayPaymentID != "" {
		if _, exists := t.store.capturedPayments[o.CapturedRazorpayPaymentID]; exists {
			return Err("ORDER_CAPTURED_PAYMENT_UNIQUE", "unique confirmed order per captured payment")
		}
		t.store.capturedPayments[o.CapturedRazorpayPaymentID] = o.OrderID
	}
	t.store.orders[o.OrderID] = o
	t.store.orderByProposal[o.CheckoutProposalID] = o.OrderID
	return nil
}

func (t *memTx) UpdateOrder(o MerchantOrder) error {
	prev, ok := t.store.orders[o.OrderID]
	if !ok {
		return Err("NOT_FOUND", "order not found")
	}
	if prev.State == OrderConfirmed && o.State != OrderConfirmed && o.State != OrderFulfilling && o.State != OrderCompleted && o.State != OrderCancelled {
		return Err("ORDER_CONFIRMATION_IMMUTABLE", "historical confirmation cannot be rewritten")
	}
	if o.CapturedRazorpayPaymentID != "" {
		if existing, exists := t.store.capturedPayments[o.CapturedRazorpayPaymentID]; exists && existing != o.OrderID {
			return Err("ORDER_CAPTURED_PAYMENT_UNIQUE", "unique confirmed order per captured payment")
		}
		t.store.capturedPayments[o.CapturedRazorpayPaymentID] = o.OrderID
	}
	t.store.orders[o.OrderID] = o
	return nil
}

func (t *memTx) InsertProviderEvent(e ProviderEvent) error {
	if _, exists := t.store.events[e.ProviderEventID]; exists {
		return ErrDuplicateEvent
	}
	t.store.events[e.ProviderEventID] = e
	t.store.eventsByAttempt[e.PaymentAttemptID] = append(t.store.eventsByAttempt[e.PaymentAttemptID], e.ProviderEventID)
	return nil
}

func (t *memTx) GetProviderEvent(id string) (ProviderEvent, bool) {
	e, ok := t.store.events[id]
	return e, ok
}

func (t *memTx) ListProviderEvents(attemptID string) []ProviderEvent {
	ids := t.store.eventsByAttempt[attemptID]
	out := make([]ProviderEvent, 0, len(ids))
	for _, id := range ids {
		out = append(out, t.store.events[id])
	}
	return out
}

func (t *memTx) InsertReconciliation(r Reconciliation) error {
	t.store.reconciliations[r.PaymentAttemptID] = append(t.store.reconciliations[r.PaymentAttemptID], r)
	return nil
}

func (t *memTx) ListReconciliations(attemptID string) []Reconciliation {
	return append([]Reconciliation{}, t.store.reconciliations[attemptID]...)
}

func (t *memTx) InsertRunnerJob(j RunnerJob) error {
	t.store.runnerJobs[j.JobID] = j
	return nil
}

func (t *memTx) GetRunnerJob(id string) (RunnerJob, bool) {
	j, ok := t.store.runnerJobs[id]
	return j, ok
}

func (t *memTx) ClaimIssuedRunnerJob(tokenHash string) (RunnerJob, bool) {
	for id, j := range t.store.runnerJobs {
		if j.Status != "ISSUED" {
			continue
		}
		if tokenHash != "" && j.ExecutorTokenHash != tokenHash {
			continue
		}
		now := t.Now()
		claimed := j
		claimed.Status = "CLAIMED"
		claimed.ClaimedAt = &now
		j.Status = "CLAIMED"
		j.ClaimedAt = &now
		j.ExecutorToken = "" // one-action: plaintext not retained after claim
		t.store.runnerJobs[id] = j
		return claimed, true
	}
	return RunnerJob{}, false
}

func (t *memTx) UpdateRunnerJob(j RunnerJob) error {
	t.store.runnerJobs[j.JobID] = j
	return nil
}

func (t *memTx) EnqueueJob(j WorkerJob) error {
	t.store.jobs[j.JobID] = j
	return nil
}

func (t *memTx) ClaimJobs(jobType string, limit int) []WorkerJob {
	var out []WorkerJob
	now := t.Now()
	for id, j := range t.store.jobs {
		if j.Done || j.Type != jobType || j.AvailableAt.After(now) {
			continue
		}
		j.AttemptCount++
		t.store.jobs[id] = j
		out = append(out, j)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func (t *memTx) CompleteJob(id string) error {
	j, ok := t.store.jobs[id]
	if !ok {
		return Err("NOT_FOUND", "job not found")
	}
	j.Done = true
	t.store.jobs[id] = j
	return nil
}

func (t *memTx) ListJobs() []WorkerJob {
	out := make([]WorkerJob, 0, len(t.store.jobs))
	for _, j := range t.store.jobs {
		out = append(out, j)
	}
	return out
}

func (t *memTx) InsertAudit(e AuditEvent) error {
	if e.OperationID == "" && e.PaymentAttemptID != "" {
		if a, ok := t.store.attempts[e.PaymentAttemptID]; ok {
			e.OperationID = a.OperationID
			if e.RequestID == "" {
				e.RequestID = a.RequestID
			}
		}
	}
	e.RecordSequence = t.NextRecordSequence()
	t.store.audits = append(t.store.audits, e)
	return nil
}

func (t *memTx) ListAudit(attemptID string) []AuditEvent {
	var out []AuditEvent
	for _, a := range t.store.audits {
		if a.PaymentAttemptID == attemptID {
			out = append(out, a)
		}
	}
	return out
}

func (t *memTx) ConvertHold(proposalID string) error {
	if t.store.Hooks.ConvertHold != nil {
		if err := t.store.Hooks.ConvertHold(t.ctx, proposalID); err != nil {
			return err
		}
	}
	t.store.holdsConverted[proposalID] = true
	return nil
}

func (t *memTx) FreezeHold(proposalID string) error {
	if t.store.Hooks.FreezeHold != nil {
		if err := t.store.Hooks.FreezeHold(t.ctx, proposalID); err != nil {
			return err
		}
	}
	t.store.holdsFrozen[proposalID] = true
	return nil
}

func (t *memTx) HoldConverted(proposalID string) bool { return t.store.holdsConverted[proposalID] }
func (t *memTx) HoldFrozen(proposalID string) bool    { return t.store.holdsFrozen[proposalID] }

func (t *memTx) LockPaymentForRefund(attemptID string) (PaymentAttempt, error) {
	a, ok := t.store.attempts[attemptID]
	if !ok {
		return PaymentAttempt{}, Err("NOT_FOUND", "payment attempt not found")
	}
	return a, nil
}

func (t *memTx) InsertRefund(r Refund) error {
	if r.IdempotencyKey != "" {
		if existing, ok := t.store.refundByIdem[r.IdempotencyKey]; ok {
			if existing != r.RefundID {
				return ErrIdempotencyConflict
			}
		}
		t.store.refundByIdem[r.IdempotencyKey] = r.RefundID
	}
	t.store.refunds[r.RefundID] = r
	return nil
}

func (t *memTx) UpdateRefund(r Refund) error {
	t.store.refunds[r.RefundID] = r
	return nil
}

func (t *memTx) GetRefund(id string) (Refund, bool) {
	r, ok := t.store.refunds[id]
	return r, ok
}

func (t *memTx) GetRefundByIdempotency(key string) (Refund, bool) {
	id, ok := t.store.refundByIdem[key]
	if !ok {
		return Refund{}, false
	}
	return t.GetRefund(id)
}

func (t *memTx) ListRefunds(attemptID string) []Refund {
	var out []Refund
	for _, r := range t.store.refunds {
		if r.PaymentAttemptID == attemptID {
			out = append(out, r)
		}
	}
	return out
}

func (t *memTx) InsertRefundReservation(rr RefundReservation) error {
	t.store.reservations[rr.ReservationID] = rr
	return nil
}

func (t *memTx) UpdateRefundReservation(rr RefundReservation) error {
	t.store.reservations[rr.ReservationID] = rr
	return nil
}

func (t *memTx) ListReservations(attemptID string) []RefundReservation {
	var out []RefundReservation
	for _, r := range t.store.reservations {
		if r.PaymentAttemptID == attemptID {
			out = append(out, r)
		}
	}
	return out
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func SnapshotDigest(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		_, _ = h.Write([]byte(p))
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
