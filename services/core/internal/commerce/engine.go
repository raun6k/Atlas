package commerce

import (
	"sort"
	"strings"
	"time"

	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/inventory"
)

type Candidate struct {
	Strategy       string
	Reason         string
	Terms          string
	Patch          Patch
	BuyerImpact    int64
	Rank           float64
	BaseAllInMinor int64
	PatchedAllIn   int64
	Eligibility    string
}

type Patch struct {
	Type         string
	Lines        []PatchLine
	SourceLineID string
	SourceSKUID  string
	PromotionID  string
	BundleID     string
}

type PatchLine struct {
	SKUID    string
	Quantity int
	Op       string
}

type Context struct {
	LocationID                 string
	MerchandiseMinor           int64
	AllInMinor                 int64
	BudgetMinor                int64
	HasBudget                  bool
	FreeDeliveryThresholdMinor int64
	DeliveryFeeMinor           int64
	Lines                      []cart.Line
	Enabled                    map[string]bool
	Fees                       cart.LocationFees
	Constraints                map[string]string
	Mission                    string
	EvaluationArm              string
	Now                        time.Time
}

type CatalogSKU struct {
	SKUID        string
	ProductID    string
	Name         string
	SellingMinor int64
	Sellable     int
	Category     string
	Brand        string
	COGSMinor    *int64
}

type GraphEdge struct {
	Source     string
	Target     string
	Type       string
	Confidence float64
}

type Inputs struct {
	Promotions []cart.Promotion
	Bundles    []cart.Bundle
	SKUs       map[string]CatalogSKU
	Edges      []GraphEdge
}

var strategyOrder = []string{"THRESHOLD", "PROMOTION", "BUNDLE", "COMPLEMENT", "UPSELL", "CROSS_SELL"}

func Select(ctx Context, in Inputs) []Candidate {
	if ctx.EvaluationArm == "CONTROL" {
		return nil
	}
	if ctx.Now.IsZero() {
		ctx.Now = time.Now().UTC()
	}
	if ctx.Fees.FreeDeliveryThresholdMinor == 0 {
		ctx.Fees.FreeDeliveryThresholdMinor = ctx.FreeDeliveryThresholdMinor
		ctx.Fees.DeliveryFeeMinor = ctx.DeliveryFeeMinor
	}
	var raw []Candidate
	if ctx.Enabled["THRESHOLD"] {
		raw = append(raw, threshold(ctx, in)...)
	}
	if ctx.Enabled["PROMOTION"] {
		raw = append(raw, promotion(ctx, in)...)
	}
	if ctx.Enabled["BUNDLE"] {
		raw = append(raw, bundle(ctx, in)...)
	}
	if ctx.Enabled["CROSS_SELL"] {
		raw = append(raw, crossSell(ctx, in)...)
	}
	if ctx.Enabled["COMPLEMENT"] {
		raw = append(raw, complement(ctx, in)...)
	}
	if ctx.Enabled["UPSELL"] {
		raw = append(raw, upsell(ctx, in)...)
	}
	var scored []Candidate
	for _, c := range raw {
		if len(c.Patch.Lines) == 0 {
			continue
		}
		if !constraintOK(ctx, in, c) {
			continue
		}
		sim, err := Simulate(ctx, in, c, ctx.Now)
		if err != nil {
			continue
		}
		if sim.Eligibility != "OK" {
			continue
		}
		if sim.Rank <= 0 {
			continue
		}
		c.BuyerImpact = sim.BuyerImpact
		c.Rank = sim.Rank
		c.BaseAllInMinor = sim.BaseAllInMinor
		c.PatchedAllIn = sim.PatchedAllInMinor
		c.Eligibility = sim.Eligibility
		if sim.ContributionDeltaMinor == nil {
			c.Eligibility = "ECONOMICS_INCOMPLETE"
		}
		scored = append(scored, c)
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Rank != scored[j].Rank {
			return scored[i].Rank > scored[j].Rank
		}
		oi, oj := strategyIndex(scored[i].Strategy), strategyIndex(scored[j].Strategy)
		if oi != oj {
			return oi < oj
		}
		return candidateKey(scored[i]) < candidateKey(scored[j])
	})
	return conflictFilter(scored, 3)
}

func strategyIndex(s string) int {
	for i, v := range strategyOrder {
		if v == s {
			return i
		}
	}
	return len(strategyOrder)
}

func candidateKey(c Candidate) string {
	if len(c.Patch.Lines) == 0 {
		return c.Strategy
	}
	return c.Strategy + ":" + c.Patch.Lines[0].SKUID
}

func constraintOK(ctx Context, in Inputs, c Candidate) bool {
	if len(ctx.Constraints) == 0 {
		return true
	}
	excludeBrand := strings.ToLower(ctx.Constraints["exclude_brand"])
	excludeCategory := strings.ToLower(ctx.Constraints["exclude_category"])
	dietary := strings.ToLower(ctx.Constraints["dietary"])
	for _, l := range c.Patch.Lines {
		sku, ok := in.SKUs[l.SKUID]
		if !ok {
			return false
		}
		if excludeBrand != "" && strings.Contains(strings.ToLower(sku.Brand), excludeBrand) {
			return false
		}
		if excludeCategory != "" && strings.Contains(strings.ToLower(sku.Category), excludeCategory) {
			return false
		}
		if dietary == "veg" && strings.Contains(strings.ToLower(sku.Name+" "+sku.Category), "chicken") {
			return false
		}
	}
	return true
}

func threshold(ctx Context, in Inputs) []Candidate {
	base := cart.PriceCart(ctx.Lines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, ctx.Now)
	if ctx.Fees.FreeDeliveryThresholdMinor <= 0 || base.MerchandiseMinor-base.DiscountsMinor >= ctx.Fees.FreeDeliveryThresholdMinor {
		return nil
	}
	inCart := map[string]bool{}
	for _, l := range ctx.Lines {
		inCart[l.SKUID] = true
	}
	ids := skuIDs(in.SKUs)
	var best *Candidate
	for _, id := range ids {
		sku := in.SKUs[id]
		if inCart[sku.SKUID] || sku.Sellable < 1 || sku.SellingMinor <= 0 {
			continue
		}
		c := Candidate{
			Strategy: "THRESHOLD",
			Reason:   "Adds " + sku.Name + " to reach the free-delivery threshold",
			Terms:    "Free delivery at the configured merchandise threshold",
			Patch:    Patch{Type: "ADD_ITEM", Lines: []PatchLine{{SKUID: sku.SKUID, Quantity: 1, Op: "ADD"}}},
		}
		sim, err := Simulate(ctx, in, c, ctx.Now)
		if err != nil || sim.Eligibility != "OK" {
			continue
		}
		if sim.PatchedAllInMinor <= 0 {
			continue
		}
		patchedLines, _ := ApplyPatchPure(ctx.Lines, c.Patch, in.SKUs)
		patched := cart.PriceCart(patchedLines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, ctx.Now)
		if patched.DeliveryFeeMinor != 0 {
			continue
		}
		c.BuyerImpact = sim.BuyerImpact
		c.Rank = sim.Rank
		if best == nil || c.Rank > best.Rank || (c.Rank == best.Rank && sku.SKUID < best.Patch.Lines[0].SKUID) {
			cp := c
			best = &cp
		}
	}
	if best == nil {
		return nil
	}
	return []Candidate{*best}
}

func promotion(ctx Context, in Inputs) []Candidate {
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

func bundle(ctx Context, in Inputs) []Candidate {
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

func crossSell(ctx Context, in Inputs) []Candidate {
	return graphAdd(ctx, in, []string{"USED_WITH", "BUNDLE_COMPATIBLE"}, "CROSS_SELL", "Pairs with an item already in the cart")
}

func complement(ctx Context, in Inputs) []Candidate {
	return graphAdd(ctx, in, []string{"COMPLEMENT", "CONSUMED_WITH"}, "COMPLEMENT", "Merchant-configured complement for a cart item")
}

func graphAdd(ctx Context, in Inputs, types []string, strategy, reason string) []Candidate {
	inCart := map[string]bool{}
	for _, l := range ctx.Lines {
		inCart[l.SKUID] = true
		inCart[l.ProductID] = true
	}
	seen := map[string]bool{}
	var out []Candidate
	edges := append([]GraphEdge(nil), in.Edges...)
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Target < edges[j].Target
	})
	for _, e := range edges {
		if !inList(types, e.Type) {
			continue
		}
		if e.Confidence > 0 && e.Confidence < 0.3 {
			continue
		}
		if !inCart[e.Source] {
			continue
		}
		sku, ok := resolveTarget(in.SKUs, e.Target)
		if !ok || inCart[sku.SKUID] || sku.Sellable < 1 || seen[sku.SKUID] {
			continue
		}
		seen[sku.SKUID] = true
		out = append(out, Candidate{
			Strategy: strategy,
			Reason:   reason + ": " + sku.Name,
			Terms:    e.Type,
			Patch:    Patch{Type: "ADD_ITEM", Lines: []PatchLine{{SKUID: sku.SKUID, Quantity: 1, Op: "ADD"}}},
		})
	}
	return out
}

func resolveTarget(skus map[string]CatalogSKU, target string) (CatalogSKU, bool) {
	if sku, ok := skus[target]; ok {
		return sku, true
	}
	ids := skuIDs(skus)
	for _, id := range ids {
		s := skus[id]
		if s.ProductID == target {
			return s, true
		}
	}
	return CatalogSKU{}, false
}

func skuIDs(skus map[string]CatalogSKU) []string {
	ids := make([]string, 0, len(skus))
	for id := range skus {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func upsell(ctx Context, in Inputs) []Candidate {
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

func conflictFilter(in []Candidate, n int) []Candidate {
	usedSKU := map[string]bool{}
	usedStrat := map[string]bool{}
	usedSource := map[string]bool{}
	var out []Candidate
	for _, c := range in {
		if usedStrat[c.Strategy] {
			continue
		}
		conflict := false
		if c.Patch.SourceLineID != "" && usedSource[c.Patch.SourceLineID] {
			conflict = true
		}
		for _, l := range c.Patch.Lines {
			if usedSKU[l.SKUID] {
				conflict = true
				break
			}
		}
		if conflict {
			continue
		}
		usedStrat[c.Strategy] = true
		if c.Patch.SourceLineID != "" {
			usedSource[c.Patch.SourceLineID] = true
		}
		for _, l := range c.Patch.Lines {
			usedSKU[l.SKUID] = true
		}
		out = append(out, c)
		if len(out) >= n {
			break
		}
	}
	return out
}

func contains(ids []string, id string) bool {
	if len(ids) == 0 {
		return true
	}
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func inList(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
