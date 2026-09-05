package inventory

func Sellable(onHand, reserved, buffer int) int {
	v := onHand - reserved - buffer
	if v < 0 {
		return 0
	}
	return v
}

func Discoverable(assorted bool, onHand, reserved, buffer int) bool {
	return assorted && Sellable(onHand, reserved, buffer) > 0
}

func Status(assorted bool, sellable int) string {
	if !assorted {
		return "not_assorted"
	}
	if sellable <= 0 {
		return "out_of_stock"
	}
	return "in_stock"
}

// DiscoverableSQL is the location-inventory predicate used by search, product
// lookup, and commerce catalog load. Cart/checkout use Sellable() on the same inputs.
const DiscoverableSQL = `i.assorted = TRUE AND (i.on_hand_quantity - i.reserved_quantity - i.safety_buffer) > 0`

const PriceEffectiveSQL = `p.effective_from <= now() AND (p.effective_to IS NULL OR p.effective_to > now())`

const LocationActiveSQL = `loc.active = TRUE`
