package commerce

import (
	"math"
	"testing"
	"time"
)

func TestDueAndReorderFormulas(t *testing.T) {
	if DueScore(7, 7) != 1 {
		t.Fatalf("due at cadence")
	}
	if DueScore(3.5, 7) != 0.5 {
		t.Fatalf("half due")
	}
	now := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	st := SKUStats{PurchaseCount: 4, PurchaseCount90: 4, ReorderRate: 0.75, MedianDays: 7, LastBoughtAt: now.Add(-7 * 24 * time.Hour)}
	got := ReorderScore(st, now)
	want := 0.35*Norm(4, 5) + 0.35*1 + 0.30*0.75
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("reorder score %v want %v", got, want)
	}
}

func TestReplenishmentAndPastPurchase(t *testing.T) {
	if ReplenishmentScore(7, 7) < 0.49 || ReplenishmentScore(7, 7) > 0.51 {
		t.Fatalf("sigmoid at 0 should be ~0.5, got %v", ReplenishmentScore(7, 7))
	}
	if ReplenishmentScore(14, 7) <= ReplenishmentScore(7, 7) {
		t.Fatal("later purchases should score higher")
	}
	now := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	st := SKUStats{PurchaseCount: 4, ReorderRate: 0.75, LastBoughtAt: now}
	if PastPurchaseScore(st, now) <= 0 {
		t.Fatal("expected positive past-purchase score")
	}
}

func TestBasketFormulas(t *testing.T) {
	now := time.Now().UTC()
	market := []PurchaseEvent{
		{OrderID: "1", SKUID: "a", OrderedAt: now},
		{OrderID: "1", SKUID: "b", OrderedAt: now},
		{OrderID: "2", SKUID: "a", OrderedAt: now},
		{OrderID: "2", SKUID: "b", OrderedAt: now},
		{OrderID: "3", SKUID: "b", OrderedAt: now},
		{OrderID: "4", SKUID: "c", OrderedAt: now},
	}
	idx := BuildBasketIndex(market, nil)
	if idx.Confidence("a", "b") != 1 {
		t.Fatalf("confidence %v", idx.Confidence("a", "b"))
	}
	if idx.Lift("a", "b") <= 1 {
		t.Fatalf("lift should exceed 1, got %v", idx.Lift("a", "b"))
	}
	assoc := idx.BasketAssociation([]string{"a"}, "b")
	if assoc != 1 {
		t.Fatalf("association %v", assoc)
	}
}

func TestLargerPackAndFees(t *testing.T) {
	cur := CatalogSKU{SKUID: "s", PackSize: 100, SellingMinor: 10000}
	large := CatalogSKU{SKUID: "l", PackSize: 200, SellingMinor: 16000}
	shelf := 30
	large.ShelfLifeDays = &shelf
	score := LargerPackScore(cur, large, 10)
	if score <= 0 {
		t.Fatalf("expected savings with fit, got %v", score)
	}
	if ThresholdGap(200, 180) != 20 {
		t.Fatal("gap")
	}
	if NetIncrementalCost(22, 25) != -3 {
		t.Fatal("net incremental")
	}
}

func TestBrandFunding(t *testing.T) {
	d := TotalDiscount(10, 10000, 1000)
	if d != 1000 {
		t.Fatalf("cap %d", d)
	}
	b, m := SplitFunding(1000, 70, 30)
	if b != 700 || m != 300 {
		t.Fatalf("split %d %d", b, m)
	}
}

func TestSearchScoreWeights(t *testing.T) {
	s := SearchScore(1, 1, 1, 1, 1, 1)
	if math.Abs(s-1) > 1e-9 {
		t.Fatalf("weights should sum to 1, got %v", s)
	}
}

func TestSpecFormulasMatchPublishedWeights(t *testing.T) {
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)

	// 1. Reorder: DueScore = min(1, days/median); ReorderScore = 0.35 N(count90) + 0.35 Due + 0.30 reorder_rate
	if DueScore(10, 7) != 1 {
		t.Fatalf("due score cap")
	}
	st := SKUStats{PurchaseCount90: 5, ReorderRate: 1, MedianDays: 7, LastBoughtAt: now.Add(-7 * 24 * time.Hour)}
	if math.Abs(ReorderScore(st, now)-(0.35*1+0.35*1+0.30*1)) > 1e-9 {
		t.Fatalf("reorder weights")
	}

	// 2. Replenishment: σ((days-median)/(0.2*median+1)); at cadence, σ(0)=0.5
	if math.Abs(ReplenishmentScore(7, 7)-0.5) > 1e-9 {
		t.Fatalf("replenishment at cadence")
	}
	if ConsumptionRate(2, 7) != 2.0/7.0 {
		t.Fatalf("consumption rate")
	}

	// 3. Past purchase: 0.5 N(count) + 0.3 e^{-d/τ} + 0.2 reorder_rate
	st3 := SKUStats{PurchaseCount: 8, ReorderRate: 1, LastBoughtAt: now}
	wantPast := 0.5*1 + 0.3*Recency(0, 45) + 0.2*1
	if math.Abs(PastPurchaseScore(st3, now)-wantPast) > 1e-9 {
		t.Fatalf("past purchase %v want %v", PastPurchaseScore(st3, now), wantPast)
	}

	// 4–6. Basket scores
	if math.Abs(CompletionScore(1, 1, 1)-1) > 1e-9 {
		t.Fatalf("completion weights")
	}
	if math.Abs(RecommendationScore(1, 1, 1)-1) > 1e-9 {
		t.Fatalf("recommendation weights")
	}
	idx := BuildBasketIndex([]PurchaseEvent{
		{OrderID: "1", SKUID: "pasta"}, {OrderID: "1", SKUID: "sauce"},
		{OrderID: "2", SKUID: "pasta"}, {OrderID: "2", SKUID: "sauce"},
		{OrderID: "3", SKUID: "chips"},
	}, nil)
	if idx.Confidence("pasta", "sauce") != 1 {
		t.Fatalf("FBT confidence")
	}
	if idx.Support("pasta", "sauce") != 2.0/3.0 {
		t.Fatalf("FBT support")
	}
	if idx.Lift("pasta", "sauce") <= 1 {
		t.Fatalf("FBT lift")
	}

	// 7. Search weights already covered; price competitiveness = median/price
	if PriceCompetitiveness(50, 100) != 1 {
		t.Fatalf("cheaper than median should clamp to 1")
	}
	if math.Abs(PriceCompetitiveness(200, 100)-0.5) > 1e-9 {
		t.Fatalf("price competitiveness")
	}

	// 8. Routine: inclusion * due
	inc := 2.0 / 3.0
	due := DueScore(7, 7)
	if math.Abs(inc*due-2.0/3.0) > 1e-9 {
		t.Fatalf("routine item score")
	}

	// 9. Larger pack: unit saving × consumption fit
	cur := CatalogSKU{PackSize: 100, SellingMinor: 10000}
	large := CatalogSKU{PackSize: 200, SellingMinor: 16000}
	shelf := 20
	large.ShelfLifeDays = &shelf
	// unit prices 100 vs 80 → saving 0.20; rate 10/day * 20 days = 200 qty fit = 1
	if math.Abs(UnitSavingPct(cur, large)-0.2) > 1e-9 {
		t.Fatalf("unit saving")
	}
	if math.Abs(LargerPackScore(cur, large, 10)-0.2) > 1e-9 {
		t.Fatalf("larger pack score")
	}

	// 10–11. Fee fill: Gap, FeeSaving, NetIncrementalCost (₹180 cart, ₹200 free, ₹25 fee, ₹22 milk)
	if ThresholdGap(20000, 18000) != 2000 {
		t.Fatalf("gap paise")
	}
	if FeeSaving(2500, 0) != 2500 {
		t.Fatalf("fee saving")
	}
	if NetIncrementalCost(2200, 2500) != -300 {
		t.Fatalf("milk vs delivery fee")
	}

	// 12. Brand funding: min(rate*spend, cap); split
	if TotalDiscount(10, 10000, 500) != 500 {
		t.Fatalf("discount cap")
	}
	if TotalDiscount(10, 2000, 1000) != 200 {
		t.Fatalf("discount rate")
	}
	b, m := SplitFunding(1000, 70, 30)
	if b != 700 || m != 300 {
		t.Fatalf("funding split")
	}
}
