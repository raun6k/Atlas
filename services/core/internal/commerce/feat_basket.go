package commerce

type BasketIndex struct {
	TotalOrders int
	Count       map[string]int
	Pair        map[string]int
	Personal    map[string]int
	PersonalN   int
}

func pairKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "\x00" + b
}

func BuildBasketIndex(market, personal []PurchaseEvent) BasketIndex {
	idx := BasketIndex{Count: map[string]int{}, Pair: map[string]int{}, Personal: map[string]int{}}
	addOrders := func(events []PurchaseEvent, personal bool) {
		byOrder := map[string]map[string]bool{}
		for _, e := range events {
			if byOrder[e.OrderID] == nil {
				byOrder[e.OrderID] = map[string]bool{}
			}
			byOrder[e.OrderID][e.SKUID] = true
		}
		ids := make([]string, 0, len(byOrder))
		for id := range byOrder {
			ids = append(ids, id)
		}
		sortStrings(ids)
		for _, id := range ids {
			skus := keys(byOrder[id])
			sortStrings(skus)
			if personal {
				idx.PersonalN++
				for _, s := range skus {
					idx.Personal[s]++
				}
			} else {
				idx.TotalOrders++
				for _, s := range skus {
					idx.Count[s]++
				}
				for i := 0; i < len(skus); i++ {
					for j := i + 1; j < len(skus); j++ {
						idx.Pair[pairKey(skus[i], skus[j])]++
					}
				}
			}
		}
	}
	addOrders(market, false)
	addOrders(personal, true)
	return idx
}

func (idx BasketIndex) Confidence(a, b string) float64 {
	if idx.Count[a] == 0 {
		return 0
	}
	return float64(idx.Pair[pairKey(a, b)]) / float64(idx.Count[a])
}

func (idx BasketIndex) Support(a, b string) float64 {
	if idx.TotalOrders == 0 {
		return 0
	}
	return float64(idx.Pair[pairKey(a, b)]) / float64(idx.TotalOrders)
}

func (idx BasketIndex) Lift(a, b string) float64 {
	if idx.TotalOrders == 0 || idx.Count[a] == 0 || idx.Count[b] == 0 {
		return 0
	}
	pab := float64(idx.Pair[pairKey(a, b)]) / float64(idx.TotalOrders)
	pa := float64(idx.Count[a]) / float64(idx.TotalOrders)
	pb := float64(idx.Count[b]) / float64(idx.TotalOrders)
	if pa*pb == 0 {
		return 0
	}
	return pab / (pa * pb)
}

func (idx BasketIndex) BasketAssociation(cart []string, j string) float64 {
	if len(cart) == 0 {
		return 0
	}
	prod := 1.0
	for _, i := range cart {
		if i == j {
			continue
		}
		prod *= (1 - idx.Confidence(i, j))
	}
	return 1 - prod
}

func (idx BasketIndex) BasketAffinity(cart []string, j string) float64 {
	if len(cart) == 0 {
		return 0
	}
	var sum float64
	n := 0
	for _, i := range cart {
		if i == j {
			continue
		}
		sum += idx.Confidence(i, j)
		n++
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

func (idx BasketIndex) PersonalBasketScore(sku string) float64 {
	if idx.PersonalN == 0 {
		return 0
	}
	return float64(idx.Personal[sku]) / float64(idx.PersonalN)
}

func (idx BasketIndex) FBTScore(a, b string) float64 {
	conf := Clamp01(idx.Confidence(a, b))
	lift := NormLog1p(idx.Lift(a, b), 10)
	co := NormLog1p(float64(idx.Pair[pairKey(a, b)]), 20)
	return conf * lift * co
}

func CompletionScore(personal, association, replenishment float64) float64 {
	return 0.45*personal + 0.35*association + 0.20*replenishment
}

func RecommendationScore(basket, user, offer float64) float64 {
	return 0.50*basket + 0.30*user + 0.20*offer
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func sortStrings(s []string) {
	for i := 0; i < len(s); i++ {
		for j := i + 1; j < len(s); j++ {
			if s[j] < s[i] {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
}

func cartSKUs(ctx Context) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range ctx.Lines {
		if seen[l.SKUID] {
			continue
		}
		seen[l.SKUID] = true
		out = append(out, l.SKUID)
	}
	sortStrings(out)
	return out
}

func inCartSet(ctx Context) map[string]bool {
	inCart := map[string]bool{}
	for _, l := range ctx.Lines {
		inCart[l.SKUID] = true
		inCart[l.ProductID] = true
	}
	return inCart
}
