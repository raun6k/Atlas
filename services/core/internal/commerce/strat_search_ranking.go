package commerce

// searchRankingStrategy reorders catalog search; it does not emit cart patches.
type searchRankingStrategy struct{}

func (searchRankingStrategy) Type() string { return "SEARCH_RANKING" }

func (searchRankingStrategy) Generate(Context, Inputs) []Candidate { return nil }
