-- Deterministic suite eval reports are artifacts (kind deterministic_eval.json)
-- on DETERMINISTIC_SCENARIO runs with scenario_id suite_qm_v1. Not a new run_type
-- enum value: keeps variant CHECKs and sellability denominators unchanged.

INSERT INTO schema_migrations (version)
VALUES ('0003_deterministic_suite')
ON CONFLICT (version) DO NOTHING;
