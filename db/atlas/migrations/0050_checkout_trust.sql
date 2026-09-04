-- Kernel 0050: checkout proposals, reservations, trust gate, passports.

CREATE TABLE checkout_proposals (
    checkout_proposal_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    cart_id TEXT NOT NULL REFERENCES carts (cart_id),
    session_context_version BIGINT NOT NULL,
    cart_version BIGINT NOT NULL,
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    quote_hash TEXT NOT NULL,
    currency TEXT NOT NULL,
    merchandise_minor BIGINT NOT NULL CHECK (merchandise_minor >= 0),
    discounts_minor BIGINT NOT NULL CHECK (discounts_minor >= 0),
    delivery_fee_minor BIGINT NOT NULL CHECK (delivery_fee_minor >= 0),
    handling_fee_minor BIGINT NOT NULL CHECK (handling_fee_minor >= 0),
    tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
    final_amount_minor BIGINT NOT NULL CHECK (final_amount_minor >= 0),
    payment_capability_id TEXT NOT NULL CHECK (payment_capability_id = 'pcap_razorpay_test'),
    snapshot JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'INVALIDATED', 'CANCELLED')),
    hold_expires_at TIMESTAMPTZ NOT NULL,
    proposal_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX checkout_proposals_session_idx ON checkout_proposals (session_id, status);

CREATE TABLE reservations (
    reservation_id TEXT PRIMARY KEY,
    checkout_proposal_id TEXT NOT NULL REFERENCES checkout_proposals (checkout_proposal_id),
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    quantity INT NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'CONVERTED')),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (checkout_proposal_id, sku_id)
);

CREATE UNIQUE INDEX reservations_active_allocation
    ON reservations (location_id, sku_id, checkout_proposal_id)
    WHERE status = 'ACTIVE';

CREATE TABLE policy_decisions (
    policy_decision_id TEXT PRIMARY KEY,
    session_id TEXT,
    checkout_proposal_id TEXT,
    result TEXT NOT NULL CHECK (result IN ('ALLOW', 'DENY', 'REPLAN', 'REQUIRE_APPROVAL')),
    reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    revision TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE execution_passports (
    passport_id TEXT PRIMARY KEY,
    checkout_proposal_id TEXT NOT NULL REFERENCES checkout_proposals (checkout_proposal_id),
    policy_decision_id TEXT NOT NULL REFERENCES policy_decisions (policy_decision_id),
    action_type TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency TEXT NOT NULL,
    payment_capability_id TEXT NOT NULL,
    authority_hash TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX execution_passports_one_active
    ON execution_passports (checkout_proposal_id)
    WHERE consumed_at IS NULL;
