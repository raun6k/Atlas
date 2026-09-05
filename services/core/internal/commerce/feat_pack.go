package commerce

func NormalizedQuantity(sku CatalogSKU) float64 {
	n := float64(sku.PackSize)
	if sku.PackCount > 1 {
		n *= float64(sku.PackCount)
	}
	if n <= 0 {
		return 1
	}
	return n
}

func UnitPrice(sku CatalogSKU) float64 {
	q := NormalizedQuantity(sku)
	if q <= 0 {
		return 0
	}
	return float64(sku.SellingMinor) / q
}

func UnitSavingPct(current, large CatalogSKU) float64 {
	cu := UnitPrice(current)
	lu := UnitPrice(large)
	if cu <= 0 {
		return 0
	}
	return 1 - lu/cu
}

func ConsumptionFit(rate float64, shelfDays int, largeQty float64) float64 {
	if largeQty <= 0 {
		return 0
	}
	expected := rate * float64(shelfDays)
	if shelfDays <= 0 {
		return 1
	}
	return mathMin(1, expected/largeQty)
}

func LargerPackScore(current, large CatalogSKU, rate float64) float64 {
	save := UnitSavingPct(current, large)
	if save <= 0 {
		return 0
	}
	shelf := 0
	if large.ShelfLifeDays != nil {
		shelf = *large.ShelfLifeDays
	}
	return save * ConsumptionFit(rate, shelf, NormalizedQuantity(large))
}

func mathMin(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func largerPacks(current CatalogSKU, skus map[string]CatalogSKU) []CatalogSKU {
	var out []CatalogSKU
	curQ := NormalizedQuantity(current)
	ids := skuIDs(skus)
	for _, id := range ids {
		s := skus[id]
		if s.SKUID == current.SKUID {
			continue
		}
		if s.ProductID != current.ProductID {
			continue
		}
		if s.NetUnit != "" && current.NetUnit != "" && s.NetUnit != current.NetUnit {
			continue
		}
		if s.Sellable < 1 {
			continue
		}
		if NormalizedQuantity(s) > curQ {
			out = append(out, s)
		}
	}
	return out
}
