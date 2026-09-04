-- Permission helper used by Lab isolation tests.
-- AtlasLab role must not be able to connect to or read the Atlas database.
-- When Atlas PostgreSQL is absent (vertical isolation), the probe fails closed.

CREATE OR REPLACE FUNCTION atlaslab_cannot_read_atlas() RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  can_connect BOOLEAN := false;
BEGIN
  -- Atlas is a different database and trust domain. Presence of the Atlas
  -- database on this server is not required; inability to read it is.
  PERFORM 1 FROM pg_database WHERE datname = 'atlas';
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  BEGIN
    PERFORM dblink_connect('atlas_probe', 'dbname=atlas');
    can_connect := true;
    PERFORM dblink_disconnect('atlas_probe');
  EXCEPTION
    WHEN OTHERS THEN
      can_connect := false;
  END;
  RETURN NOT can_connect;
END;
$$;
