# Tracked commercial evidence

`artifacts/provider-commercial-proof.json` is gitignored because it contains
live Razorpay Test Mode order and payment identifiers.

A clean checkout cannot pass `make release-verify` until that artifact is
regenerated **after** the last fixture-reset suite:

```bash
set -a
. ./.env
set +a
PATH=/opt/homebrew/opt/node@24/bin:$PATH
ATLASLAB_PROVIDER_ASSISTED_PAYMENTS=1 MODEL_ID=<approved-model> \
  node scripts/provider-commercial-proof.mjs
PATH=/opt/homebrew/opt/node@24/bin:$PATH make release-verify
```

The proof is operator-assisted Razorpay Test Mode. Browser success is not
capture. Settlement is not implemented. The artifact must include
`fixture_digest`, `content_digest`, `run_id`, `report_id`, and Core session IDs
so release verification can cross-check the current Lab report and Core
evidence.

This directory keeps a sanitized schema only. Do not commit provider secrets
or raw webhook payloads.
