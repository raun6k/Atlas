-- Verified Razorpay webhook events. Unique provider event id. Raw body is not stored.

CREATE TABLE IF NOT EXISTS provider_events (
    row_id TEXT PRIMARY KEY,
    provider_event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    signature_valid BOOLEAN NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
    currency TEXT,
    provider_status TEXT,
    payment_attempt_id TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    source_occurred_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS provider_events_attempt_idx
    ON provider_events (payment_attempt_id, received_at);
