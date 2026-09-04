# Payment Fabric fragment. Kernel Makefile includes make/*.mk.
# Closed developer targets remain generate, migrate, up, test, test-contract, test-e2e.

PAYMENT_GO_PKGS := ./internal/provider/... ./internal/payment/... ./internal/refund/...
PAYMENT_CONTRACT_DIRS := tests/contract/payment tests/contract/runner

.PHONY: payment-test payment-typecheck payment-lint

payment-test:
	cd services/core && go test $(PAYMENT_GO_PKGS)
	cd apps/payment-runner && npm test
	cd tests/contract/payment && npm test
	cd tests/contract/runner && npm test

payment-typecheck:
	cd apps/payment-runner && npm run typecheck
	cd tests/contract/payment && npm run typecheck
	cd tests/contract/runner && npm run typecheck

payment-lint: payment-typecheck
	cd services/core && test -z "$$(gofmt -l internal/provider internal/payment internal/refund)"

test:: payment-test
test-contract:: payment-test
