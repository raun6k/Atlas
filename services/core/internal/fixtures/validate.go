package fixtures

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"atlas.dev/core/internal/inventory"
)

var knownStrategies = map[string]bool{
	"REORDER": true, "REPLENISHMENT": true, "PAST_PURCHASE": true, "CART_COMPLETION": true,
	"BASKET_REC": true, "FBT": true, "SEARCH_RANKING": true, "ROUTINE": true,
	"LARGER_PACK": true, "FREE_DELIVERY": true, "SMALL_ORDER": true, "BRAND_PROMO": true,
}

func ValidateDir(dir string) error {
	if _, err := DigestDir(dir); err != nil {
		return err
	}
	currency, err := MerchantCurrency(dir)
	if err != nil {
		return err
	}
	if currency == "" {
		return fmt.Errorf("merchant currency missing")
	}
	products, err := idSet(dir, "products.csv", "product_id")
	if err != nil {
		return err
	}
	skus, skuProduct, err := skuIndex(dir)
	if err != nil {
		return err
	}
	for sku, prd := range skuProduct {
		if !products[prd] {
			return fmt.Errorf("sku %s references missing product %s", sku, prd)
		}
	}
	locations, err := idSet(dir, "locations.csv", "location_id")
	if err != nil {
		return err
	}
	if err := validateServiceAreas(dir, locations); err != nil {
		return err
	}
	if err := validateOffers(dir, locations, skus); err != nil {
		return err
	}
	if err := validateRelationships(dir, products, skus); err != nil {
		return err
	}
	if err := validatePromotions(dir, skus, locations); err != nil {
		return err
	}
	if err := validateBundles(dir, skus, locations); err != nil {
		return err
	}
	if err := validateStrategies(dir); err != nil {
		return err
	}
	buyers, err := idSet(dir, "buyers.csv", "buyer_id")
	if err != nil {
		return err
	}
	if err := validateBuyerLocations(dir, locations); err != nil {
		return err
	}
	if err := validateCampaigns(dir); err != nil {
		return err
	}
	if err := validateHistory(dir, buyers, locations, skus); err != nil {
		return err
	}
	return nil
}

func idSet(dir, file, key string) (map[string]bool, error) {
	rows, err := readCSV(filepath.Join(dir, file))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	out := map[string]bool{}
	for _, row := range rows {
		id := csvString(row, key)
		if id == "" {
			return nil, fmt.Errorf("%s: empty %s", file, key)
		}
		out[id] = true
	}
	return out, nil
}

func skuIndex(dir string) (map[string]bool, map[string]string, error) {
	rows, err := readCSV(filepath.Join(dir, "skus.csv"))
	if err != nil {
		return nil, nil, fmt.Errorf("skus.csv: %w", err)
	}
	ids := map[string]bool{}
	prod := map[string]string{}
	for _, row := range rows {
		sku := csvString(row, "sku_id")
		prd := csvString(row, "product_id")
		if sku == "" || prd == "" {
			return nil, nil, fmt.Errorf("skus.csv: sku_id and product_id required")
		}
		ids[sku] = true
		prod[sku] = prd
	}
	return ids, prod, nil
}

func validateServiceAreas(dir string, locations map[string]bool) error {
	raw, err := os.ReadFile(filepath.Join(dir, "service_areas.json"))
	if err != nil {
		return err
	}
	var areas []struct {
		LocationID string `json:"location_id"`
	}
	if err := json.Unmarshal(raw, &areas); err != nil {
		return fmt.Errorf("service_areas.json: %w", err)
	}
	covered := map[string]bool{}
	for _, a := range areas {
		if !locations[a.LocationID] {
			return fmt.Errorf("service_areas.json references missing location %s", a.LocationID)
		}
		covered[a.LocationID] = true
	}
	for loc := range locations {
		if !covered[loc] {
			return fmt.Errorf("location %s has no service area", loc)
		}
	}
	return nil
}

func validateOffers(dir string, locations, skus map[string]bool) error {
	rows, err := readCSV(filepath.Join(dir, "location_sku_offers.csv"))
	if err != nil {
		return fmt.Errorf("location_sku_offers.csv: %w", err)
	}
	if len(rows) == 0 {
		return fmt.Errorf("location_sku_offers.csv is empty")
	}
	for i, row := range rows {
		loc := csvString(row, "location_id")
		sku := csvString(row, "sku_id")
		if !locations[loc] {
			return fmt.Errorf("offer row %d: missing location %s", i+2, loc)
		}
		if !skus[sku] {
			return fmt.Errorf("offer row %d: missing sku %s", i+2, sku)
		}
		if csvInt(row, "selling_price_minor", -1) < 0 || csvInt(row, "mrp_minor", -1) < 0 {
			return fmt.Errorf("offer %s/%s: negative price", loc, sku)
		}
		on := int(csvInt(row, "on_hand_quantity", 0))
		res := int(csvInt(row, "reserved_quantity", 0))
		buf := int(csvInt(row, "safety_buffer", 0))
		if on < 0 || res < 0 || buf < 0 {
			return fmt.Errorf("offer %s/%s: negative inventory", loc, sku)
		}
		_ = inventory.Discoverable(csvBool(row, "assorted", true), on, res, buf)
	}
	return nil
}

func validateRelationships(dir string, products, skus map[string]bool) error {
	rows, err := readCSV(filepath.Join(dir, "relationships.csv"))
	if err != nil {
		return fmt.Errorf("relationships.csv: %w", err)
	}
	for _, row := range rows {
		src := csvString(row, "source_id")
		tgt := csvString(row, "target_id")
		if !knownEntity(src, products, skus) || !knownEntity(tgt, products, skus) {
			return fmt.Errorf("relationship %s -> %s references unknown ids", src, tgt)
		}
	}
	return nil
}

func knownEntity(id string, products, skus map[string]bool) bool {
	return products[id] || skus[id]
}

func validatePromotions(dir string, skus, locations map[string]bool) error {
	raw, err := os.ReadFile(filepath.Join(dir, "promotions.json"))
	if err != nil {
		return err
	}
	var promos []struct {
		ID      string   `json:"promotion_id"`
		SKUs    []string `json:"eligible_sku_ids"`
		Locs    []string `json:"location_ids"`
		Enabled bool     `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &promos); err != nil {
		return fmt.Errorf("promotions.json: %w", err)
	}
	for _, p := range promos {
		if p.ID == "" {
			return fmt.Errorf("promotions.json: empty promotion_id")
		}
		for _, sku := range p.SKUs {
			if !skus[sku] {
				return fmt.Errorf("promotion %s references missing sku %s", p.ID, sku)
			}
		}
		for _, loc := range p.Locs {
			if !locations[loc] {
				return fmt.Errorf("promotion %s references missing location %s", p.ID, loc)
			}
		}
	}
	return nil
}

func validateBundles(dir string, skus, locations map[string]bool) error {
	raw, err := os.ReadFile(filepath.Join(dir, "bundles.json"))
	if err != nil {
		return err
	}
	var bundles []struct {
		ID    string   `json:"bundle_id"`
		Locs  []string `json:"location_ids"`
		Items []struct {
			SKUID string `json:"sku_id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &bundles); err != nil {
		return fmt.Errorf("bundles.json: %w", err)
	}
	for _, b := range bundles {
		if b.ID == "" {
			return fmt.Errorf("bundles.json: empty bundle_id")
		}
		for _, loc := range b.Locs {
			if !locations[loc] {
				return fmt.Errorf("bundle %s references missing location %s", b.ID, loc)
			}
		}
		for _, it := range b.Items {
			if !skus[it.SKUID] {
				return fmt.Errorf("bundle %s references missing sku %s", b.ID, it.SKUID)
			}
		}
	}
	return nil
}

func validateStrategies(dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "strategies.json"))
	if err != nil {
		return err
	}
	var rows []struct {
		Type string `json:"strategy_type"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return fmt.Errorf("strategies.json: %w", err)
	}
	for _, r := range rows {
		if !knownStrategies[r.Type] {
			return fmt.Errorf("unknown strategy_type %s", r.Type)
		}
	}
	return nil
}

func validateBuyerLocations(dir string, locations map[string]bool) error {
	rows, err := readCSV(filepath.Join(dir, "buyers.csv"))
	if err != nil {
		return fmt.Errorf("buyers.csv: %w", err)
	}
	for _, row := range rows {
		loc := csvString(row, "default_location_id")
		if loc != "" && !locations[loc] {
			return fmt.Errorf("buyer %s references missing location %s", csvString(row, "buyer_id"), loc)
		}
	}
	return nil
}

func validateCampaigns(dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "campaigns.json"))
	if err != nil {
		return err
	}
	var camps []struct {
		ID     string   `json:"campaign_id"`
		Promos []string `json:"promotion_ids"`
	}
	if err := json.Unmarshal(raw, &camps); err != nil {
		return fmt.Errorf("campaigns.json: %w", err)
	}
	promoRaw, err := os.ReadFile(filepath.Join(dir, "promotions.json"))
	if err != nil {
		return err
	}
	var promos []struct {
		ID string `json:"promotion_id"`
	}
	if err := json.Unmarshal(promoRaw, &promos); err != nil {
		return err
	}
	known := map[string]bool{}
	for _, p := range promos {
		known[p.ID] = true
	}
	for _, c := range camps {
		if c.ID == "" {
			return fmt.Errorf("campaigns.json: empty campaign_id")
		}
		for _, pid := range c.Promos {
			if !known[pid] {
				return fmt.Errorf("campaign %s references missing promotion %s", c.ID, pid)
			}
		}
	}
	return nil
}

func validateHistory(dir string, buyers, locations, skus map[string]bool) error {
	orders, err := readCSV(filepath.Join(dir, "orders.csv"))
	if err != nil {
		return fmt.Errorf("orders.csv: %w", err)
	}
	orderIDs := map[string]bool{}
	for _, row := range orders {
		oid := csvString(row, "order_id")
		bid := csvString(row, "buyer_id")
		loc := csvString(row, "location_id")
		if !buyers[bid] {
			return fmt.Errorf("order %s references missing buyer %s", oid, bid)
		}
		if !locations[loc] {
			return fmt.Errorf("order %s references missing location %s", oid, loc)
		}
		orderIDs[oid] = true
	}
	lines, err := readCSV(filepath.Join(dir, "order_lines.csv"))
	if err != nil {
		return fmt.Errorf("order_lines.csv: %w", err)
	}
	for _, row := range lines {
		oid := csvString(row, "order_id")
		sku := csvString(row, "sku_id")
		if !orderIDs[oid] {
			return fmt.Errorf("order_lines references missing order %s", oid)
		}
		if !skus[sku] {
			return fmt.Errorf("order %s line references missing sku %s", oid, sku)
		}
	}
	return nil
}
