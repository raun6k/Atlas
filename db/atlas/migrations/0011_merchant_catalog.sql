-- Kernel 0011: merchant profile, locations, catalog, SKUs, prices, inventory, relationships.

CREATE TABLE merchant_profile (
    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'singleton'),
    display_name TEXT NOT NULL,
    legal_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL CHECK (currency = 'INR'),
    locale TEXT NOT NULL DEFAULT 'en-IN',
    country TEXT NOT NULL DEFAULT 'IN',
    city TEXT NOT NULL DEFAULT 'Bengaluru',
    timezone_display TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    terms_url TEXT,
    privacy_url TEXT,
    support_email TEXT,
    capability_summary TEXT,
    affiliation_disclaimer TEXT,
    profile_version BIGINT NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locations (
    location_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    neighbourhood TEXT NOT NULL,
    city TEXT NOT NULL,
    region TEXT,
    country TEXT NOT NULL DEFAULT 'IN',
    serviceability_reference TEXT NOT NULL UNIQUE,
    address_public TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_reference_location BOOLEAN NOT NULL DEFAULT FALSE,
    fulfillment_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_fee_minor BIGINT NOT NULL CHECK (delivery_fee_minor >= 0),
    minimum_order_value_minor BIGINT NOT NULL CHECK (minimum_order_value_minor >= 0),
    free_delivery_threshold_minor BIGINT NOT NULL CHECK (free_delivery_threshold_minor >= 0),
    eta_min_minutes INT NOT NULL CHECK (eta_min_minutes >= 0),
    eta_max_minutes INT NOT NULL CHECK (eta_max_minutes >= eta_min_minutes),
    handling_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (handling_fee_minor >= 0),
    location_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX locations_one_reference ON locations (is_reference_location) WHERE is_reference_location;

CREATE TABLE products (
    product_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    canonical_description TEXT NOT NULL DEFAULT '',
    dietary JSONB NOT NULL DEFAULT '[]'::jsonb,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'inactive', 'archived')),
    image_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    search_document TSVECTOR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE skus (
    sku_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products (product_id),
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    variant TEXT,
    pack_size INT NOT NULL CHECK (pack_size > 0),
    unit_of_measure TEXT NOT NULL,
    barcode TEXT,
    canonical_description TEXT NOT NULL DEFAULT '',
    dietary JSONB NOT NULL DEFAULT '[]'::jsonb,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('sellable', 'discontinued', 'hidden')),
    image_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    search_document TSVECTOR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX skus_product_idx ON skus (product_id);

CREATE TABLE prices (
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    list_price_minor BIGINT NOT NULL CHECK (list_price_minor >= 0),
    selling_price_minor BIGINT NOT NULL CHECK (selling_price_minor >= 0),
    tax_inclusive BOOLEAN NOT NULL DEFAULT TRUE,
    tax_rate_bps INT NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
    tax_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_amount_minor >= 0),
    cogs_minor BIGINT NOT NULL DEFAULT 0 CHECK (cogs_minor >= 0),
    variable_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (variable_cost_minor >= 0),
    supplier_funding_minor BIGINT NOT NULL DEFAULT 0 CHECK (supplier_funding_minor >= 0),
    contribution_margin_minor BIGINT NOT NULL DEFAULT 0,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to TIMESTAMPTZ,
    PRIMARY KEY (location_id, sku_id)
);

CREATE TABLE inventory (
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    sku_id TEXT NOT NULL REFERENCES skus (sku_id),
    assorted BOOLEAN NOT NULL DEFAULT TRUE,
    on_hand_quantity INT NOT NULL CHECK (on_hand_quantity >= 0),
    reserved_quantity INT NOT NULL CHECK (reserved_quantity >= 0),
    safety_buffer INT NOT NULL CHECK (safety_buffer >= 0),
    stock_status TEXT NOT NULL CHECK (stock_status IN ('in_stock', 'low', 'out_of_stock', 'out', 'not_assorted')),
    stock_confidence TEXT NOT NULL CHECK (stock_confidence IN ('high', 'medium', 'low')),
    expiry_risk TEXT NOT NULL DEFAULT 'low',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, sku_id),
    CHECK (reserved_quantity <= on_hand_quantity)
);

CREATE TABLE product_relationships (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (relationship_type IN (
        'SAME_FAMILY', 'SUBSTITUTE', 'UPGRADE', 'DOWNGRADE',
        'COMPLEMENT', 'CONSUMED_WITH', 'USED_WITH', 'BUNDLE_COMPATIBLE'
    )),
    confidence NUMERIC(4, 3),
    provenance TEXT,
    PRIMARY KEY (source_id, target_id, relationship_type)
);

CREATE TABLE promotions (
    promotion_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    eligible_sku_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    minimum_quantity INT,
    discount_amount_minor BIGINT CHECK (discount_amount_minor >= 0),
    stacking TEXT,
    location_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    supplier_funding_minor BIGINT NOT NULL DEFAULT 0,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    promotion_version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE bundles (
    bundle_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sku_quantities JSONB NOT NULL,
    standalone_total_minor BIGINT NOT NULL CHECK (standalone_total_minor >= 0),
    bundle_total_minor BIGINT NOT NULL CHECK (bundle_total_minor >= 0),
    discount_amount_minor BIGINT NOT NULL CHECK (discount_amount_minor >= 0),
    location_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE commercial_strategies (
    strategy_type TEXT PRIMARY KEY CHECK (strategy_type IN (
        'THRESHOLD', 'PROMOTION', 'BUNDLE', 'CROSS_SELL', 'COMPLEMENT', 'UPSELL'
    )),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revision TEXT NOT NULL
);

CREATE INDEX products_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX skus_trgm_idx ON skus USING gin (name gin_trgm_ops);
CREATE INDEX products_fts_idx ON products USING gin (search_document);
CREATE INDEX skus_fts_idx ON skus USING gin (search_document);
