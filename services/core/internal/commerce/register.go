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

// DefaultSurfaces is the fixture assignment for the six cart-offer strategies.
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

func init() {
	Register(thresholdStrategy{})
	Register(promotionStrategy{})
	Register(bundleStrategy{})
	Register(crossSellStrategy{})
	Register(complementStrategy{})
	Register(upsellStrategy{})
}
