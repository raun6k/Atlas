package commerce

type replenishmentStrategy struct{}

func (replenishmentStrategy) Type() string { return "REPLENISHMENT" }

func (replenishmentStrategy) Generate(ctx Context, in Inputs) []Candidate {
	if len(in.Buyer.SKU) == 0 {
		return nil
	}
	var out []Candidate
	ids := skuIDs(in.SKUs)
	for _, id := range ids {
		st, ok := in.Buyer.SKU[id]
		if !ok || st.MedianDays <= 0 {
			continue
		}
		sku, ok := sellableOutsideCart(ctx, in, id)
		if !ok {
			continue
		}
		days := DaysSince(st.LastBoughtAt, ctx.Now)
		score := ReplenishmentScore(days, st.MedianDays)
		if score < 0.45 {
			continue
		}
		qty := st.LastQuantity
		if qty < 1 {
			qty = 1
		}
		out = append(out, Candidate{
			Strategy:  "REPLENISHMENT",
			Patch:     addSKUPatch(sku, qty),
			Relevance: score,
			Vars: mergeVars(skuVars(sku, qty), map[string]string{
				"median_days": fmtDays(st.MedianDays),
				"days_since":  fmtDays(days),
			}),
		})
	}
	return bestByRelevance(out)
}
