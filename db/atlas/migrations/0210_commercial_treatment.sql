-- Treatment policy, demo-visible strategies, offer economics, and attribution chain.

CREATE TABLE IF NOT EXISTS commercial_strategy_types (
    strategy_type TEXT PRIMARY KEY,
    visibility TEXT NOT NULL CHECK (visibility IN ('DEMO', 'EXPLORATORY'))
);

INSERT INTO commercial_strategy_types (strategy_type, visibility) VALUES
    ('FREE_DELIVERY', 'DEMO'),
    ('SMALL_ORDER', 'DEMO'),
    ('BRAND_PROMO', 'DEMO'),
    ('FBT', 'DEMO'),
    ('REORDER', 'EXPLORATORY'),
    ('REPLENISHMENT', 'EXPLORATORY'),
    ('PAST_PURCHASE', 'EXPLORATORY'),
    ('CART_COMPLETION', 'EXPLORATORY'),
    ('BASKET_REC', 'EXPLORATORY'),
    ('SEARCH_RANKING', 'EXPLORATORY'),
    ('ROUTINE', 'EXPLORATORY'),
    ('LARGER_PACK', 'EXPLORATORY')
ON CONFLICT (strategy_type) DO NOTHING;

ALTER TABLE commercial_strategies
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'EXPLORATORY';

UPDATE commercial_strategies s
SET visibility = t.visibility
FROM commercial_strategy_types t
WHERE s.strategy_type = t.strategy_type;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'commercial_strategies'::regclass AND c.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE commercial_strategies DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE commercial_strategies
    ADD CONSTRAINT commercial_strategies_visibility_chk
        CHECK (visibility IN ('DEMO', 'EXPLORATORY')),
    ADD CONSTRAINT commercial_strategies_type_fk
        FOREIGN KEY (strategy_type) REFERENCES commercial_strategy_types (strategy_type);

CREATE TABLE IF NOT EXISTS commercial_strategy_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    strategy_type TEXT NOT NULL REFERENCES commercial_strategy_types (strategy_type),
    revision TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    visibility TEXT NOT NULL,
    surfaces TEXT[] NOT NULL DEFAULT '{}',
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (strategy_type, revision)
);

INSERT INTO commercial_strategy_snapshots (snapshot_id, strategy_type, revision, enabled, visibility, surfaces, config)
SELECT
    'ssnap_' || replace(strategy_type, '_', '') || '_' || replace(revision, '-', ''),
    strategy_type, revision, enabled, visibility, COALESCE(surfaces, '{}'), COALESCE(config, '{}'::jsonb)
FROM commercial_strategies
ON CONFLICT (strategy_type, revision) DO NOTHING;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS revision TEXT NOT NULL DEFAULT 'v1';

CREATE TABLE IF NOT EXISTS session_treatment_policies (
    policy_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES shopping_sessions (session_id),
    arm TEXT NOT NULL DEFAULT '',
    strategy_allowlist TEXT[] NOT NULL DEFAULT '{}',
    strategy_revisions JSONB NOT NULL DEFAULT '{}'::jsonb,
    campaign_revisions JSONB NOT NULL DEFAULT '{}'::jsonb,
    ranking_version TEXT NOT NULL,
    economic_objective_version TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id)
);

ALTER TABLE shopping_sessions
    ADD COLUMN IF NOT EXISTS treatment_policy_id TEXT;

ALTER TABLE offers
    ADD COLUMN IF NOT EXISTS strategy_revision TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_promotion_id TEXT,
    ADD COLUMN IF NOT EXISTS eligibility_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS discount_amount_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS merchant_funded_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS partner_funded_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS expected_margin_impact_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quote_delta_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS public_explanation JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'offers'::regclass AND c.contype = 'c' AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE offers DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE offers
    ADD CONSTRAINT offers_status_chk CHECK (status IN (
        'GENERATED', 'SHOWN', 'SELECTED', 'ACCEPTED', 'APPLIED', 'RETAINED',
        'ORDER_CONFIRMED', 'ATTRIBUTED', 'EXPIRED', 'INVALIDATED', 'CHECKED_OUT_UNACCEPTED'
    ));

ALTER TABLE commercial_attributions
    ADD COLUMN IF NOT EXISTS attribution_state TEXT NOT NULL DEFAULT 'GENERATED',
    ADD COLUMN IF NOT EXISTS strategy_revision TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS strategy_digest TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS payment_attempt_id TEXT,
    ADD COLUMN IF NOT EXISTS quote_delta_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS merchant_funded_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS partner_funded_minor BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS attributed_revenue_minor BIGINT,
    ADD COLUMN IF NOT EXISTS attributed_margin_minor BIGINT,
    ADD COLUMN IF NOT EXISTS cart_patch JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'commercial_attributions'::regclass AND c.contype = 'c' AND a.attname = 'attribution_state'
  LOOP
    EXECUTE format('ALTER TABLE commercial_attributions DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE commercial_attributions
    ADD CONSTRAINT commercial_attributions_state_chk CHECK (attribution_state IN (
        'GENERATED', 'APPLIED', 'ORDER_CONFIRMED', 'PAYMENT_RECONCILED',
        'REVENUE_ATTRIBUTED', 'EXCLUDED', 'REVERSED'
    ));

CREATE TABLE IF NOT EXISTS campaign_budget_ledger (
    ledger_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns (campaign_id),
    session_id TEXT NOT NULL,
    offer_id TEXT,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buyer_promo_redemptions (
    redemption_id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    promotion_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    offer_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, promotion_id)
);

CREATE INDEX IF NOT EXISTS buyer_promo_redemptions_buyer_idx
    ON buyer_promo_redemptions (buyer_id, promotion_id);
