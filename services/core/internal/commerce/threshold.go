package commerce

import "atlas.dev/core/internal/cart"

type thresholdStrategy struct{}

func (thresholdStrategy) Type() string { return "THRESHOLD" }

func (thresholdStrategy) Generate(ctx Context, in Inputs) []Candidate {
	base := cart.PriceCart(ctx.Lines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, ctx.Now)
	if ctx.Fees.FreeDeliveryThresholdMinor <= 0 || base.MerchandiseMinor-base.DiscountsMinor >= ctx.Fees.FreeDeliveryThresholdMinor {
		return nil
	}
	inCart := map[string]bool{}
	for _, l := range ctx.Lines {
		inCart[l.SKUID] = true
	}
	ids := skuIDs(in.SKUs)
	var best *Candidate
	for _, id := range ids {
		sku := in.SKUs[id]
		if inCart[sku.SKUID] || sku.Sellable < 1 || sku.SellingMinor <= 0 {
			continue
		}
		c := Candidate{
			Strategy: "THRESHOLD",
			Reason:   "Adds " + sku.Name + " to reach the free-delivery threshold",
			Terms:    "Free delivery at the configured merchandise threshold",
			Patch:    Patch{Type: "ADD_ITEM", Lines: []PatchLine{{SKUID: sku.SKUID, Quantity: 1, Op: "ADD"}}},
		}
		sim, err := Simulate(ctx, in, c, ctx.Now)
		if err != nil || sim.Eligibility != "OK" {
			continue
		}
		if sim.PatchedAllInMinor <= 0 {
			continue
		}
		patchedLines, _ := ApplyPatchPure(ctx.Lines, c.Patch, in.SKUs)
		patched := cart.PriceCart(patchedLines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, ctx.Now)
		if patched.DeliveryFeeMinor != 0 {
			continue
		}
		c.BuyerImpact = sim.BuyerImpact
		c.Rank = sim.Rank
		if best == nil || c.Rank > best.Rank || (c.Rank == best.Rank && sku.SKUID < best.Patch.Lines[0].SKUID) {
			cp := c
			best = &cp
		}
	}
	if best == nil {
		return nil
	}
	return []Candidate{*best}
}
