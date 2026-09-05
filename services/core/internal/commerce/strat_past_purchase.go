package commerce

// pastPurchaseStrategy reorders search hits; it does not emit cart patches.
type pastPurchaseStrategy struct{}

func (pastPurchaseStrategy) Type() string { return "PAST_PURCHASE" }

func (pastPurchaseStrategy) Generate(Context, Inputs) []Candidate { return nil }
