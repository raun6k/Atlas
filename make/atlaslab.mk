# AtlasLab Makefile fragment. Kernel's root Makefile uses `-include make/*.mk`.
# Closed target names only: generate, migrate, up, test, test-contract, test-e2e.

ATLASLAB_APP := apps/atlaslab
ATLASLAB_COMPOSE := compose/atlaslab-postgres.yml compose/atlaslab.yml
ATLASLAB_HTTP ?= http://127.0.0.1:8090

atlaslab-migrate:
	npm --prefix $(ATLASLAB_APP) run migrate

atlaslab-test:
	npm --prefix $(ATLASLAB_APP) test

atlaslab-typecheck:
	npm --prefix $(ATLASLAB_APP) run typecheck

atlaslab-up:
	docker compose -f compose/atlaslab-postgres.yml -f compose/atlaslab.yml up --build -d

# Default release sitting: deterministic suite + 2 live compat + 1 commercial pair.
atlaslab-eval:
	@test -n "$(ATLASLAB_API_TOKEN)" || (echo "ATLASLAB_API_TOKEN is required" >&2; exit 1)
	ATLASLAB_MODE=release ATLASLAB_MOCK_MCP=0 ATLASLAB_MOCK_FIXTURE_RESET=0 curl -fsS -X POST "$(ATLASLAB_HTTP)/lab/v1/eval" \
		-H "authorization: Bearer $(ATLASLAB_API_TOKEN)" \
		-H "content-type: application/json" \
		-H "accept: application/json" \
		-d '{"model_id":"$(MODEL_ID)"}'

# One-shot Atlas interface eval: real MCP only (ATLASLAB_MOCK_MCP=0).
atlaslab-eval-deterministic:
	@test -n "$(ATLASLAB_API_TOKEN)" || (echo "ATLASLAB_API_TOKEN is required" >&2; exit 1)
	ATLASLAB_MOCK_MCP=0 ATLASLAB_MOCK_FIXTURE_RESET=0 curl -fsS -X POST "$(ATLASLAB_HTTP)/lab/v1/deterministic-eval" \
		-H "authorization: Bearer $(ATLASLAB_API_TOKEN)" \
		-H "content-type: application/json" \
		-H "accept: application/json"

# Core Live model eval: 4 CONTROL missions. Pass MODEL_ID=openai/...
atlaslab-eval-agent-compatibility:
	@test -n "$(ATLASLAB_API_TOKEN)" || (echo "ATLASLAB_API_TOKEN is required" >&2; exit 1)
	@test -n "$(MODEL_ID)" || (echo "MODEL_ID is required" >&2; exit 1)
	ATLASLAB_MOCK_MCP=0 ATLASLAB_MOCK_FIXTURE_RESET=0 curl -fsS -X POST "$(ATLASLAB_HTTP)/lab/v1/agent-compatibility-eval" \
		-H "authorization: Bearer $(ATLASLAB_API_TOKEN)" \
		-H "content-type: application/json" \
		-H "accept: application/json" \
		-d '{"model_id":"$(MODEL_ID)"}'

# Core Live RPAS: 3 portfolio pairs + 3 isolate-one cells.
atlaslab-eval-commercial-uplift:
	@test -n "$(ATLASLAB_API_TOKEN)" || (echo "ATLASLAB_API_TOKEN is required" >&2; exit 1)
	@test -n "$(MODEL_ID)" || (echo "MODEL_ID is required" >&2; exit 1)
	ATLASLAB_MOCK_MCP=0 ATLASLAB_MOCK_FIXTURE_RESET=0 curl -fsS -X POST "$(ATLASLAB_HTTP)/lab/v1/commercial-uplift-eval" \
		-H "authorization: Bearer $(ATLASLAB_API_TOKEN)" \
		-H "content-type: application/json" \
		-H "accept: application/json" \
		-d '{"model_id":"$(MODEL_ID)"}'

migrate:: atlaslab-migrate
test:: atlaslab-test
test-contract:: atlaslab-test
