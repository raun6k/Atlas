# AtlasLab Makefile fragment. Kernel's root Makefile uses `-include make/*.mk`.
# Closed target names only: generate, migrate, up, test, test-contract, test-e2e.

ATLASLAB_APP := apps/atlaslab
ATLASLAB_COMPOSE := compose/atlaslab-postgres.yml compose/atlaslab.yml

atlaslab-migrate:
	npm --prefix $(ATLASLAB_APP) run migrate

atlaslab-test:
	npm --prefix $(ATLASLAB_APP) test

atlaslab-typecheck:
	npm --prefix $(ATLASLAB_APP) run typecheck

atlaslab-up:
	docker compose -f compose/atlaslab-postgres.yml -f compose/atlaslab.yml up --build -d

migrate:: atlaslab-migrate
test:: atlaslab-test
test-contract:: atlaslab-test
