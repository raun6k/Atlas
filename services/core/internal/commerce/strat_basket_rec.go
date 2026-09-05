package commerce

type basketRecStrategy struct{}

func (basketRecStrategy) Type() string { return "BASKET_REC" }

func (basketRecStrategy) Generate(ctx Context, in Inputs) []Candidate {
	cartIDs := cartSKUs(ctx)
	if len(cartIDs) == 0 {
		return nil
	}
	var out []Candidate
	ids := skuIDs(in.SKUs)
	for _, id := range ids {
		sku, ok := sellableOutsideCart(ctx, in, id)
		if !ok {
			continue
		}
		basket := in.Market.BasketAffinity(cartIDs, id)
		user := UserProductAffinity(in.Buyer, sku)
		if user == 0 {
			user = UserBrandAffinity(in.Buyer, sku)
		}
		offer := offerValueForSKU(in, sku)
		score := RecommendationScore(basket, user, offer)
		if score < 0.15 {
			continue
		}
		out = append(out, Candidate{
			Strategy:  "BASKET_REC",
			Patch:     addSKUPatch(sku, 1),
			Relevance: score,
			Vars:      skuVars(sku, 1),
		})
	}
	return bestByRelevance(out)
}

func offerValueForSKU(in Inputs, sku CatalogSKU) float64 {
	best := 0.0
	for _, p := range in.Promotions {
		if !p.Enabled {
			continue
		}
		if !inList(p.EligibleSKUs, sku.SKUID) {
			continue
		}
		terms := in.PromoTerms[p.ID]
		spend := sku.SellingMinor
		d := terms.DiscountCap
		if terms.DiscountRate > 0 {
			d = TotalDiscount(terms.DiscountRate, spend, terms.DiscountCap)
		} else if p.DiscountMinor > 0 {
			d = p.DiscountMinor
		}
		v := OfferValue(d, spend)
		if v > best {
			best = v
		}
	}
	return best
}
