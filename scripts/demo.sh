#!/usr/bin/env bash
# Five-minute Atlas demo from a clean Compose start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "1. Open merchant dashboard: http://127.0.0.1:3000"
curl -sf http://127.0.0.1:3000/health/live >/dev/null
curl -sf http://127.0.0.1:8080/health/ready >/dev/null
curl -sf http://127.0.0.1:8080/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' >/dev/null
echo "2. Dashboard shows merchant details, commerce strategies, and the AtlasLab evaluation framework"
echo "3. Optional AI buyer journey: POST /lab/v1/agent-compatibility-eval with MODEL_ID"
echo "4. Deterministic offer decision: POST /lab/v1/deterministic-eval"
if [[ -n "${ATLASLAB_API_TOKEN:-}" ]]; then
  curl -sf -X POST http://127.0.0.1:8090/lab/v1/deterministic-eval \
    -H "authorization: Bearer ${ATLASLAB_API_TOKEN}" -H "content-type: application/json" >/tmp/atlas-demo-contract.json || \
    echo "deterministic eval skipped (lab not ready)"
fi
echo "5. Provider-backed commercial pair (explicit operator boundary):"
echo "   ATLASLAB_PROVIDER_ASSISTED_PAYMENTS=1 MODEL_ID=<approved-model> node scripts/provider-commercial-proof.mjs"
echo "   Open the printed local checkout URL once per arm. Checkout.js success is not payment truth."
echo
echo "Atlas demonstrates controlled Test Mode commercial evidence and payment reconciliation."
echo "It does not claim real-world causal revenue uplift."
