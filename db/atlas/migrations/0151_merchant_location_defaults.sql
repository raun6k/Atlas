-- Merchant-wide location defaults (fees, handling, static ETA).

ALTER TABLE merchant_profile
    ADD COLUMN IF NOT EXISTS base_delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_delivery_fee_minor >= 0),
    ADD COLUMN IF NOT EXISTS minimum_order_value_minor BIGINT NOT NULL DEFAULT 0 CHECK (minimum_order_value_minor >= 0),
    ADD COLUMN IF NOT EXISTS free_delivery_threshold_minor BIGINT,
    ADD COLUMN IF NOT EXISTS base_handling_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_handling_fee_minor >= 0),
    ADD COLUMN IF NOT EXISTS eta_min_minutes INT NOT NULL DEFAULT 0 CHECK (eta_min_minutes >= 0);
