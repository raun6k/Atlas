# Quickmart merchant seed (v2)

Authoring pack for Atlas Test Mode. Fill the files below; do not seed derived fields (`sellable_quantity`, `stock_status`, `tax_amount_minor`, `contribution_margin_minor`, bundle `standalone_total_minor`).

Money is integer paise (`*_minor`). JSON cells inside CSVs must be quoted.

| File | Role |
|---|---|
| `merchant.json` | Merchant identity, policies, disclosures |
| `locations.csv` | Dark stores / fulfillment locations |
| `service_areas.json` | Delivery zones (pincodes / geometry) |
| `products.csv` | Product families |
| `skus.csv` | Sellable variants |
| `location_sku_offers.csv` | Price + assortment + starting stock per location×SKU |
| `relationships.csv` | Commercial graph edges |
| `promotions.json` | Promotions (`condition` + `benefit`) |
| `bundles.json` | Bundles with items and location offers |
| `strategies.json` | Six Commercial Engine strategies (types pre-filled) |
| `agent_capabilities.json` | Agent-facing capability flags |
| `manifest.json` | Snapshot metadata and file hashes |
| `tests/reference_carts.json` | Test carts only — not loaded into Postgres |

JSON list files include one empty template object. Delete it or leave `*_id` blank; the loader skips blank ids.

## CSV JSON columns

Put one JSON value per cell, quoted:

- `operating_hours_json`: `{"mon":[["06:00","23:59"]],...}`
- `fulfillment_modes_json`: `["delivery"]`
- `dietary_tags_json` / `allergen_tags_json` / `aliases_json`: `["vegetarian"]`
- `media_json`: `[{"url":"/images/x.jpg","role":"primary","alt":""}]`
- `attributes_json` / `dimensions_json` / `metadata_json`: objects

## Reset

```text
POST /test/v1/fixtures/reset
  { "fixture_snapshot_id": "fix_quickmart_v1" }
```
