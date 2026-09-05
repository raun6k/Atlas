package commerce

type fbtStrategy struct{}

func (fbtStrategy) Type() string { return "FBT" }

func (fbtStrategy) Generate(ctx Context, in Inputs) []Candidate {
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
		best := 0.0
		anchor := ""
		for _, i := range cartIDs {
			s := in.Market.FBTScore(i, id)
			if s > best {
				best = s
				anchor = i
			}
		}
		if best < 0.05 {
			continue
		}
		anchorName := sku.Name
		if src, ok := in.SKUs[anchor]; ok {
			anchorName = src.Name
		}
		out = append(out, Candidate{
			Strategy:  "FBT",
			Patch:     addSKUPatch(sku, 1),
			Relevance: best,
			Vars:      mergeVars(skuVars(sku, 1), map[string]string{"anchor_name": anchorName}),
		})
	}
	return bestByRelevance(out)
}
