package inventory

func Sellable(onHand, reserved, buffer int) int {
	v := onHand - reserved - buffer
	if v < 0 {
		return 0
	}
	return v
}
