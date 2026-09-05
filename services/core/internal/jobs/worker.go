package jobs

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/store"

	"github.com/jackc/pgx/v5"
)

func ExpireHolds(ctx context.Context, db *store.DB, now time.Time) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT checkout_proposal_id, session_id FROM checkout_proposals WHERE status='ACTIVE' AND hold_expires_at <= $1 AND checkout_proposal_id NOT IN (SELECT checkout_proposal_id FROM payment_hold_flags WHERE frozen) FOR UPDATE SKIP LOCKED`, now)
	if err != nil {
		return err
	}
	var list [][2]string
	for rows.Next() {
		var p, s string
		if err := rows.Scan(&p, &s); err != nil {
			rows.Close()
			return err
		}
		list = append(list, [2]string{p, s})
	}
	rows.Close()
	for _, item := range list {
		if err := release(ctx, tx, item[0]); err != nil {
			return err
		}
		_, _ = tx.Exec(ctx, `UPDATE shopping_sessions SET status='ACTIVE', updated_at=now() WHERE session_id=$1 AND status='CHECKOUT_HELD'`, item[1])
	}
	return tx.Commit(ctx)
}

func release(ctx context.Context, tx pgx.Tx, proposalID string) error {
	resRows, err := tx.Query(ctx, `SELECT sku_id, location_id, quantity FROM reservations WHERE checkout_proposal_id=$1 AND status='ACTIVE' FOR UPDATE`, proposalID)
	if err != nil {
		return err
	}
	type r struct {
		sku, loc string
		qty      int
	}
	var list []r
	for resRows.Next() {
		var x r
		if err := resRows.Scan(&x.sku, &x.loc, &x.qty); err != nil {
			resRows.Close()
			return err
		}
		list = append(list, x)
	}
	resRows.Close()
	for _, x := range list {
		if _, err := tx.Exec(ctx, `UPDATE inventory SET reserved_quantity = GREATEST(reserved_quantity - $3, 0), updated_at=now() WHERE location_id=$1 AND sku_id=$2`, x.loc, x.sku, x.qty); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE reservations SET status='RELEASED' WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE checkout_proposals SET status='EXPIRED' WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID)
	return err
}

func GenerateExport(ctx context.Context, db *store.DB, exportID, outDir string) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var format string
	var maxSeq int64
	if err := tx.QueryRow(ctx, `SELECT format, COALESCE(maximum_record_sequence,0) FROM audit_exports WHERE export_id=$1 FOR UPDATE`, exportID).Scan(&format, &maxSeq); err != nil {
		return err
	}
	_, _ = tx.Exec(ctx, `UPDATE audit_exports SET status='GENERATING' WHERE export_id=$1`, exportID)
	rows, err := tx.Query(ctx, `SELECT audit_event_id, record_sequence, event_kind, occurred_at::text, COALESCE(action,''), COALESCE(summary_sentence,'') FROM audit_events WHERE record_sequence <= $1 ORDER BY record_sequence LIMIT 10000`, maxSeq)
	if err != nil {
		return err
	}
	defer rows.Close()
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(outDir, exportID+".csv")
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := csv.NewWriter(f)
	_ = w.Write([]string{"audit_event_id", "record_sequence", "event_kind", "occurred_at", "action", "summary"})
	for rows.Next() {
		var id, kind, occurred, action, summary string
		var seq int64
		if err := rows.Scan(&id, &seq, &kind, &occurred, &action, &summary); err != nil {
			_ = f.Close()
			return err
		}
		if len(summary) > 0 && (summary[0] == '=' || summary[0] == '+' || summary[0] == '-' || summary[0] == '@') {
			summary = "'" + summary
		}
		_ = w.Write([]string{id, itoa(seq), kind, occurred, action, summary})
	}
	w.Flush()
	_ = f.Close()
	st, _ := os.Stat(path)
	var size int64
	if st != nil {
		size = st.Size()
	}
	_, err = tx.Exec(ctx, `UPDATE audit_exports SET status='READY', artifact_path=$2, byte_size=$3 WHERE export_id=$1`, exportID, path, size)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func PublishOutbox(ctx context.Context, db *store.DB) error {
	_, err := db.Pool.Exec(ctx, `UPDATE outbox_events SET published_at=now() WHERE published_at IS NULL`)
	return err
}

func Claim(ctx context.Context, db *store.DB, workerID string, types []string, lease time.Duration) (string, string, []byte, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return "", "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var jobID, jobType string
	var payload []byte
	err = tx.QueryRow(ctx, `
		SELECT job_id, job_type, payload FROM jobs
		WHERE status='PENDING' AND available_at <= now() AND job_type = ANY($1)
		ORDER BY created_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1`, types).Scan(&jobID, &jobType, &payload)
	if err != nil {
		_ = tx.Rollback(ctx)
		return "", "", nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET status='CLAIMED', lease_owner=$2, lease_expires_at=$3, attempt_count=attempt_count+1 WHERE job_id=$1`, jobID, workerID, time.Now().Add(lease)); err != nil {
		return "", "", nil, err
	}
	return jobID, jobType, payload, tx.Commit(ctx)
}

func Complete(ctx context.Context, db *store.DB, jobID string) error {
	_, err := db.Pool.Exec(ctx, `UPDATE jobs SET status='COMPLETED', last_error=NULL WHERE job_id=$1`, jobID)
	return err
}

func Fail(ctx context.Context, db *store.DB, jobID string, jobErr error) error {
	msg := "job failed"
	if jobErr != nil {
		msg = jobErr.Error()
		if len(msg) > 2000 {
			msg = msg[:2000]
		}
	}
	_, err := db.Pool.Exec(ctx, `UPDATE jobs SET status='FAILED', last_error=$2, lease_owner=NULL, lease_expires_at=NULL WHERE job_id=$1`, jobID, msg)
	return err
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func NewJobID() string { return ids.New(ids.Job) }
