package commerce

import "strings"

type RankedHit struct {
	SKUID          string
	QueryRelevance float64
	PriceMinor     int64
	Rating         float64
	Sellable       int
	ProductID      string
	Brand          string
	BrandID        string
	CategoryID     string
}

func QueryRelevance(query, name, brand, category string) float64 {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return 0.5
	}
	n := strings.ToLower(name)
	if n == q {
		return 1
	}
	if strings.Contains(n, q) {
		return 0.85
	}
	if strings.Contains(strings.ToLower(brand), q) {
		return 0.65
	}
	if strings.Contains(strings.ToLower(category), q) {
		return 0.5
	}
	return 0.2
}

func PriceCompetitiveness(price, medianComparable int64) float64 {
	if price <= 0 {
		return 0
	}
	if medianComparable <= 0 {
		return 0.5
	}
	return Clamp01(float64(medianComparable) / float64(price))
}

func AvailabilityScore(sellable int) float64 {
	if sellable > 0 {
		return 1
	}
	return 0
}

func RatingScore(rating float64) float64 {
	return Clamp01(rating / 5)
}

func SearchScore(queryRel, userAff, purchaseProb, priceComp, avail, rating float64) float64 {
	return 0.45*queryRel + 0.20*userAff + 0.10*purchaseProb + 0.10*priceComp + 0.10*avail + 0.05*rating
}

func RankCatalog(ctx Context, in Inputs, hits []RankedHit) []RankedHit {
	if len(hits) == 0 {
		return hits
	}
	useSearch := ctx.Enabled["SEARCH_RANKING"]
	usePast := ctx.Enabled["PAST_PURCHASE"]
	if !useSearch && !usePast {
		return hits
	}
	prices := make([]float64, 0, len(hits))
	for _, h := range hits {
		if h.PriceMinor > 0 {
			prices = append(prices, float64(h.PriceMinor))
		}
	}
	median := int64(medianFloat(prices))
	type scored struct {
		h RankedHit
		s float64
		k string
	}
	var rows []scored
	for _, h := range hits {
		sku := in.SKUs[h.SKUID]
		userAff := UserProductAffinity(in.Buyer, sku)
		if userAff == 0 {
			userAff = UserBrandAffinity(in.Buyer, sku)
		}
		st := in.Buyer.SKU[h.SKUID]
		purchase := PastPurchaseScore(st, ctx.Now)
		if !usePast {
			userAff, purchase = 0, 0
		}
		qrel := h.QueryRelevance
		if qrel == 0 {
			qrel = 0.5
		}
		var s float64
		if useSearch {
			s = SearchScore(qrel, userAff, purchase, PriceCompetitiveness(h.PriceMinor, median), AvailabilityScore(h.Sellable), RatingScore(h.Rating))
		} else {
			s = 0.6*qrel + 0.4*purchase
		}
		rows = append(rows, scored{h: h, s: s, k: h.SKUID})
	}
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if rows[j].s > rows[i].s || (rows[j].s == rows[i].s && rows[j].k < rows[i].k) {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	out := make([]RankedHit, len(rows))
	for i, r := range rows {
		out[i] = r.h
	}
	return out
}
