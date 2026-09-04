package commerce

type crossSellStrategy struct{}

func (crossSellStrategy) Type() string { return "CROSS_SELL" }

func (crossSellStrategy) Generate(ctx Context, in Inputs) []Candidate {
	return graphAdd(ctx, in, []string{"USED_WITH", "BUNDLE_COMPATIBLE"}, "CROSS_SELL", "Pairs with an item already in the cart")
}
