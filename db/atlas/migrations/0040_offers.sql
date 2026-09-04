-- Kernel 0040: commercial engine candidates and public offers.

CREATE TABLE opportunity_candidates (
    candidate_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    cart_id TEXT NOT NULL REFERENCES carts (cart_id),
    session_context_version BIGINT NOT NULL,
    cart_version BIGINT NOT NULL,
    strategy_type TEXT NOT NULL,
    features JSONB NOT NULL DEFAULT '{}'::jsonb,
    economics_private JSONB NOT NULL DEFAULT '{}'::jsonb,
    ranking_score NUMERIC,
    experiment_assignment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offers (
    offer_id TEXT PRIMARY KEY,
    candidate_id TEXT REFERENCES opportunity_candidates (candidate_id),
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    cart_id TEXT NOT NULL REFERENCES carts (cart_id),
    session_context_version BIGINT NOT NULL,
    cart_version BIGINT NOT NULL,
    strategy_type TEXT NOT NULL CHECK (strategy_type IN (
        'THRESHOLD', 'PROMOTION', 'BUNDLE', 'CROSS_SELL', 'COMPLEMENT', 'UPSELL'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'GENERATED', 'SHOWN', 'ACCEPTED', 'APPLIED', 'EXPIRED', 'INVALIDATED', 'CHECKED_OUT_UNACCEPTED'
    )),
    grounded_reason TEXT NOT NULL,
    terms TEXT NOT NULL DEFAULT '',
    cart_patch JSONB NOT NULL,
    buyer_impact_minor BIGINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX offers_session_idx ON offers (session_id, status);

CREATE TABLE offer_events (
    offer_event_id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL REFERENCES offers (offer_id),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
