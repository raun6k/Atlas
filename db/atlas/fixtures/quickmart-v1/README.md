# QuickMart merchant seed (`fix_quickmart_v1`)

Authoring pack loaded by Atlas Test Mode (`POST /test/v1/fixtures/reset`). Money is integer paise (`*_minor`). JSON cells inside CSVs must be quoted. Do not seed derived fields (`sellable_quantity`, `stock_status`, `tax_amount_minor`, `contribution_margin_minor`, bundle `standalone_total_minor`).

## Current pack

Filled QuickMart catalog for Bengaluru quick commerce. Snapshot id remains `fix_quickmart_v1`.

| Surface | Current state |
|---|---|
| Merchant | `quickmart_in` / QuickMart. INR, `en-IN`, `Asia/Kolkata`, prices include tax. Delivery ₹35 (`3500`), MOV ₹99 (`9900`), free delivery from ₹199 (`19900`), handling `0`, static ETA 10 minutes. Support `support@quickmart.example`. Policy URLs, logo, phone, and disclosures are unset (nullable). |
| Locations | Three active dark stores, daily `06:00`–`23:30`: Koramangala (`loc_qm_koramangala`, delivery ref `blr_koramangala_5th_block`), Bellandur (`blr_bellandur`), Indiranagar (`blr_indiranagar`). Fees and ETA copy from the merchant row. |
| Service areas | One active pincode list per store (no geometry). |
| Catalog | 250 products, 350 SKUs, 720 location×SKU offers (Koramangala 300, Bellandur 210, Indiranagar 210). Every SKU is offered in at least one store. |
| Graph | 500 product-level edges (`SAME_FAMILY`, `COMPLEMENT`, and related types). |
| Promotions | 18 automatic category-basket / mix-and-match promotions, Sep–Oct 2026. |
| Bundles | 20 Koramangala bundles. |
| Strategies | All six Commercial Engine types enabled. |
| Agent capabilities | Checkout on, discount codes on, substitutions require buyer permission. |
| Reference carts | Template only — not loaded into Postgres. |

Categories in the catalog: snacks, beverages, fresh produce, meat and seafood, household, personal care, pantry, pet care, baby care.

## Files

| File | Role |
|---|---|
| `merchant.json` | Merchant identity, locale, tax flag, support, merchant-wide fees and ETA |
| `locations.csv` | Dark stores: identity, address, status, hours, optional `serviceability_reference` |
| `service_areas.json` | Delivery zones (pincodes) |
| `products.csv` | Product families, ratings, reviews, per-100g nutrition |
| `skus.csv` | Sellable variants |
| `location_sku_offers.csv` | Price + assortment + starting stock per location×SKU |
| `relationships.csv` | Commercial graph edges |
| `promotions.json` | Promotions (`condition` + `benefit`) |
| `bundles.json` | Bundles with items and location ids |
| `strategies.json` | Six Commercial Engine strategies |
| `agent_capabilities.json` | Agent-facing capability flags |
| `manifest.json` | Snapshot metadata and per-file SHA-256 |
| `tests/reference_carts.json` | Test carts only — not loaded into Postgres |

`tests/reference_carts.json` is `reference_cart_id`, `name`, `location_id`, optional `service_area_id`, `description`, `planning_budget_minor` (paise, or null), and `lines` (`sku_id`, `quantity`). Do not seed line prices or cart totals; those come from offers and merchant fees.

Fees, handling, and static ETA live on `merchant.json` and apply to every location. `locations.csv` is store identity, address, status, daily hours, and delivery serviceability. Fulfillment is always delivery. If `serviceability_reference` is blank, the loader uses `location_id`. There is no default or reference store: `create_session` must supply a matching `delivery_serviceability_reference` (or `requested_location_id`) before `search_catalog` / `get_product`.

## Location hours

`hours_open` / `hours_close` are `HH:MM` and apply every day. Example row:

```csv
loc_qm_koramangala,QuickMart Koramangala Dark Store,Koramangala 5th Block,Bengaluru,KA,IN,"5th Block, Koramangala, Bengaluru 560095",active,Asia/Kolkata,06:00,23:30,blr_koramangala_5th_block
```

JSON cells in other CSVs must be quoted (`dietary_tags_json`, `attributes_json`, `nutrition_per_100g_json`, and similar). Quote `product_id` in `skus.csv` as a complete CSV field (`prd_…` or `"prd_…"`), not with a dangling closing quote.

`products.csv` `nutrition_per_100g_json` is per 100 g: `energy` (kcal), `protein`, `total_sugar`, `added_sugar`, `total_fat` (grams). `rating` is the average score; `reviews` is the review count.

## Reset

```text
POST /test/v1/fixtures/reset
  { "fixture_snapshot_id": "fix_quickmart_v1" }
```
