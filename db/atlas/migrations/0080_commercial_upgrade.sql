-- Commercial Engine upgrade: evaluation arm, offer events already exist, paid attribution.

ALTER TABLE shopping_sessions
    ADD COLUMN IF NOT EXISTS evaluation_arm TEXT
        CHECK (evaluation_arm IS NULL OR evaluation_arm IN ('CONTROL', 'TREATMENT'));

CREATE INDEX IF NOT EXISTS shopping_sessions_eval_arm_idx
    ON shopping_sessions (evaluation_arm)
    WHERE evaluation_arm IS NOT NULL;

CREATE TABLE IF NOT EXISTS commercial_attributions (
    attribution_id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL REFERENCES offers (offer_id),
    candidate_id TEXT REFERENCES opportunity_candidates (candidate_id),
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    checkout_proposal_id TEXT,
    order_id TEXT,
    strategy_type TEXT NOT NULL,
    experiment_assignment TEXT,
    applied_quantity INT NOT NULL DEFAULT 0,
    paid_quantity INT,
    refunded_quantity INT NOT NULL DEFAULT 0,
    captured_revenue_minor BIGINT,
    refunded_revenue_minor BIGINT NOT NULL DEFAULT 0,
    net_realized_revenue_minor BIGINT,
    outcome_completeness TEXT NOT NULL DEFAULT 'APPLIED_ONLY'
        CHECK (outcome_completeness IN (
            'APPLIED_ONLY', 'PAID_COMPLETE', 'REFUNDED', 'MISSING_PAYMENT', 'INCOMPLETE'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_attributions_session_idx
    ON commercial_attributions (session_id);

CREATE INDEX IF NOT EXISTS commercial_attributions_order_idx
    ON commercial_attributions (order_id);
