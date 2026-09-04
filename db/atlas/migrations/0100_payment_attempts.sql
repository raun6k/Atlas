-- PaymentAttempt aggregate. One active attempt per consumed checkout proposal.
-- Money is integer minor units + ISO currency. Browser success is not stored as capture.

CREATE TABLE IF NOT EXISTS payment_attempts (
    payment_attempt_id TEXT PRIMARY KEY,
    checkout_proposal_id TEXT NOT NULL UNIQUE,
    merchant_order_id TEXT NOT NULL,
    execution_passport_id TEXT NOT NULL,
    capability_id TEXT NOT NULL CHECK (capability_id = 'pcap_razorpay_test'),
    state TEXT NOT NULL CHECK (state IN (
        'CREATED',
        'PROVIDER_ORDER_CREATED',
        'RUNNER_QUEUED',
        'CHECKOUT_IN_PROGRESS',
        'PROVIDER_SUBMITTED',
        'RECONCILING',
        'CAPTURED_RECONCILED',
        'FAILED_VERIFIED',
        'CANCELLED_VERIFIED',
        'OUTCOME_UNKNOWN'
    )),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    duplicate_attempt_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    fulfillment_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    hold_release_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    effect_disposition TEXT,
    reason_code TEXT,
    has_callback_binding BOOLEAN NOT NULL DEFAULT FALSE,
    has_webhook_binding BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key TEXT NOT NULL,
    host_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_host_idempotency_uidx
    ON payment_attempts (host_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_razorpay_order_uidx
    ON payment_attempts (razorpay_order_id)
    WHERE razorpay_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_captured_payment_uidx
    ON payment_attempts (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL AND state = 'CAPTURED_RECONCILED';
