package commerce

import (
	"sort"

	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/inventory"
)

type upsellStrategy struct{}

func (upsellStrategy) Type() string { return "UPSELL" }

func (upsellStrategy) Generate(ctx Context, in Inputs) []Candidate {
	var out []Candidate
	lines := append([]cart.Line(nil), ctx.Lines...)
	sort.Slice(lines, func(i, j int) bool { return lines[i].LineID < lines[j].LineID })
	for _, l := range lines {
		edges := append([]GraphEdge(nil), in.Edges...)
		sort.Slice(edges, func(i, j int) bool { return edges[i].Target < edges[j].Target })
		for _, e := range edges {
			if e.Type != "UPGRADE" {
				continue
			}
			if e.Source != l.SKUID && e.Source != l.ProductID {
				continue
			}
			sku, ok := resolveTarget(in.SKUs, e.Target)
			if !ok || sku.SKUID == l.SKUID || sku.Sellable < l.Quantity {
				continue
			}
			if inventory.Sellable(sku.Sellable, 0, 0) < l.Quantity && sku.Sellable < l.Quantity {
				continue
			}
			out = append(out, Candidate{
				Strategy: "UPSELL",
				Reason:   "Replace " + l.Name + " with " + sku.Name,
				Terms:    "REPLACE_ITEM",
				Patch: Patch{
					Type:         "REPLACE_ITEM",
					SourceLineID: l.LineID,
					SourceSKUID:  l.SKUID,
					Lines:        []PatchLine{{SKUID: sku.SKUID, Quantity: l.Quantity, Op: "REPLACE"}},
				},
			})
		}
	}
	return out
}
