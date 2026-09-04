-- Align inventory status with fix_quickmart_v1 values.
ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_stock_status_check;
ALTER TABLE inventory ADD CONSTRAINT inventory_stock_status_check
    CHECK (stock_status IN ('in_stock', 'low', 'out_of_stock', 'out', 'not_assorted'));
