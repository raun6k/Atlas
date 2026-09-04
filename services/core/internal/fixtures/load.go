package fixtures

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func loadMerchantPack(ctx context.Context, tx pgx.Tx, dir string) error {
	if err := loadMerchant(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadLocations(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadServiceAreas(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadProducts(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadSKUs(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadOffers(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadRelationships(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadPromotions(ctx, tx, dir); err != nil {
		return err
	}
	if err := loadBundles(ctx, tx, dir); err != nil {
		return err
	}
	return loadStrategies(ctx, tx, dir)
}

func loadMerchant(ctx context.Context, tx pgx.Tx, dir string) error {
	var m struct {
		MerchantID                 string          `json:"merchant_id"`
		DisplayName                string          `json:"display_name"`
		LegalName                  string          `json:"legal_name"`
		Description                string          `json:"description"`
		DefaultCurrency            string          `json:"default_currency"`
		DefaultLocale              string          `json:"default_locale"`
		CountryCode                string          `json:"country_code"`
		DefaultTimezone            string          `json:"default_timezone"`
		PricesIncludeTax           bool            `json:"prices_include_tax"`
		WebsiteURL                 *string         `json:"website_url"`
		LogoURL                    *string         `json:"logo_url"`
		TermsURL                   string          `json:"terms_url"`
		PrivacyURL                 string          `json:"privacy_url"`
		ReturnPolicyURL            string          `json:"return_policy_url"`
		CancellationPolicyURL      string          `json:"cancellation_policy_url"`
		SubstitutionPolicyURL      *string         `json:"substitution_policy_url"`
		SupportEmail               string          `json:"support_email"`
		SupportPhone               *string         `json:"support_phone"`
		Disclosures                json.RawMessage `json:"disclosures"`
		BaseDeliveryFeeMinor       int64           `json:"base_delivery_fee_minor"`
		MinimumOrderValueMinor     int64           `json:"minimum_order_value_minor"`
		FreeDeliveryThresholdMinor *int64          `json:"free_delivery_threshold_minor"`
		BaseHandlingFeeMinor       int64           `json:"base_handling_fee_minor"`
		EtaMinMinutes              int             `json:"eta_min_minutes"`
	}
	if err := readJSON(filepath.Join(dir, "merchant.json"), &m); err != nil {
		return err
	}
	if strings.TrimSpace(m.DisplayName) == "" && strings.TrimSpace(m.MerchantID) == "" {
		return loadCapabilities(ctx, tx, dir, false)
	}
	currency := strings.ToUpper(strings.TrimSpace(m.DefaultCurrency))
	if len(currency) != 3 {
		currency = "INR"
	}
	locale := m.DefaultLocale
	if locale == "" {
		locale = "en-IN"
	}
	country := m.CountryCode
	if country == "" {
		country = "IN"
	}
	tz := m.DefaultTimezone
	if tz == "" {
		tz = "Asia/Kolkata"
	}
	disc := m.Disclosures
	if len(disc) == 0 {
		disc = []byte("[]")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO merchant_profile (
			singleton_key, merchant_id, display_name, legal_name, description, currency, locale, country,
			timezone_display, prices_include_tax, website_url, logo_url, terms_url, privacy_url,
			return_policy_url, cancellation_policy_url, substitution_policy_url, support_email, support_phone, disclosures,
			base_delivery_fee_minor, minimum_order_value_minor, free_delivery_threshold_minor, base_handling_fee_minor, eta_min_minutes)
		VALUES ('singleton',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
		nullIfEmpty(m.MerchantID), m.DisplayName, m.LegalName, m.Description, currency, locale, country, tz,
		m.PricesIncludeTax, m.WebsiteURL, m.LogoURL, nullIfEmpty(m.TermsURL), nullIfEmpty(m.PrivacyURL),
		nullIfEmpty(m.ReturnPolicyURL), nullIfEmpty(m.CancellationPolicyURL), m.SubstitutionPolicyURL,
		nullIfEmpty(m.SupportEmail), m.SupportPhone, disc,
		m.BaseDeliveryFeeMinor, m.MinimumOrderValueMinor, m.FreeDeliveryThresholdMinor, m.BaseHandlingFeeMinor, m.EtaMinMinutes); err != nil {
		return err
	}
	return loadCapabilities(ctx, tx, dir, true)
}

func loadCapabilities(ctx context.Context, tx pgx.Tx, dir string, profileExists bool) error {
	raw, err := os.ReadFile(filepath.Join(dir, "agent_capabilities.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !profileExists {
		return nil
	}
	_, err = tx.Exec(ctx, `UPDATE merchant_profile SET agent_capabilities=$1 WHERE singleton_key='singleton'`, raw)
	return err
}

func loadLocations(ctx context.Context, tx pgx.Tx, dir string) error {
	var delivery, mov, handling int64
	var etaMin int
	var free *int64
	_ = tx.QueryRow(ctx, `SELECT base_delivery_fee_minor, minimum_order_value_minor, free_delivery_threshold_minor, base_handling_fee_minor, eta_min_minutes
		FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&delivery, &mov, &free, &handling, &etaMin)
	rows, err := readCSV(filepath.Join(dir, "locations.csv"))
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := csvString(row, "location_id")
		if id == "" {
			continue
		}
		svc := csvString(row, "serviceability_reference")
		if svc == "" {
			svc = id
		}
		status := csvString(row, "status")
		if status == "" {
			status = "active"
		}
		open := csvString(row, "hours_open")
		closeAt := csvString(row, "hours_close")
		tz := csvString(row, "timezone")
		hours := map[string]any{}
		if open != "" || closeAt != "" {
			hours = map[string]any{"timezone": tz, "daily": map[string]string{"open": open, "close": closeAt}}
		}
		modes := []string{"delivery"}
		if _, err := tx.Exec(ctx, `INSERT INTO locations (
				location_id, name, neighbourhood, city, region, country, serviceability_reference, address_public,
				active, status, timezone, operating_hours, fulfillment_hours, fulfillment_modes,
				delivery_fee_minor, minimum_order_value_minor, free_delivery_threshold_minor,
				eta_min_minutes, eta_max_minutes, handling_fee_minor)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$17,$18)`,
			id, csvString(row, "name"), csvString(row, "neighbourhood"), csvString(row, "city"),
			csvString(row, "region_code"), csvString(row, "country_code"), svc, csvString(row, "display_address"),
			status == "active", status, tz, jsonBytes(hours), jsonBytes(modes),
			delivery, mov, free, etaMin, handling); err != nil {
			return err
		}
	}
	return nil
}

func loadServiceAreas(ctx context.Context, tx pgx.Tx, dir string) error {
	var areas []map[string]any
	if err := readJSON(filepath.Join(dir, "service_areas.json"), &areas); err != nil {
		return err
	}
	for _, a := range areas {
		id, _ := a["service_area_id"].(string)
		loc, _ := a["location_id"].(string)
		if strings.TrimSpace(id) == "" || strings.TrimSpace(loc) == "" {
			continue
		}
		status, _ := a["status"].(string)
		if status == "" {
			status = "active"
		}
		name, _ := a["name"].(string)
		if _, err := tx.Exec(ctx, `INSERT INTO service_areas (
				service_area_id, location_id, name, status, priority, postal_codes, geometry,
				delivery_fee_override_minor, minimum_order_value_override_minor, free_delivery_threshold_override_minor,
				eta_adjustment_min_minutes, eta_adjustment_max_minutes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			id, loc, name, status, asInt(a["priority"]), jsonBytes(a["postal_codes"]), a["geometry"],
			a["delivery_fee_override_minor"], a["minimum_order_value_override_minor"], a["free_delivery_threshold_override_minor"],
			asInt(a["eta_adjustment_min_minutes"]), asInt(a["eta_adjustment_max_minutes"])); err != nil {
			return err
		}
	}
	return nil
}

func loadProducts(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := readCSV(filepath.Join(dir, "products.csv"))
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := csvString(row, "product_id")
		if id == "" {
			continue
		}
		lifecycle := csvString(row, "lifecycle")
		if lifecycle == "" {
			lifecycle = "active"
		}
		diet := csvJSON(row, "dietary_tags_json", []any{})
		desc := csvString(row, "description")
		nutrition := csvJSON(row, "nutrition_per_100g_json", map[string]any{})
		rating := csvFloatPtr(row, "rating")
		reviews := csvIntPtr(row, "reviews")
		if _, err := tx.Exec(ctx, `INSERT INTO products (
				product_id, name, brand, category, subcategory, canonical_description, dietary, lifecycle,
				allergen_tags, ingredients_text, aliases, country_of_origin_code, attributes, rating, reviews,
				nutrition_per_100g, search_document)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, to_tsvector('simple', $2||' '||$3||' '||$6))`,
			id, csvString(row, "name"), csvString(row, "brand"), csvString(row, "category"), csvString(row, "subcategory"),
			desc, jsonBytes(diet), lifecycle,
			jsonBytes(csvJSON(row, "allergen_tags_json", []any{})),
			nullIfEmpty(csvString(row, "ingredients_text")), jsonBytes(csvJSON(row, "aliases_json", []any{})),
			nullIfEmpty(csvString(row, "country_of_origin_code")), jsonBytes(csvJSON(row, "attributes_json", map[string]any{})),
			rating, reviews, jsonBytes(nutrition)); err != nil {
			return err
		}
	}
	return nil
}

func loadSKUs(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := readCSV(filepath.Join(dir, "skus.csv"))
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := csvString(row, "sku_id")
		prd := csvString(row, "product_id")
		if id == "" || prd == "" {
			continue
		}
		lifecycle := csvString(row, "lifecycle")
		if lifecycle == "" {
			lifecycle = "active"
		}
		pack := csvInt(row, "net_quantity", 1)
		if pack <= 0 {
			pack = 1
		}
		uom := csvString(row, "net_unit")
		if uom == "" {
			uom = "pcs"
		}
		gtin := csvString(row, "gtin")
		var brand, parentDesc string
		_ = tx.QueryRow(ctx, `SELECT brand, canonical_description FROM products WHERE product_id=$1`, prd).Scan(&brand, &parentDesc)
		storage := csvString(row, "storage_class")
		var storageAny any
		if storage != "" {
			storageAny = storage
		}
		maxQty := csvIntPtr(row, "max_order_quantity")
		shelf := csvIntPtr(row, "shelf_life_days")
		if _, err := tx.Exec(ctx, `INSERT INTO skus (
				sku_id, product_id, name, brand, variant, pack_size, unit_of_measure, barcode, canonical_description,
				dietary, attributes, lifecycle, pack_count, gtin, storage_class,
				perishable, shelf_life_days, max_order_quantity, hsn_code, search_document)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
				to_tsvector('simple', $3||' '||$4||' '||$9))`,
			id, prd, csvString(row, "name"), brand, csvString(row, "variant_label"), pack, uom, nullIfEmpty(gtin), parentDesc,
			[]byte("[]"), jsonBytes(csvJSON(row, "attributes_json", map[string]any{})), lifecycle,
			csvInt(row, "pack_count", 1), nullIfEmpty(gtin), storageAny, csvBool(row, "perishable", false), shelf, maxQty,
			nullIfEmpty(csvString(row, "hsn_code"))); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE skus s SET dietary = p.dietary FROM products p WHERE s.product_id = p.product_id`)
	return err
}

func loadOffers(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := readCSV(filepath.Join(dir, "location_sku_offers.csv"))
	if err != nil {
		return err
	}
	var taxInclusive bool
	currency := "INR"
	_ = tx.QueryRow(ctx, `SELECT COALESCE(prices_include_tax, TRUE), COALESCE(NULLIF(currency, ''), 'INR') FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&taxInclusive, &currency)
	for _, row := range rows {
		loc := csvString(row, "location_id")
		sku := csvString(row, "sku_id")
		if loc == "" || sku == "" {
			continue
		}
		assorted := csvBool(row, "assorted", true)
		selling := csvInt(row, "selling_price_minor", 0)
		cogs := csvInt(row, "unit_cogs_minor", 0)
		variable := csvInt(row, "unit_variable_cost_minor", 0)
		var taxRate int64
		_ = tx.QueryRow(ctx, `SELECT tax_rate_bps FROM skus WHERE sku_id=$1`, sku).Scan(&taxRate)
		taxAmount := int64(0)
		if taxInclusive && taxRate > 0 && selling > 0 {
			taxAmount = selling * taxRate / (10000 + taxRate)
		}
		margin := selling - cogs - variable
		if _, err := tx.Exec(ctx, `INSERT INTO prices (
				location_id, sku_id, currency, list_price_minor, selling_price_minor, tax_inclusive, tax_rate_bps,
				tax_amount_minor, cogs_minor, variable_cost_minor, supplier_funding_minor, contribution_margin_minor,
				price_source)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,'fixture')`,
			loc, sku, currency, csvInt(row, "mrp_minor", 0), selling, taxInclusive, taxRate, taxAmount, cogs, variable, margin); err != nil {
			return err
		}
		onHand := int(csvInt(row, "on_hand_quantity", 0))
		safety := int(csvInt(row, "safety_buffer", 0))
		sellable := onHand - safety
		if sellable < 0 {
			sellable = 0
		}
		status := "in_stock"
		if !assorted {
			status = "not_assorted"
		} else if sellable == 0 {
			status = "out"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO inventory (
				location_id, sku_id, assorted, on_hand_quantity, reserved_quantity, safety_buffer, stock_status,
				stock_confidence, expiry_risk, low_stock_threshold)
			VALUES ($1,$2,$3,$4,0,$5,$6,'medium','low',0)`,
			loc, sku, assorted, onHand, safety, status); err != nil {
			return err
		}
	}
	return nil
}

func loadRelationships(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := readCSV(filepath.Join(dir, "relationships.csv"))
	if err != nil {
		return err
	}
	for _, row := range rows {
		src := csvString(row, "source_id")
		tgt := csvString(row, "target_id")
		rel := csvString(row, "relationship_type")
		if src == "" || tgt == "" || rel == "" {
			continue
		}
		bps := csvInt(row, "confidence_bps", 0)
		conf := float64(bps) / 10000.0
		if _, err := tx.Exec(ctx, `INSERT INTO product_relationships (
				source_id, target_id, relationship_type, confidence, source_entity_type, target_entity_type,
				confidence_bps, priority, reason_text)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT DO NOTHING`,
			src, tgt, rel, conf, entityTypeFromID(src), entityTypeFromID(tgt), bps,
			csvInt(row, "priority", 0), nullIfEmpty(csvString(row, "reason_text"))); err != nil {
			return err
		}
	}
	return nil
}

func loadPromotions(ctx context.Context, tx pgx.Tx, dir string) error {
	var promos []map[string]any
	if err := readJSON(filepath.Join(dir, "promotions.json"), &promos); err != nil {
		return err
	}
	for _, p := range promos {
		id, _ := p["promotion_id"].(string)
		if strings.TrimSpace(id) == "" {
			continue
		}
		cond, _ := p["condition"].(map[string]any)
		ben, _ := p["benefit"].(map[string]any)
		minQty := asInt(cond["minimum_quantity"])
		discount := asInt(ben["discount_amount_minor"])
		ptype, _ := p["promotion_type"].(string)
		name, _ := p["name"].(string)
		enabled, _ := p["enabled"].(bool)
		starts := parseJSONTime(p["starts_at"])
		ends := parseJSONTime(p["ends_at"])
		if _, err := tx.Exec(ctx, `INSERT INTO promotions (
				promotion_id, type, name, description, eligible_sku_ids, minimum_quantity,
				discount_amount_minor, stacking, stacking_group, stacking_priority, location_ids, supplier_funding_minor,
				starts_at, ends_at, enabled, application_mode, code, condition, benefit, funding)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,$18)`,
			id, ptype, name, strField(p, "description"), jsonBytes(p["eligible_sku_ids"]),
			minQty, discount, p["stacking_group"], asInt(p["stacking_priority"]), jsonBytes(p["location_ids"]),
			starts, ends, enabled, strField(p, "application_mode"), p["code"], jsonBytes(p["condition"]), jsonBytes(p["benefit"]),
			jsonBytes(p["funding"])); err != nil {
			return err
		}
	}
	return nil
}

func loadBundles(ctx context.Context, tx pgx.Tx, dir string) error {
	var bundles []map[string]any
	if err := readJSON(filepath.Join(dir, "bundles.json"), &bundles); err != nil {
		return err
	}
	for _, b := range bundles {
		id, _ := b["bundle_id"].(string)
		if strings.TrimSpace(id) == "" {
			continue
		}
		qty := map[string]int{}
		if items, ok := b["items"].([]any); ok {
			for _, it := range items {
				m, _ := it.(map[string]any)
				sku, _ := m["sku_id"].(string)
				if sku == "" {
					continue
				}
				qty[sku] += int(asInt(m["quantity"]))
			}
		}
		locIDs := b["location_ids"]
		enabled := true
		if v, ok := b["enabled"].(bool); ok {
			enabled = v
		}
		discount := asInt(b["amount_off_minor"])
		if _, err := tx.Exec(ctx, `INSERT INTO bundles (
				bundle_id, name, description, items, sku_quantities, location_ids, enabled, discount_amount_minor)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			id, strField(b, "name"), strField(b, "description"), jsonBytes(b["items"]), jsonBytes(qty), jsonBytes(locIDs), enabled, discount); err != nil {
			return err
		}
	}
	return nil
}

func loadStrategies(ctx context.Context, tx pgx.Tx, dir string) error {
	var strategies []map[string]any
	if err := readJSON(filepath.Join(dir, "strategies.json"), &strategies); err != nil {
		return err
	}
	for _, s := range strategies {
		t, _ := s["strategy_type"].(string)
		if t == "" {
			continue
		}
		rev, _ := s["revision"].(string)
		if rev == "" {
			rev = "unspecified"
		}
		enabled, _ := s["enabled"].(bool)
		if _, err := tx.Exec(ctx, `INSERT INTO commercial_strategies (
				strategy_type, enabled, revision, priority, objective_metric, config)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			t, enabled, rev, asInt(s["priority"]), strField(s, "objective_metric"), jsonBytes(s["config"])); err != nil {
			return err
		}
	}
	return nil
}

func entityTypeFromID(id string) string {
	if strings.HasPrefix(id, "prd_") {
		return "product"
	}
	return "sku"
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func strField(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func parseJSONTime(v any) any {
	s, _ := v.(string)
	if strings.TrimSpace(s) == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return nil
}
