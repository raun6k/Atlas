package cart

import (
	"testing"
	"time"
)

func TestPriceCartAppliesBundleDiscount(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	lines := []Line{
		{LineID: "l1", SKUID: "sku_a", Quantity: 1, UnitMinor: 1000, LineMinor: 1000},
		{LineID: "l2", SKUID: "sku_b", Quantity: 1, UnitMinor: 4000, LineMinor: 4000},
	}
	loc := LocationFees{DeliveryFeeMinor: 3500, HandlingFeeMinor: 0, FreeDeliveryThresholdMinor: 5000}
	bundles := []Bundle{{
		ID: "bun_ab", SKUQuantities: map[string]int{"sku_a": 1, "sku_b": 1},
		DiscountMinor: 200, LocationIDs: []string{"loc_qm_koramangala"},
	}}
	got := PriceCart(lines, loc, nil, bundles, "loc_qm_koramangala", now)
	if got.DiscountsMinor != 200 {
		t.Fatalf("bundle discount: got %d", got.DiscountsMinor)
	}
	if got.AllInMinor != 1000+4000-200+3500 {
		t.Fatalf("all-in: got %d", got.AllInMinor)
	}
	if len(got.AppliedBundleIDs) != 1 {
		t.Fatalf("expected applied bundle")
	}
}

func TestPriceCartIgnoresFuturePromotion(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	lines := []Line{{SKUID: "sku_a", Quantity: 2, UnitMinor: 1000, LineMinor: 2000}}
	loc := LocationFees{}
	promos := []Promotion{{
		ID: "prm", EligibleSKUs: []string{"sku_a"}, MinimumQty: 2, DiscountMinor: 100,
		Enabled: true, StartsAt: now.Add(time.Hour), EndsAt: now.Add(2 * time.Hour),
	}}
	got := PriceCart(lines, loc, promos, nil, "loc", now)
	if got.DiscountsMinor != 0 {
		t.Fatalf("future promo applied: %d", got.DiscountsMinor)
	}
}

func TestPriceCartFreeDeliveryUsesNetMerchandise(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	lines := []Line{{SKUID: "sku_a", Quantity: 1, UnitMinor: 6000, LineMinor: 6000}}
	loc := LocationFees{DeliveryFeeMinor: 3500, FreeDeliveryThresholdMinor: 5000}
	promos := []Promotion{{
		ID: "prm", EligibleSKUs: []string{"sku_a"}, MinimumQty: 1, DiscountMinor: 2000,
		Enabled: true, StartsAt: now.Add(-time.Hour), EndsAt: now.Add(time.Hour),
	}}
	got := PriceCart(lines, loc, promos, nil, "loc", now)
	if got.DiscountsMinor != 2000 {
		t.Fatalf("discount %d", got.DiscountsMinor)
	}
	if got.DeliveryFeeMinor != 3500 {
		t.Fatalf("threshold must use net merchandise; delivery=%d", got.DeliveryFeeMinor)
	}
}

func TestPriceCartSmallOrderFee(t *testing.T) {
	now := time.Now().UTC()
	lines := []Line{{SKUID: "sku_a", Quantity: 1, UnitMinor: 1000, LineMinor: 1000}}
	loc := LocationFees{SmallOrderThresholdMinor: 2000, SmallOrderFeeMinor: 400}
	got := PriceCart(lines, loc, nil, nil, "loc", now)
	if got.HandlingFeeMinor != 400 {
		t.Fatalf("small-order fee %d", got.HandlingFeeMinor)
	}
	lines[0].UnitMinor, lines[0].LineMinor = 2500, 2500
	got = PriceCart(lines, loc, nil, nil, "loc", now)
	if got.HandlingFeeMinor != 0 {
		t.Fatalf("fee after threshold %d", got.HandlingFeeMinor)
	}
}

func TestPriceCartMinimumOrder(t *testing.T) {
	now := time.Now().UTC()
	lines := []Line{{SKUID: "sku_a", Quantity: 1, UnitMinor: 100, LineMinor: 100}}
	loc := LocationFees{MinimumOrderValueMinor: 500}
	got := PriceCart(lines, loc, nil, nil, "loc", now)
	if got.MinimumOrderMet {
		t.Fatal("expected minimum order not met")
	}
}

func TestRecalcAliasesPriceCart(t *testing.T) {
	now := time.Now().UTC()
	lines := []Line{{SKUID: "sku_a", Quantity: 1, UnitMinor: 100, LineMinor: 100}}
	a := PriceCart(lines, LocationFees{}, nil, nil, "loc", now)
	b := Recalc(lines, LocationFees{}, nil, nil, "loc", now)
	if a.AllInMinor != b.AllInMinor {
		t.Fatalf("Recalc diverged from PriceCart")
	}
}
