-- Surface assignment for commercial strategies; drop enum CHECKs so new types can register without a migration.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'commercial_strategies'::regclass
      AND c.contype = 'c'
      AND a.attname = 'strategy_type'
  LOOP
    EXECUTE format('ALTER TABLE commercial_strategies DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'offers'::regclass
      AND c.contype = 'c'
      AND a.attname = 'strategy_type'
  LOOP
    EXECUTE format('ALTER TABLE offers DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE commercial_strategies
    ADD COLUMN IF NOT EXISTS surfaces TEXT[] NOT NULL DEFAULT '{}';
