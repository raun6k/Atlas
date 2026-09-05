package commerce

type Strategy interface {
	Type() string
	Generate(ctx Context, in Inputs) []Candidate
}

var registry []Strategy

func Register(s Strategy) {
	registry = append(registry, s)
}

func KnownTypes() map[string]bool {
	out := make(map[string]bool, len(registry))
	for _, s := range registry {
		out[s.Type()] = true
	}
	return out
}

var EngineStrategyTypes = []string{
	"REORDER", "REPLENISHMENT", "PAST_PURCHASE", "CART_COMPLETION", "BASKET_REC", "FBT",
	"SEARCH_RANKING", "ROUTINE", "LARGER_PACK", "FREE_DELIVERY", "SMALL_ORDER", "BRAND_PROMO",
}

// DemoStrategyTypes are the Buildathon live path: threshold completion, promotion, complementary add-on.
var DemoStrategyTypes = []string{"FREE_DELIVERY", "SMALL_ORDER", "BRAND_PROMO", "FBT"}

const (
	VisibilityDemo        = "DEMO"
	VisibilityExploratory = "EXPLORATORY"
	RankingVersion        = "rank_conservative_v1"
	EconomicObjective     = "incremental_confirmed_revenue_v1"
)

func IsKnownType(t string) bool {
	return KnownTypes()[t]
}

func IsDemoType(t string) bool {
	for _, v := range DemoStrategyTypes {
		if v == t {
			return true
		}
	}
	return false
}

func ValidateStrategyType(t string) error {
	if !IsKnownType(t) {
		return errUnknownStrategy(t)
	}
	return nil
}

func ValidateAllowlist(types []string) error {
	for _, t := range types {
		if err := ValidateStrategyType(t); err != nil {
			return err
		}
		if !IsDemoType(t) {
			return errExploratoryStrategy(t)
		}
	}
	return nil
}

func init() {
	Register(reorderStrategy{})
	Register(replenishmentStrategy{})
	Register(pastPurchaseStrategy{})
	Register(cartCompletionStrategy{})
	Register(basketRecStrategy{})
	Register(fbtStrategy{})
	Register(searchRankingStrategy{})
	Register(routineStrategy{})
	Register(largerPackStrategy{})
	Register(freeDeliveryStrategy{})
	Register(smallOrderStrategy{})
	Register(brandPromoStrategy{})
}
