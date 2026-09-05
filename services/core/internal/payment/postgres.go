package payment

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore persists Payment Fabric aggregates on Atlas PostgreSQL and
// maps worker jobs onto Kernel `jobs` (ID-504).
type PostgresStore struct {
	Pool  *pgxpool.Pool
	Hooks InventoryHooks
}

func NewPostgresStore(pool *pgxpool.Pool, hooks InventoryHooks) *PostgresStore {
	return &PostgresStore{Pool: pool, Hooks: hooks}
}

func (s *PostgresStore) RunInTx(ctx context.Context, fn func(Tx) error) error {
	if existing := ExistingTx(ctx); existing != nil {
		return fn(&pgTx{ctx: ctx, tx: existing, hooks: s.Hooks})
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(&pgTx{ctx: ctx, tx: tx, hooks: s.Hooks}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type pgTx struct {
	ctx   context.Context
	tx    pgx.Tx
	hooks InventoryHooks
}

func (t *pgTx) Now() time.Time { return time.Now().UTC() }

func (t *pgTx) NextRecordSequence() int64 {
	var seq int64
	_ = t.tx.QueryRow(t.ctx, `SELECT nextval('payment_audit_events_record_sequence_seq')`).Scan(&seq)
	return seq
}

func scanAttempt(row pgx.Row) (PaymentAttempt, error) {
	var a PaymentAttempt
	var rzpOrder, rzpPay, effect, reason, opID, reqID *string
	var provIdem, provDigest *string
	var nextAt, waitSince *time.Time
	var reconCount int
	err := row.Scan(
		&a.PaymentAttemptID, &a.CheckoutProposalID, &a.MerchantOrderID, &a.ExecutionPassportID,
		&a.CapabilityID, &a.State, &a.Version, &a.Amount.AmountMinor, &a.Amount.Currency,
		&rzpOrder, &rzpPay, &a.DuplicateFrozen, &a.FulfillmentFrozen, &a.HoldReleaseFrozen,
		&effect, &reason, &a.HasCallbackBinding, &a.HasWebhookBinding,
		&a.IdempotencyKey, &a.HostID, &a.CreatedAt, &a.UpdatedAt, &opID, &reqID,
		&provIdem, &provDigest, &reconCount, &nextAt, &waitSince,
	)
	if err != nil {
		return PaymentAttempt{}, err
	}
	if rzpOrder != nil {
		a.RazorpayOrderID = *rzpOrder
	}
	if rzpPay != nil {
		a.RazorpayPaymentID = *rzpPay
	}
	if effect != nil {
		a.EffectDisposition = *effect
	}
	if reason != nil {
		a.ReasonCode = *reason
	}
	if opID != nil {
		a.OperationID = *opID
	}
	if reqID != nil {
		a.RequestID = *reqID
	}
	if provIdem != nil {
		a.ProviderIdempotencyKey = *provIdem
	}
	if provDigest != nil {
		a.ProviderRequestDigest = *provDigest
	}
	a.ReconcileAttemptCount = reconCount
	a.ReconcileNextAttemptAt = nextAt
	a.WaitingEventBindingSince = waitSince
	return a, nil
}

const attemptCols = `payment_attempt_id, checkout_proposal_id, merchant_order_id, execution_passport_id,
	capability_id, state, version, amount_minor, currency, razorpay_order_id, razorpay_payment_id,
	duplicate_attempt_frozen, fulfillment_frozen, hold_release_frozen, effect_disposition, reason_code,
	has_callback_binding, has_webhook_binding, idempotency_key, host_id, created_at, updated_at,
	COALESCE(operation_id,''), COALESCE(request_id,''),
	provider_idempotency_key, provider_request_digest, COALESCE(reconcile_attempt_count,0),
	reconcile_next_attempt_at, waiting_event_binding_since`

func (t *pgTx) GetAttemptByID(id string) (PaymentAttempt, bool) {
	a, err := scanAttempt(t.tx.QueryRow(t.ctx, `SELECT `+attemptCols+` FROM payment_attempts WHERE payment_attempt_id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return PaymentAttempt{}, false
	}
	if err != nil {
		return PaymentAttempt{}, false
	}
	return a, true
}

func (t *pgTx) GetAttemptByProposal(proposalID string) (PaymentAttempt, bool) {
	a, err := scanAttempt(t.tx.QueryRow(t.ctx, `SELECT `+attemptCols+` FROM payment_attempts WHERE checkout_proposal_id=$1`, proposalID))
	if err != nil {
		return PaymentAttempt{}, false
	}
	return a, true
}

func (t *pgTx) GetAttemptByRazorpayOrder(orderID string) (PaymentAttempt, bool) {
	a, err := scanAttempt(t.tx.QueryRow(t.ctx, `SELECT `+attemptCols+` FROM payment_attempts WHERE razorpay_order_id=$1`, orderID))
	if err != nil {
		return PaymentAttempt{}, false
	}
	return a, true
}

func (t *pgTx) GetAttemptByIdempotency(hostID, key string) (PaymentAttempt, bool) {
	a, err := scanAttempt(t.tx.QueryRow(t.ctx, `SELECT `+attemptCols+` FROM payment_attempts WHERE host_id=$1 AND idempotency_key=$2`, hostID, key))
	if err != nil {
		return PaymentAttempt{}, false
	}
	return a, true
}

func (t *pgTx) InsertAttempt(a PaymentAttempt) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO payment_attempts (
			payment_attempt_id, checkout_proposal_id, merchant_order_id, execution_passport_id,
			capability_id, state, version, amount_minor, currency, razorpay_order_id, razorpay_payment_id,
			duplicate_attempt_frozen, fulfillment_frozen, hold_release_frozen, effect_disposition, reason_code,
			has_callback_binding, has_webhook_binding, idempotency_key, host_id, created_at, updated_at,
			operation_id, request_id, provider_idempotency_key, provider_request_digest, reconcile_attempt_count,
			reconcile_next_attempt_at, waiting_event_binding_since
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''),NULLIF($11,''),$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NULLIF($23,''),NULLIF($24,''),NULLIF($25,''),NULLIF($26,''),$27,$28,$29)`,
		a.PaymentAttemptID, a.CheckoutProposalID, a.MerchantOrderID, a.ExecutionPassportID,
		a.CapabilityID, string(a.State), a.Version, a.Amount.AmountMinor, a.Amount.Currency,
		a.RazorpayOrderID, a.RazorpayPaymentID, a.DuplicateFrozen, a.FulfillmentFrozen, a.HoldReleaseFrozen,
		nullIfEmpty(a.EffectDisposition), nullIfEmpty(a.ReasonCode), a.HasCallbackBinding, a.HasWebhookBinding,
		a.IdempotencyKey, a.HostID, a.CreatedAt, a.UpdatedAt, a.OperationID, a.RequestID,
		a.ProviderIdempotencyKey, a.ProviderRequestDigest, a.ReconcileAttemptCount, a.ReconcileNextAttemptAt, a.WaitingEventBindingSince,
	)
	if err != nil {
		return err
	}
	if a.ExecutionPassportID == "" {
		return nil
	}
	tag, cerr := t.tx.Exec(t.ctx, `
		UPDATE execution_passports
		SET consumed_at=now(), status='consumed'
		WHERE passport_id=$1 AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND COALESCE(status,'issued') IN ('issued','')`,
		a.ExecutionPassportID)
	if cerr != nil {
		return cerr
	}
	if tag.RowsAffected() == 0 {
		return Err("AUTHORITY_INVALID", "execution passport is not consumable")
	}
	return nil
}

func (t *pgTx) UpdateAttempt(a PaymentAttempt) error {
	prev, ok := t.GetAttemptByID(a.PaymentAttemptID)
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
	_, err := t.tx.Exec(t.ctx, `
		UPDATE payment_attempts SET
			state=$2, version=$3, razorpay_order_id=NULLIF($4,''), razorpay_payment_id=NULLIF($5,''),
			duplicate_attempt_frozen=$6, fulfillment_frozen=$7, hold_release_frozen=$8,
			effect_disposition=$9, reason_code=$10, has_callback_binding=$11, has_webhook_binding=$12, updated_at=$13,
			provider_idempotency_key=NULLIF($14,''), provider_request_digest=NULLIF($15,''),
			reconcile_attempt_count=$16, reconcile_next_attempt_at=$17, waiting_event_binding_since=$18
		WHERE payment_attempt_id=$1`,
		a.PaymentAttemptID, string(a.State), a.Version, a.RazorpayOrderID, a.RazorpayPaymentID,
		a.DuplicateFrozen, a.FulfillmentFrozen, a.HoldReleaseFrozen,
		nullIfEmpty(a.EffectDisposition), nullIfEmpty(a.ReasonCode), a.HasCallbackBinding, a.HasWebhookBinding, a.UpdatedAt,
		a.ProviderIdempotencyKey, a.ProviderRequestDigest, a.ReconcileAttemptCount, a.ReconcileNextAttemptAt, a.WaitingEventBindingSince,
	)
	return err
}

func (t *pgTx) GetOrderByID(id string) (MerchantOrder, bool) {
	var o MerchantOrder
	var capAttempt, capPay string
	err := t.tx.QueryRow(t.ctx, `
		SELECT order_id, COALESCE(checkout_proposal_id,''), location_id, session_id,
		       COALESCE(captured_payment_attempt_id, COALESCE(payment_attempt_id,'')),
		       COALESCE(captured_razorpay_payment_id, COALESCE(captured_payment_id,'')),
		       status, total_amount_minor, currency, quote_hash, created_at, COALESCE(updated_at, created_at)
		FROM orders WHERE order_id=$1`, id).Scan(
		&o.OrderID, &o.CheckoutProposalID, &o.LocationID, &o.SessionID,
		&capAttempt, &capPay, &o.State, &o.Amount.AmountMinor, &o.Amount.Currency, &o.QuoteHash, &o.CreatedAt, &o.UpdatedAt)
	if err != nil {
		return MerchantOrder{}, false
	}
	o.CapturedPaymentAttemptID = capAttempt
	o.CapturedRazorpayPaymentID = capPay
	rows, err := t.tx.Query(t.ctx, `SELECT sku_id, quantity, COALESCE(amount_minor, line_total_minor), COALESCE(currency,'INR') FROM order_lines WHERE order_id=$1`, id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var l OrderLine
			if err := rows.Scan(&l.SKUId, &l.Quantity, &l.AmountMinor, &l.Currency); err == nil {
				o.Lines = append(o.Lines, l)
			}
		}
	}
	return o, true
}

func (t *pgTx) GetOrderByProposal(proposalID string) (MerchantOrder, bool) {
	var id string
	if err := t.tx.QueryRow(t.ctx, `SELECT order_id FROM orders WHERE checkout_proposal_id=$1`, proposalID).Scan(&id); err != nil {
		return MerchantOrder{}, false
	}
	return t.GetOrderByID(id)
}

func (t *pgTx) InsertOrder(o MerchantOrder) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO orders (order_id, checkout_proposal_id, session_id, location_id, status, currency, total_amount_minor, quote_hash, payment_attempt_id, payment_public_status, snapshot, captured_payment_attempt_id, captured_razorpay_payment_id, captured_payment_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,NULLIF($12,''),NULLIF($12,''))`,
		o.OrderID, nullIfEmpty(o.CheckoutProposalID), o.SessionID, o.LocationID, string(o.State),
		o.Amount.Currency, o.Amount.AmountMinor, o.QuoteHash, nullIfEmpty(o.CapturedPaymentAttemptID),
		publicStatusForOrder(o), nullIfEmpty(o.CapturedPaymentAttemptID), o.CapturedRazorpayPaymentID,
	)
	if err != nil {
		return err
	}
	for i, l := range o.Lines {
		if _, err := t.tx.Exec(t.ctx, `
			INSERT INTO order_lines (order_line_id, order_id, sku_id, product_id, quantity, unit_amount_minor, line_total_minor, line_index, amount_minor, currency)
			VALUES ($1,$2,$3,'', $4, $5, $5, $6, $5, $7)`,
			"orl_join_"+o.OrderID+"_"+itoa(int64(i)), o.OrderID, l.SKUId, l.Quantity, l.AmountMinor, i, l.Currency,
		); err != nil {
			return err
		}
	}
	if o.SessionID != "" {
		_, _ = t.tx.Exec(t.ctx, `
			UPDATE commercial_attributions SET
				order_id=$2, checkout_proposal_id=NULLIF($3,''), attribution_state='ORDER_CONFIRMED', updated_at=now()
			WHERE session_id=$1 AND attribution_state='APPLIED'`,
			o.SessionID, o.OrderID, o.CheckoutProposalID)
		_, _ = t.tx.Exec(t.ctx, `UPDATE offers SET status='ORDER_CONFIRMED', updated_at=now()
			WHERE session_id=$1 AND status IN ('APPLIED','RETAINED')`, o.SessionID)
	}
	return nil
}

func (t *pgTx) UpdateOrder(o MerchantOrder) error {
	pub := publicStatusForOrder(o)
	_, err := t.tx.Exec(t.ctx, `
		UPDATE orders SET
			status=$2,
			captured_payment_attempt_id=NULLIF($3,''),
			captured_razorpay_payment_id=NULLIF($4,''),
			captured_payment_id=NULLIF($4,''),
			payment_public_status=$5,
			confirmed_at=CASE WHEN $2='CONFIRMED' THEN now() ELSE confirmed_at END,
			updated_at=now()
		WHERE order_id=$1`,
		o.OrderID, string(o.State), o.CapturedPaymentAttemptID, o.CapturedRazorpayPaymentID, pub,
	)
	if err != nil {
		return err
	}
	if o.State == OrderConfirmed && o.SessionID != "" {
		_, _ = t.tx.Exec(t.ctx, `UPDATE shopping_sessions SET status='ORDER_CONFIRMED', updated_at=now() WHERE session_id=$1`, o.SessionID)
		_, _ = t.tx.Exec(t.ctx, `
			UPDATE commercial_attributions SET
				order_id=$2,
				paid_quantity = applied_quantity,
				captured_revenue_minor = quote_delta_minor,
				net_realized_revenue_minor = quote_delta_minor,
				attributed_revenue_minor = quote_delta_minor,
				attributed_margin_minor = COALESCE(attributed_margin_minor, 0),
				outcome_completeness = 'PAID_COMPLETE',
				attribution_state = 'PAYMENT_RECONCILED',
				updated_at=now()
			WHERE session_id=$1 AND attribution_state IN ('APPLIED','ORDER_CONFIRMED')`,
			o.SessionID, o.OrderID)
		_, _ = t.tx.Exec(t.ctx, `
			UPDATE commercial_attributions SET attribution_state = 'REVENUE_ATTRIBUTED', updated_at=now()
			WHERE session_id=$1 AND order_id=$2 AND attribution_state='PAYMENT_RECONCILED'`,
			o.SessionID, o.OrderID)
		_, _ = t.tx.Exec(t.ctx, `UPDATE offers SET status='ATTRIBUTED', updated_at=now()
			WHERE session_id=$1 AND status IN ('APPLIED','RETAINED','ORDER_CONFIRMED')`, o.SessionID)
		_, _ = t.tx.Exec(t.ctx, `
			INSERT INTO offer_events (offer_event_id, offer_id, event_type, payload)
			SELECT 'oev_' || replace(gen_random_uuid()::text, '-', ''), offer_id, 'OFFER_REVENUE_ATTRIBUTED', jsonb_build_object('order_id', $2::text)
			FROM commercial_attributions WHERE session_id=$1 AND order_id=$2`, o.SessionID, o.OrderID)
	}
	return nil
}

func publicStatusForOrder(o MerchantOrder) string {
	switch o.State {
	case OrderConfirmed:
		return string(PublicConfirmed)
	case OrderPaymentFailed:
		return string(PublicPaymentFailedVerified)
	default:
		return string(PublicPaymentProcessing)
	}
}

func (t *pgTx) InsertProviderEvent(e ProviderEvent) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO provider_events (row_id, provider_event_id, event_type, body_digest, signature_valid, razorpay_order_id, razorpay_payment_id, amount_minor, currency, provider_status, payment_attempt_id, received_at, source_occurred_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		e.RowID, e.ProviderEventID, e.EventType, e.BodyDigest, e.SignatureValid, nullIfEmpty(e.RazorpayOrderID),
		nullIfEmpty(e.RazorpayPaymentID), e.AmountMinor, nullIfEmpty(e.Currency), nullIfEmpty(e.ProviderStatus),
		nullIfEmpty(e.PaymentAttemptID), e.ReceivedAt, e.SourceOccurredAt,
	)
	if err != nil {
		if isUnique(err) {
			return ErrDuplicateEvent
		}
	}
	return err
}

func (t *pgTx) GetProviderEvent(id string) (ProviderEvent, bool) {
	var e ProviderEvent
	err := t.tx.QueryRow(t.ctx, `
		SELECT row_id, provider_event_id, event_type, body_digest, signature_valid, COALESCE(razorpay_order_id,''), COALESCE(razorpay_payment_id,''), COALESCE(amount_minor,0), COALESCE(currency,''), COALESCE(provider_status,''), COALESCE(payment_attempt_id,''), received_at, COALESCE(source_occurred_at, received_at)
		FROM provider_events WHERE provider_event_id=$1`, id).Scan(
		&e.RowID, &e.ProviderEventID, &e.EventType, &e.BodyDigest, &e.SignatureValid, &e.RazorpayOrderID,
		&e.RazorpayPaymentID, &e.AmountMinor, &e.Currency, &e.ProviderStatus, &e.PaymentAttemptID, &e.ReceivedAt, &e.SourceOccurredAt)
	if err != nil {
		return ProviderEvent{}, false
	}
	return e, true
}

func (t *pgTx) ListProviderEvents(attemptID string) []ProviderEvent {
	rows, err := t.tx.Query(t.ctx, `SELECT provider_event_id FROM provider_events WHERE payment_attempt_id=$1 ORDER BY received_at`, attemptID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []ProviderEvent
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			if e, ok := t.GetProviderEvent(id); ok {
				out = append(out, e)
			}
		}
	}
	return out
}

func (t *pgTx) InsertReconciliation(r Reconciliation) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO provider_reconciliations (reconciliation_id, payment_attempt_id, fetched_at, provider_order_id, provider_status, snapshot_digest, decision, mismatch_reason)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		r.ReconciliationID, r.PaymentAttemptID, r.FetchedAt, nullIfEmpty(r.ProviderOrderID), nullIfEmpty(r.ProviderStatus),
		r.SnapshotDigest, r.Decision, nullIfEmpty(r.MismatchReason),
	)
	return err
}

func (t *pgTx) ListReconciliations(attemptID string) []Reconciliation {
	rows, err := t.tx.Query(t.ctx, `
		SELECT reconciliation_id, payment_attempt_id, fetched_at, COALESCE(provider_order_id,''), COALESCE(provider_status,''), snapshot_digest, decision, COALESCE(mismatch_reason,'')
		FROM provider_reconciliations WHERE payment_attempt_id=$1 ORDER BY fetched_at`, attemptID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Reconciliation
	for rows.Next() {
		var r Reconciliation
		if err := rows.Scan(&r.ReconciliationID, &r.PaymentAttemptID, &r.FetchedAt, &r.ProviderOrderID, &r.ProviderStatus, &r.SnapshotDigest, &r.Decision, &r.MismatchReason); err == nil {
			out = append(out, r)
		}
	}
	return out
}

func (t *pgTx) InsertRunnerJob(j RunnerJob) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO test_runner_jobs (job_id, payment_attempt_id, executor_token_hash, executor_token, status, razorpay_order_id, razorpay_key_id, amount_minor, currency, callback_origin, scenario, checkout_page_url, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		j.JobID, j.PaymentAttemptID, j.ExecutorTokenHash, nullIfEmpty(j.ExecutorToken), j.Status,
		j.RazorpayOrderID, j.RazorpayKeyID, j.AmountMinor, j.Currency, nullIfEmpty(j.CallbackOrigin),
		nullIfEmpty(j.Scenario), nullIfEmpty(j.CheckoutPageURL), j.CreatedAt,
	)
	return err
}

func (t *pgTx) GetRunnerJob(id string) (RunnerJob, bool) {
	j, err := t.scanRunner(t.tx.QueryRow(t.ctx, runnerSelect+` WHERE job_id=$1`, id))
	if err != nil {
		return RunnerJob{}, false
	}
	return j, true
}

const runnerSelect = `SELECT job_id, payment_attempt_id, executor_token_hash, COALESCE(executor_token,''), status, razorpay_order_id, razorpay_key_id, amount_minor, currency, COALESCE(callback_origin,''), COALESCE(scenario,''), COALESCE(checkout_page_url,''), claimed_at, COALESCE(observation_summary,''), created_at FROM test_runner_jobs`

func (t *pgTx) scanRunner(row pgx.Row) (RunnerJob, error) {
	var j RunnerJob
	var claimed *time.Time
	err := row.Scan(&j.JobID, &j.PaymentAttemptID, &j.ExecutorTokenHash, &j.ExecutorToken, &j.Status,
		&j.RazorpayOrderID, &j.RazorpayKeyID, &j.AmountMinor, &j.Currency, &j.CallbackOrigin, &j.Scenario,
		&j.CheckoutPageURL, &claimed, &j.ObservationSummary, &j.CreatedAt)
	if claimed != nil {
		j.ClaimedAt = claimed
	}
	return j, err
}

func (t *pgTx) ClaimIssuedRunnerJob(tokenHash string) (RunnerJob, bool) {
	var id string
	err := t.tx.QueryRow(t.ctx, `
		SELECT job_id FROM test_runner_jobs WHERE status='ISSUED'
		AND ($1='' OR executor_token_hash=$1)
		ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, tokenHash).Scan(&id)
	if err != nil {
		return RunnerJob{}, false
	}
	now := t.Now()
	_, err = t.tx.Exec(t.ctx, `UPDATE test_runner_jobs SET status='CLAIMED', claimed_at=$2 WHERE job_id=$1`, id, now)
	if err != nil {
		return RunnerJob{}, false
	}
	j, ok := t.GetRunnerJob(id)
	if !ok {
		return RunnerJob{}, false
	}
	_, _ = t.tx.Exec(t.ctx, `UPDATE test_runner_jobs SET executor_token=NULL WHERE job_id=$1`, id)
	return j, true
}

func (t *pgTx) UpdateRunnerJob(j RunnerJob) error {
	_, err := t.tx.Exec(t.ctx, `UPDATE test_runner_jobs SET status=$2, observation_summary=$3, observation_confidence=$4, claimed_by_identity=COALESCE(NULLIF($5,''), claimed_by_identity) WHERE job_id=$1`,
		j.JobID, j.Status, j.ObservationSummary, nullIfEmpty(j.ObservationConfidence), j.ClaimedByIdentity)
	return err
}

func (t *pgTx) EnqueueJob(j WorkerJob) error {
	payload := j.PayloadJSON
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO jobs (job_id, job_type, payload, operation_id, dedupe_key, status, available_at)
		VALUES ($1,$2,$3::jsonb,NULLIF($4,''),NULLIF($5,''),'PENDING',$6)
		ON CONFLICT (dedupe_key) DO NOTHING`,
		j.JobID, j.Type, payload, j.OperationID, j.DedupKey, j.AvailableAt,
	)
	return err
}

func (t *pgTx) ClaimJobs(jobType string, limit int) []WorkerJob {
	rows, err := t.tx.Query(t.ctx, `
		UPDATE jobs SET status='CLAIMED', lease_owner='payment-fabric', lease_expires_at=now()+interval '30 seconds', attempt_count=attempt_count+1
		WHERE job_id IN (
			SELECT job_id FROM jobs
			WHERE status='PENDING' AND available_at <= now() AND job_type=$1
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		)
		RETURNING job_id, job_type, payload, COALESCE(dedupe_key,''), attempt_count, available_at`, jobType, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []WorkerJob
	for rows.Next() {
		var j WorkerJob
		if err := rows.Scan(&j.JobID, &j.Type, &j.PayloadJSON, &j.DedupKey, &j.AttemptCount, &j.AvailableAt); err == nil {
			out = append(out, j)
		}
	}
	return out
}

func (t *pgTx) CompleteJob(id string) error {
	_, err := t.tx.Exec(t.ctx, `UPDATE jobs SET status='COMPLETED' WHERE job_id=$1`, id)
	return err
}

func (t *pgTx) ListJobs() []WorkerJob {
	rows, err := t.tx.Query(t.ctx, `SELECT job_id, job_type, payload, COALESCE(dedupe_key,''), attempt_count, available_at, status FROM jobs`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []WorkerJob
	for rows.Next() {
		var j WorkerJob
		var status string
		if err := rows.Scan(&j.JobID, &j.Type, &j.PayloadJSON, &j.DedupKey, &j.AttemptCount, &j.AvailableAt, &status); err == nil {
			j.Done = status == "COMPLETED"
			out = append(out, j)
		}
	}
	return out
}

func (t *pgTx) InsertAudit(e AuditEvent) error {
	if e.OperationID == "" && e.PaymentAttemptID != "" {
		if a, ok := t.GetAttemptByID(e.PaymentAttemptID); ok {
			e.OperationID = a.OperationID
			if e.RequestID == "" {
				e.RequestID = a.RequestID
			}
		}
	}
	body, _ := json.Marshal(e.SafeBody)
	auth := true
	if e.Authoritative != nil {
		auth = *e.Authoritative
	}
	if e.Kind == "RUNNER_OBSERVATION" {
		auth = false
	}
	corr := map[string]string{"request_id": e.RequestID, "operation_id": e.OperationID, "payment_attempt_id": e.PaymentAttemptID, "merchant_order_id": e.OrderID}
	corrJSON, _ := json.Marshal(corr)
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO payment_audit_events (audit_event_id, kind, payment_attempt_id, order_id, refund_id, safe_body, occurred_at, operation_id, request_id, correlation, authoritative)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NULLIF($8,''),NULLIF($9,''),$10::jsonb,$11)`,
		e.AuditEventID, e.Kind, nullIfEmpty(e.PaymentAttemptID), nullIfEmpty(e.OrderID), nullIfEmpty(e.RefundID), body, e.OccurredAt, e.OperationID, e.RequestID, corrJSON, auth,
	)
	return err
}

func (t *pgTx) ListAudit(attemptID string) []AuditEvent {
	rows, err := t.tx.Query(t.ctx, `SELECT audit_event_id, kind, COALESCE(payment_attempt_id,''), COALESCE(order_id,''), COALESCE(refund_id,''), safe_body, occurred_at, record_sequence, COALESCE(operation_id,''), COALESCE(request_id,'') FROM payment_audit_events WHERE payment_attempt_id=$1 ORDER BY record_sequence`, attemptID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var e AuditEvent
		var body []byte
		if err := rows.Scan(&e.AuditEventID, &e.Kind, &e.PaymentAttemptID, &e.OrderID, &e.RefundID, &body, &e.OccurredAt, &e.RecordSequence, &e.OperationID, &e.RequestID); err == nil {
			_ = json.Unmarshal(body, &e.SafeBody)
			out = append(out, e)
		}
	}
	return out
}

func (t *pgTx) ConvertHold(proposalID string) error {
	if t.hooks.ConvertHold != nil {
		if err := t.hooks.ConvertHold(t.ctx, proposalID); err != nil {
			return err
		}
	}
	rows, err := t.tx.Query(t.ctx, `SELECT sku_id, location_id, quantity FROM reservations WHERE checkout_proposal_id=$1 AND status='ACTIVE' FOR UPDATE`, proposalID)
	if err != nil {
		return err
	}
	type r struct {
		sku, loc string
		qty      int
	}
	var list []r
	for rows.Next() {
		var x r
		if err := rows.Scan(&x.sku, &x.loc, &x.qty); err != nil {
			rows.Close()
			return err
		}
		list = append(list, x)
	}
	rows.Close()
	for _, x := range list {
		if _, err := t.tx.Exec(t.ctx, `UPDATE inventory SET reserved_quantity = GREATEST(reserved_quantity - $3, 0), on_hand_quantity = GREATEST(on_hand_quantity - $3, 0), updated_at=now() WHERE location_id=$1 AND sku_id=$2`, x.loc, x.sku, x.qty); err != nil {
			return err
		}
	}
	if _, err := t.tx.Exec(t.ctx, `UPDATE reservations SET status='CONVERTED' WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID); err != nil {
		return err
	}
	_, err = t.tx.Exec(t.ctx, `INSERT INTO payment_hold_flags (checkout_proposal_id, converted, frozen) VALUES ($1, TRUE, FALSE) ON CONFLICT (checkout_proposal_id) DO UPDATE SET converted=TRUE, updated_at=now()`, proposalID)
	return err
}

func (t *pgTx) FreezeHold(proposalID string) error {
	if t.hooks.FreezeHold != nil {
		if err := t.hooks.FreezeHold(t.ctx, proposalID); err != nil {
			return err
		}
	}
	_, err := t.tx.Exec(t.ctx, `INSERT INTO payment_hold_flags (checkout_proposal_id, converted, frozen) VALUES ($1, FALSE, TRUE) ON CONFLICT (checkout_proposal_id) DO UPDATE SET frozen=TRUE, updated_at=now()`, proposalID)
	return err
}

func (t *pgTx) ReleaseHold(proposalID string) error {
	if t.hooks.ReleaseHold != nil {
		if err := t.hooks.ReleaseHold(t.ctx, proposalID); err != nil {
			return err
		}
	}
	rows, err := t.tx.Query(t.ctx, `SELECT sku_id, location_id, quantity FROM reservations WHERE checkout_proposal_id=$1 AND status='ACTIVE' FOR UPDATE`, proposalID)
	if err != nil {
		return err
	}
	type r struct {
		sku, loc string
		qty      int
	}
	var list []r
	for rows.Next() {
		var x r
		if err := rows.Scan(&x.sku, &x.loc, &x.qty); err != nil {
			rows.Close()
			return err
		}
		list = append(list, x)
	}
	rows.Close()
	for _, x := range list {
		if _, err := t.tx.Exec(t.ctx, `UPDATE inventory SET reserved_quantity = GREATEST(reserved_quantity - $3, 0), updated_at=now() WHERE location_id=$1 AND sku_id=$2`, x.loc, x.sku, x.qty); err != nil {
			return err
		}
	}
	if _, err := t.tx.Exec(t.ctx, `UPDATE reservations SET status='RELEASED' WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID); err != nil {
		return err
	}
	_, err = t.tx.Exec(t.ctx, `INSERT INTO payment_hold_flags (checkout_proposal_id, converted, frozen) VALUES ($1, FALSE, FALSE) ON CONFLICT (checkout_proposal_id) DO UPDATE SET frozen=FALSE, updated_at=now()`, proposalID)
	return err
}

func (t *pgTx) SetOrderPaymentPublicStatus(orderID, status string) error {
	_, err := t.tx.Exec(t.ctx, `UPDATE orders SET payment_public_status=$2, updated_at=now() WHERE order_id=$1`, orderID, status)
	return err
}

func (t *pgTx) ReleaseSessionToActive(sessionID string) error {
	if sessionID == "" {
		return nil
	}
	_, err := t.tx.Exec(t.ctx, `UPDATE shopping_sessions SET status='ACTIVE', updated_at=now() WHERE session_id=$1 AND status='PAYMENT_PENDING'`, sessionID)
	return err
}

func (t *pgTx) HoldConverted(proposalID string) bool {
	var v bool
	_ = t.tx.QueryRow(t.ctx, `SELECT converted FROM payment_hold_flags WHERE checkout_proposal_id=$1`, proposalID).Scan(&v)
	return v
}

func (t *pgTx) HoldFrozen(proposalID string) bool {
	var v bool
	_ = t.tx.QueryRow(t.ctx, `SELECT frozen FROM payment_hold_flags WHERE checkout_proposal_id=$1`, proposalID).Scan(&v)
	return v
}

func (t *pgTx) LockPaymentForRefund(attemptID string) (PaymentAttempt, error) {
	a, err := scanAttempt(t.tx.QueryRow(t.ctx, `SELECT `+attemptCols+` FROM payment_attempts WHERE payment_attempt_id=$1 FOR UPDATE`, attemptID))
	if err != nil {
		return PaymentAttempt{}, Err("NOT_FOUND", "payment attempt not found")
	}
	return a, nil
}

func (t *pgTx) InsertRefund(r Refund) error {
	_, err := t.tx.Exec(t.ctx, `
		INSERT INTO refunds (refund_id, payment_attempt_id, order_id, amount_minor, currency, state, idempotency_key, razorpay_refund_id, reason_code, effect_disposition, duplicate_frozen, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		r.RefundID, r.PaymentAttemptID, r.OrderID, r.AmountMinor, r.Currency, string(r.State), r.IdempotencyKey,
		nullIfEmpty(r.RazorpayRefundID), nullIfEmpty(r.ReasonCode), nullIfEmpty(r.EffectDisposition), r.DuplicateFrozen, r.CreatedAt, r.UpdatedAt,
	)
	return err
}

func (t *pgTx) UpdateRefund(r Refund) error {
	_, err := t.tx.Exec(t.ctx, `UPDATE refunds SET state=$2, razorpay_refund_id=$3, reason_code=$4, effect_disposition=$5, duplicate_frozen=$6, updated_at=now() WHERE refund_id=$1`,
		r.RefundID, string(r.State), nullIfEmpty(r.RazorpayRefundID), nullIfEmpty(r.ReasonCode), nullIfEmpty(r.EffectDisposition), r.DuplicateFrozen)
	return err
}

func (t *pgTx) GetRefund(id string) (Refund, bool) {
	r, err := t.scanRefund(t.tx.QueryRow(t.ctx, refundSelect+` WHERE refund_id=$1`, id))
	if err != nil {
		return Refund{}, false
	}
	return r, true
}

const refundSelect = `SELECT refund_id, payment_attempt_id, order_id, amount_minor, currency, state, idempotency_key, COALESCE(razorpay_refund_id,''), COALESCE(reason_code,''), COALESCE(effect_disposition,''), duplicate_frozen, created_at, updated_at FROM refunds`

func (t *pgTx) scanRefund(row pgx.Row) (Refund, error) {
	var r Refund
	err := row.Scan(&r.RefundID, &r.PaymentAttemptID, &r.OrderID, &r.AmountMinor, &r.Currency, &r.State, &r.IdempotencyKey, &r.RazorpayRefundID, &r.ReasonCode, &r.EffectDisposition, &r.DuplicateFrozen, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func (t *pgTx) GetRefundByIdempotency(key string) (Refund, bool) {
	r, err := t.scanRefund(t.tx.QueryRow(t.ctx, refundSelect+` WHERE idempotency_key=$1`, key))
	if err != nil {
		return Refund{}, false
	}
	return r, true
}

func (t *pgTx) ListRefunds(attemptID string) []Refund {
	rows, err := t.tx.Query(t.ctx, refundSelect+` WHERE payment_attempt_id=$1`, attemptID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Refund
	for rows.Next() {
		r, err := t.scanRefund(rows)
		if err == nil {
			out = append(out, r)
		}
	}
	return out
}

func (t *pgTx) InsertRefundReservation(rr RefundReservation) error {
	_, err := t.tx.Exec(t.ctx, `INSERT INTO refund_reservations (reservation_id, refund_id, payment_attempt_id, amount_minor, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		rr.ReservationID, rr.RefundID, rr.PaymentAttemptID, rr.AmountMinor, string(rr.Status), rr.CreatedAt)
	return err
}

func (t *pgTx) UpdateRefundReservation(rr RefundReservation) error {
	_, err := t.tx.Exec(t.ctx, `UPDATE refund_reservations SET status=$2 WHERE reservation_id=$1`, rr.ReservationID, string(rr.Status))
	return err
}

func (t *pgTx) ListReservations(attemptID string) []RefundReservation {
	rows, err := t.tx.Query(t.ctx, `SELECT reservation_id, refund_id, payment_attempt_id, amount_minor, status, created_at FROM refund_reservations WHERE payment_attempt_id=$1`, attemptID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []RefundReservation
	for rows.Next() {
		var rr RefundReservation
		if err := rows.Scan(&rr.ReservationID, &rr.RefundID, &rr.PaymentAttemptID, &rr.AmountMinor, &rr.Status, &rr.CreatedAt); err == nil {
			out = append(out, rr)
		}
	}
	return out
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func isUnique(err error) bool {
	return err != nil && (contains(err.Error(), "unique") || contains(err.Error(), "duplicate"))
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})())
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
