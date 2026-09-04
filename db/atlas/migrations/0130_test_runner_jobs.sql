-- Private Test Mode runner jobs. Safe references plus a hashed one-action executor token.
-- The runner never holds Razorpay secrets or a database URL.

CREATE TABLE IF NOT EXISTS test_runner_jobs (
    job_id TEXT PRIMARY KEY,
    payment_attempt_id TEXT NOT NULL,
    executor_token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ISSUED', 'CLAIMED', 'OBSERVED', 'EXPIRED')),
    razorpay_order_id TEXT NOT NULL,
    razorpay_key_id TEXT NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    callback_origin TEXT,
    scenario TEXT,
    checkout_page_url TEXT,
    observation_summary TEXT,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS test_runner_jobs_issued_idx
    ON test_runner_jobs (status)
    WHERE status = 'ISSUED';
