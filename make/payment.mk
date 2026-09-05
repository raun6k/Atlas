# Payment Fabric fragment. Kernel Makefile includes make/*.mk.
# Closed developer targets remain generate, migrate, up, test, test-contract, test-e2e.

PAYMENT_GO_PKGS := ./internal/provider/... ./internal/payment/... ./internal/refund/...
PAYMENT_CONTRACT_DIRS := tests/contract/payment tests/contract/runner
PAYMENT_ENV := set -a; [ ! -f .env ] || . ./.env; set +a;

.PHONY: payment-test payment-test-fabric payment-test-provider payment-test-unknown-outcome payment-test-settlement-claim payment-typecheck payment-lint

payment-test: payment-test-fabric

payment-test-fabric:
	cd services/core && go test $(PAYMENT_GO_PKGS)
	cd apps/payment-runner && npm test
	cd tests/contract/payment && npm test
	cd tests/contract/runner && npm test

# Explicitly operator-assisted and never part of unattended CI.
payment-test-provider:
	$(PAYMENT_ENV) node scripts/provider-commercial-proof.mjs

payment-test-unknown-outcome:
	node tests/e2e/unknown-outcome.test.mjs

payment-test-settlement-claim:
	node tests/e2e/payment.test.mjs

payment-typecheck:
	cd apps/payment-runner && npm run typecheck
	cd tests/contract/payment && npm run typecheck
	cd tests/contract/runner && npm run typecheck

payment-lint: payment-typecheck
	cd services/core && test -z "$$(gofmt -l internal/provider internal/payment internal/refund)"

test:: payment-test
test-contract:: payment-test
