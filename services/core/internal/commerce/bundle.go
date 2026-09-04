package commerce

import (
	"sort"

	"atlas.dev/core/internal/cart"
)

type bundleStrategy struct{}

func (bundleStrategy) Type() string { return "BUNDLE" }

func (bundleStrategy) Generate(ctx Context, in Inputs) []Candidate {
	qty := map[string]int{}
	for _, l := range ctx.Lines {
		qty[l.SKUID] += l.Quantity
	}
	var out []Candidate
	bundles := append([]cart.Bundle(nil), in.Bundles...)
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].ID < bundles[j].ID })
	for _, b := range bundles {
		if !contains(b.LocationIDs, ctx.LocationID) {
			continue
		}
		var missing []PatchLine
		complete := true
		needIDs := make([]string, 0, len(b.SKUQuantities))
		for sku := range b.SKUQuantities {
			needIDs = append(needIDs, sku)
		}
		sort.Strings(needIDs)
		for _, sku := range needIDs {
			need := b.SKUQuantities[sku]
			have := qty[sku]
			if have >= need {
				continue
			}
			cat, ok := in.SKUs[sku]
			if !ok || cat.Sellable < (need-have) {
				complete = false
				break
			}
			missing = append(missing, PatchLine{SKUID: sku, Quantity: need - have, Op: "ADD"})
		}
		if !complete || len(missing) == 0 {
			continue
		}
		out = append(out, Candidate{
			Strategy: "BUNDLE",
			Reason:   "Complete the " + b.Name + " bundle",
			Terms:    b.Name,
			Patch:    Patch{Type: "BUNDLE", BundleID: b.ID, Lines: missing},
		})
	}
	return out
}
