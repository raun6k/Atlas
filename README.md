# Atlas

AI buyer → public MCP → deterministic merchant engine → signed checkout authority → Razorpay Test Mode → provider-backed reconciliation → confirmed merchant order → evidence-linked merchant dashboard.

Atlas is a Track 1 commerce system for one reference merchant (QuickMart). Core owns merchant and payment state. The public surface is MCP. Money movement is Razorpay Test Mode only.

**Atlas demonstrates controlled Test Mode commercial evidence and payment reconciliation. It does not claim real-world causal revenue uplift.**

## Track 1 fit

- One merchant, not a generic onboarding product.
- Public MCP commerce contract (`atlas.merchant.v1`).
- Deterministic Core; Host signs mutations.
- Test Mode capture reconciled from provider evidence, not browser success.
- AtlasLab measures controlled agent behavior.

## Architecture and trust domains

| Domain | What it owns |
| --- | --- |
| Host | Buyer agent identity, signed mutation proofs |
| Gateway | Public MCP HTTP, webhooks, admin BFF |
| Core | Catalog, cart, offers, holds, orders, payment fabric |
| Payment runner | Private Test Mode checkout executor (not payment truth) |
| Razorpay Test Mode | Simulated capture |
| AtlasLab | Contract, compatibility, and commercial eval |
| Console | Merchant evidence presentation |

Research / future (not the public story): substitutions, refunds-as-settlement, unused strategies, custom exploratory missions.

## Public MCP tools and schemas

Tools: `get_capabilities`, `create_session`, `set_intent`, `search_catalog`, `get_product`, `get_cart`, `add_cart_item`, `update_cart_item`, `remove_cart_item`, `apply_offer`, `prepare_checkout`, `complete_checkout`, `get_order`.

JSON schemas live in `schemas/mcp/`. `get_session`, profile, and substitution tools are not on public MCP.

## Payment flow

1. `prepare_checkout` creates a hold and checkout proposal.
2. `complete_checkout` consumes checkout authority and creates a pending order plus payment attempt.
3. The private runner may open Razorpay Test Mode checkout. A success screen is **not** capture.
4. Authenticated webhook and/or callback binding plus provider fetch can move the attempt to `CAPTURED_RECONCILED`.
5. Only then may the merchant order confirm.

Settlement is not implemented. Do not claim merchant settlement.

## Test Mode setup

Copy `.env` keys (never commit secrets):

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (Test Mode keys only)
- `RAZORPAY_WEBHOOK_SECRET`
- `ATLAS_ADMIN_SERVICE_TOKEN`, `ATLASLAB_API_TOKEN`
- `ATLAS_FRONTEND_OPERATOR_SESSION_SECRET`
- `ATLAS_SEED_OPERATOR_MERCHANT_EMAIL` / `ATLAS_SEED_OPERATOR_MERCHANT_PASSWORD`

```bash
docker compose up --build
```

## Webhook setup

Point Razorpay Test Mode webhooks at:

`POST {ATLAS_PUBLIC_ORIGIN}/providers/razorpay/webhooks`

Core verifies the signature. Duplicate events are ignored. Capture is not confirmed from the webhook body alone.

## Runner setup

The payment runner is a private executor (`apps/payment-runner`). Set `ATLAS_RUNNER_EXECUTOR_CREDENTIAL`. It reports observations; Core still requires provider evidence.

## Fixture reset

```bash
curl -X POST http://127.0.0.1:8080/test/v1/fixtures/reset \
  -H "authorization: Bearer $ATLAS_TEST_FIXTURE_BEARER" \
  -H "content-type: application/json" \
  -d '{"fixture_snapshot_id":"fix_quickmart_v1"}'
```

## AtlasLab run types

| Endpoint | Evidence eligibility |
| --- | --- |
| `POST /lab/v1/deterministic-eval` | Contract evidence only |
| `POST /lab/v1/agent-compatibility-eval` | Controlled agent behavior, not revenue |
| `POST /lab/v1/commercial-uplift-eval` | Test Mode RPAS; not real-world causal uplift |
| `POST /lab/v1/runs` custom/deterministic | Exploratory or contract; cannot enter the commercial denominator |

## Evidence eligibility

Missing evidence is never presented as zero. States: confirmed, measured, partial, unavailable, ineligible, unresolved, simulated, Test Mode only.

Examples:

- Revenue uplift unavailable — 0 eligible confirmed-order pairs.
- Payment captured at provider; webhook binding pending.
- Agent run completed, but this run is excluded from the benchmark denominator.

## Dashboard routes

| Route | Screen |
| --- | --- |
| `/` | Home — attention, readiness, latest confirmed order, latest evidence |
| `/sellability` | Public MCP, schema, buyer journey |
| `/growth` | Control/treatment, Test Mode revenue, exclusions |
| `/commerce` | Sessions, carts, offers, orders |
| `/merchant` | Profile, locations, catalog, inventory, strategies |
| `/trust` | Payment assurance, unresolved money, audit |
| `/system` | Readiness, workers, runner, AtlasLab, provider |
| `/demo` | Scripted five-minute demo |
| `/login` | Operator session |

## Exact demo commands

From a clean Compose start:

```bash
docker compose up --build
./scripts/demo.sh
```

Then open http://127.0.0.1:3000/demo and sign in with the seed merchant operator.

Release proof:

```bash
make release-verify
```

`make release-verify` is strict by default. It requires a clean worktree, a
ready Gateway, AtlasLab live-eval readiness, correct MCP protected-tool
authentication ordering, a ready frontend, and a fresh
`artifacts/provider-commercial-proof.json` generated at the current `HEAD`.
The commercial artifact must contain a provider-backed Razorpay Test Mode
confirmed-order pair for both CONTROL and TREATMENT; deterministic, mock, or
payment-fabric output is not provider proof. The default proof freshness window
is 24 hours.

The gates can be run separately when they support a narrower claim:

```bash
make release-verify-static       # repository/documentation checks only
make release-verify-runtime      # live readiness and MCP auth-order checks
make release-verify-commercial   # provider artifact checks only
```

Static-only CI may set `ATLAS_RELEASE_STATIC_ONLY=1` when invoking
`node scripts/release-verify.mjs`, or use `make release-verify-static`. This
does not constitute runtime or commercial release evidence. Runtime checks use
`ATLAS_GATEWAY_URL`, `ATLASLAB_API_URL`, `ATLAS_FRONTEND_URL`, and require
`ATLAS_MCP_HOST_TOKEN` (or `ATLASLAB_HOST_BEARER`). Operators may adjust proof
freshness with `ATLAS_RELEASE_PROOF_MAX_AGE_SECONDS`. Local verification of an
intentionally dirty worktree requires `ATLAS_RELEASE_ALLOW_DIRTY=1`; final
release verification should not set it.

## Known limitations

- One reference merchant; not arbitrary onboarding.
- Razorpay Test Mode only; not production payment safety.
- No settlement claim. Settlement is not implemented.
- No real-world uplift claim from Test Mode.
- External agents beyond the AtlasLab Host are not broadly certified.
- Substitutions and refunds are future/research surfaces.

## Defensible claims

- One reference merchant is exposed through a public MCP commerce contract.
- The deterministic Core owns merchant and payment state.
- Razorpay Test Mode payment capture can be reconciled through provider evidence.
- AtlasLab can measure controlled agent behavior.
- The commercial engine is designed for bounded, merchant-controlled offers.
- Real revenue uplift remains an empirical goal until confirmed-order paired evidence exists.
