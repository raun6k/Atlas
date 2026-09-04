-- Application role for AtlasLab. Must not be able to read the Atlas database.
-- The Atlas database is a separate trust domain. This script is applied on the
-- AtlasLab PostgreSQL instance only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlaslab_app') THEN
    CREATE ROLE atlaslab_app LOGIN PASSWORD 'atlaslab_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE atlaslab TO atlaslab_app;
GRANT USAGE ON SCHEMA public TO atlaslab_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO atlaslab_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO atlaslab_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO atlaslab_app;

-- run_events, evaluations, and grades are append-oriented; still allow UPDATE only
-- for orchestrator state on runs / pair_results. Application code never updates events.

REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM atlaslab_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM atlaslab_app;
