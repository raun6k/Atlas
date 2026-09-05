-- Merchant-level fee thresholds used by free-delivery and small-order strategies.

ALTER TABLE merchant_profile
    ADD COLUMN IF NOT EXISTS small_order_threshold_minor BIGINT NOT NULL DEFAULT 0 CHECK (small_order_threshold_minor >= 0),
    ADD COLUMN IF NOT EXISTS small_order_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (small_order_fee_minor >= 0),
    ADD COLUMN IF NOT EXISTS fee_after_small_order_threshold_minor BIGINT NOT NULL DEFAULT 0 CHECK (fee_after_small_order_threshold_minor >= 0),
    ADD COLUMN IF NOT EXISTS delivery_fee_after_threshold_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_after_threshold_minor >= 0);
