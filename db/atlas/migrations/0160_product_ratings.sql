-- Product ratings, review counts, and per-100g nutrition from the merchant seed.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS rating NUMERIC,
    ADD COLUMN IF NOT EXISTS reviews INT,
    ADD COLUMN IF NOT EXISTS nutrition_per_100g JSONB NOT NULL DEFAULT '{}'::jsonb;
