package commerce

import "time"

type PurchaseEvent struct {
	OrderID    string
	SKUID      string
	ProductID  string
	Brand      string
	BrandID    string
	CategoryID string
	Quantity   int
	OrderedAt  time.Time
	PricePaid  int64
}

type SearchEvent struct {
	Query     string
	SKUID     string
	EventType string
	At        time.Time
}

type Routine struct {
	ID            string
	Name          string
	CadenceDays   int
	LastOrderedAt time.Time
	Items         []RoutineItem
}

type RoutineItem struct {
	SKUID         string
	UsualQuantity int
}

type SKUStats struct {
	SKUID           string
	PurchaseCount   int
	PurchaseCount90 int
	UsualQuantity   float64
	LastBoughtAt    time.Time
	LastQuantity    int
	MedianDays      float64
	ReorderRate     float64
}

type BuyerSignals struct {
	BuyerID         string
	Events          []PurchaseEvent
	Search          []SearchEvent
	Routines        []Routine
	SKU             map[string]SKUStats
	ProductAffinity map[string]float64
	BrandAffinity   map[string]float64
}

func BuildBuyerSignals(buyerID string, events []PurchaseEvent, search []SearchEvent, routines []Routine, now time.Time) BuyerSignals {
	out := BuyerSignals{
		BuyerID:         buyerID,
		Events:          events,
		Search:          search,
		Routines:        routines,
		SKU:             map[string]SKUStats{},
		ProductAffinity: map[string]float64{},
		BrandAffinity:   map[string]float64{},
	}
	bySKU := map[string][]PurchaseEvent{}
	brandCount := map[string]int{}
	productCount := map[string]int{}
	for _, e := range events {
		bySKU[e.SKUID] = append(bySKU[e.SKUID], e)
		if e.BrandID != "" {
			brandCount[e.BrandID]++
		} else if e.Brand != "" {
			brandCount[e.Brand]++
		}
		if e.ProductID != "" {
			productCount[e.ProductID]++
		}
	}
	maxBrand, maxProduct := 1, 1
	for _, n := range brandCount {
		if n > maxBrand {
			maxBrand = n
		}
	}
	for _, n := range productCount {
		if n > maxProduct {
			maxProduct = n
		}
	}
	for k, n := range brandCount {
		out.BrandAffinity[k] = float64(n) / float64(maxBrand)
	}
	for k, n := range productCount {
		out.ProductAffinity[k] = float64(n) / float64(maxProduct)
	}
	window := now.Add(-90 * 24 * time.Hour)
	for sku, evs := range bySKU {
		sortPurchases(evs)
		st := SKUStats{SKUID: sku, PurchaseCount: len(evs)}
		var gaps []float64
		var qtys []int
		for i, e := range evs {
			qtys = append(qtys, e.Quantity)
			if !e.OrderedAt.Before(window) {
				st.PurchaseCount90++
			}
			if i > 0 {
				gaps = append(gaps, evs[i].OrderedAt.Sub(evs[i-1].OrderedAt).Hours()/24)
			}
		}
		last := evs[len(evs)-1]
		st.LastBoughtAt = last.OrderedAt
		st.LastQuantity = last.Quantity
		st.UsualQuantity = medianInt(qtys)
		st.MedianDays = medianFloat(gaps)
		if st.PurchaseCount > 0 {
			st.ReorderRate = float64(st.PurchaseCount-1) / float64(st.PurchaseCount)
		}
		out.SKU[sku] = st
	}
	return out
}

func sortPurchases(evs []PurchaseEvent) {
	for i := 0; i < len(evs); i++ {
		for j := i + 1; j < len(evs); j++ {
			if evs[j].OrderedAt.Before(evs[i].OrderedAt) {
				evs[i], evs[j] = evs[j], evs[i]
			}
		}
	}
}

func DaysSince(last, now time.Time) float64 {
	if last.IsZero() {
		return 0
	}
	d := now.Sub(last).Hours() / 24
	if d < 0 {
		return 0
	}
	return d
}

func ConsumptionRate(typicalQty, medianDays float64) float64 {
	if medianDays <= 0 {
		return 0
	}
	return typicalQty / medianDays
}

func ReplenishmentScore(daysSince, medianDays float64) float64 {
	if medianDays <= 0 {
		return 0
	}
	return Sigmoid((daysSince - medianDays) / (0.2*medianDays + 1))
}

func ReorderScore(st SKUStats, now time.Time) float64 {
	due := DueScore(DaysSince(st.LastBoughtAt, now), st.MedianDays)
	return 0.35*Norm(float64(st.PurchaseCount90), 5) + 0.35*due + 0.30*Clamp01(st.ReorderRate)
}

func PastPurchaseScore(st SKUStats, now time.Time) float64 {
	rec := Recency(DaysSince(st.LastBoughtAt, now), 45)
	return 0.5*Norm(float64(st.PurchaseCount), 8) + 0.3*rec + 0.2*Clamp01(st.ReorderRate)
}

func UserProductAffinity(b BuyerSignals, sku CatalogSKU) float64 {
	if v, ok := b.ProductAffinity[sku.ProductID]; ok {
		return v
	}
	if st, ok := b.SKU[sku.SKUID]; ok {
		return PastPurchaseScore(st, time.Time{})
	}
	return 0
}

func UserBrandAffinity(b BuyerSignals, sku CatalogSKU) float64 {
	if sku.BrandID != "" {
		if v, ok := b.BrandAffinity[sku.BrandID]; ok {
			return v
		}
	}
	if v, ok := b.BrandAffinity[sku.Brand]; ok {
		return v
	}
	return 0
}

func UsefulHistoryScore(b BuyerSignals, skuID string, now time.Time) float64 {
	st, ok := b.SKU[skuID]
	if !ok {
		return 0
	}
	a := ReorderScore(st, now)
	bsc := ReplenishmentScore(DaysSince(st.LastBoughtAt, now), st.MedianDays)
	c := PastPurchaseScore(st, now)
	if bsc > a {
		a = bsc
	}
	if c > a {
		a = c
	}
	return a
}
