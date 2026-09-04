-- Refunds are independent of PaymentAttempt terminal success. Historical confirmation is not rewritten.

CREATE TABLE IF NOT EXISTS refunds (
    refund_id TEXT PRIMARY KEY,
    payment_attempt_id TEXT NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders (order_id),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    state TEXT NOT NULL CHECK (state IN (
        'REQUESTED',
        'SUBMITTING',
        'PROVIDER_SUBMITTED',
        'RECONCILING',
        'PROCESSED_RECONCILED',
        'FAILED_VERIFIED',
        'OUTCOME_UNKNOWN'
    )),
    idempotency_key TEXT NOT NULL UNIQUE,
    razorpay_refund_id TEXT,
    reason_code TEXT,
    effect_disposition TEXT,
    duplicate_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS refunds_attempt_idx ON refunds (payment_attempt_id);
