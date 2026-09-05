package commerce

type routineStrategy struct{}

func (routineStrategy) Type() string { return "ROUTINE" }

func (routineStrategy) Generate(ctx Context, in Inputs) []Candidate {
	if len(in.Buyer.Routines) == 0 {
		return nil
	}
	var best *Candidate
	for _, r := range in.Buyer.Routines {
		if r.CadenceDays <= 0 {
			continue
		}
		due := DueScore(DaysSince(r.LastOrderedAt, ctx.Now), float64(r.CadenceDays))
		if due < 0.6 {
			continue
		}
		var lines []PatchLine
		var scoreSum float64
		n := 0
		for _, it := range r.Items {
			sku, ok := sellableOutsideCart(ctx, in, it.SKUID)
			if !ok {
				continue
			}
			qty := it.UsualQuantity
			if qty < 1 {
				qty = 1
			}
			lines = append(lines, PatchLine{SKUID: sku.SKUID, Quantity: qty, Op: "ADD"})
			inc := 1.0
			if st, ok := in.Buyer.SKU[it.SKUID]; ok && st.PurchaseCount > 0 {
				inc = float64(st.PurchaseCount) / float64(st.PurchaseCount+1)
			}
			scoreSum += inc * due
			n++
		}
		if len(lines) == 0 {
			continue
		}
		rel := scoreSum / float64(n)
		firstName := in.SKUs[lines[0].SKUID].Name
		c := Candidate{
			Strategy:  "ROUTINE",
			Patch:     Patch{Type: "ADD_ITEMS", Lines: lines},
			Relevance: rel,
			Vars: map[string]string{
				"routine_id":   r.ID,
				"routine_name": r.Name,
				"cadence_days": itoa(r.CadenceDays),
				"item_count":   itoa(len(lines)),
				"sku_name":     firstName,
			},
		}
		if best == nil || c.Relevance > best.Relevance || (c.Relevance == best.Relevance && r.ID < best.Vars["routine_id"]) {
			cp := c
			best = &cp
		}
	}
	if best == nil {
		return nil
	}
	return []Candidate{*best}
}
