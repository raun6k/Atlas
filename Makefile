# Atlas developer contract. Verticals add only make/<name>.mk.
# Closed target names: generate, migrate, up, test, test-contract, test-e2e.

.PHONY: generate migrate up test test-contract test-e2e

-include make/*.mk
