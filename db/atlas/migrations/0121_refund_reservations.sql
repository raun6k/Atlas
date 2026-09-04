-- Remaining-balance reservations. Concurrent partial refunds cannot spend the same money twice.

CREATE TABLE IF NOT EXISTS refund_reservations (
    reservation_id TEXT PRIMARY KEY,
    refund_id TEXT NOT NULL REFERENCES refunds (refund_id),
    payment_attempt_id TEXT NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE UNIQUE INDEX IF NOT EXISTS refund_reservations_active_refund_uidx
    ON refund_reservations (refund_id)
    WHERE status IN ('ACTIVE', 'COMMITTED');
