-- Authenticated provider fetch snapshots. Terminal success is decided from these plus an event binding.

CREATE TABLE IF NOT EXISTS provider_reconciliations (
    reconciliation_id TEXT PRIMARY KEY,
    payment_attempt_id TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    provider_order_id TEXT,
    provider_status TEXT,
    snapshot_digest TEXT NOT NULL,
    decision TEXT NOT NULL,
    mismatch_reason TEXT
);

CREATE INDEX IF NOT EXISTS provider_reconciliations_attempt_idx
    ON provider_reconciliations (payment_attempt_id, fetched_at);
