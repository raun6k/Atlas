-- Join stitch ID-502: Kernel 0070 already created order_lines with sku_id as the sellable unit.
-- Payment Fabric confirms into those rows; no second line table.

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS line_index INT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS amount_minor BIGINT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS currency TEXT;

UPDATE order_lines
SET amount_minor = COALESCE(amount_minor, line_total_minor),
    currency = COALESCE(currency, 'INR')
WHERE amount_minor IS NULL OR currency IS NULL;
