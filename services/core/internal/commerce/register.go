package commerce

// Surface identifiers match buyer-agent tool names.
const (
	SurfaceSetIntent      = "set_intent"
	SurfaceSearchCatalog  = "search_catalog"
	SurfaceGetCart        = "get_cart"
	SurfaceAddCartItem    = "add_cart_item"
	SurfaceUpdateCartItem = "update_cart_item"
	SurfaceRemoveCartItem = "remove_cart_item"
)

var DefaultSurfaces = []string{
	SurfaceSetIntent,
	SurfaceSearchCatalog,
	SurfaceGetCart,
	SurfaceAddCartItem,
	SurfaceUpdateCartItem,
	SurfaceRemoveCartItem,
}

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
