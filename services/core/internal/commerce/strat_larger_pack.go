package commerce

import "sort"

type largerPackStrategy struct{}

func (largerPackStrategy) Type() string { return "LARGER_PACK" }

func (largerPackStrategy) Generate(ctx Context, in Inputs) []Candidate {
	if len(ctx.Lines) == 0 {
		return nil
	}
	lines := append([]cartLines(nil), toCartLines(ctx)...)
	sort.Slice(lines, func(i, j int) bool { return lines[i].LineID < lines[j].LineID })
	var out []Candidate
	for _, l := range lines {
		cur, ok := in.SKUs[l.SKUID]
		if !ok {
			continue
		}
		rate := 0.0
		if st, ok := in.Buyer.SKU[l.SKUID]; ok {
			rate = ConsumptionRate(st.UsualQuantity, st.MedianDays)
		}
		for _, large := range largerPacks(cur, in.SKUs) {
			if large.Sellable < l.Quantity {
				continue
			}
			score := LargerPackScore(cur, large, rate)
			if score <= 0 {
				continue
			}
			out = append(out, Candidate{
				Strategy:  "LARGER_PACK",
				Relevance: score,
				Vars: mergeVars(skuVars(large, l.Quantity), map[string]string{
					"current_name": cur.Name,
					"saving_pct":   fmtPct(UnitSavingPct(cur, large)),
				}),
				Patch: Patch{
					Type:         "REPLACE_ITEM",
					SourceLineID: l.LineID,
					SourceSKUID:  l.SKUID,
					Lines:        []PatchLine{{SKUID: large.SKUID, Quantity: l.Quantity, Op: "REPLACE"}},
				},
			})
		}
	}
	return bestByRelevance(out)
}

type cartLines struct {
	LineID   string
	SKUID    string
	Quantity int
}

func toCartLines(ctx Context) []cartLines {
	var out []cartLines
	for _, l := range ctx.Lines {
		out = append(out, cartLines{LineID: l.LineID, SKUID: l.SKUID, Quantity: l.Quantity})
	}
	return out
}
