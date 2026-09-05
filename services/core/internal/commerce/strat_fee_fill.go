package commerce

import (
	"atlas.dev/core/internal/cart"
)

type freeDeliveryStrategy struct{}

func (freeDeliveryStrategy) Type() string { return "FREE_DELIVERY" }

func (freeDeliveryStrategy) Generate(ctx Context, in Inputs) []Candidate {
	return feeFill(ctx, in, "FREE_DELIVERY",
		ctx.Fees.FreeDeliveryThresholdMinor,
		ctx.Fees.DeliveryFeeMinor,
		ctx.Fees.DeliveryFeeAfterThresholdMinor)
}

type smallOrderStrategy struct{}

func (smallOrderStrategy) Type() string { return "SMALL_ORDER" }

func (smallOrderStrategy) Generate(ctx Context, in Inputs) []Candidate {
	return feeFill(ctx, in, "SMALL_ORDER",
		ctx.Fees.SmallOrderThresholdMinor,
		ctx.Fees.SmallOrderFeeMinor,
		ctx.Fees.FeeAfterSmallOrderThresholdMinor)
}

func feeFill(ctx Context, in Inputs, strategy string, threshold, currentFee, afterFee int64) []Candidate {
	if threshold <= 0 || currentFee <= afterFee {
		return nil
	}
	base := cart.PriceCart(ctx.Lines, ctx.Fees, in.Promotions, in.Bundles, ctx.LocationID, ctx.Now)
	sub := base.MerchandiseMinor - base.DiscountsMinor
	gap := ThresholdGap(threshold, sub)
	if gap == 0 {
		return nil
	}
	saving := FeeSaving(currentFee, afterFee)
	var out []Candidate
	ids := skuIDs(in.SKUs)
	for _, id := range ids {
		sku, ok := sellableOutsideCart(ctx, in, id)
		if !ok {
			continue
		}
		useful := UsefulHistoryScore(in.Buyer, id, ctx.Now)
		if useful == 0 {
			useful = in.Market.PersonalBasketScore(id)
		}
		score := FillScore(useful, sku.SellingMinor, saving, gap)
		if score < 0.12 {
			continue
		}
		patch := addSKUPatch(sku, 1)
		patch.Economics = &OfferEconomics{
			ItemCostMinor:     sku.SellingMinor,
			ThresholdGapMinor: gap,
			FeeSavingMinor:    saving,
		}
		out = append(out, Candidate{
			Strategy:  strategy,
			Patch:     patch,
			Relevance: score,
			Vars: mergeVars(skuVars(sku, 1), map[string]string{
				"gap":        INR(gap),
				"fee_saving": INR(saving),
			}),
		})
	}
	return bestByRelevance(out)
}
