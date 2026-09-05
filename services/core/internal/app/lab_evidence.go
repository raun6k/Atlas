package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/payment"
)

type LabEvidence struct {
	MerchantOrderID               string   `json:"merchant_order_id"`
	PaymentAttemptID              string   `json:"payment_attempt_id"`
	ProviderOrderID               string   `json:"provider_order_id"`
	ProviderPaymentID             string   `json:"provider_payment_id"`
	ConfirmedOrderAmountMinor     int64    `json:"confirmed_order_amount_minor"`
	Currency                      string   `json:"currency"`
	MerchantOrderState            string   `json:"merchant_order_state"`
	PaymentAttemptState           string   `json:"payment_attempt_state"`
	AuthenticatedProviderEventRef string   `json:"authenticated_provider_event_reference"`
	ProviderFetchRef              string   `json:"provider_fetch_reference"`
	EventBindingStatus            string   `json:"event_binding_status"`
	ProviderFetchMatchStatus      string   `json:"provider_fetch_match_status"`
	StrategyRevision              string   `json:"strategy_revision"`
	StrategyAllowlistDigest       string   `json:"strategy_allowlist_digest"`
	ShownOfferIDs                 []string `json:"shown_offer_ids"`
	AppliedOfferIDs               []string `json:"applied_offer_ids"`
	AttributionID                 string   `json:"attribution_id"`
	FixtureSnapshotID             string   `json:"fixture_snapshot_id"`
	FixtureDigest                 string   `json:"fixture_digest"`
	ContractVersion               string   `json:"contract_version"`
	CapabilitiesOK                bool     `json:"capabilities_ok"`
	ActiveLocationID              string   `json:"active_location_id"`
	SellableSkuID                 string   `json:"sellable_sku_id"`
	CartVersion                   int64    `json:"cart_version"`
	SessionContextVersion         int64    `json:"session_context_version"`
	CheckoutProposalID            string   `json:"checkout_proposal_id"`
	ReservationsActive            bool     `json:"reservations_active"`
	CoreOrderConfirmed            bool     `json:"core_order_confirmed"`
	MerchandiseMinor              int64    `json:"merchandise_minor"`
	MerchantFundedDiscountMinor   int64    `json:"merchant_funded_discount_minor"`
	SponsorFundedDiscountMinor    int64    `json:"sponsor_funded_discount_minor"`
	// PaymentFeeMinor stays nil unless an authenticated provider fee is present.
	// Test Mode capture is not used to invent a payment fee.
	PaymentFeeMinor               *int64   `json:"payment_fee_minor"`
	FulfillmentCostMinor          int64    `json:"fulfillment_cost_minor"`
	CogsMinor                     int64    `json:"cogs_minor"`
	Units                         int64    `json:"units"`
}

func (k *Kernel) LabEvidence(ctx context.Context, sessionID string) (LabEvidence, error) {
	out := LabEvidence{ContractVersion: ContractVersion, CapabilitiesOK: true, ShownOfferIDs: []string{}, AppliedOfferIDs: []string{}}
	if sessionID == "" {
		return out, apperr.New(apperr.InvalidArgument, "session_id required")
	}
	var allowlist []string
	var evaluationArm string
	err := k.Pool().QueryRow(ctx, `
		SELECT location_id, session_context_version, COALESCE(strategy_allowlist, '{}'), COALESCE(evaluation_arm, '')
		FROM shopping_sessions WHERE session_id=$1`, sessionID).Scan(&out.ActiveLocationID, &out.SessionContextVersion, &allowlist, &evaluationArm)
	if err != nil {
		return out, err
	}
	out.StrategyAllowlistDigest = digestStrings(allowlist)
	_ = k.Pool().QueryRow(ctx, `SELECT cart_version FROM carts WHERE session_id=$1`, sessionID).Scan(&out.CartVersion)
	_ = k.Pool().QueryRow(ctx, `
		SELECT cl.sku_id FROM cart_lines cl
		JOIN carts c ON c.cart_id = cl.cart_id
		WHERE c.session_id=$1 LIMIT 1`, sessionID).Scan(&out.SellableSkuID)
	_ = k.Pool().QueryRow(ctx, `
		SELECT checkout_proposal_id FROM checkout_proposals WHERE session_id=$1 AND status='ACTIVE' LIMIT 1`, sessionID).Scan(&out.CheckoutProposalID)
	out.ReservationsActive = out.CheckoutProposalID != ""
	if rows, qerr := k.Pool().Query(ctx, `SELECT offer_id FROM offers WHERE session_id=$1 AND status IN ('SHOWN','SELECTED','ACCEPTED','APPLIED','RETAINED','ATTRIBUTED','ORDER_CONFIRMED')`, sessionID); qerr == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil && id != "" {
				out.ShownOfferIDs = append(out.ShownOfferIDs, id)
			}
		}
	}
	if rows, qerr := k.Pool().Query(ctx, `SELECT offer_id FROM offers WHERE session_id=$1 AND status IN ('APPLIED','ATTRIBUTED','ORDER_CONFIRMED')`, sessionID); qerr == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil && id != "" {
				out.AppliedOfferIDs = append(out.AppliedOfferIDs, id)
			}
		}
	}
	_ = k.Pool().QueryRow(ctx, `
		SELECT attribution_id, COALESCE(strategy_revision,'') FROM commercial_attributions WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(&out.AttributionID, &out.StrategyRevision)
	if out.AttributionID == "" && evaluationArm == "CONTROL" {
		out.AttributionID = "control_no_offer:" + sessionID
		out.StrategyRevision = "CONTROL_NO_OFFER"
	}
	if fix, ferr := k.CurrentFixture(ctx); ferr == nil {
		out.FixtureSnapshotID = fix.SnapshotID
		out.FixtureDigest = fix.Digest
	}
	var orderID, payAttempt, status, currency string
	var amount, dummyDiscount, handling int64
	if qerr := k.Pool().QueryRow(ctx, `
		SELECT order_id, COALESCE(payment_attempt_id,''), status, total_amount_minor, currency
		FROM orders WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(&orderID, &payAttempt, &status, &amount, &currency); qerr != nil {
		return out, nil
	}
	out.MerchantOrderID = orderID
	out.PaymentAttemptID = payAttempt
	out.MerchantOrderState = status
	out.ConfirmedOrderAmountMinor = amount
	out.Currency = currency
	out.CoreOrderConfirmed = status == "CONFIRMED" || status == "FULFILLING" || status == "COMPLETED" || status == "ORDER_CONFIRMED"
	_ = k.Pool().QueryRow(ctx, `
		SELECT COALESCE(merchandise_minor,0), COALESCE(discounts_minor,0), COALESCE(delivery_fee_minor,0), COALESCE(handling_fee_minor,0)
		FROM checkout_proposals WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(
		&out.MerchandiseMinor, &dummyDiscount, &out.FulfillmentCostMinor, &handling)
	out.FulfillmentCostMinor += handling
	_ = k.Pool().QueryRow(ctx, `
		SELECT COALESCE(SUM(merchant_funded_minor),0), COALESCE(SUM(partner_funded_minor),0)
		FROM offers WHERE session_id=$1 AND status IN ('APPLIED','RETAINED','ATTRIBUTED','ORDER_CONFIRMED')`, sessionID).Scan(
		&out.MerchantFundedDiscountMinor, &out.SponsorFundedDiscountMinor)
	_ = k.Pool().QueryRow(ctx, `
		SELECT COALESCE(SUM(cl.quantity),0), COALESCE(SUM(cl.quantity * COALESCE(pr.cogs_minor,0)),0)
		FROM cart_lines cl
		JOIN carts c ON c.cart_id = cl.cart_id
		JOIN shopping_sessions s ON s.session_id = c.session_id
		JOIN prices pr ON pr.sku_id = cl.sku_id AND pr.location_id = s.location_id
		WHERE c.session_id=$1`, sessionID).Scan(&out.Units, &out.CogsMinor)
	if payAttempt == "" {
		return out, nil
	}
	var rzpOrder, rzpPay, pstate string
	var hasCB, hasWH bool
	if err := k.Pool().QueryRow(ctx, `
		SELECT COALESCE(razorpay_order_id,''), COALESCE(razorpay_payment_id,''), state, has_callback_binding, has_webhook_binding
		FROM payment_attempts WHERE payment_attempt_id=$1`, payAttempt).Scan(&rzpOrder, &rzpPay, &pstate, &hasCB, &hasWH); err == nil {
		out.ProviderOrderID = rzpOrder
		out.ProviderPaymentID = rzpPay
		out.PaymentAttemptState = pstate
		if hasCB || hasWH {
			out.EventBindingStatus = "BOUND"
		} else {
			out.EventBindingStatus = "UNBOUND"
		}
	}
	_ = k.Pool().QueryRow(ctx, `
		SELECT provider_event_id FROM provider_events WHERE payment_attempt_id=$1 AND signature_valid=TRUE ORDER BY received_at DESC LIMIT 1`, payAttempt).Scan(&out.AuthenticatedProviderEventRef)
	var reconID, decision string
	_ = k.Pool().QueryRow(ctx, `
		SELECT reconciliation_id, decision FROM provider_reconciliations WHERE payment_attempt_id=$1 ORDER BY fetched_at DESC LIMIT 1`, payAttempt).Scan(&reconID, &decision)
	out.ProviderFetchRef = reconID
	upper := strings.ToUpper(decision)
	if upper == "MATCH" || upper == "CAPTURED_RECONCILED" || strings.Contains(upper, "MATCH") {
		out.ProviderFetchMatchStatus = "MATCH"
	} else if decision != "" {
		out.ProviderFetchMatchStatus = decision
	}
	return out, nil
}

func (k *Kernel) ApplyLabPaymentOutcome(ctx context.Context, pay *payment.Service, sessionID, outcome string) (map[string]any, error) {
	var attemptID string
	if err := k.Pool().QueryRow(ctx, `
		SELECT COALESCE(payment_attempt_id,'') FROM orders WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`, sessionID).Scan(&attemptID); err != nil {
		return nil, err
	}
	if attemptID == "" {
		return nil, apperr.New(apperr.NotFound, "payment attempt not found for session")
	}
	if err := pay.ApplyFixtureOutcome(ctx, attemptID, outcome); err != nil {
		return nil, err
	}
	ev, err := k.LabEvidence(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(ev)
	var out map[string]any
	_ = json.Unmarshal(body, &out)
	return out, nil
}

func digestStrings(ids []string) string {
	b, _ := json.Marshal(ids)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
