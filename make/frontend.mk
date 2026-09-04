# Operator console fragment. Included by the Kernel Makefile stub (`-include make/*.mk`).
# Do not invent additional closed developer-contract target names.

test::
	cd apps/frontend && npm test

test-e2e::
	cd apps/frontend && npm run test:e2e
