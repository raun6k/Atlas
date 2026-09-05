package app

import (
	"context"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/jobs"
)

type JobView struct {
	JobID            string
	JobType          string
	Status           string
	OperationID      string
	AttemptCount     int32
	LastErrorClass   string
	NextRetryAt      string
	LeaseOwner       string
	LeaseExpiresAt   string
	Retryable        bool
	DeadLetterReason string
	OperatorAction   string
	LastError        string
}

type ReconcileResult struct {
	Scheduled bool
	Status    string
	JobID     string
	Code      string
}

func (k *Kernel) ListJobs(ctx context.Context, m Meta) (Envelope, []JobView, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `
		SELECT job_id, job_type, status, COALESCE(operation_id,''), attempt_count,
		       COALESCE(last_error_class,''), COALESCE(available_at::text,''), COALESCE(lease_owner,''),
		       COALESCE(lease_expires_at::text,''), COALESCE(retryable, TRUE), COALESCE(dead_letter_reason,''),
		       COALESCE(operator_action,''), COALESCE(last_error,'')
		FROM jobs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []JobView
	for rows.Next() {
		var j JobView
		if err := rows.Scan(&j.JobID, &j.JobType, &j.Status, &j.OperationID, &j.AttemptCount,
			&j.LastErrorClass, &j.NextRetryAt, &j.LeaseOwner, &j.LeaseExpiresAt, &j.Retryable,
			&j.DeadLetterReason, &j.OperatorAction, &j.LastError); err != nil {
			return Envelope{}, nil, err
		}
		j.Status = jobs.PublicStatus(j.Status)
		out = append(out, j)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ReconcileOperation(ctx context.Context, m Meta, operationID string) (Envelope, ReconcileResult, error) {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return Envelope{}, ReconcileResult{}, err
	}
	env := k.withMeta(k.env(), m, operationID)
	if operationID == "" {
		return env, ReconcileResult{Scheduled: false, Status: jobs.StatusNotRetryable}, nil
	}
	var attemptID, state string
	err := k.Pool().QueryRow(ctx, `SELECT payment_attempt_id, state FROM payment_attempts WHERE operation_id=$1 ORDER BY updated_at DESC LIMIT 1`, operationID).Scan(&attemptID, &state)
	if err != nil || attemptID == "" {
		return env, ReconcileResult{}, apperr.New(apperr.NotReconcilable, "operation is not a reconcilable payment")
	}
	switch state {
	case "CAPTURED_RECONCILED":
		return env, ReconcileResult{Scheduled: false, Status: jobs.StatusCompleted}, nil
	case "FAILED_VERIFIED", "CANCELLED_VERIFIED":
		return env, ReconcileResult{Scheduled: false, Status: jobs.StatusNotRetryable}, nil
	}
	jobID := ids.New(ids.Job)
	dedupe := "reconcile-op:" + operationID
	tag, err := k.Pool().Exec(ctx, `
		INSERT INTO jobs (job_id, job_type, payload, operation_id, dedupe_key, status, available_at, operator_action)
		VALUES ($1,'RECONCILE_PAYMENT',$2::jsonb,$3,$4,'PENDING',now(),'Worker will claim RECONCILE_PAYMENT')
		ON CONFLICT (dedupe_key) DO NOTHING`,
		jobID, mustJSON(map[string]string{"payment_attempt_id": attemptID, "operation_id": operationID}), operationID, dedupe)
	if err != nil {
		return env, ReconcileResult{}, err
	}
	if tag.RowsAffected() == 0 {
		var existing, st string
		_ = k.Pool().QueryRow(ctx, `SELECT job_id, status FROM jobs WHERE dedupe_key=$1`, dedupe).Scan(&existing, &st)
		return env, ReconcileResult{Scheduled: false, Status: jobs.PublicStatus(st), JobID: existing}, nil
	}
	return env, ReconcileResult{Scheduled: true, Status: jobs.StatusQueued, JobID: jobID}, nil
}
