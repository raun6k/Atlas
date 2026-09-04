-- Merchant seed v2: columns and tables for the mixed JSON/CSV fixture pack.

ALTER TABLE merchant_profile
    ADD COLUMN IF NOT EXISTS merchant_id TEXT,
    ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS website_url TEXT,
    ADD COLUMN IF NOT EXISTS logo_url TEXT,
    ADD COLUMN IF NOT EXISTS return_policy_url TEXT,
    ADD COLUMN IF NOT EXISTS cancellation_policy_url TEXT,
    ADD COLUMN IF NOT EXISTS substitution_policy_url TEXT,
    ADD COLUMN IF NOT EXISTS support_phone TEXT,
    ADD COLUMN IF NOT EXISTS disclosures JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS agent_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE merchant_profile ALTER COLUMN city DROP NOT NULL;
ALTER TABLE merchant_profile DROP CONSTRAINT IF EXISTS merchant_profile_currency_check;
ALTER TABLE merchant_profile ADD CONSTRAINT merchant_profile_currency_check CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE locations
    ADD COLUMN IF NOT EXISTS latitude NUMERIC,
    ADD COLUMN IF NOT EXISTS longitude NUMERIC,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS timezone TEXT,
    ADD COLUMN IF NOT EXISTS operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS fulfillment_modes JSONB NOT NULL DEFAULT '["delivery"]'::jsonb;

ALTER TABLE locations ALTER COLUMN free_delivery_threshold_minor DROP NOT NULL;
ALTER TABLE locations ALTER COLUMN serviceability_reference DROP NOT NULL;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_status_check;
ALTER TABLE locations ADD CONSTRAINT locations_status_check
    CHECK (status IN ('active', 'paused', 'inactive', 'closed'));

CREATE TABLE IF NOT EXISTS service_areas (
    service_area_id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations (location_id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'inactive')),
    priority INT NOT NULL DEFAULT 0,
    postal_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
    geometry JSONB,
    delivery_fee_override_minor BIGINT,
    minimum_order_value_override_minor BIGINT,
    free_delivery_threshold_override_minor BIGINT,
    eta_adjustment_min_minutes INT NOT NULL DEFAULT 0,
    eta_adjustment_max_minutes INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS service_areas_location_idx ON service_areas (location_id);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS product_url TEXT,
    ADD COLUMN IF NOT EXISTS allergen_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS ingredients_text TEXT,
    ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS country_of_origin_code TEXT,
    ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE skus
    ADD COLUMN IF NOT EXISTS pack_count INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS gtin TEXT,
    ADD COLUMN IF NOT EXISTS description_override TEXT,
    ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS storage_class TEXT,
    ADD COLUMN IF NOT EXISTS perishable BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS shelf_life_days INT,
    ADD COLUMN IF NOT EXISTS min_order_quantity INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS max_order_quantity INT,
    ADD COLUMN IF NOT EXISTS quantity_step INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS gross_weight_grams INT,
    ADD COLUMN IF NOT EXISTS dimensions JSONB,
    ADD COLUMN IF NOT EXISTS hsn_code TEXT,
    ADD COLUMN IF NOT EXISTS tax_rate_bps INT NOT NULL DEFAULT 0;

ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_lifecycle_check;
ALTER TABLE skus ADD CONSTRAINT skus_lifecycle_check
    CHECK (lifecycle IN ('active', 'hidden', 'discontinued', 'sellable'));

ALTER TABLE skus DROP CONSTRAINT IF EXISTS skus_storage_class_check;
ALTER TABLE skus ADD CONSTRAINT skus_storage_class_check
    CHECK (storage_class IS NULL OR storage_class IN ('ambient', 'ambient_cool', 'chilled', 'frozen'));

ALTER TABLE prices
    ADD COLUMN IF NOT EXISTS price_source TEXT NOT NULL DEFAULT 'fixture';

ALTER TABLE inventory
    ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 0;

ALTER TABLE product_relationships
    ADD COLUMN IF NOT EXISTS source_entity_type TEXT NOT NULL DEFAULT 'sku',
    ADD COLUMN IF NOT EXISTS target_entity_type TEXT NOT NULL DEFAULT 'sku',
    ADD COLUMN IF NOT EXISTS confidence_bps INT,
    ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reason_code TEXT,
    ADD COLUMN IF NOT EXISTS reason_text TEXT,
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE product_relationships DROP CONSTRAINT IF EXISTS product_relationships_relationship_type_check;
ALTER TABLE product_relationships ADD CONSTRAINT product_relationships_relationship_type_check
    CHECK (relationship_type IN (
        'SUBSTITUTE', 'UPGRADE', 'DOWNGRADE',
        'COMPLEMENT', 'CONSUMED_WITH', 'USED_WITH', 'BUNDLE_COMPATIBLE',
        'SAME_FAMILY'
    ));

ALTER TABLE product_relationships DROP CONSTRAINT IF EXISTS product_relationships_entity_type_check;
ALTER TABLE product_relationships ADD CONSTRAINT product_relationships_entity_type_check
    CHECK (
        source_entity_type IN ('product', 'sku')
        AND target_entity_type IN ('product', 'sku')
    );

ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS application_mode TEXT NOT NULL DEFAULT 'automatic',
    ADD COLUMN IF NOT EXISTS code TEXT,
    ADD COLUMN IF NOT EXISTS condition JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS benefit JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS stacking_group TEXT,
    ADD COLUMN IF NOT EXISTS stacking_priority INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS funding JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS commercial_objective TEXT,
    ADD COLUMN IF NOT EXISTS excluded_sku_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE promotions ALTER COLUMN starts_at DROP NOT NULL;
ALTER TABLE promotions ALTER COLUMN ends_at DROP NOT NULL;

ALTER TABLE bundles
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS commercial_objective TEXT,
    ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS offers JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE bundles ALTER COLUMN sku_quantities SET DEFAULT '{}'::jsonb;
ALTER TABLE bundles ALTER COLUMN standalone_total_minor SET DEFAULT 0;
ALTER TABLE bundles ALTER COLUMN bundle_total_minor SET DEFAULT 0;
ALTER TABLE bundles ALTER COLUMN discount_amount_minor SET DEFAULT 0;

ALTER TABLE commercial_strategies
    ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS objective_metric TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
