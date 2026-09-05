package commerce

import (
	"math"
	"sort"
	"strings"
	"time"

	"atlas.dev/core/internal/cart"
)

type Candidate struct {
	Strategy       string
	Reason         string
	Terms          string
	Patch          Patch
	BuyerImpact    int64
	Rank           float64
	Relevance      float64
	Vars           map[string]string
	BaseAllInMinor int64
	PatchedAllIn   int64
	Eligibility    string
	Economics      RuntimeEconomics
	Explanation    PublicExplanation
}

// Drop is a public commercial decision without private scores.
type Drop struct {
	Strategy    string
	Eligibility string
	Reason      string
}

type OfferEconomics struct {
	ItemCostMinor     int64 `json:"item_cost_minor,omitempty"`
	ThresholdGapMinor int64 `json:"threshold_gap_minor,omitempty"`
	FeeSavingMinor    int64 `json:"fee_saving_minor,omitempty"`
}

type Patch struct {
	Type         string
	Lines        []PatchLine
	SourceLineID string
	SourceSKUID  string
	PromotionID  string
	BundleID     string
	Economics    *OfferEconomics `json:"economics,omitempty"`
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
	BuyerID                    string
	Query                      string
}

type CatalogSKU struct {
	SKUID         string
	ProductID     string
	Name          string
	SellingMinor  int64
	Sellable      int
	Category      string
	CategoryID    string
	SubcategoryID string
	Brand         string
	BrandID       string
	COGSMinor     *int64
	PackSize      int
	PackCount     int
	NetUnit       string
	ShelfLifeDays *int
	Rating        float64
	Reviews       int
	ProductActive bool
}

// GraphEdge is fixture-advisory catalog metadata. It is not substitution, inventory, or payment authority.
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
	Buyer      BuyerSignals
	Market     BasketIndex
	Campaigns  []Campaign
	PromoTerms map[string]PromoTerms
	Copy       map[string]BuyerCopy
	Revisions  map[string]string
}

var strategyOrder = []string{
	"REORDER", "REPLENISHMENT", "ROUTINE", "CART_COMPLETION", "BASKET_REC", "FBT",
	"LARGER_PACK", "FREE_DELIVERY", "SMALL_ORDER", "BRAND_PROMO",
}

func Select(ctx Context, in Inputs) []Candidate {
	shown, _ := SelectTrace(ctx, in)
	return shown
}

func SelectTrace(ctx Context, in Inputs) ([]Candidate, []Drop) {
	if ctx.EvaluationArm == "CONTROL" {
		return nil, []Drop{{Reason: "CONTROL_ARM"}}
	}
	if ctx.Now.IsZero() {
		ctx.Now = time.Now().UTC()
	}
	if ctx.Fees.FreeDeliveryThresholdMinor == 0 {
		ctx.Fees.FreeDeliveryThresholdMinor = ctx.FreeDeliveryThresholdMinor
		ctx.Fees.DeliveryFeeMinor = ctx.DeliveryFeeMinor
	}
	var raw []Candidate
	for _, s := range registry {
		if ctx.Enabled[s.Type()] {
			raw = append(raw, s.Generate(ctx, in)...)
		}
	}
	var scored []Candidate
	var dropped []Drop
	for _, c := range raw {
		if len(c.Patch.Lines) == 0 {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Reason: "EMPTY_PATCH"})
			continue
		}
		if !constraintOK(ctx, in, c) {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Reason: "CONSTRAINT"})
			continue
		}
		sim, err := Simulate(ctx, in, c, ctx.Now)
		if err != nil {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Reason: "SIMULATE_FAILED"})
			continue
		}
		if sim.Eligibility != "OK" {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Eligibility: sim.Eligibility, Reason: sim.Eligibility})
			continue
		}
		if c.Relevance <= 0 && sim.Rank <= 0 {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Eligibility: sim.Eligibility, Reason: "RANK_ZERO"})
			continue
		}
		c.Rank = sim.Rank
		if c.Relevance > 0 {
			c.Rank = c.Relevance*10000 + math.Max(0, sim.Rank)/1000
		}
		if sim.ContributionDeltaMinor == nil {
			sim.Eligibility = "ECONOMICS_INCOMPLETE"
		}
		AttachEconomics(&c, sim, in)
		applyBuyerCopy(&c, in)
		c.Explanation = ExplainCandidate(c)
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
	shown, extra := conflictFilter(scored, 3)
	return shown, append(dropped, extra...)
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

func skuIDs(skus map[string]CatalogSKU) []string {
	ids := make([]string, 0, len(skus))
	for id := range skus {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func conflictFilter(in []Candidate, n int) ([]Candidate, []Drop) {
	usedSKU := map[string]bool{}
	usedStrat := map[string]bool{}
	usedSource := map[string]bool{}
	var out []Candidate
	var dropped []Drop
	for _, c := range in {
		if len(out) >= n {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Eligibility: c.Eligibility, Reason: "SLOT_CAP"})
			continue
		}
		if usedStrat[c.Strategy] {
			dropped = append(dropped, Drop{Strategy: c.Strategy, Eligibility: c.Eligibility, Reason: "STRATEGY_DUP"})
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
			dropped = append(dropped, Drop{Strategy: c.Strategy, Eligibility: c.Eligibility, Reason: "CONFLICT"})
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
	}
	return out, dropped
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
