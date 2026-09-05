-- Buyer identity, purchase history, search events, routines, and brand campaigns.
-- These are commercial-engine inputs, not checkout aggregates.

CREATE TABLE buyers (
    buyer_id TEXT PRIMARY KEY,
    default_location_id TEXT REFERENCES locations (location_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
    campaign_id TEXT PRIMARY KEY,
    brand_id TEXT,
    brand TEXT,
    name TEXT NOT NULL DEFAULT '',
    promotion_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    budget_minor BIGINT NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
    budget_consumed_minor BIGINT NOT NULL DEFAULT 0 CHECK (budget_consumed_minor >= 0),
    brand_funding_pct INT NOT NULL DEFAULT 0 CHECK (brand_funding_pct >= 0 AND brand_funding_pct <= 100),
    merchant_funding_pct INT NOT NULL DEFAULT 0 CHECK (merchant_funding_pct >= 0 AND merchant_funding_pct <= 100),
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ
);

CREATE TABLE buyer_orders (
    order_id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL REFERENCES buyers (buyer_id),
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    ordered_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'COMPLETED', 'CONFIRMED', 'CANCELLED', 'PENDING_PAYMENT', 'PAYMENT_FAILED', 'FULFILLING'
    ))
);

CREATE INDEX buyer_orders_buyer_idx ON buyer_orders (buyer_id, ordered_at DESC);

CREATE TABLE buyer_order_lines (
    order_id TEXT NOT NULL REFERENCES buyer_orders (order_id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    quantity INT NOT NULL CHECK (quantity > 0),
    price_paid_minor BIGINT NOT NULL CHECK (price_paid_minor >= 0),
    PRIMARY KEY (order_id, sku_id)
);

CREATE INDEX buyer_order_lines_sku_idx ON buyer_order_lines (sku_id);

CREATE TABLE search_events (
    search_event_id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL REFERENCES buyers (buyer_id),
    search_query TEXT NOT NULL,
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'add_to_cart')),
    occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX search_events_buyer_idx ON search_events (buyer_id, occurred_at DESC);

CREATE TABLE buyer_routines (
    routine_id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL REFERENCES buyers (buyer_id),
    name TEXT NOT NULL,
    cadence_days INT NOT NULL CHECK (cadence_days > 0),
    last_ordered_at TIMESTAMPTZ
);

CREATE TABLE buyer_routine_items (
    routine_id TEXT NOT NULL REFERENCES buyer_routines (routine_id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    usual_quantity INT NOT NULL CHECK (usual_quantity > 0),
    PRIMARY KEY (routine_id, sku_id)
);
