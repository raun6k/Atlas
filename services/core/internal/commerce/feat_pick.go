package commerce

import "sort"

func addSKUPatch(sku CatalogSKU, qty int) Patch {
	if qty < 1 {
		qty = 1
	}
	return Patch{Type: "ADD_ITEM", Lines: []PatchLine{{SKUID: sku.SKUID, Quantity: qty, Op: "ADD"}}}
}

func sellableOutsideCart(ctx Context, in Inputs, skuID string) (CatalogSKU, bool) {
	inCart := inCartSet(ctx)
	sku, ok := in.SKUs[skuID]
	if !ok || inCart[sku.SKUID] || sku.Sellable < 1 || sku.SellingMinor <= 0 {
		return CatalogSKU{}, false
	}
	return sku, true
}

func bestByRelevance(cands []Candidate) []Candidate {
	if len(cands) == 0 {
		return nil
	}
	best := cands[0]
	for _, c := range cands[1:] {
		if c.Relevance > best.Relevance || (c.Relevance == best.Relevance && candidateKey(c) < candidateKey(best)) {
			best = c
		}
	}
	return []Candidate{best}
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
