package commerce

func ThresholdGap(threshold, subtotal int64) int64 {
	g := threshold - subtotal
	if g < 0 {
		return 0
	}
	return g
}

func FeeSaving(current, after int64) int64 {
	s := current - after
	if s < 0 {
		return 0
	}
	return s
}

func NetIncrementalCost(itemCost, feeSaving int64) int64 {
	return itemCost - feeSaving
}

func GapFit(price, gap int64) float64 {
	if gap <= 0 {
		return 0
	}
	diff := price - gap
	if diff < 0 {
		diff = -diff
	}
	return Clamp01(1 - float64(diff)/float64(gap))
}

func FillScore(useful float64, itemCost, feeSaving, gap int64) float64 {
	net := NetIncrementalCost(itemCost, feeSaving)
	econ := 0.0
	if feeSaving > 0 && net < 0 {
		econ = Clamp01(float64(-net) / float64(feeSaving))
	} else if feeSaving > 0 {
		econ = 0.15 * GapFit(itemCost, gap)
	}
	if useful <= 0 {
		useful = 0.25 * GapFit(itemCost, gap)
	}
	return 0.65*useful + 0.35*econ
}
