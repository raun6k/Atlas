package commerce

type cartCompletionStrategy struct{}

func (cartCompletionStrategy) Type() string { return "CART_COMPLETION" }

func (cartCompletionStrategy) Generate(ctx Context, in Inputs) []Candidate {
	cartIDs := cartSKUs(ctx)
	if len(cartIDs) < 2 {
		return nil
	}
	var out []Candidate
	ids := skuIDs(in.SKUs)
	for _, id := range ids {
		sku, ok := sellableOutsideCart(ctx, in, id)
		if !ok {
			continue
		}
		assoc := in.Market.BasketAssociation(cartIDs, id)
		personal := in.Market.PersonalBasketScore(id)
		repl := 0.0
		if st, ok := in.Buyer.SKU[id]; ok {
			repl = ReplenishmentScore(DaysSince(st.LastBoughtAt, ctx.Now), st.MedianDays)
		}
		score := CompletionScore(personal, assoc, repl)
		if score < 0.2 {
			continue
		}
		out = append(out, Candidate{
			Strategy:  "CART_COMPLETION",
			Patch:     addSKUPatch(sku, 1),
			Relevance: score,
			Vars:      skuVars(sku, 1),
		})
	}
	return bestByRelevance(out)
}
