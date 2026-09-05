# Security and vulnerability scanning.

.PHONY: vulncheck

join-lint:: vulncheck

GOPATH_BIN := $(shell go env GOPATH)/bin

vulncheck:
	@GOVULNCHECK=""; \
	if command -v govulncheck >/dev/null 2>&1; then GOVULNCHECK="$$(command -v govulncheck)"; \
	elif [ -x "$(GOPATH_BIN)/govulncheck" ]; then GOVULNCHECK="$(GOPATH_BIN)/govulncheck"; fi; \
	if [ -n "$$GOVULNCHECK" ]; then \
	  echo "govulncheck services/core"; \
	  (cd services/core && "$$GOVULNCHECK" ./...); \
	else \
	  echo "govulncheck skipped (install with: go install golang.org/x/vuln/cmd/govulncheck@latest)"; \
	fi
