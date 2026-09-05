-- Durable sittings, child sessions, fixture leases, run provenance.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_evaluation_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE run_configurations DROP CONSTRAINT IF EXISTS run_configurations_variant_chk;
ALTER TABLE run_configurations ADD CONSTRAINT run_configurations_variant_chk CHECK (
  (
    run_type = 'DETERMINISTIC_SCENARIO'
    AND driver_json ? 'scenario_id'
    AND driver_json ? 'action_program_id'
    AND NOT driver_json ? 'model_id'
    AND NOT driver_json ? 'custom_input_digest'
  )
  OR (
    run_type = 'BENCHMARK_MODEL'
    AND driver_json ? 'scenario_id'
    AND driver_json ? 'model_id'
    AND NOT driver_json ? 'custom_input_digest'
    AND NOT driver_json ? 'action_program_id'
  )
  OR (
    run_type = 'CUSTOM_MISSION'
    AND driver_json ? 'custom_input_digest'
    AND driver_json ? 'model_id'
    AND NOT driver_json ? 'scenario_id'
    AND NOT driver_json ? 'action_program_id'
  )
  OR run_type IN (
    'DETERMINISTIC_SUITE',
    'LIVE_COMPATIBILITY_SUITE',
    'LIVE_COMMERCIAL_SUITE',
    'LIVE_SESSION',
    'EVALUATION_SITTING'
  )
);

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_variant_chk;
ALTER TABLE runs ADD CONSTRAINT runs_variant_chk CHECK (
  (
    run_type = 'DETERMINISTIC_SCENARIO'
    AND scenario_id IS NOT NULL
    AND action_program_id IS NOT NULL
    AND requested_model_id IS NULL
    AND custom_input_digest IS NULL
    AND evidence_eligibility = 'CONTRACT_EVIDENCE_ONLY'
    AND arm IS NULL
    AND pair_id IS NULL
  )
  OR (
    run_type = 'BENCHMARK_MODEL'
    AND scenario_id IS NOT NULL
    AND requested_model_id IS NOT NULL
    AND custom_input_digest IS NULL
    AND action_program_id IS NULL
    AND evidence_eligibility IN ('BENCHMARK_ELIGIBLE', 'BENCHMARK_INELIGIBLE', 'EXPLORATORY')
  )
  OR (
    run_type = 'CUSTOM_MISSION'
    AND custom_input_digest IS NOT NULL
    AND requested_model_id IS NOT NULL
    AND scenario_id IS NULL
    AND action_program_id IS NULL
    AND evidence_eligibility = 'EXPLORATORY'
    AND arm IS NULL
    AND pair_id IS NULL
  )
  OR (
    run_type = 'DETERMINISTIC_SUITE'
    AND scenario_id IS NOT NULL
    AND requested_model_id IS NULL
    AND evidence_eligibility = 'CONTRACT_EVIDENCE_ONLY'
  )
  OR (
    run_type IN ('LIVE_COMPATIBILITY_SUITE', 'LIVE_COMMERCIAL_SUITE', 'LIVE_SESSION')
    AND requested_model_id IS NOT NULL
  )
  OR run_type = 'EVALUATION_SITTING'
);

CREATE TABLE IF NOT EXISTS eval_sittings (
  evaluation_id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES runs (run_id),
  state TEXT NOT NULL,
  planned_sessions INTEGER NOT NULL DEFAULT 0,
  started_sessions INTEGER NOT NULL DEFAULT 0,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  failed_sessions INTEGER NOT NULL DEFAULT 0,
  excluded_sessions INTEGER NOT NULL DEFAULT 0,
  aborted_sessions INTEGER NOT NULL DEFAULT 0,
  never_started_sessions INTEGER NOT NULL DEFAULT 0,
  spend_usd_micros BIGINT NOT NULL DEFAULT 0,
  aborted_reason TEXT,
  wall_deadline_at TIMESTAMPTZ NOT NULL,
  randomization_seed TEXT,
  first_arm commercial_arm,
  lock_json JSONB,
  provenance_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_children (
  child_run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  evaluation_id TEXT NOT NULL REFERENCES eval_sittings (evaluation_id),
  arm commercial_arm,
  mission_id TEXT,
  buyer_subject TEXT,
  policy_digest TEXT,
  strategy_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  fixture_snapshot_id TEXT,
  fixture_digest TEXT,
  model_id TEXT,
  model_invocation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  merchant_order_id TEXT,
  payment_attempt_id TEXT,
  provider_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_json JSONB,
  final_state TEXT,
  external_effect_possible BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS fixture_leases (
  lease_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  owner_evaluation_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS fixture_leases_active_idx
  ON fixture_leases (snapshot_id)
  WHERE released_at IS NULL;

CREATE OR REPLACE FUNCTION atlaslab_forbid_cross_variant_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rt run_type;
BEGIN
  SELECT run_type INTO rt FROM runs WHERE run_id = NEW.run_id;
  IF TG_TABLE_NAME IN ('driver_steps') AND rt NOT IN ('DETERMINISTIC_SCENARIO', 'DETERMINISTIC_SUITE') THEN
    RAISE EXCEPTION 'driver_steps allowed only on deterministic runs';
  END IF;
  IF TG_TABLE_NAME IN ('agent_turns', 'model_invocations') AND rt IN ('DETERMINISTIC_SCENARIO', 'DETERMINISTIC_SUITE') THEN
    RAISE EXCEPTION '% allowed only on model runs', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW benchmark_eligible_runs AS
SELECT *
FROM runs
WHERE run_type IN ('BENCHMARK_MODEL', 'LIVE_SESSION')
  AND evidence_eligibility = 'BENCHMARK_ELIGIBLE';

INSERT INTO schema_migrations (version)
VALUES ('0006_release_repair')
ON CONFLICT (version) DO NOTHING;
