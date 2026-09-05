package app_test

import (
	"context"
	"testing"

	"atlas.dev/core/internal/testdb"
)

func TestFixtureBuyerHistorySeed(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	want := map[string]int{
		"buyers":              12,
		"campaigns":           3,
		"buyer_orders":        39,
		"buyer_order_lines":   96,
		"search_events":       60,
		"buyer_routines":      16,
		"buyer_routine_items": 36,
	}
	for table, n := range want {
		var got int
		if err := k.Pool().QueryRow(ctx, "SELECT COUNT(*) FROM "+table).Scan(&got); err != nil {
			t.Fatalf("%s: %v", table, err)
		}
		if got != n {
			t.Fatalf("%s: got %d want %d", table, got, n)
		}
	}

	var campaign string
	if err := k.Pool().QueryRow(ctx, `SELECT campaign_id FROM promotions WHERE promotion_id='promo_qm_brand_carebloom_01'`).Scan(&campaign); err != nil {
		t.Fatal(err)
	}
	if campaign != "camp_qm_carebloom_personal_care_2026" {
		t.Fatalf("brand promo campaign %s", campaign)
	}
}
