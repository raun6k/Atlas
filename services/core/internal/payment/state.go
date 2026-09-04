package payment

// CanTransition reports whether a PaymentAttempt may move from -> to.
// State may skip forward when provider evidence arrives before runner status.
// It may never move backward from a reconciled terminal state.
func CanTransition(from, to State) bool {
	if from == to {
		return true
	}
	if from.Terminal() {
		return false
	}
	rank := map[State]int{
		StateCreated:              1,
		StateProviderOrderCreated: 2,
		StateRunnerQueued:         3,
		StateCheckoutInProgress:   4,
		StateProviderSubmitted:    5,
		StateReconciling:          6,
		StateOutcomeUnknown:       6,
		StateCapturedReconciled:   7,
		StateFailedVerified:       7,
		StateCancelledVerified:    7,
	}
	fr, okF := rank[from]
	tr, okT := rank[to]
	if !okF || !okT {
		return false
	}
	// OUTCOME_UNKNOWN and RECONCILING may move to each other and then to a terminal.
	if from == StateOutcomeUnknown && (to == StateReconciling || to.Terminal()) {
		return true
	}
	if from == StateReconciling && (to == StateOutcomeUnknown || to.Terminal()) {
		return true
	}
	return tr >= fr
}
