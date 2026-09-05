-- Observability ops: truthful job states, retry metadata, correlation on the merchant trail.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'REQUESTED',
    'QUEUED',
    'PENDING',
    'CLAIMED',
    'RUNNING',
    'WAITING_PROVIDER',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'NOT_RETRYABLE'
));

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS last_error_class TEXT,
    ADD COLUMN IF NOT EXISTS retryable BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT,
    ADD COLUMN IF NOT EXISTS operator_action TEXT,
    ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5;

ALTER TABLE audit_events
    ADD COLUMN IF NOT EXISTS correlation JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payment_audit_events
    ADD COLUMN IF NOT EXISTS correlation JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS authoritative BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS audit_events_correlation_gin
    ON audit_events USING GIN (correlation);
