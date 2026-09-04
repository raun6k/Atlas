package commerce

import (
	"fmt"
	"sort"
	"time"

	"atlas.dev/core/internal/cart"
)

type SimulatedCandidate struct {
	Candidate
	BaseAllInMinor          int64
	PatchedAllInMinor       int64
	MerchantRevenueDeltaMinor int64
	ContributionDeltaMinor  *int64
	Eligibility             string
}

func Simulate(ctx Context, in Inputs, c Candidate, now time.Time) (SimulatedCandidate, error) {
	base := cart.PriceCart(ctx.Lines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, now)
	patchedLines, err := ApplyPatchPure(ctx.Lines, c.Patch, in.SKUs)
	if err != nil {
		return SimulatedCandidate{}, err
	}
	patched := cart.PriceCart(patchedLines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, now)
	impact := patched.AllInMinor - base.AllInMinor
	out := SimulatedCandidate{
		Candidate:                 c,
		BaseAllInMinor:            base.AllInMinor,
		PatchedAllInMinor:         patched.AllInMinor,
		MerchantRevenueDeltaMinor: impact,
		Eligibility:               "OK",
	}
	out.BuyerImpact = impact
	if ctx.HasBudget && patched.AllInMinor > ctx.BudgetMinor {
		out.Eligibility = "OVER_BUDGET"
	}
	if !patched.MinimumOrderMet {
		out.Eligibility = "BELOW_MINIMUM_ORDER"
	}
	var contrib int64
	complete := true
	for _, l := range patchedLines {
		sku, ok := in.SKUs[l.SKUID]
		if !ok || sku.COGSMinor == nil {
			complete = false
			break
		}
		contrib += (sku.SellingMinor - *sku.COGSMinor) * int64(l.Quantity)
	}
	if complete {
		var baseC int64
		baseComplete := true
		for _, l := range ctx.Lines {
			sku, ok := in.SKUs[l.SKUID]
			if !ok || sku.COGSMinor == nil {
				baseComplete = false
				break
			}
			baseC += (sku.SellingMinor - *sku.COGSMinor) * int64(l.Quantity)
		}
		if baseComplete {
			d := contrib - baseC
			out.ContributionDeltaMinor = &d
			if d < 0 {
				out.Eligibility = "NEGATIVE_CONTRIBUTION"
			}
		}
	}
	out.Rank = conservativeScore(out)
	return out, nil
}

func conservativeScore(s SimulatedCandidate) float64 {
	score := float64(s.MerchantRevenueDeltaMinor)
	if s.ContributionDeltaMinor != nil {
		score += float64(*s.ContributionDeltaMinor) / 10
	}
	if s.BuyerImpact > 0 && s.MerchantRevenueDeltaMinor > 0 {
		overshoot := s.BuyerImpact
		if overshoot > 5000 {
			score -= float64(overshoot-5000) / 100
		}
	}
	return score
}

func ApplyPatchPure(lines []cart.Line, patch Patch, skus map[string]CatalogSKU) ([]cart.Line, error) {
	out := append([]cart.Line(nil), lines...)
	if patch.Type == "REPLACE_ITEM" {
		found := false
		var next []cart.Line
		for _, l := range out {
			if l.LineID == patch.SourceLineID || (patch.SourceSKUID != "" && l.SKUID == patch.SourceSKUID) {
				found = true
				continue
			}
			next = append(next, l)
		}
		if !found {
			return nil, fmt.Errorf("replace source missing")
		}
		out = next
	}
	for _, pl := range patch.Lines {
		if pl.Op == "REMOVE" {
			var next []cart.Line
			for _, l := range out {
				if l.SKUID != pl.SKUID {
					next = append(next, l)
				}
			}
			out = next
			continue
		}
		sku, ok := skus[pl.SKUID]
		if !ok {
			return nil, fmt.Errorf("unknown sku %s", pl.SKUID)
		}
		replaced := false
		for i, l := range out {
			if l.SKUID != pl.SKUID {
				continue
			}
			qty := l.Quantity
			if pl.Op == "REPLACE" {
				qty = pl.Quantity
			} else {
				qty += pl.Quantity
			}
			out[i].Quantity = qty
			out[i].UnitMinor = sku.SellingMinor
			out[i].LineMinor = sku.SellingMinor * int64(qty)
			replaced = true
			break
		}
		if !replaced {
			out = append(out, cart.Line{
				LineID:    "sim_" + pl.SKUID,
				SKUID:     pl.SKUID,
				ProductID: sku.ProductID,
				Name:      sku.Name,
				Quantity:  pl.Quantity,
				UnitMinor: sku.SellingMinor,
				LineMinor: sku.SellingMinor * int64(pl.Quantity),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SKUID < out[j].SKUID })
	return out, nil
}
