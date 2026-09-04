package commerce

type complementStrategy struct{}

func (complementStrategy) Type() string { return "COMPLEMENT" }

func (complementStrategy) Generate(ctx Context, in Inputs) []Candidate {
	return graphAdd(ctx, in, []string{"COMPLEMENT", "CONSUMED_WITH"}, "COMPLEMENT", "Merchant-configured complement for a cart item")
}
