package commerce

import "sort"

type promotionStrategy struct{}

func (promotionStrategy) Type() string { return "PROMOTION" }

func (promotionStrategy) Generate(ctx Context, in Inputs) []Candidate {
	qty := map[string]int{}
	for _, l := range ctx.Lines {
		qty[l.SKUID] += l.Quantity
	}
	var out []Candidate
	for _, p := range in.Promotions {
		if !p.Enabled || p.MinimumQty <= 0 || len(p.EligibleSKUs) == 0 {
			continue
		}
		if ctx.Now.Before(p.StartsAt) || ctx.Now.After(p.EndsAt) {
			continue
		}
		if !contains(p.LocationIDs, ctx.LocationID) {
			continue
		}
		var n int
		for _, sku := range p.EligibleSKUs {
			n += qty[sku]
		}
		if n == 0 || n >= p.MinimumQty {
			continue
		}
		need := p.MinimumQty - n
		target := firstSellable(p.EligibleSKUs, in.SKUs, need)
		if target == "" {
			continue
		}
		out = append(out, Candidate{
			Strategy: "PROMOTION",
			Reason:   "Add qualifying items to earn " + p.Name,
			Terms:    p.Name,
			Patch: Patch{
				Type:        "PROMOTION",
				PromotionID: p.ID,
				Lines:       []PatchLine{{SKUID: target, Quantity: need, Op: "ADD"}},
			},
		})
	}
	return out
}

func firstSellable(ids []string, skus map[string]CatalogSKU, need int) string {
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	for _, id := range sorted {
		sku, ok := skus[id]
		if ok && sku.Sellable >= need {
			return id
		}
	}
	return ""
}
