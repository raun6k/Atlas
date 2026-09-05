-- Live model eval suite reports are artifacts on BENCHMARK_MODEL runs with
-- scenario_id suite_agent_compat_v1 / suite_commercial_uplift_v1. Not a new
-- run_type enum value: keeps variant CHECKs. Those scenario ids are excluded
-- from leftover sellability denominators.

INSERT INTO schema_migrations (version)
VALUES ('0004_model_eval_suites')
ON CONFLICT (version) DO NOTHING;
