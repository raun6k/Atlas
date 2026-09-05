package fixtures

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
)

func loadOptionalJSON(path string, v any) (bool, error) {
	err := readJSON(path, v)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func loadOptionalCSV(path string) ([]map[string]string, error) {
	rows, err := readCSV(path)
	if err == nil {
		return rows, nil
	}
	if os.IsNotExist(err) {
		return nil, nil
	}
	return nil, err
}

func loadBuyers(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := loadOptionalCSV(filepath.Join(dir, "buyers.csv"))
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := csvString(row, "buyer_id")
		if id == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO buyers (buyer_id, default_location_id) VALUES ($1,$2)`,
			id, nullIfEmpty(csvString(row, "default_location_id"))); err != nil {
			return err
		}
	}
	return nil
}

func loadCampaigns(ctx context.Context, tx pgx.Tx, dir string) error {
	var campaigns []map[string]any
	ok, err := loadOptionalJSON(filepath.Join(dir, "campaigns.json"), &campaigns)
	if err != nil || !ok {
		return err
	}
	for _, c := range campaigns {
		id, _ := c["campaign_id"].(string)
		if strings.TrimSpace(id) == "" {
			continue
		}
		campRev := strField(c, "revision")
		if campRev == "" {
			campRev = "v1"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO campaigns (
				campaign_id, brand_id, brand, name, promotion_ids, budget_minor, budget_consumed_minor,
				brand_funding_pct, merchant_funding_pct, start_at, end_at, revision)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			id, nullIfEmpty(strField(c, "brand_id")), nullIfEmpty(strField(c, "brand")), strField(c, "name"),
			jsonBytes(c["promotion_ids"]), asInt(c["budget_minor"]), asInt(c["budget_consumed_minor"]),
			asInt(c["brand_funding_pct"]), asInt(c["merchant_funding_pct"]),
			parseJSONTime(c["start_at"]), parseJSONTime(c["end_at"]), campRev); err != nil {
			return err
		}
	}
	return nil
}

func loadBuyerOrders(ctx context.Context, tx pgx.Tx, dir string) error {
	orders, err := loadOptionalCSV(filepath.Join(dir, "orders.csv"))
	if err != nil {
		return err
	}
	for _, row := range orders {
		id := csvString(row, "order_id")
		buyer := csvString(row, "buyer_id")
		loc := csvString(row, "location_id")
		if id == "" || buyer == "" || loc == "" {
			continue
		}
		status := csvString(row, "status")
		if status == "" {
			status = "COMPLETED"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO buyer_orders (order_id, buyer_id, location_id, ordered_at, status)
			VALUES ($1,$2,$3,$4,$5)`,
			id, buyer, loc, parseJSONTime(csvString(row, "ordered_at")), status); err != nil {
			return err
		}
	}
	lines, err := loadOptionalCSV(filepath.Join(dir, "order_lines.csv"))
	if err != nil {
		return err
	}
	for _, row := range lines {
		orderID := csvString(row, "order_id")
		sku := csvString(row, "sku_id")
		if orderID == "" || sku == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO buyer_order_lines (order_id, sku_id, quantity, price_paid_minor)
			VALUES ($1,$2,$3,$4)`,
			orderID, sku, csvInt(row, "quantity", 1), csvInt(row, "price_paid_minor", 0)); err != nil {
			return err
		}
	}
	return nil
}

func loadSearchEvents(ctx context.Context, tx pgx.Tx, dir string) error {
	rows, err := loadOptionalCSV(filepath.Join(dir, "search_events.csv"))
	if err != nil {
		return err
	}
	for i, row := range rows {
		buyer := csvString(row, "buyer_id")
		query := csvString(row, "search_query")
		sku := csvString(row, "sku_id")
		eventType := csvString(row, "event_type")
		if buyer == "" || query == "" || sku == "" || eventType == "" {
			continue
		}
		id := fmt.Sprintf("sev_qm_%03d", i+1)
		if _, err := tx.Exec(ctx, `INSERT INTO search_events (
				search_event_id, buyer_id, search_query, sku_id, event_type, occurred_at)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			id, buyer, query, sku, eventType, parseJSONTime(csvString(row, "occurred_at"))); err != nil {
			return err
		}
	}
	return nil
}

func loadRoutines(ctx context.Context, tx pgx.Tx, dir string) error {
	var routines []map[string]any
	ok, err := loadOptionalJSON(filepath.Join(dir, "routines.json"), &routines)
	if err != nil || !ok {
		return err
	}
	for _, r := range routines {
		id, _ := r["routine_id"].(string)
		buyer, _ := r["buyer_id"].(string)
		if strings.TrimSpace(id) == "" || strings.TrimSpace(buyer) == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO buyer_routines (routine_id, buyer_id, name, cadence_days, last_ordered_at)
			VALUES ($1,$2,$3,$4,$5)`,
			id, buyer, strField(r, "name"), asInt(r["cadence_days"]), parseJSONTime(r["last_ordered_at"])); err != nil {
			return err
		}
		items, _ := r["items"].([]any)
		for _, it := range items {
			m, _ := it.(map[string]any)
			sku, _ := m["sku_id"].(string)
			if sku == "" {
				continue
			}
			qty := asInt(m["usual_quantity"])
			if qty <= 0 {
				qty = 1
			}
			if _, err := tx.Exec(ctx, `INSERT INTO buyer_routine_items (routine_id, sku_id, usual_quantity) VALUES ($1,$2,$3)`,
				id, sku, qty); err != nil {
				return err
			}
		}
	}
	return nil
}
