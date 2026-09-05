package commerce

import (
	"testing"
	"time"

	"atlas.dev/core/internal/cart"
)

func allOn() map[string]bool {
	out := map[string]bool{}
	for _, t := range EngineStrategyTypes {
		out[t] = true
	}
	return out
}

func fixtureInputs() (Context, Inputs) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	ctx := Context{
		LocationID:                 "loc_qm_koramangala",
		MerchandiseMinor:           1000,
		AllInMinor:                 4500,
		FreeDeliveryThresholdMinor: 5000,
		DeliveryFeeMinor:           3500,
		Fees: cart.LocationFees{
			DeliveryFeeMinor: 3500, FreeDeliveryThresholdMinor: 5000,
			SmallOrderThresholdMinor: 2000, SmallOrderFeeMinor: 400,
		},
		Now: now,
		Lines: []cart.Line{{
			LineID: "ln_a", SKUID: "sku_a", ProductID: "prd_a", Name: "Item A",
			Quantity: 1, UnitMinor: 1000, LineMinor: 1000,
		}},
		Enabled: allOn(),
	}
	in := Inputs{
		Promotions: []cart.Promotion{{
			ID: "prm_qty", Type: "QUANTITY", Name: "Buy 2 save 1", EligibleSKUs: []string{"sku_a"},
			MinimumQty: 2, DiscountMinor: 100, LocationIDs: []string{"loc_qm_koramangala"}, Enabled: true,
			StartsAt: now.Add(-time.Hour), EndsAt: now.Add(time.Hour),
		}, {
			ID: "prm_brand", Type: "BRAND_CAMPAIGN", Name: "Brand days", EligibleSKUs: []string{"sku_e"},
			MinimumQty: 1, DiscountMinor: 200, LocationIDs: []string{"loc_qm_koramangala"}, Enabled: true,
			StartsAt: now.Add(-time.Hour), EndsAt: now.Add(time.Hour),
		}},
		Bundles: []cart.Bundle{{
			ID: "bun_ab", Name: "A+B", SKUQuantities: map[string]int{"sku_a": 1, "sku_b": 1},
			DiscountMinor: 200, LocationIDs: []string{"loc_qm_koramangala"},
		}},
		SKUs: map[string]CatalogSKU{
			"sku_a":  {SKUID: "sku_a", ProductID: "prd_a", Name: "Item A", SellingMinor: 1000, Sellable: 10, PackSize: 1, Brand: "BrandA"},
			"sku_b":  {SKUID: "sku_b", ProductID: "prd_b", Name: "Item B", SellingMinor: 4000, Sellable: 10, PackSize: 1},
			"sku_c":  {SKUID: "sku_c", ProductID: "prd_c", Name: "Item C", SellingMinor: 500, Sellable: 10, PackSize: 1, BrandID: "brand_c"},
			"sku_d":  {SKUID: "sku_d", ProductID: "prd_d", Name: "Item D", SellingMinor: 600, Sellable: 10, PackSize: 1},
			"sku_up": {SKUID: "sku_up", ProductID: "prd_a", Name: "Item A+", SellingMinor: 1600, Sellable: 10, PackSize: 2, NetUnit: "g"},
			"sku_e":  {SKUID: "sku_e", ProductID: "prd_e", Name: "Item E", SellingMinor: 5000, Sellable: 10, PackSize: 1, BrandID: "brand_e"},
		},
		Edges: []GraphEdge{
			{Source: "sku_a", Target: "sku_c", Type: "USED_WITH"},
			{Source: "prd_a", Target: "sku_d", Type: "COMPLEMENT"},
			{Source: "sku_a", Target: "sku_up", Type: "UPGRADE"},
		},
	}
	return ctx, in
}

func TestBudgetSuppressesOffer(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"FBT": true}
	ctx.HasBudget = true
	ctx.BudgetMinor = 5200
	got := Select(ctx, in)
	if len(got) != 0 {
		t.Fatalf("expected budget suppression, got %+v", got)
	}
	_, dropped := SelectTrace(ctx, in)
	found := false
	for _, d := range dropped {
		if d.Reason == "OVER_BUDGET" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected OVER_BUDGET drop, got %+v", dropped)
	}
}

func TestControlArmSelectsNoOffer(t *testing.T) {
	ctx, in := fixtureInputs()
	ctx.EvaluationArm = "CONTROL"
	got := Select(ctx, in)
	if len(got) != 0 {
		t.Fatalf("control must select NO_OFFER, got %+v", got)
	}
	_, dropped := SelectTrace(ctx, in)
	if len(dropped) != 1 || dropped[0].Reason != "CONTROL_ARM" {
		t.Fatalf("control drop %+v", dropped)
	}
}

func TestMissingCOGSDoesNotBecomeZero(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"FBT": true}
	sim, err := Simulate(ctx, in, Candidate{
		Strategy: "FBT",
		Patch:    Patch{Type: "ADD_ITEM", Lines: []PatchLine{{SKUID: "sku_c", Quantity: 1, Op: "ADD"}}},
	}, ctx.Now)
	if err != nil {
		t.Fatal(err)
	}
	if sim.ContributionDeltaMinor != nil {
		t.Fatalf("missing COGS must stay absent, got %v", *sim.ContributionDeltaMinor)
	}
	got := Select(ctx, in)
	if len(got) == 0 {
		t.Fatal("missing COGS must not drop the candidate")
	}
	if got[0].Eligibility != "ECONOMICS_INCOMPLETE" {
		t.Fatalf("want ECONOMICS_INCOMPLETE, got %s", got[0].Eligibility)
	}
}

func TestConflictFilterOneSKUOneStrategy(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	got := Select(ctx, in)
	if len(got) == 0 || len(got) > 3 {
		t.Fatalf("want 1-3 offers, got %d", len(got))
	}
	seenSKU := map[string]bool{}
	seenStrat := map[string]bool{}
	for _, c := range got {
		if seenStrat[c.Strategy] {
			t.Fatalf("duplicate strategy %s", c.Strategy)
		}
		seenStrat[c.Strategy] = true
		for _, l := range c.Patch.Lines {
			if seenSKU[l.SKUID] {
				t.Fatalf("sku conflict %s", l.SKUID)
			}
			seenSKU[l.SKUID] = true
		}
	}
}

func TestKnownTypesRegistered(t *testing.T) {
	got := KnownTypes()
	for _, want := range EngineStrategyTypes {
		if !got[want] {
			t.Fatalf("missing registry type %s", want)
		}
	}
}

func TestSelectDisabledStrategies(t *testing.T) {
	ctx, in := fixtureInputs()
	ctx.Enabled = map[string]bool{}
	got := Select(ctx, in)
	if len(got) != 0 {
		t.Fatalf("expected no candidates, got %+v", got)
	}
}

func TestDeterministicTieBreak(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"FBT": true, "BASKET_REC": true}
	a := Select(ctx, in)
	b := Select(ctx, in)
	if len(a) != len(b) {
		t.Fatalf("nondeterministic length")
	}
	for i := range a {
		if candidateKey(a[i]) != candidateKey(b[i]) {
			t.Fatalf("tie-break unstable")
		}
	}
}

func withSignals(ctx Context, in Inputs) (Context, Inputs) {
	now := ctx.Now
	ctx.Lines = append(ctx.Lines, cart.Line{
		LineID: "ln_d", SKUID: "sku_d", ProductID: "prd_d", Name: "Item D",
		Quantity: 1, UnitMinor: 600, LineMinor: 600,
	})
	personal := []PurchaseEvent{
		{OrderID: "o1", SKUID: "sku_c", ProductID: "prd_c", BrandID: "brand_c", Quantity: 1, OrderedAt: now.Add(-14 * 24 * time.Hour)},
		{OrderID: "o2", SKUID: "sku_c", ProductID: "prd_c", BrandID: "brand_c", Quantity: 1, OrderedAt: now.Add(-7 * 24 * time.Hour)},
		{OrderID: "o2", SKUID: "sku_d", ProductID: "prd_d", Quantity: 1, OrderedAt: now.Add(-7 * 24 * time.Hour)},
	}
	market := []PurchaseEvent{
		{OrderID: "m1", SKUID: "sku_a", Quantity: 1, OrderedAt: now},
		{OrderID: "m1", SKUID: "sku_c", Quantity: 1, OrderedAt: now},
		{OrderID: "m2", SKUID: "sku_a", Quantity: 1, OrderedAt: now},
		{OrderID: "m2", SKUID: "sku_c", Quantity: 1, OrderedAt: now},
		{OrderID: "m3", SKUID: "sku_a", Quantity: 1, OrderedAt: now},
		{OrderID: "m3", SKUID: "sku_d", Quantity: 1, OrderedAt: now},
		{OrderID: "m4", SKUID: "sku_a", Quantity: 1, OrderedAt: now},
		{OrderID: "m4", SKUID: "sku_c", Quantity: 1, OrderedAt: now},
	}
	in.Buyer = BuildBuyerSignals("buyer_qm_01", personal, nil, []Routine{{
		ID: "rtn", Name: "Weekly C", CadenceDays: 7, LastOrderedAt: now.Add(-8 * 24 * time.Hour),
		Items: []RoutineItem{{SKUID: "sku_c", UsualQuantity: 1}},
	}}, now)
	in.Market = BuildBasketIndex(market, personal)
	in.PromoTerms = map[string]PromoTerms{
		"prm_brand": {DiscountRate: 10, DiscountCap: 500, BrandFundPct: 80, MerchantFundPct: 20},
	}
	in.Campaigns = []Campaign{{ID: "camp", PromotionIDs: []string{"prm_brand"}, BudgetMinor: 100000, BrandFundingPct: 80, MerchantFundingPct: 20}}
	return ctx, in
}

func TestFormulaStrategiesIndependently(t *testing.T) {
	base, in := withSignals(fixtureInputs())
	want := []string{"REORDER", "REPLENISHMENT", "CART_COMPLETION", "BASKET_REC", "FBT", "ROUTINE", "LARGER_PACK", "FREE_DELIVERY", "SMALL_ORDER", "BRAND_PROMO"}
	for _, strat := range want {
		ctx := base
		ctx.Enabled = map[string]bool{strat: true}
		got := Select(ctx, in)
		if len(got) == 0 {
			t.Fatalf("%s produced no candidates", strat)
		}
		if got[0].Strategy != strat {
			t.Fatalf("%s: got %s", strat, got[0].Strategy)
		}
		if got[0].Reason == "" || got[0].Terms == "" {
			t.Fatalf("%s missing buyer copy reason/terms", strat)
		}
		if strat == "ROUTINE" && got[0].Patch.Type != "ADD_ITEMS" {
			t.Fatalf("ROUTINE patch type %q", got[0].Patch.Type)
		}
		if (strat == "FREE_DELIVERY" || strat == "SMALL_ORDER") && (got[0].Patch.Economics == nil || got[0].Patch.Economics.ItemCostMinor <= 0) {
			t.Fatalf("%s missing structured economics", strat)
		}
	}
}

func TestRankingStrategiesEmitNoPatch(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	for _, strat := range []string{"PAST_PURCHASE", "SEARCH_RANKING"} {
		ctx.Enabled = map[string]bool{strat: true}
		if got := Select(ctx, in); len(got) != 0 {
			t.Fatalf("%s must not emit cart patches", strat)
		}
	}
	hits := []RankedHit{
		{SKUID: "sku_e", QueryRelevance: 0.8, PriceMinor: 5000, Sellable: 10},
		{SKUID: "sku_c", QueryRelevance: 0.7, PriceMinor: 500, Sellable: 10, ProductID: "prd_c", BrandID: "brand_c"},
	}
	ctx.Enabled = map[string]bool{"PAST_PURCHASE": true, "SEARCH_RANKING": true}
	ranked := RankCatalog(ctx, in, hits)
	if ranked[0].SKUID != "sku_c" {
		t.Fatalf("expected history boost for sku_c, got %s", ranked[0].SKUID)
	}
	ctx.EvaluationArm = "CONTROL"
	controlRanked := RankCatalog(ctx, in, hits)
	if controlRanked[0].SKUID != hits[0].SKUID {
		t.Fatalf("CONTROL must not rerank search, got %s", controlRanked[0].SKUID)
	}
}

func TestDisabledFormulaStrategy(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"REORDER": false}
	got := Select(ctx, in)
	for _, c := range got {
		if c.Strategy == "REORDER" {
			t.Fatal("disabled REORDER leaked")
		}
	}
}

func TestBuyerCopyJSONOverride(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"REORDER": true}
	in.Copy = map[string]BuyerCopy{
		"REORDER": {
			Headline: "Again please",
			Reason:   "Please add {{sku_name}} to the cart.",
			Terms:    "Custom terms for {{sku_name}}",
		},
	}
	got := Select(ctx, in)
	if len(got) == 0 {
		t.Fatal("expected reorder")
	}
	if got[0].Reason != "Please add Item C to the cart." {
		t.Fatalf("reason %q", got[0].Reason)
	}
	if got[0].Terms != "Again please" {
		t.Fatalf("headline/terms %q", got[0].Terms)
	}
}

func TestRenderTemplate(t *testing.T) {
	got := RenderTemplate("Add {{sku_name}} for {{price}}", map[string]string{"sku_name": "Milk", "price": "₹22"})
	if got != "Add Milk for ₹22" {
		t.Fatalf("got %q", got)
	}
	raw := []byte(`{"min_score":0.2,"buyer":{"headline":"Hi","reason":"Because {{sku_name}}","terms":"T"}}`)
	c := BuyerCopyFromConfig(raw)
	if c.Headline != "Hi" || c.Reason != "Because {{sku_name}}" {
		t.Fatalf("%+v", c)
	}
}

func TestValidateAllowlistRejectsUnknownAndExploratory(t *testing.T) {
	if err := ValidateAllowlist([]string{"FREE_DELIVERY", "FBT"}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAllowlist([]string{"NOT_A_STRATEGY"}); err == nil {
		t.Fatal("unknown must fail")
	}
	if err := ValidateAllowlist([]string{"REORDER"}); err == nil {
		t.Fatal("exploratory must fail")
	}
}

func TestSelectAttachesPublicExplanation(t *testing.T) {
	ctx, in := withSignals(fixtureInputs())
	ctx.Enabled = map[string]bool{"FBT": true}
	got := Select(ctx, in)
	if len(got) == 0 {
		t.Fatal("expected FBT")
	}
	if got[0].Explanation.WhatChanged == "" || got[0].Explanation.FundedBy == "" {
		t.Fatalf("missing buyer explanation %+v", got[0].Explanation)
	}
	if got[0].Economics.QuoteDeltaMinor == 0 && got[0].BuyerImpact == 0 {
		t.Fatalf("quote delta should be persisted on candidate %+v", got[0].Economics)
	}
}
