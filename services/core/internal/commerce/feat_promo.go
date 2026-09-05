package commerce

type Campaign struct {
	ID                 string
	BrandID            string
	Brand              string
	PromotionIDs       []string
	BudgetMinor        int64
	BudgetConsumed     int64
	BrandFundingPct    int
	MerchantFundingPct int
}

type PromoTerms struct {
	DiscountRate    float64
	DiscountCap     int64
	MinimumSpend    int64
	BrandFundPct    int
	MerchantFundPct int
	MaxPerBuyer     int
	MaxPerSession   int
}

func TotalDiscount(rate float64, eligibleSpend, cap int64) int64 {
	d := int64(rate * float64(eligibleSpend) / 100)
	if cap > 0 && d > cap {
		d = cap
	}
	if d < 0 {
		return 0
	}
	return d
}

func SplitFunding(total int64, brandPct, merchantPct int) (brand, merchant int64) {
	if brandPct+merchantPct == 0 {
		return 0, total
	}
	brand = total * int64(brandPct) / 100
	merchant = total * int64(merchantPct) / 100
	return brand, merchant
}

func OfferValue(discount, spend int64) float64 {
	if spend <= 0 {
		if discount > 0 {
			return 1
		}
		return 0
	}
	return Clamp01(float64(discount) / float64(spend))
}
