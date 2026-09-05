package cart

import (
	"encoding/json"
	"strings"
	"time"
)

type Line struct {
	LineID    string
	SKUID     string
	ProductID string
	Name      string
	Quantity  int
	UnitMinor int64
	LineMinor int64
}

type Totals struct {
	MerchandiseMinor    int64
	DiscountsMinor      int64
	DeliveryFeeMinor    int64
	HandlingFeeMinor    int64
	TaxMinor            int64
	AllInMinor          int64
	Currency            string
	MinimumOrderMet     bool
	AppliedBundleIDs    []string
	AppliedPromotionIDs []string
}

type Promotion struct {
	ID            string
	Type          string
	Name          string
	EligibleSKUs  []string
	MinimumQty    int
	DiscountMinor int64
	LocationIDs   []string
	StartsAt      time.Time
	EndsAt        time.Time
	Enabled       bool
	Exclusive     bool
}

type Bundle struct {
	ID                   string
	Name                 string
	SKUQuantities        map[string]int
	StandaloneTotalMinor int64
	BundleTotalMinor     int64
	DiscountMinor        int64
	LocationIDs          []string
}

type LocationFees struct {
	DeliveryFeeMinor                 int64
	HandlingFeeMinor                 int64
	MinimumOrderValueMinor           int64
	FreeDeliveryThresholdMinor       int64
	DeliveryFeeAfterThresholdMinor   int64
	SmallOrderThresholdMinor         int64
	SmallOrderFeeMinor               int64
	FeeAfterSmallOrderThresholdMinor int64
	Currency                         string
}

// PriceCart is the canonical repricer for cart, offer simulation, apply, and checkout.
func PriceCart(lines []Line, loc LocationFees, promotions []Promotion, bundles []Bundle, locationID string, now time.Time) Totals {
	var merch int64
	qty := map[string]int{}
	for _, l := range lines {
		line := l.LineMinor
		if line == 0 {
			line = l.UnitMinor * int64(l.Quantity)
		}
		merch += line
		qty[l.SKUID] += l.Quantity
	}
	var discounts int64
	var promoIDs []string
	exclusiveUsed := false
	for _, p := range promotions {
		if !p.Enabled || now.Before(p.StartsAt) || now.After(p.EndsAt) {
			continue
		}
		if !contains(p.LocationIDs, locationID) {
			continue
		}
		if exclusiveUsed && p.Exclusive {
			continue
		}
		var n int
		for _, sku := range p.EligibleSKUs {
			n += qty[sku]
		}
		if p.MinimumQty > 0 && n >= p.MinimumQty {
			times := n / p.MinimumQty
			discounts += p.DiscountMinor * int64(times)
			promoIDs = append(promoIDs, p.ID)
			if p.Exclusive {
				exclusiveUsed = true
			}
		}
	}
	var bundleIDs []string
	if !exclusiveUsed {
		for _, b := range sortedBundles(bundles) {
			if !contains(b.LocationIDs, locationID) {
				continue
			}
			if !bundleQualifies(qty, b.SKUQuantities) {
				continue
			}
			d := b.DiscountMinor
			if d <= 0 && b.StandaloneTotalMinor > b.BundleTotalMinor && b.BundleTotalMinor > 0 {
				d = b.StandaloneTotalMinor - b.BundleTotalMinor
			}
			if d <= 0 {
				continue
			}
			discounts += d
			bundleIDs = append(bundleIDs, b.ID)
		}
	}
	if discounts > merch {
		discounts = merch
	}
	net := merch - discounts
	delivery := loc.DeliveryFeeMinor
	if loc.FreeDeliveryThresholdMinor > 0 && net >= loc.FreeDeliveryThresholdMinor {
		delivery = loc.DeliveryFeeAfterThresholdMinor
	}
	small := int64(0)
	if loc.SmallOrderThresholdMinor > 0 && net < loc.SmallOrderThresholdMinor {
		small = loc.SmallOrderFeeMinor
	} else if loc.SmallOrderThresholdMinor > 0 {
		small = loc.FeeAfterSmallOrderThresholdMinor
	}
	allIn := net + delivery + loc.HandlingFeeMinor + small
	minMet := loc.MinimumOrderValueMinor <= 0 || net >= loc.MinimumOrderValueMinor
	cur := strings.TrimSpace(loc.Currency)
	return Totals{
		MerchandiseMinor:    merch,
		DiscountsMinor:      discounts,
		DeliveryFeeMinor:    delivery,
		HandlingFeeMinor:    loc.HandlingFeeMinor + small,
		TaxMinor:            0,
		AllInMinor:          allIn,
		Currency:            cur,
		MinimumOrderMet:     minMet,
		AppliedBundleIDs:    bundleIDs,
		AppliedPromotionIDs: promoIDs,
	}
}

// Recalc is an alias for PriceCart so existing call sites share the same function.
func Recalc(lines []Line, loc LocationFees, promotions []Promotion, bundles []Bundle, locationID string, now time.Time) Totals {
	return PriceCart(lines, loc, promotions, bundles, locationID, now)
}

func sortedBundles(in []Bundle) []Bundle {
	out := append([]Bundle(nil), in...)
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].ID < out[i].ID {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func bundleQualifies(have map[string]int, need map[string]int) bool {
	for sku, q := range need {
		if have[sku] < q {
			return false
		}
	}
	return len(need) > 0
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

func ParseSKUQty(raw []byte) map[string]int {
	out := map[string]int{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func ParseStringSlice(raw []byte) []string {
	var out []string
	_ = json.Unmarshal(raw, &out)
	return out
}
