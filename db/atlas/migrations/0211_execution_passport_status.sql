-- Passport lifecycle is explicit so consumed/expired/rejected rows cannot be replayed.

ALTER TABLE execution_passports
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'issued';

UPDATE execution_passports
SET status = 'consumed'
WHERE consumed_at IS NOT NULL AND status = 'issued';

ALTER TABLE execution_passports DROP CONSTRAINT IF EXISTS execution_passports_status_check;
ALTER TABLE execution_passports
    ADD CONSTRAINT execution_passports_status_check
    CHECK (status IN ('issued', 'consumed', 'expired', 'rejected'));
