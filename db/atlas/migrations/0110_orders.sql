-- Join stitch ID-502: extend Kernel 0070 orders (ID-001 / ID-101). Do not fork a second aggregate.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS captured_payment_attempt_id TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS captured_razorpay_payment_id TEXT UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS orders_confirmed_captured_payment_uidx
    ON orders (captured_razorpay_payment_id)
    WHERE captured_razorpay_payment_id IS NOT NULL;
