-- Stable taxonomy and campaign identifiers used by brand-funded promotions.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS brand_id TEXT,
    ADD COLUMN IF NOT EXISTS category_id TEXT,
    ADD COLUMN IF NOT EXISTS subcategory_id TEXT;

CREATE INDEX IF NOT EXISTS products_brand_id_idx ON products (brand_id);
CREATE INDEX IF NOT EXISTS products_category_id_idx ON products (category_id);
CREATE INDEX IF NOT EXISTS products_subcategory_id_idx ON products (subcategory_id);

ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS campaign_id TEXT,
    ADD COLUMN IF NOT EXISTS brand TEXT,
    ADD COLUMN IF NOT EXISTS brand_id TEXT,
    ADD COLUMN IF NOT EXISTS campaign_budget_minor BIGINT NOT NULL DEFAULT 0 CHECK (campaign_budget_minor >= 0),
    ADD COLUMN IF NOT EXISTS budget_consumed_minor BIGINT NOT NULL DEFAULT 0 CHECK (budget_consumed_minor >= 0);

CREATE INDEX IF NOT EXISTS promotions_campaign_id_idx ON promotions (campaign_id);
CREATE INDEX IF NOT EXISTS promotions_brand_id_idx ON promotions (brand_id);
