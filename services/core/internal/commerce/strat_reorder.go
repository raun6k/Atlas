package commerce

type reorderStrategy struct{}

func (reorderStrategy) Type() string { return "REORDER" }

func (reorderStrategy) Generate(ctx Context, in Inputs) []Candidate {
	if len(in.Buyer.SKU) == 0 {
		return nil
	}
	var out []Candidate
	ids := skuIDs(in.SKUs)
	for _, id := range ids {
		st, ok := in.Buyer.SKU[id]
		if !ok || st.PurchaseCount < 1 {
			continue
		}
		sku, ok := sellableOutsideCart(ctx, in, id)
		if !ok {
			continue
		}
		score := ReorderScore(st, ctx.Now)
		if score < 0.25 {
			continue
		}
		qty := int(st.UsualQuantity + 0.5)
		out = append(out, Candidate{
			Strategy:  "REORDER",
			Patch:     addSKUPatch(sku, qty),
			Relevance: score,
			Vars: mergeVars(skuVars(sku, qty), map[string]string{
				"median_days": fmtDays(st.MedianDays),
				"days_since":  fmtDays(DaysSince(st.LastBoughtAt, ctx.Now)),
			}),
		})
	}
	return bestByRelevance(out)
}
