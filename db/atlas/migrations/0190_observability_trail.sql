-- Correlation columns so one operation timeline can stitch existing stores.
-- No new event log: audit_events remains the merchant trail; payment/offer/policy/jobs join by operation_id.

ALTER TABLE payment_attempts
    ADD COLUMN IF NOT EXISTS operation_id TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS payment_attempts_operation_idx
    ON payment_attempts (operation_id)
    WHERE operation_id IS NOT NULL AND operation_id <> '';

ALTER TABLE payment_audit_events
    ADD COLUMN IF NOT EXISTS operation_id TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS payment_audit_events_operation_idx
    ON payment_audit_events (operation_id)
    WHERE operation_id IS NOT NULL AND operation_id <> '';

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS jobs_operation_idx
    ON jobs (operation_id)
    WHERE operation_id IS NOT NULL AND operation_id <> '';

ALTER TABLE policy_decisions
    ADD COLUMN IF NOT EXISTS operation_id TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT,
    ADD COLUMN IF NOT EXISTS host_id TEXT,
    ADD COLUMN IF NOT EXISTS action TEXT,
    ADD COLUMN IF NOT EXISTS summary_sentence TEXT;

CREATE INDEX IF NOT EXISTS policy_decisions_operation_idx
    ON policy_decisions (operation_id)
    WHERE operation_id IS NOT NULL AND operation_id <> '';

ALTER TABLE offer_events
    ADD COLUMN IF NOT EXISTS operation_id TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS offer_events_operation_idx
    ON offer_events (operation_id)
    WHERE operation_id IS NOT NULL AND operation_id <> '';
