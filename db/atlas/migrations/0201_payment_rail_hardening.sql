-- Razorpay Test Mode capture rail: provider idempotency, reconcile backoff, runner observation confidence.
-- CAPTURED_RECONCILED remains Test Mode capture + reconcile, not merchant settlement.

ALTER TABLE payment_attempts
    ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS provider_request_digest TEXT,
    ADD COLUMN IF NOT EXISTS reconcile_attempt_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reconcile_next_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS waiting_event_binding_since TIMESTAMPTZ;

ALTER TABLE test_runner_jobs
    ADD COLUMN IF NOT EXISTS observation_confidence TEXT,
    ADD COLUMN IF NOT EXISTS claimed_by_identity TEXT;
