package commerce

type brandPromoStrategy struct{}

func (brandPromoStrategy) Type() string { return "BRAND_PROMO" }

func (brandPromoStrategy) Generate(ctx Context, in Inputs) []Candidate {
	qty := map[string]int{}
	for _, l := range ctx.Lines {
		qty[l.SKUID] += l.Quantity
	}
	var out []Candidate
	for _, p := range in.Promotions {
		if !p.Enabled || len(p.EligibleSKUs) == 0 {
			continue
		}
		if ctx.Now.Before(p.StartsAt) || ctx.Now.After(p.EndsAt) {
			continue
		}
		if !contains(p.LocationIDs, ctx.LocationID) {
			continue
		}
		terms := in.PromoTerms[p.ID]
		if terms.BrandFundPct <= 0 && p.Type != "BRAND_CAMPAIGN" {
			continue
		}
		if campaignExhausted(in, p.ID) {
			continue
		}
		target := firstSellable(p.EligibleSKUs, in.SKUs, 1)
		if target == "" {
			continue
		}
		sku, ok := in.SKUs[target]
		if !ok || sku.Sellable < 1 {
			continue
		}
		already := qty[target]
		addQty := 1
		if already == 0 && p.MinimumQty > 1 {
			addQty = p.MinimumQty
		}
		spend := sku.SellingMinor * int64(already+addQty)
		if terms.MinimumSpend > 0 && spend < terms.MinimumSpend {
			continue
		}
		discount := p.DiscountMinor
		if terms.DiscountRate > 0 {
			discount = TotalDiscount(terms.DiscountRate, spend, terms.DiscountCap)
		} else if terms.DiscountCap > 0 && discount > terms.DiscountCap {
			discount = terms.DiscountCap
		}
		brand, merchant := SplitFunding(discount, terms.BrandFundPct, terms.MerchantFundPct)
		_ = brand
		var cogs int64
		if sku.COGSMinor != nil {
			cogs = *sku.COGSMinor * int64(addQty)
		}
		contrib := sku.SellingMinor*int64(addQty) - cogs - merchant
		if contrib < 0 {
			continue
		}
		aff := UserBrandAffinity(in.Buyer, sku)
		score := Clamp01(0.5*OfferValue(discount, spend) + 0.3*aff + 0.2*Norm(float64(contrib), float64(sku.SellingMinor+1)))
		if score < 0.1 {
			continue
		}
		out = append(out, Candidate{
			Strategy:  "BRAND_PROMO",
			Relevance: score,
			Vars: mergeVars(skuVars(sku, addQty), map[string]string{
				"promo_name": p.Name,
				"discount":   INR(discount),
			}),
			Patch: Patch{
				Type:        "PROMOTION",
				PromotionID: p.ID,
				Lines:       []PatchLine{{SKUID: target, Quantity: addQty, Op: "ADD"}},
			},
		})
	}
	return bestByRelevance(out)
}

func campaignExhausted(in Inputs, promoID string) bool {
	for _, c := range in.Campaigns {
		matched := false
		for _, id := range c.PromotionIDs {
			if id == promoID {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if c.BudgetMinor > 0 && c.BudgetConsumed >= c.BudgetMinor {
			return true
		}
	}
	return false
}
