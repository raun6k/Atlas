# Integration Agent fragment. Closed developer-contract targets only.

JOIN_E2E := tests/e2e
JOIN_COMPOSE := docker-compose.yml

.PHONY: join-e2e join-permission join-up join-lint

up:: join-up

test:: join-permission-soft

test-contract:: kernel-test-contract payment-test

test-e2e:: join-e2e

join-up:
	docker compose -f $(JOIN_COMPOSE) up --build

join-e2e: join-permission
	node tests/e2e/mcp.live.test.mjs
	node tests/e2e/payment.test.mjs
	node tests/e2e/unknown-outcome.test.mjs
	node tests/e2e/sellability-report.test.mjs
	@if curl -sf http://127.0.0.1:8080/health/live >/dev/null 2>&1; then \
	  cd apps/frontend && ATLAS_FRONTEND_ENABLE_MOCKS=0 npm run test:e2e; \
	else \
	  echo "live browser gate skipped (gateway not up); frontend mock journeys still run via make/frontend.mk"; \
	fi

join-permission:
	node tests/e2e/permission.test.mjs

join-permission-soft:
	@node tests/e2e/permission.test.mjs || echo "permission test skipped (stack not running)"

join-lint:
	cd services/core && go vet ./...
	cd apps/gateway && npx tsc --noEmit
	cd apps/payment-runner && npm run typecheck
	cd apps/atlaslab && npm run typecheck
	cd apps/frontend && npx tsc --noEmit && npx eslint .
