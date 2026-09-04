# Merchant Kernel fragments. Do not invent additional top-level target names.
# Closed targets use double-colon so Payment, Lab, Console, and join fragments attach (ID-501).

PROTO_DIR := proto
GO_GEN_DIR := services/core/internal/gen
CORE_MOD := services/core
GATEWAY_DIR := apps/gateway
KERNEL_COMPOSE := -f compose/atlas-postgres.yml -f compose/core.yml -f compose/gateway.yml -f compose/worker.yml

.PHONY: kernel-generate kernel-migrate kernel-test kernel-test-contract kernel-lint kernel-typecheck kernel-up

generate:: kernel-generate
migrate:: kernel-migrate
test:: kernel-test
test-contract:: kernel-test-contract

kernel-generate:
	@mkdir -p $(GO_GEN_DIR)
	@command -v protoc >/dev/null || { echo "protoc is required for make generate" >&2; exit 1; }
	@command -v protoc-gen-go >/dev/null || { echo "protoc-gen-go is required" >&2; exit 1; }
	@command -v protoc-gen-go-grpc >/dev/null || { echo "protoc-gen-go-grpc is required" >&2; exit 1; }
	protoc \
		-I $(PROTO_DIR) \
		--go_out=$(GO_GEN_DIR) --go_opt=paths=source_relative \
		--go-grpc_out=$(GO_GEN_DIR) --go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/atlas/merchant/v1/merchant.proto
	@git diff --exit-code -- $(PROTO_DIR) $(GO_GEN_DIR) schemas

kernel-migrate:
	@test -n "$$ATLAS_POSTGRES_URL" || { echo "ATLAS_POSTGRES_URL is required" >&2; exit 1; }
	go run ./$(CORE_MOD)/cmd/migrate --postgres-url "$$ATLAS_POSTGRES_URL"

kernel-up:
	docker compose $(KERNEL_COMPOSE) up --build

kernel-test:
	cd $(CORE_MOD) && go test ./...
	cd $(GATEWAY_DIR) && npm test --if-present

kernel-test-contract:
	cd $(CORE_MOD) && go test ./internal/app ./internal/platform ./internal/grpcapi ./internal/money ./internal/cart ./internal/commerce ./internal/audit -count=1
	node tests/contract/mcp/mcp.contract.test.ts
	node tests/contract/admin/admin.contract.test.ts
	node tests/contract/grpc/grpc.contract.test.ts

kernel-lint:
	cd $(CORE_MOD) && go vet ./...
	cd $(GATEWAY_DIR) && npx --yes tsc --noEmit

kernel-typecheck: kernel-lint
