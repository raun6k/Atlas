-- AtlasLab PostgreSQL schema.
-- Discriminated run variants are enforced here, not only in the API.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE run_type AS ENUM (
    'DETERMINISTIC_SCENARIO',
    'BENCHMARK_MODEL',
    'CUSTOM_MISSION'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evidence_eligibility AS ENUM (
    'CONTRACT_EVIDENCE_ONLY',
    'BENCHMARK_ELIGIBLE',
    'BENCHMARK_INELIGIBLE',
    'EXPLORATORY'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE run_state AS ENUM (
    'QUEUED',
    'RESETTING_FIXTURE',
    'READY',
    'RUNNING',
    'RECONCILING',
    'EVALUATING',
    'COMPLETED',
    'CANCEL_REQUESTED',
    'CANCELLED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE commercial_arm AS ENUM ('CONTROL', 'TREATMENT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE event_source AS ENUM (
    'USER_INPUT',
    'ATLASLAB_ORCHESTRATOR',
    'DETERMINISTIC_DRIVER',
    'MODEL_VISIBLE',
    'HOST_BOUNDARY',
    'ATLAS_RESPONSE',
    'ATLASLAB_EVALUATOR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE evaluation_result AS ENUM ('PASS', 'FAIL', 'NOT_APPLICABLE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS run_configurations (
  configuration_id TEXT PRIMARY KEY,
  configuration_digest TEXT NOT NULL UNIQUE,
  run_type run_type NOT NULL,
  atlas_contract_version TEXT NOT NULL,
  evaluator_set_version TEXT NOT NULL,
  fixture_snapshot_id TEXT NOT NULL,
  host_policy_version TEXT NOT NULL,
  payment_simulation TEXT NOT NULL,
  common_json JSONB NOT NULL,
  driver_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_configurations_payment_simulation_chk CHECK (
    payment_simulation IN (
      'NONE',
      'SUCCESS',
      'FAILURE',
      'AMBIGUOUS_THEN_SUCCESS',
      'AMBIGUOUS_THEN_FAILURE'
    )
  ),
  CONSTRAINT run_configurations_variant_chk CHECK (
    (
      run_type = 'DETERMINISTIC_SCENARIO'
      AND driver_json ? 'scenario_id'
      AND driver_json ? 'action_program_id'
      AND NOT driver_json ? 'model_id'
      AND NOT driver_json ? 'custom_input_digest'
      AND NOT driver_json ? 'token_ceiling'
      AND NOT driver_json ? 'cost_ceiling_usd_micros'
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
      AND NOT driver_json ? 'pair_id'
      AND NOT driver_json ? 'arm'
    )
  )
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  run_type run_type NOT NULL,
  configuration_id TEXT NOT NULL REFERENCES run_configurations (configuration_id),
  configuration_digest TEXT NOT NULL,
  evidence_eligibility evidence_eligibility NOT NULL,
  state run_state NOT NULL,
  fixture_snapshot_id TEXT NOT NULL,
  fixture_digest TEXT,
  arm commercial_arm,
  pair_id TEXT,
  scenario_id TEXT,
  scenario_version TEXT,
  action_program_id TEXT,
  action_program_digest TEXT,
  custom_input_digest TEXT,
  requested_model_id TEXT,
  returned_model_id TEXT,
  terminal_reason TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT runs_variant_chk CHECK (
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
      AND evidence_eligibility IN ('BENCHMARK_ELIGIBLE', 'BENCHMARK_INELIGIBLE')
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
  )
);

CREATE INDEX IF NOT EXISTS runs_state_idx ON runs (state);
CREATE INDEX IF NOT EXISTS runs_pair_idx ON runs (pair_id) WHERE pair_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_inputs (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  scenario_id TEXT,
  scenario_version TEXT,
  custom_input_snapshot TEXT,
  custom_input_digest TEXT,
  consent_policy_json JSONB NOT NULL,
  permitted_actions JSONB NOT NULL,
  structured_criteria JSONB,
  redaction_revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  record_sequence BIGINT NOT NULL,
  source event_source NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  UNIQUE (run_id, record_sequence)
);

CREATE TABLE IF NOT EXISTS driver_steps (
  driver_step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  action_program_id TEXT NOT NULL,
  public_precondition JSONB,
  selected_branch TEXT,
  typed_action JSONB NOT NULL,
  result_code TEXT,
  next_step_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, attempt)
);

CREATE TABLE IF NOT EXISTS agent_turns (
  agent_turn_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  turn_number INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL,
  selected_skill TEXT NOT NULL,
  invocation_id TEXT,
  structured_action JSONB,
  visible_decision_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, turn_number)
);

CREATE TABLE IF NOT EXISTS tool_exchanges (
  tool_exchange_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  tool_name TEXT NOT NULL,
  canonical_argument_digest TEXT NOT NULL,
  idempotency_key TEXT,
  request_status TEXT NOT NULL,
  result_status TEXT,
  latency_ms INTEGER,
  atlas_ids JSONB,
  proposed_arguments JSONB NOT NULL,
  host_enriched_request JSONB,
  atlas_response JSONB,
  returned_to_driver JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS state_projections (
  projection_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  after_exchange_id TEXT,
  public_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_invocations (
  invocation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  requested_model_id TEXT NOT NULL,
  returned_model_id TEXT,
  configuration_json JSONB NOT NULL,
  usage_json JSONB,
  cost_usd_micros BIGINT,
  latency_ms INTEGER,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  assertion_id TEXT,
  result evaluation_result NOT NULL,
  severity TEXT NOT NULL,
  evidence_refs JSONB NOT NULL,
  detail_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grades (
  grade_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  dimension TEXT NOT NULL,
  result evaluation_result NOT NULL,
  hard_gate BOOLEAN NOT NULL,
  detail_json JSONB NOT NULL,
  UNIQUE (run_id, dimension)
);

CREATE TABLE IF NOT EXISTS pair_results (
  pair_id TEXT PRIMARY KEY,
  pairing_key TEXT NOT NULL,
  control_run_id TEXT REFERENCES runs (run_id),
  treatment_run_id TEXT REFERENCES runs (run_id),
  eligible BOOLEAN NOT NULL,
  exclusion_reason TEXT,
  first_arm commercial_arm,
  fixture_digest TEXT,
  deltas_json JSONB,
  guardrails_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  local_path TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Model/driver rows may only exist for the matching run type.
CREATE OR REPLACE FUNCTION atlaslab_forbid_cross_variant_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rt run_type;
BEGIN
  SELECT run_type INTO rt FROM runs WHERE run_id = NEW.run_id;
  IF TG_TABLE_NAME IN ('driver_steps') AND rt IS DISTINCT FROM 'DETERMINISTIC_SCENARIO' THEN
    RAISE EXCEPTION 'driver_steps allowed only on DETERMINISTIC_SCENARIO';
  END IF;
  IF TG_TABLE_NAME IN ('agent_turns', 'model_invocations') AND rt = 'DETERMINISTIC_SCENARIO' THEN
    RAISE EXCEPTION '% allowed only on model runs', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS driver_steps_variant_trg ON driver_steps;
CREATE TRIGGER driver_steps_variant_trg
  BEFORE INSERT ON driver_steps
  FOR EACH ROW EXECUTE FUNCTION atlaslab_forbid_cross_variant_children();

DROP TRIGGER IF EXISTS agent_turns_variant_trg ON agent_turns;
CREATE TRIGGER agent_turns_variant_trg
  BEFORE INSERT ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION atlaslab_forbid_cross_variant_children();

DROP TRIGGER IF EXISTS model_invocations_variant_trg ON model_invocations;
CREATE TRIGGER model_invocations_variant_trg
  BEFORE INSERT ON model_invocations
  FOR EACH ROW EXECUTE FUNCTION atlaslab_forbid_cross_variant_children();

-- Pair/report queries must not admit custom or deterministic runs into benchmark denominators.
CREATE OR REPLACE VIEW benchmark_eligible_runs AS
SELECT *
FROM runs
WHERE run_type = 'BENCHMARK_MODEL'
  AND evidence_eligibility = 'BENCHMARK_ELIGIBLE';

INSERT INTO schema_migrations (version)
VALUES ('0001_init')
ON CONFLICT (version) DO NOTHING;
