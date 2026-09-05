package commerce

import "math"

func Clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func Norm(v, cap float64) float64 {
	if cap <= 0 {
		return 0
	}
	return Clamp01(v / cap)
}

func NormLog1p(v, cap float64) float64 {
	if cap <= 0 {
		return 0
	}
	return Clamp01(math.Log1p(math.Max(0, v)) / math.Log1p(cap))
}

func Sigmoid(x float64) float64 {
	return 1 / (1 + math.Exp(-x))
}

func Recency(days, tau float64) float64 {
	if tau <= 0 {
		tau = 45
	}
	if days < 0 {
		days = 0
	}
	return math.Exp(-days / tau)
}

func DueScore(daysSince, medianDays float64) float64 {
	if medianDays <= 0 {
		return 0
	}
	return math.Min(1, daysSince/medianDays)
}

func medianFloat(in []float64) float64 {
	if len(in) == 0 {
		return 0
	}
	s := append([]float64(nil), in...)
	for i := 0; i < len(s); i++ {
		for j := i + 1; j < len(s); j++ {
			if s[j] < s[i] {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
	mid := len(s) / 2
	if len(s)%2 == 1 {
		return s[mid]
	}
	return (s[mid-1] + s[mid]) / 2
}

func medianInt(in []int) float64 {
	if len(in) == 0 {
		return 0
	}
	xs := make([]float64, len(in))
	for i, v := range in {
		xs[i] = float64(v)
	}
	return medianFloat(xs)
}
