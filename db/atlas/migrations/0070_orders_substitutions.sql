-- Kernel 0070: Merchant Order + substitution tables matching ID-001 so Kernel
-- substitutions can run against fixture-confirmed orders before Payment Fabric
-- migrations 0100+ extend payment columns.

CREATE TABLE orders (
    order_id TEXT PRIMARY KEY,
    checkout_proposal_id TEXT UNIQUE REFERENCES checkout_proposals (checkout_proposal_id),
    captured_payment_id TEXT UNIQUE,
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    status TEXT NOT NULL CHECK (status IN (
        'PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'FULFILLING', 'COMPLETED', 'CANCELLED'
    )),
    currency TEXT NOT NULL,
    total_amount_minor BIGINT NOT NULL CHECK (total_amount_minor >= 0),
    quote_hash TEXT NOT NULL,
    payment_attempt_id TEXT,
    payment_public_status TEXT,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ
);

CREATE TABLE order_lines (
    order_line_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    product_id TEXT NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
    line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0)
);

CREATE INDEX order_lines_order_idx ON order_lines (order_id);

CREATE TABLE substitution_requests (
    substitution_request_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders (order_id),
    original_sku_id TEXT NOT NULL,
    original_quantity INT NOT NULL CHECK (original_quantity > 0),
    options JSONB NOT NULL,
    substitution_version BIGINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESPONDED', 'EXPIRED', 'DECLINED', 'APPLIED')),
    deadline_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE substitution_responses (
    substitution_response_id TEXT PRIMARY KEY,
    substitution_request_id TEXT NOT NULL UNIQUE REFERENCES substitution_requests (substitution_request_id),
    selected_option_id TEXT,
    declined BOOLEAN NOT NULL DEFAULT FALSE,
    host_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
