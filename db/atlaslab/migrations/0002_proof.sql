-- Per-run proof projections (ID-601). Recomputed from events; never invents missing evidence.

CREATE TABLE IF NOT EXISTS run_proofs (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  proof_json JSONB NOT NULL,
  trajectory_json JSONB NOT NULL,
  payment_assurance_json JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_stage_results (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  stage TEXT NOT NULL,
  result TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail TEXT,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS run_requirement_grades (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  requirement_id TEXT NOT NULL,
  category TEXT NOT NULL,
  result TEXT NOT NULL,
  assertion_json JSONB NOT NULL,
  PRIMARY KEY (run_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS run_failures (
  failure_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  domain TEXT NOT NULL,
  code TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_payment_assurance (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  display_state TEXT NOT NULL,
  payment_status TEXT,
  outcome_unknown BOOLEAN NOT NULL DEFAULT FALSE,
  frozen BOOLEAN NOT NULL DEFAULT FALSE,
  body JSONB NOT NULL
);

INSERT INTO schema_migrations (version)
VALUES ('0002_proof')
ON CONFLICT (version) DO NOTHING;
