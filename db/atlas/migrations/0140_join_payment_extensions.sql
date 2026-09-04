-- Join-owned Payment Fabric extensions onto Kernel tables (ID-502 / ID-504).

CREATE TABLE IF NOT EXISTS payment_hold_flags (
    checkout_proposal_id TEXT PRIMARY KEY REFERENCES checkout_proposals (checkout_proposal_id),
    converted BOOLEAN NOT NULL DEFAULT FALSE,
    frozen BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_audit_events (
    audit_event_id TEXT PRIMARY KEY,
    record_sequence BIGSERIAL UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    payment_attempt_id TEXT,
    order_id TEXT,
    refund_id TEXT,
    safe_body JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE test_runner_jobs ADD COLUMN IF NOT EXISTS executor_token TEXT;

ALTER TABLE payment_attempts
    ADD CONSTRAINT payment_attempts_order_fk
    FOREIGN KEY (merchant_order_id) REFERENCES orders (order_id) NOT VALID;
