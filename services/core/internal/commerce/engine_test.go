package commerce

import (
	"testing"
	"time"

	"atlas.dev/core/internal/cart"
)

func allOn() map[string]bool {
	return map[string]bool{
		"THRESHOLD": true, "PROMOTION": true, "BUNDLE": true,
		"CROSS_SELL": true, "COMPLEMENT": true, "UPSELL": true,
	}
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
		}},
		Bundles: []cart.Bundle{{
			ID: "bun_ab", Name: "A+B", SKUQuantities: map[string]int{"sku_a": 1, "sku_b": 1},
			DiscountMinor: 200, LocationIDs: []string{"loc_qm_koramangala"},
		}},
		SKUs: map[string]CatalogSKU{
			"sku_a":  {SKUID: "sku_a", ProductID: "prd_a", Name: "Item A", SellingMinor: 1000, Sellable: 10},
			"sku_b":  {SKUID: "sku_b", ProductID: "prd_b", Name: "Item B", SellingMinor: 4000, Sellable: 10},
			"sku_c":  {SKUID: "sku_c", ProductID: "prd_c", Name: "Item C", SellingMinor: 500, Sellable: 10},
			"sku_d":  {SKUID: "sku_d", ProductID: "prd_d", Name: "Item D", SellingMinor: 600, Sellable: 10},
			"sku_up": {SKUID: "sku_up", ProductID: "prd_a", Name: "Item A+", SellingMinor: 2000, Sellable: 10},
			"sku_e":  {SKUID: "sku_e", ProductID: "prd_e", Name: "Item E", SellingMinor: 5000, Sellable: 10},
		},
		Edges: []GraphEdge{
			{Source: "sku_a", Target: "sku_c", Type: "USED_WITH"},
			{Source: "prd_a", Target: "sku_d", Type: "COMPLEMENT"},
			{Source: "sku_a", Target: "sku_up", Type: "UPGRADE"},
		},
	}
	return ctx, in
}

func TestSixStrategiesIndependently(t *testing.T) {
	base, in := fixtureInputs()
	want := []string{"THRESHOLD", "PROMOTION", "BUNDLE", "CROSS_SELL", "COMPLEMENT", "UPSELL"}
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
		if len(got[0].Patch.Lines) == 0 {
			t.Fatalf("%s missing patch lines", strat)
		}
		sim, err := Simulate(ctx, in, got[0], ctx.Now)
		if err != nil {
			t.Fatalf("%s simulate: %v", strat, err)
		}
		if sim.BuyerImpact != got[0].BuyerImpact {
			t.Fatalf("%s buyer impact %d != simulated %d", strat, got[0].BuyerImpact, sim.BuyerImpact)
		}
	}
}

func TestBudgetSuppressesOffer(t *testing.T) {
	ctx, in := fixtureInputs()
	ctx.Enabled = map[string]bool{"CROSS_SELL": true}
	ctx.HasBudget = true
	ctx.BudgetMinor = 4600
	got := Select(ctx, in)
	if len(got) != 0 {
		t.Fatalf("expected budget suppression, got %+v", got)
	}
}

func TestControlArmSelectsNoOffer(t *testing.T) {
	ctx, in := fixtureInputs()
	ctx.EvaluationArm = "CONTROL"
	got := Select(ctx, in)
	if len(got) != 0 {
		t.Fatalf("control must select NO_OFFER, got %+v", got)
	}
}

func TestMissingCOGSDoesNotBecomeZero(t *testing.T) {
	ctx, in := fixtureInputs()
	ctx.Enabled = map[string]bool{"CROSS_SELL": true}
	sim, err := Simulate(ctx, in, Candidate{
		Strategy: "CROSS_SELL",
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
	ctx, in := fixtureInputs()
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
	for _, want := range []string{"THRESHOLD", "PROMOTION", "BUNDLE", "CROSS_SELL", "COMPLEMENT", "UPSELL"} {
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
	ctx, in := fixtureInputs()
	ctx.Enabled = map[string]bool{"CROSS_SELL": true, "COMPLEMENT": true}
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
