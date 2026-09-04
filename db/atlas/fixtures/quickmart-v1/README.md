# Quickmart v1 reference fixture

Synthetic, near-realistic **quick commerce** merchant data for Atlas Test Mode.

| Field | Value |
|---|---|
| Snapshot ID | `fix_quickmart_v1` |
| Merchant | Quickmart |
| Currency | INR |
| City | Bengaluru |
| Dark stores | Koramangala (reference), Indiranagar, HSR Layout |

This pack is the executable catalog for tests, AtlasLab fixture reset, and the operator demo. Prose examples in docs must not invent different SKU prices.

## Public disclaimer

- Quickmart is a **fictional** merchant created for this project.
- Catalog brand names (Amul, Britannia, Coca-Cola, Maggi, and others) appear only as a realistic Indian grocery assortment. **Quickmart and Atlas are not affiliated with, endorsed by, or sponsored by those brand owners.**
- Barcodes use an in-house `99` prefix. They are not allocated GTINs.
- Addresses are neighbourhood-level and are not a real store lease.
- Contact and policy URLs use the reserved `quickmart.example` domain.
- Economics fields (`cogs_minor`, `variable_cost_minor`, `supplier_funding_minor`, `contribution_margin_minor`) are **merchant-private**. They must never appear on Buyer Agent MCP responses.
- Money is integer paise plus `INR`. Payments remain Razorpay **Test Mode** / simulated.

## What is in the pack

| File | Contents |
|---|---|
| `manifest.json` | Snapshot ID, file list, counts, `content_digest`, reset recipe |
| `merchant.json` | Singleton merchant profile |
| `locations.json` | Three dark stores, fees, MOV ₹99, free delivery at ₹199, 10–22 minute ETA |
| `products.json` | Canonical product families |
| `skus.json` | Sellable variants |
| `prices.json` | Location-level tax-inclusive prices and private economics |
| `inventory.json` | On-hand, safety buffer, sellable quantity; HSR has intentional lows and a not-assorted 2 L Coke |
| `promotions.json` | Buy-3 Coca-Cola 750 ml; buy-3 Maggi 70 g |
| `bundles.json` | Nachos+salsa, chai+biscuits, breakfast (eggs/bread/bananas) |
| `relationships.json` | `SAME_FAMILY`, `UPGRADE`, `SUBSTITUTE`, `CONSUMED_WITH`, `COMPLEMENT`, `BUNDLE_COMPATIBLE` |
| `strategies.json` | All six Commercial Engine strategies enabled at revision `ce_qm_v1` |
| `reference_carts.json` | Eggs + bread + bananas under ₹180 at Koramangala (₹167 all-in) |

Koramangala is the reference location for default AtlasLab scenarios.

## Reset recipe

```text
POST /test/v1/fixtures/reset
  { "fixture_snapshot_id": "fix_quickmart_v1" }

GET /test/v1/fixtures/current
  -> fixture_snapshot_id and content_digest must match manifest.json
```

Paired control/treatment runs are ineligible if the digest differs.

Regenerate JSON (does not change product meaning unless you edit `_generate.py`):

```text
python3 db/atlas/fixtures/quickmart-v1/_generate.py
```

## Reference breakfast cart (Koramangala)

| SKU | Price |
|---|---|
| White Eggs 6 pcs | ₹54.00 |
| Britannia White Bread 400 g | ₹42.00 |
| Robusta Banana 500 g | ₹36.00 |
| Merchandise | ₹132.00 |
| Delivery (below ₹199 threshold) | ₹35.00 |
| All-in total | ₹167.00 |

Planning budget ₹180. No threshold Offer should suggest adding enough goods to violate that budget.
