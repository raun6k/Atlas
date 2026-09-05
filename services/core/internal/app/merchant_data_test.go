package app_test

import (
	"context"
	"testing"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/testdb"
)

func TestSearchExcludesAssortedZeroSellable(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	var sku, productID string
	err = k.Pool().QueryRow(ctx, `
		SELECT i.sku_id, s.product_id FROM inventory i
		JOIN skus s ON s.sku_id=i.sku_id
		WHERE i.location_id='loc_qm_koramangala' AND i.assorted=TRUE
		  AND (i.on_hand_quantity - i.reserved_quantity - i.safety_buffer) <= 0
		  AND s.lifecycle IN ('sellable','active')
		LIMIT 1`).Scan(&sku, &productID)
	if err != nil {
		t.Skip("no zero-sellable assorted SKU in pack")
	}
	host := "host_atlaslab_quickmart"
	created, err := k.CreateSession(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, "stock-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, items, _, _, err := k.SearchCatalog(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, "", "", "", "", 25)
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if it.SKUID == sku {
			t.Fatalf("zero-sellable SKU %s appeared in search", sku)
		}
		if it.Sellable <= 0 {
			t.Fatalf("search returned unsellable %s", it.SKUID)
		}
	}
	_, prod, err := k.GetProduct(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, productID, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range prod.SKUs {
		if it.SKUID == sku {
			t.Fatalf("zero-sellable SKU %s appeared on product", sku)
		}
	}
	_, err = k.AddItem(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, created.Session.CartID, created.Cart.Version, sku, 1)
	if !apperr.Is(err, apperr.ItemUnavailable) {
		t.Fatalf("want ITEM_UNAVAILABLE adding %s got %v", sku, err)
	}
}

func TestSetIntentRejectsForeignCurrency(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	created, err := k.CreateSession(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, "cur-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Cart.Currency != "INR" {
		t.Fatalf("cart currency %s", created.Cart.Currency)
	}
	_, err = k.SetIntent(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, 0, "mission", 18000, "USD", nil)
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("want INVALID_ARGUMENT got %v", err)
	}
	_, err = k.SetIntent(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, 0, "mission", 18000, "EUR", nil)
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("EUR want INVALID_ARGUMENT got %v", err)
	}
	_, err = k.SetIntent(ctx, app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, 0, "mission", 18000, "", nil)
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("empty currency want INVALID_ARGUMENT got %v", err)
	}
}
