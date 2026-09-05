-- Host-stamped per-session commercial strategy mask for isolate-one evaluation.

ALTER TABLE shopping_sessions
    ADD COLUMN IF NOT EXISTS strategy_allowlist TEXT[] NOT NULL DEFAULT '{}';
