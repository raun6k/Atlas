-- Kernel 0020: shopping sessions, carts, cart lines.

CREATE TABLE shopping_sessions (
    session_id TEXT PRIMARY KEY,
    approved_host_id TEXT NOT NULL,
    subject_reference TEXT NOT NULL,
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    serviceability_reference TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en-IN',
    session_context_version BIGINT NOT NULL DEFAULT 0 CHECK (session_context_version >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'ACTIVE', 'CHECKOUT_HELD', 'PAYMENT_PENDING', 'ORDER_CONFIRMED', 'EXPIRED', 'CLOSED'
    )),
    mission TEXT,
    planning_budget_minor BIGINT CHECK (planning_budget_minor IS NULL OR planning_budget_minor >= 0),
    planning_budget_currency TEXT,
    constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX shopping_sessions_host_idx ON shopping_sessions (approved_host_id, created_at DESC);

CREATE TABLE carts (
    cart_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES shopping_sessions (session_id),
    cart_version BIGINT NOT NULL DEFAULT 0 CHECK (cart_version >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    merchandise_minor BIGINT NOT NULL DEFAULT 0 CHECK (merchandise_minor >= 0),
    discounts_minor BIGINT NOT NULL DEFAULT 0 CHECK (discounts_minor >= 0),
    delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
    handling_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (handling_fee_minor >= 0),
    tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
    all_in_total_minor BIGINT NOT NULL DEFAULT 0 CHECK (all_in_total_minor >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cart_lines (
    cart_line_id TEXT PRIMARY KEY,
    cart_id TEXT NOT NULL REFERENCES carts (cart_id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    product_id TEXT NOT NULL REFERENCES products (product_id),
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
    line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
    UNIQUE (cart_id, sku_id)
);

CREATE INDEX cart_lines_cart_idx ON cart_lines (cart_id);
