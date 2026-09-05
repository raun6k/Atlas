# QuickMart merchant seed (`fix_quickmart_v1`)

Authoring pack loaded by Atlas Test Mode (`POST /test/v1/fixtures/reset`). Money is integer paise (`*_minor`): `4400` is ₹44.00. JSON cells inside CSVs must be quoted. Do not seed derived fields (`sellable_quantity`, `stock_status`, `tax_amount_minor`, `contribution_margin_minor`, bundle `standalone_total_minor`).

There is no default store. `create_session` must supply a matching `delivery_serviceability_reference` (or `requested_location_id`) before `search_catalog` / `get_product`. Fees, handling, and static ETA live on `merchant.json` and are copied onto every location. Fulfillment is always delivery.

## Current pack

| Surface | Count / value |
|---|---|
| Merchant | `quickmart_in` / QuickMart. INR, `en-IN`, `Asia/Kolkata`, tax-inclusive prices. Delivery ₹35, MOV ₹99, free delivery from ₹199, handling ₹0, ETA 10 minutes. |
| Locations | 3 dark stores, daily `06:00`–`23:30`: Koramangala (`blr_koramangala_5th_block`), Bellandur (`blr_bellandur`), Indiranagar (`blr_indiranagar`). |
| Service areas | 1 pincode list per store. |
| Catalog | 250 products, 350 SKUs, 720 location×SKU offers (Koramangala 300, Bellandur 210, Indiranagar 210). |
| Graph | 500 product-level edges. |
| Promotions | 21 automatic promotions, including 3 brand-funded campaigns, Sep–Oct 2026. |
| Bundles | 20 Koramangala bundles. |
| Strategies | All six Commercial Engine types enabled. |
| Reference carts | Synthetic carts for evaluation — not loaded into Postgres. |

Categories: snacks, beverages, fresh produce, meat and seafood, household, personal care, pantry, pet care, baby care.

## Files

| File | Loaded? | Role |
|---|---|---|
| `merchant.json` | yes | Merchant identity, locale, tax, support, merchant-wide fees and ETA |
| `locations.csv` | yes | Dark stores |
| `service_areas.json` | yes | Delivery pincode zones |
| `products.csv` | yes | Product families |
| `skus.csv` | yes | Sellable variants |
| `location_sku_offers.csv` | yes | Price, assortment, and starting stock per location×SKU |
| `relationships.csv` | yes | Commercial graph edges |
| `promotions.json` | yes | Promotions (`condition` + `benefit`) |
| `bundles.json` | yes | Bundles |
| `strategies.json` | yes | Commercial Engine strategies |
| `agent_capabilities.json` | yes | Agent-facing capability flags |
| `buyers.csv` | no | Supplemental buyer-to-location history |
| `campaigns.json` | no | Supplemental campaign roll-up for brand-funded promotions |
| `routines.json` | no | Supplemental recurring-basket history |
| `orders.csv` | no | Supplemental completed-order history |
| `order_lines.csv` | no | Supplemental historical order contents and line totals |
| `search_events.csv` | no | Supplemental search-to-cart behavior events |
| `manifest.json` | digest only | Snapshot metadata and per-file SHA-256 |
| `tests/reference_carts.json` | no | Test carts only |

---

### `merchant.json`

Singleton merchant profile. Policy URLs, logo, phone, and `disclosures` are optional (nullable / default `[]`); this pack leaves them unset.

| Field | Type | Meaning |
|---|---|---|
| `merchant_id` | string | Stable merchant id |
| `display_name` | string | Buyer-facing name |
| `legal_name` | string | Legal entity name |
| `description` | string | Public description |
| `default_currency` | string | ISO-4217, must be `INR` |
| `default_locale` | string | BCP-47 locale |
| `country_code` | string | ISO country |
| `default_timezone` | string | IANA timezone |
| `prices_include_tax` | bool | Selling prices include tax |
| `website_url` | string | Public site |
| `support_email` | string | Support inbox |
| `base_delivery_fee_minor` | int | Delivery fee in paise, applied to every location |
| `minimum_order_value_minor` | int | MOV in paise |
| `free_delivery_threshold_minor` | int \| null | All-in merchandise at which delivery becomes free |
| `base_handling_fee_minor` | int | Handling fee in paise |
| `eta_min_minutes` | int | Static lower-bound ETA (max is set to the same value on load) |

Optional loader fields not present in this pack: `logo_url`, `terms_url`, `privacy_url`, `return_policy_url`, `cancellation_policy_url`, `substitution_policy_url`, `support_phone`, `disclosures`.

```json
{
  "merchant_id": "quickmart_in",
  "display_name": "QuickMart",
  "legal_name": "QuickMart Commerce Private Limited",
  "description": "QuickMart is a Bengaluru-based quick commerce company offering fast, on-demand delivery of groceries, fresh produce, household essentials, personal care products, snacks, beverages, and other everyday items.",
  "default_currency": "INR",
  "default_locale": "en-IN",
  "country_code": "IN",
  "default_timezone": "Asia/Kolkata",
  "prices_include_tax": true,
  "website_url": "https://quickmart.example",
  "support_email": "support@quickmart.example",
  "base_delivery_fee_minor": 3500,
  "minimum_order_value_minor": 9900,
  "free_delivery_threshold_minor": 19900,
  "base_handling_fee_minor": 0,
  "eta_min_minutes": 10
}
```

---

### `locations.csv`

One row per dark store. Status: `active`, `paused`, `inactive`, `closed`. Hours apply every day as `HH:MM`. If `serviceability_reference` is blank, the loader uses `location_id`.

| Field | Type | Meaning |
|---|---|---|
| `location_id` | string | Primary key, e.g. `loc_qm_koramangala` |
| `name` | string | Store display name |
| `neighbourhood` | string | Neighbourhood label |
| `city` | string | City |
| `region_code` | string | State / region (`KA`) |
| `country_code` | string | Country (`IN`) |
| `display_address` | string | Public address (quote if it contains commas) |
| `status` | string | `active` / `paused` / `inactive` / `closed` |
| `timezone` | string | Store timezone |
| `hours_open` | string | Daily open `HH:MM` |
| `hours_close` | string | Daily close `HH:MM` |
| `serviceability_reference` | string | Opaque Host delivery ref used in `create_session` |

```csv
location_id,name,neighbourhood,city,region_code,country_code,display_address,status,timezone,hours_open,hours_close,serviceability_reference
loc_qm_koramangala,QuickMart Koramangala Dark Store,Koramangala 5th Block,Bengaluru,KA,IN,"5th Block, Koramangala, Bengaluru 560095",active,Asia/Kolkata,06:00,23:30,blr_koramangala_5th_block
```

---

### `service_areas.json`

Array of delivery zones. Each zone belongs to one location. Status: `active`, `paused`, `inactive`. Loader skips objects with a blank `service_area_id` or `location_id`. Optional unused fields: `geometry`, `priority`, fee/ETA overrides.

| Field | Type | Meaning |
|---|---|---|
| `service_area_id` | string | Primary key |
| `location_id` | string | Parent store |
| `name` | string | Zone name |
| `status` | string | `active` / `paused` / `inactive` |
| `postal_codes` | string[] | Served pincodes |

```json
{
  "service_area_id": "sa_qm_koramangala",
  "location_id": "loc_qm_koramangala",
  "name": "Koramangala Service Area",
  "status": "active",
  "postal_codes": ["560095", "560034", "560047", "560029", "560030"]
}
```

---

### `products.csv`

One row per product family. Lifecycle: `active`, `inactive`, `archived`. JSON columns are quoted CSV strings.

| Field | Type | Meaning |
|---|---|---|
| `product_id` | string | Primary key (`prd_qm_…`) |
| `name` | string | Product name |
| `brand` | string | Brand |
| `brand_id` | string | Stable brand key (`brand_qm_…`) |
| `category` | string | Category slug |
| `category_id` | string | Stable category key (`cat_qm_…`) |
| `subcategory` | string | Subcategory slug |
| `subcategory_id` | string | Stable subcategory key (`subcat_qm_…`) |
| `description` | string | Canonical description |
| `dietary_tags_json` | JSON array | e.g. `["vegetarian"]` |
| `allergen_tags_json` | JSON array | e.g. `["wheat","gluten","milk"]` |
| `ingredients_text` | string | Ingredients |
| `aliases_json` | JSON array | Search aliases |
| `country_of_origin_code` | string | Origin country |
| `attributes_json` | JSON object | Extra attributes (`storage`, `pack_size`) |
| `lifecycle` | string | `active` / `inactive` / `archived` |
| `rating` | number | Average score |
| `reviews` | int | Review count |
| `nutrition_per_100g_json` | JSON object | Per 100 g: `energy` (kcal), `protein`, `total_sugar`, `added_sugar`, `total_fat` (grams) |

```csv
product_id,name,brand,brand_id,category,category_id,subcategory,subcategory_id,description,dietary_tags_json,allergen_tags_json,ingredients_text,aliases_json,country_of_origin_code,attributes_json,lifecycle,rating,reviews,nutrition_per_100g_json
"prd_qm_crispkettle_tea_biscuits_plain","Tea Biscuits Plain","CrispKettle","brand_qm_crispkettle","snacks","cat_qm_snacks","biscuits_chips_namkeen","subcat_qm_biscuits_chips_namkeen","Crunchy ready-to-eat snack for tea breaks, travel, sharing and quick hunger occasions.","[""vegetarian""]","[""wheat"",""gluten"",""milk"",""peanuts""]","Cereals, pulses or potatoes, edible vegetable oil, spices, sugar and salt","[""tea biscuits plain"",""biscuits"",""crispkettle tea biscuits plain""]","IN","{""storage"":""ambient"",""pack_size"":""100 g""}","active","4.4","488","{""energy"":500,""protein"":8,""total_sugar"":10,""added_sugar"":7,""total_fat"":25}"
```

---

### `skus.csv`

One or more sellable variants per product. Lifecycle: `active`, `hidden`, `discontinued`, `sellable`. Storage: `ambient`, `ambient_cool`, `chilled`, `frozen`. Quote `product_id` as a complete field (`prd_…` or `"prd_…"`), never with a dangling closing quote.

| Field | Type | Meaning |
|---|---|---|
| `sku_id` | string | Primary key (`QM-SNK-0001-A`) |
| `product_id` | string | Parent product |
| `name` | string | SKU display name |
| `variant_label` | string | Variant (`standard pack`, `family pack`) |
| `net_quantity` | int | Pack net quantity (becomes `pack_size`) |
| `net_unit` | string | Unit of measure (`g`, `ml`, `pcs`) |
| `pack_count` | int | Inner pack count |
| `gtin` | string | Barcode / GTIN |
| `lifecycle` | string | `active` / `hidden` / `discontinued` / `sellable` |
| `storage_class` | string | `ambient` / `ambient_cool` / `chilled` / `frozen` |
| `perishable` | bool | Perishable flag |
| `shelf_life_days` | int | Shelf life |
| `max_order_quantity` | int | Max units per order |
| `hsn_code` | string | HSN |
| `attributes_json` | JSON object | Variant metadata |

```csv
sku_id,product_id,name,variant_label,net_quantity,net_unit,pack_count,gtin,lifecycle,storage_class,perishable,shelf_life_days,max_order_quantity,hsn_code,attributes_json
QM-SNK-0001-A,prd_qm_crispkettle_tea_biscuits_plain,Tea Biscuits Plain - standard pack,standard pack,100,g,1,8900000000000,active,ambient,false,540,12,1905,"{""source_product_id"":""prd_qm_crispkettle_tea_biscuits_plain"",""variant_type"":""standard"",""display_pack_size"":""100 g"",""storage"":""ambient""}"
```

---

### `location_sku_offers.csv`

Price and starting inventory for one SKU at one store. Assortment + stock determine derived `stock_status` on load (`in_stock`, `out`, `not_assorted`). Tax amount and contribution margin are also derived.

| Field | Type | Meaning |
|---|---|---|
| `location_id` | string | Store |
| `sku_id` | string | SKU |
| `assorted` | bool | Carried at this store |
| `mrp_minor` | int | List / MRP (paise) |
| `selling_price_minor` | int | Selling price (paise) |
| `unit_cogs_minor` | int | Unit COGS (paise) |
| `unit_variable_cost_minor` | int | Unit variable cost (paise) |
| `on_hand_quantity` | int | On-hand units |
| `safety_buffer` | int | Reserved buffer; sellable = on-hand − buffer |

```csv
location_id,sku_id,assorted,mrp_minor,selling_price_minor,unit_cogs_minor,unit_variable_cost_minor,on_hand_quantity,safety_buffer
"loc_qm_koramangala","QM-SNK-0001-A","true","4800","4400","2882","440","9","8"
```

That row is MRP ₹48.00, selling ₹44.00, 9 on hand with safety 8 (1 sellable).

---

### `relationships.csv`

Directed commercial graph. Types: `SAME_FAMILY`, `SUBSTITUTE`, `UPGRADE`, `DOWNGRADE`, `COMPLEMENT`, `CONSUMED_WITH`, `USED_WITH`, `BUNDLE_COMPATIBLE`. Ids may be products (`prd_…`) or SKUs. `confidence_bps` is 0–10000 (7600 = 0.760).

| Field | Type | Meaning |
|---|---|---|
| `source_id` | string | From product or SKU |
| `target_id` | string | To product or SKU |
| `relationship_type` | string | Edge type |
| `confidence_bps` | int | Confidence in basis points |
| `priority` | int | Rank among edges of this source |
| `reason_text` | string | Why the edge exists |

```csv
source_id,target_id,relationship_type,confidence_bps,priority,reason_text
"prd_qm_crispkettle_tea_biscuits_plain","prd_qm_munchmitra_butter_shortbread_bites","SAME_FAMILY","7600","5","A similar snacks choice can be suggested when the shopper is browsing this item."
"prd_qm_crispkettle_tea_biscuits_plain","prd_qm_fizzyleaf_sparkling_cola_drink","COMPLEMENT","8400","10","This complements tea biscuits plain in a practical basket for the same shopping occasion."
```

---

### `promotions.json`

Array of promotions. Loader skips a blank `promotion_id`. Times are RFC 3339.

| Field | Type | Meaning |
|---|---|---|
| `promotion_id` | string | Primary key |
| `promotion_type` | string | e.g. `CATEGORY_BASKET`, `MULTI_BUY` |
| `name` | string | Display name |
| `description` | string | Buyer/internal copy |
| `campaign_id` | string \| null | Stable campaign key for campaign-backed promotions |
| `brand` | string \| null | Brand display name for a brand-funded promotion |
| `brand_id` | string \| null | Stable brand key used for ID-based campaign matching |
| `application_mode` | string | `automatic` (or a code-gated mode) |
| `code` | string \| null | Promo code, if any |
| `condition.minimum_quantity` | int | Min qualifying units |
| `condition.minimum_cart_value_minor` | int | Min cart value (paise) |
| `benefit.type` | string | `fixed_amount` or `percentage` |
| `benefit.discount_rate` | number \| null | Percentage points for percentage benefits (`10` means 10%) |
| `benefit.discount_amount_minor` | int \| null | Fixed discount fallback (paise) |
| `benefit.discount_cap_minor` | int \| null | Maximum discount for a percentage benefit (paise) |
| `stacking_group` | string | Mutual-exclusion group |
| `stacking_priority` | int | Higher wins inside the group |
| `funding.merchant_funded_minor` | int \| null | Legacy rupee split for fixed promotions |
| `funding.supplier_funded_minor` | int \| null | Supplier-funded portion |
| `funding.brand_funding_pct` | number \| null | Brand share of the discount |
| `funding.merchant_funding_pct` | number \| null | Merchant share of the discount |
| `campaign_budget_minor` | int \| null | Campaign budget (paise) |
| `budget_consumed_minor` | int \| null | Consumed campaign budget to date (paise) |
| `eligible_sku_ids` | string[] | Qualifying SKUs |
| `location_ids` | string[] | Stores where it applies |
| `starts_at` / `ends_at` | string | Inclusive window |
| `enabled` | bool | On/off |

```json
{
  "promotion_id": "promo_qm_snk_basket_01",
  "promotion_type": "CATEGORY_BASKET",
  "name": "snack basket savings",
  "description": "Automatic saving when the cart includes qualifying snack items.",
  "application_mode": "automatic",
  "code": null,
  "condition": { "minimum_quantity": 2, "minimum_cart_value_minor": 0 },
  "benefit": { "type": "fixed_amount", "discount_amount_minor": 6000 },
  "stacking_group": "category_basket",
  "stacking_priority": 10,
  "funding": { "merchant_funded_minor": 6000, "supplier_funded_minor": 0 },
  "eligible_sku_ids": ["QM-SNK-0001-A", "QM-SNK-0001-B", "QM-SNK-0002-A", "QM-SNK-0002-B", "QM-SNK-0003-A", "QM-SNK-0003-B"],
  "location_ids": ["loc_qm_koramangala", "loc_qm_bellandur", "loc_qm_indiranagar"],
  "starts_at": "2026-09-01T00:00:00+05:30",
  "ends_at": "2026-10-31T23:59:59+05:30",
  "enabled": true
}
```

Brand-funded campaigns use stable IDs in addition to display names. The fixture keeps `discount_amount_minor` as a compatibility fallback for the current fixed-amount pricing path while recording the percentage terms and cap from the campaign specification.

```json
{
  "promotion_id": "promo_qm_brand_crispkettle_01",
  "promotion_type": "BRAND_CAMPAIGN",
  "name": "CrispKettle brand days",
  "campaign_id": "camp_qm_crispkettle_brand_days_2026",
  "brand": "CrispKettle",
  "brand_id": "brand_qm_crispkettle",
  "benefit": {
    "type": "percentage",
    "discount_rate": 10,
    "discount_amount_minor": 600,
    "discount_cap_minor": 1000
  },
  "funding": {
    "brand_funding_pct": 70,
    "merchant_funding_pct": 30
  },
  "campaign_budget_minor": 200000,
  "budget_consumed_minor": 0
}
```

---

### `bundles.json`

Array of bundles. Loader skips a blank `bundle_id`. `amount_off_minor` is the bundle discount; standalone/bundle totals are derived later.

| Field | Type | Meaning |
|---|---|---|
| `bundle_id` | string | Primary key |
| `name` | string | Display name |
| `description` | string | Copy |
| `enabled` | bool | On/off |
| `location_ids` | string[] | Stores that offer the bundle |
| `amount_off_minor` | int | Discount vs standalone (paise) |
| `items[].sku_id` | string | Constituent SKU |
| `items[].quantity` | int | Required quantity |

```json
{
  "bundle_id": "bundle_qm_001",
  "name": "breakfast starter bundle",
  "description": "A practical breakfast starter combination for a quick-commerce basket.",
  "enabled": true,
  "location_ids": ["loc_qm_koramangala"],
  "amount_off_minor": 2500,
  "items": [
    { "sku_id": "QM-BEV-0031-A", "quantity": 2 },
    { "sku_id": "QM-PAN-0195-A", "quantity": 1 },
    { "sku_id": "QM-SNK-0006-A", "quantity": 1 }
  ]
}
```

---

### `strategies.json`

Commercial Engine types (the previous THRESHOLD / PROMOTION / BUNDLE / CROSS_SELL / COMPLEMENT / UPSELL set was replaced by these 12):

`REORDER`, `REPLENISHMENT`, `PAST_PURCHASE`, `CART_COMPLETION`, `BASKET_REC`, `FBT`, `SEARCH_RANKING`, `ROUTINE`, `LARGER_PACK`, `FREE_DELIVERY`, `SMALL_ORDER`, `BRAND_PROMO`.

Each row can be enabled or disabled independently. Edit **`buyer`** to change what the Buyer Agent reads (`headline` → offer terms, `reason` → grounded reason). Placeholders are `{{sku_name}}`, `{{quantity}}`, `{{price}}`, `{{gap}}`, and other strategy-specific keys. `config` is scoring knobs. `surfaces` lists buyer-agent tools that may calculate and attach offers (or rerank search for `PAST_PURCHASE` and `SEARCH_RANKING`).

| Field | Type | Meaning |
|---|---|---|
| `strategy_type` | string | Strategy type (primary key) |
| `enabled` | bool | Global on/off |
| `revision` | string | Config revision label |
| `priority` | int | Higher runs first |
| `objective_metric` | string | What the strategy optimizes |
| `surfaces` | string[] | Buyer tools that may show this strategy |
| `buyer` | object | Copy shown to the Buyer Agent (`headline`, `reason`, `terms`) |
| `config` | object | Type-specific scoring knobs |

```json
{
  "strategy_type": "REORDER",
  "enabled": true,
  "revision": "qm-v1-reorder-2026-09",
  "priority": 95,
  "objective_metric": "repeat_purchase_rate",
  "surfaces": ["set_intent", "search_catalog", "get_cart", "add_cart_item"],
  "buyer": {
    "headline": "Buy again",
    "reason": "Add {{sku_name}} — you usually repurchase this about every {{median_days}} days.",
    "terms": "Buy again · qty {{quantity}}"
  },
  "config": { "min_score": 0.25, "lookback_days": 90 }
}
```

---

### `agent_capabilities.json`

Raw JSON stored on `merchant_profile.agent_capabilities`. Ignored if `merchant.json` is empty.

| Field | Type | Meaning |
|---|---|---|
| `checkout.enabled` | bool | Checkout tools available |
| `discounts.codes` | bool | Promo codes accepted |
| `substitutions.requires_buyer_permission` | bool | Substitutions need buyer consent |

```json
{
  "checkout": { "enabled": true },
  "discounts": { "codes": true },
  "substitutions": { "requires_buyer_permission": true }
}
```

---

### Supplemental buyer and merchandising history

The following files preserve a consistent synthetic history for analytics and campaign evaluation. They are deliberately not loaded by the current Core fixture reset. All monetary values use integer paise, and all IDs resolve against the catalog or promotion fixture above.

#### `buyers.csv`

| Field | Type | Meaning |
|---|---|---|
| `buyer_id` | string | Stable synthetic buyer key |
| `default_location_id` | string | Buyer’s normal delivery store |

The pack contains 12 buyers distributed across Koramangala, Bellandur, and Indiranagar.

#### `campaigns.json`

Each campaign rolls up one brand-funded promotion and repeats the key commercial terms needed by analytics consumers.

| Field | Type | Meaning |
|---|---|---|
| `campaign_id` | string | Stable campaign key |
| `brand_id` / `brand` | string | Brand identity and display name |
| `campaign_type` | string | `BRAND_FUNDED` |
| `status` | string | Campaign lifecycle status |
| `objective` | string | Campaign measurement objective |
| `target_category_id` | string | Catalog category targeted by the campaign |
| `promotion_ids` | string[] | Linked promotion IDs |
| `discount_rate` | number | Percentage points (`10` means 10%) |
| `discount_cap_minor` | int | Per-benefit cap in paise |
| `eligible_sku_count` | int | Number of eligible SKUs |
| `budget_minor` / `budget_consumed_minor` | int | Campaign budget and consumed amount in paise |
| `budget_remaining_minor` | int | `budget_minor - budget_consumed_minor` |
| `brand_funding_pct` / `merchant_funding_pct` | number | Funding split; must sum to 100 |
| `start_at` / `end_at` | string | RFC 3339 campaign window |

#### `routines.json`

| Field | Type | Meaning |
|---|---|---|
| `routine_id` | string | Stable recurring-basket key |
| `buyer_id` | string | Buyer who owns the routine |
| `name` | string | Buyer-friendly routine name |
| `cadence_days` | int | Expected repeat interval |
| `last_ordered_at` | string | RFC 3339 timestamp of the latest matching order |
| `items[].sku_id` | string | Catalog SKU in the routine |
| `items[].usual_quantity` | int | Typical quantity |

#### `orders.csv` and `order_lines.csv`

`orders.csv` contains 39 completed orders across all three locations. `order_lines.csv` contains 96 lines. `price_paid_minor` is the historical line total, not the unit price; it equals the location offer price multiplied by `quantity` for the corresponding SKU.

#### `search_events.csv`

Each search journey contains impressions, a click, and an `add_to_cart` event. The primary SKU added to cart has a later matching historical order for the same buyer, which makes the file useful for conversion-path checks without inventing unsupported event types.

| Field | Type | Meaning |
|---|---|---|
| `buyer_id` | string | Buyer performing the search |
| `search_query` | string | Search text |
| `sku_id` | string | Displayed or selected SKU |
| `event_type` | string | `impression`, `click`, or `add_to_cart` |
| `occurred_at` | string | RFC 3339 event timestamp |

---

### `manifest.json`

Snapshot metadata. File hashes must match current bytes. Test Mode content digest is computed from these listed files.

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | string | Pack schema (`2.0.0`) |
| `snapshot_id` | string | Must be `fix_quickmart_v1` |
| `created_for` | string | `atlas_fixture` |
| `currency_minor_unit` | int | 100 = paise |
| `files[].path` | string | File relative to this directory |
| `files[].sha256` | string | Hex digest of the file |

```json
{
  "schema_version": "2.0.0",
  "snapshot_id": "fix_quickmart_v1",
  "created_for": "atlas_fixture",
  "currency_minor_unit": 100,
  "files": [
    { "path": "merchant.json", "sha256": "a52adba2ef29bd92a71322760e5c14c2c39aa332d4fdc7147ee421b42c09fed9" }
  ]
}
```

---

### `tests/reference_carts.json`

Not loaded into Postgres. Do not seed line prices or cart totals; those come from offers and merchant fees.

| Field | Type | Meaning |
|---|---|---|
| `reference_cart_id` | string | Cart id |
| `name` | string | Label |
| `location_id` | string | Store |
| `service_area_id` | string \| null | Zone |
| `description` | string | Purpose |
| `planning_budget_minor` | int \| null | Mission budget (paise) |
| `lines[].sku_id` | string | SKU |
| `lines[].quantity` | int | Units |

```json
{
  "reference_cart_id": "rc_qm_breakfast_001",
  "name": "Breakfast top-up",
  "location_id": "loc_qm_koramangala",
  "service_area_id": "sa_qm_koramangala",
  "description": "Synthetic breakfast top-up cart for commercial-engine evaluation.",
  "planning_budget_minor": 18000,
  "lines": [
    { "sku_id": "QM-PAN-0189-A", "quantity": 1 },
    { "sku_id": "QM-BEV-0038-B", "quantity": 1 },
    { "sku_id": "QM-SNK-0013-A", "quantity": 1 }
  ]
}
```

## Reset

```text
POST /test/v1/fixtures/reset
  { "fixture_snapshot_id": "fix_quickmart_v1" }
```
