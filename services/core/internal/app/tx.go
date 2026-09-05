package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/inventory"
	"atlas.dev/core/internal/trust"

	"github.com/jackc/pgx/v5"
)

type idempotencyHit struct {
	found bool
	body  []byte
}

func (k *Kernel) beginMutation(ctx context.Context, m Meta, scope string, input any) (pgx.Tx, []byte, string, error) {
	if m.RequireIdempotency && m.IdempotencyKey == "" {
		return nil, nil, "", apperr.New(apperr.InvalidArgument, "idempotency_key is required")
	}
	if m.RequestID == "" {
		return nil, nil, "", apperr.New(apperr.InvalidArgument, "request_id is required")
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	op := newOp()
	if m.ApprovedHostID != "" {
		if err := k.assertHostGate(ctx, tx, m); err != nil {
			_ = tx.Rollback(ctx)
			k.recordGateDecision(ctx, m, op, "", "", "DENY", gateReasonCodes(err), "Atlas denied the Approved Host before the command ran.")
			return nil, nil, "", err
		}
	}
	if m.RequireIdempotency && m.ApprovedHostID != "" {
		hit, err := k.lockIdempotency(ctx, tx, m, scope, input)
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, nil, "", err
		}
		if hit.found {
			_ = tx.Commit(ctx)
			return nil, hit.body, op, nil
		}
	}
	if !m.SkipProof && m.ApprovedHostID != "" {
		if _, err := trust.VerifyHostProof(ctx, tx, m.HostRequestProof, m.ApprovedHostID, m.Tool, m.RequestID, m.IdempotencyKey, m.Arguments, k.Now(), k.Cfg.HostAudience, k.Cfg.HostProofTTL); err != nil {
			_ = tx.Rollback(ctx)
			k.recordGateDecision(ctx, m, op, "", "", "DENY", gateReasonCodes(err), "Atlas denied the Approved Host because the request proof did not verify.")
			return nil, nil, "", err
		}
	}
	return tx, nil, op, nil
}

func (k *Kernel) lockIdempotency(ctx context.Context, tx pgx.Tx, m Meta, scope string, input any) (idempotencyHit, error) {
	dig := digestOf(input)
	var existingDigest string
	var body []byte
	err := tx.QueryRow(ctx, `
		SELECT request_digest, response_body FROM idempotency_records
		WHERE host_id=$1 AND scope=$2 AND idempotency_key=$3 FOR UPDATE`,
		m.ApprovedHostID, scope, m.IdempotencyKey,
	).Scan(&existingDigest, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return idempotencyHit{}, nil
	}
	if err != nil {
		return idempotencyHit{}, err
	}
	if existingDigest != dig {
		return idempotencyHit{}, apperr.New(apperr.IdempotencyConflict, "idempotency key reused with different input")
	}
	return idempotencyHit{found: true, body: body}, nil
}

func (k *Kernel) storeIdempotency(ctx context.Context, tx pgx.Tx, m Meta, scope string, input any, result any, auditID string) error {
	if !m.RequireIdempotency || m.ApprovedHostID == "" || m.IdempotencyKey == "" {
		return nil
	}
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO idempotency_records (host_id, scope, idempotency_key, request_digest, response_status, response_body, original_audit_event_id)
		VALUES ($1,$2,$3,$4,'ok',$5,$6)`,
		m.ApprovedHostID, scope, m.IdempotencyKey, digestOf(input), body, auditID)
	return err
}

func (k *Kernel) loadSession(ctx context.Context, tx pgx.Tx, sessionID, hostID string) (SessionSummary, error) {
	var s SessionSummary
	var budget *int64
	var mission *string
	var evalArm *string
	var constraintsRaw []byte
	err := tx.QueryRow(ctx, `
		SELECT session_id, session_context_version, location_id, status, planning_budget_minor, mission, approved_host_id, subject_reference, evaluation_arm, constraints, COALESCE(strategy_allowlist, '{}')
		FROM shopping_sessions WHERE session_id=$1 FOR UPDATE`, sessionID).Scan(
		&s.SessionID, &s.SessionContextVersion, &s.LocationID, &s.Status, &budget, &mission, &s.HostID, &s.SubjectReference, &evalArm, &constraintsRaw, &s.StrategyAllowlist)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, apperr.New(apperr.NotFound, "session not found")
	}
	if err != nil {
		return s, err
	}
	if mission != nil {
		s.Mission = *mission
	}
	if evalArm != nil {
		s.EvaluationArm = *evalArm
	}
	s.Constraints = map[string]string{}
	if len(constraintsRaw) > 0 {
		_ = json.Unmarshal(constraintsRaw, &s.Constraints)
	}
	if hostID != "" && s.HostID != hostID {
		return s, apperr.New(apperr.HostForbidden, "session does not belong to this host")
	}
	if budget != nil {
		s.PlanningBudgetMinor = *budget
		s.HasBudget = true
	}
	s.Treatment = k.loadTreatment(ctx, tx, s.SessionID)
	if s.Treatment != nil {
		s.TreatmentPolicyID = s.Treatment.PolicyID
		if len(s.StrategyAllowlist) == 0 {
			s.StrategyAllowlist = s.Treatment.StrategyAllowlist
		}
	}
	var cartID string
	var cartVer int64
	if err := tx.QueryRow(ctx, `SELECT cart_id, cart_version, currency FROM carts WHERE session_id=$1 FOR UPDATE`, sessionID).Scan(&cartID, &cartVer, &s.Currency); err != nil {
		return s, err
	}
	if s.Currency == "" {
		s.Currency, _ = k.merchantCurrency(ctx, tx)
	}
	s.CartID = cartID
	s.CartVersion = cartVer
	return s, nil
}

func (k *Kernel) loadCart(ctx context.Context, tx pgx.Tx, cartID string) (CartView, error) {
	var v CartView
	err := tx.QueryRow(ctx, `
		SELECT cart_id, session_id, cart_version, currency, merchandise_minor, discounts_minor, delivery_fee_minor, handling_fee_minor, tax_minor, all_in_total_minor
		FROM carts WHERE cart_id=$1`, cartID).Scan(
		&v.CartID, &v.SessionID, &v.Version, &v.Currency,
		&v.Totals.MerchandiseMinor, &v.Totals.DiscountsMinor, &v.Totals.DeliveryFeeMinor,
		&v.Totals.HandlingFeeMinor, &v.Totals.TaxMinor, &v.Totals.AllInMinor)
	if err != nil {
		return v, err
	}
	v.Totals.Currency = v.Currency
	rows, err := tx.Query(ctx, `
		SELECT cart_line_id, sku_id, product_id, quantity, unit_price_minor, line_total_minor
		FROM cart_lines WHERE cart_id=$1 ORDER BY cart_line_id`, cartID)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var l LineView
		if err := rows.Scan(&l.LineID, &l.SKUID, &l.ProductID, &l.Quantity, &l.UnitMinor, &l.LineMinor); err != nil {
			return v, err
		}
		_ = tx.QueryRow(ctx, `SELECT name FROM skus WHERE sku_id=$1`, l.SKUID).Scan(&l.Name)
		v.Lines = append(v.Lines, l)
	}
	return v, rows.Err()
}

func (k *Kernel) recalcAndStoreCart(ctx context.Context, tx pgx.Tx, session SessionSummary) (CartView, error) {
	lines, err := k.lineModels(ctx, tx, session.CartID)
	if err != nil {
		return CartView{}, err
	}
	fees, err := k.locationFees(ctx, tx, session.LocationID)
	if err != nil {
		return CartView{}, err
	}
	promos, bundles, err := k.pricingRules(ctx, tx)
	if err != nil {
		return CartView{}, err
	}
	tot := cart.Recalc(lines, fees, promos, bundles, session.LocationID, k.Now())
	_, err = tx.Exec(ctx, `
		UPDATE carts SET merchandise_minor=$2, discounts_minor=$3, delivery_fee_minor=$4, handling_fee_minor=$5,
			tax_minor=$6, all_in_total_minor=$7, currency=$8, updated_at=now() WHERE cart_id=$1`,
		session.CartID, tot.MerchandiseMinor, tot.DiscountsMinor, tot.DeliveryFeeMinor, tot.HandlingFeeMinor, tot.TaxMinor, tot.AllInMinor, tot.Currency)
	if err != nil {
		return CartView{}, err
	}
	return k.loadCart(ctx, tx, session.CartID)
}

func (k *Kernel) lineModels(ctx context.Context, tx pgx.Tx, cartID string) ([]cart.Line, error) {
	rows, err := tx.Query(ctx, `SELECT cart_line_id, sku_id, product_id, quantity, unit_price_minor, line_total_minor FROM cart_lines WHERE cart_id=$1`, cartID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []cart.Line
	for rows.Next() {
		var l cart.Line
		if err := rows.Scan(&l.LineID, &l.SKUID, &l.ProductID, &l.Quantity, &l.UnitMinor, &l.LineMinor); err != nil {
			return nil, err
		}
		lines = append(lines, l)
	}
	return lines, rows.Err()
}

func (k *Kernel) merchantCurrency(ctx context.Context, tx pgx.Tx) (string, error) {
	var c string
	err := tx.QueryRow(ctx, `SELECT currency FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&c)
	if err != nil || strings.TrimSpace(c) == "" {
		return "", apperr.New(apperr.TemporarilyUnavailable, "merchant fixture is not loaded")
	}
	return strings.ToUpper(strings.TrimSpace(c)), nil
}

func (k *Kernel) locationFees(ctx context.Context, tx pgx.Tx, locationID string) (cart.LocationFees, error) {
	var f cart.LocationFees
	err := tx.QueryRow(ctx, `
		SELECT l.delivery_fee_minor, l.handling_fee_minor, l.minimum_order_value_minor, COALESCE(l.free_delivery_threshold_minor,0),
		       COALESCE(m.delivery_fee_after_threshold_minor,0), COALESCE(m.small_order_threshold_minor,0),
		       COALESCE(m.small_order_fee_minor,0), COALESCE(m.fee_after_small_order_threshold_minor,0),
		       COALESCE(NULLIF(m.currency,''), '')
		FROM locations l
		LEFT JOIN merchant_profile m ON m.singleton_key='singleton'
		WHERE l.location_id=$1`, locationID).Scan(
		&f.DeliveryFeeMinor, &f.HandlingFeeMinor, &f.MinimumOrderValueMinor, &f.FreeDeliveryThresholdMinor,
		&f.DeliveryFeeAfterThresholdMinor, &f.SmallOrderThresholdMinor, &f.SmallOrderFeeMinor, &f.FeeAfterSmallOrderThresholdMinor,
		&f.Currency)
	return f, err
}

func (k *Kernel) pricingRules(ctx context.Context, tx pgx.Tx) ([]cart.Promotion, []cart.Bundle, error) {
	prows, err := tx.Query(ctx, `SELECT promotion_id, type, name, eligible_sku_ids, COALESCE(minimum_quantity,0), COALESCE(discount_amount_minor,0), location_ids, starts_at, ends_at, enabled FROM promotions`)
	if err != nil {
		return nil, nil, err
	}
	defer prows.Close()
	var promos []cart.Promotion
	for prows.Next() {
		var p cart.Promotion
		var skuRaw, locRaw []byte
		if err := prows.Scan(&p.ID, &p.Type, &p.Name, &skuRaw, &p.MinimumQty, &p.DiscountMinor, &locRaw, &p.StartsAt, &p.EndsAt, &p.Enabled); err != nil {
			return nil, nil, err
		}
		p.EligibleSKUs = cart.ParseStringSlice(skuRaw)
		p.LocationIDs = cart.ParseStringSlice(locRaw)
		promos = append(promos, p)
	}
	brows, err := tx.Query(ctx, `SELECT bundle_id, name, sku_quantities, standalone_total_minor, bundle_total_minor, discount_amount_minor, location_ids FROM bundles WHERE enabled=TRUE`)
	if err != nil {
		return nil, nil, err
	}
	defer brows.Close()
	var bundles []cart.Bundle
	for brows.Next() {
		var b cart.Bundle
		var qtyRaw, locRaw []byte
		if err := brows.Scan(&b.ID, &b.Name, &qtyRaw, &b.StandaloneTotalMinor, &b.BundleTotalMinor, &b.DiscountMinor, &locRaw); err != nil {
			return nil, nil, err
		}
		b.SKUQuantities = cart.ParseSKUQty(qtyRaw)
		b.LocationIDs = cart.ParseStringSlice(locRaw)
		bundles = append(bundles, b)
	}
	return promos, bundles, nil
}

func (k *Kernel) invalidateActiveProposal(ctx context.Context, tx pgx.Tx, session *SessionSummary) error {
	if session.Status != "CHECKOUT_HELD" {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT checkout_proposal_id FROM checkout_proposals WHERE session_id=$1 AND status='ACTIVE'`, session.SessionID)
	if err != nil {
		return err
	}
	var idsList []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		idsList = append(idsList, id)
	}
	rows.Close()
	for _, pid := range idsList {
		if err := k.releaseProposal(ctx, tx, pid, "INVALIDATED"); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE shopping_sessions SET status='ACTIVE', updated_at=now() WHERE session_id=$1`, session.SessionID)
	session.Status = "ACTIVE"
	return err
}

func (k *Kernel) releaseProposal(ctx context.Context, tx pgx.Tx, proposalID, terminal string) error {
	resRows, err := tx.Query(ctx, `SELECT sku_id, location_id, quantity FROM reservations WHERE checkout_proposal_id=$1 AND status='ACTIVE' FOR UPDATE`, proposalID)
	if err != nil {
		return err
	}
	type res struct {
		sku, loc string
		qty      int
	}
	var list []res
	for resRows.Next() {
		var r res
		if err := resRows.Scan(&r.sku, &r.loc, &r.qty); err != nil {
			resRows.Close()
			return err
		}
		list = append(list, r)
	}
	resRows.Close()
	for _, r := range list {
		if _, err := tx.Exec(ctx, `UPDATE inventory SET reserved_quantity = reserved_quantity - $3, updated_at=now() WHERE location_id=$1 AND sku_id=$2`, r.loc, r.sku, r.qty); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE reservations SET status='RELEASED' WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE checkout_proposals SET status=$2 WHERE checkout_proposal_id=$1 AND status='ACTIVE'`, proposalID, terminal)
	return err
}

func (k *Kernel) guardMutable(session SessionSummary) error {
	switch session.Status {
	case "PAYMENT_PENDING":
		return apperr.New(apperr.PaymentProcessing, "cart cannot change while payment is pending")
	case "ORDER_CONFIRMED", "CLOSED", "EXPIRED":
		return apperr.New(apperr.InvalidArgument, "session is not mutable")
	}
	return nil
}

func (k *Kernel) expectCart(session SessionSummary, expected int64) error {
	if session.CartVersion != expected {
		e := apperr.New(apperr.CartVersionConflict, "stale cart version")
		e.Session = session
		return e
	}
	return nil
}

func (k *Kernel) expectSession(session SessionSummary, expected int64) error {
	if session.SessionContextVersion != expected {
		e := apperr.New(apperr.SessionVersionConflict, "stale session context version")
		e.Session = session
		return e
	}
	return nil
}

func (k *Kernel) bumpCart(ctx context.Context, tx pgx.Tx, session *SessionSummary) error {
	if err := tx.QueryRow(ctx, `UPDATE carts SET cart_version = cart_version + 1, updated_at=now() WHERE cart_id=$1 RETURNING cart_version`, session.CartID).Scan(&session.CartVersion); err != nil {
		return err
	}
	return nil
}

func (k *Kernel) skuPriceQty(ctx context.Context, tx pgx.Tx, locationID, skuID string) (productID, name string, price int64, sellable int, err error) {
	var onHand, reserved, buffer int
	var lifecycle string
	var assorted bool
	err = tx.QueryRow(ctx, `
		SELECT s.product_id, s.name, s.lifecycle, p.selling_price_minor, i.on_hand_quantity, i.reserved_quantity, i.safety_buffer, i.assorted
		FROM skus s
		JOIN prices p ON p.sku_id=s.sku_id AND p.location_id=$1
		JOIN inventory i ON i.sku_id=s.sku_id AND i.location_id=$1
		JOIN locations loc ON loc.location_id=$1
		WHERE s.sku_id=$2 AND `+inventory.PriceEffectiveSQL+` AND `+inventory.LocationActiveSQL, locationID, skuID).Scan(&productID, &name, &lifecycle, &price, &onHand, &reserved, &buffer, &assorted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, 0, apperr.New(apperr.ItemUnavailable, "SKU is not assorted at this location")
	}
	if err != nil {
		return "", "", 0, 0, err
	}
	if (lifecycle != "sellable" && lifecycle != "active") || !assorted {
		return "", "", 0, 0, apperr.New(apperr.ItemUnavailable, "SKU is not sellable")
	}
	qty := inventory.Sellable(onHand, reserved, buffer)
	if qty <= 0 {
		return "", "", 0, 0, apperr.New(apperr.ItemUnavailable, "SKU is not sellable")
	}
	return productID, name, price, qty, nil
}

func auditMutation(ctx context.Context, tx pgx.Tx, m Meta, op, action, resType, resID string, ver int64, body map[string]any, summary string) (string, error) {
	principal := audit.PrincipalApprovedHost
	pid := m.ApprovedHostID
	ch := audit.ChannelMCP
	if m.OperatorID != "" {
		principal = audit.PrincipalOperator
		pid = m.OperatorID
		ch = audit.ChannelAdmin
	}
	return audit.Append(ctx, tx, audit.Event{
		Kind:          "BOUNDARY_COMMAND_EVALUATED",
		RequestID:     m.RequestID,
		OperationID:   op,
		PrincipalType: principal,
		PrincipalID:   pid,
		Channel:       ch,
		Action:        action,
		ResourceType:  resType,
		ResourceID:    resID,
		ResourceVer:   ver,
		Body:          body,
		Summary:       summary,
		Correlation: audit.Merge(m.Correlation, map[string]string{
			"request_id": m.RequestID, "operation_id": op, "host_id": m.ApprovedHostID,
			resType + "_id": resID,
		}),
	})
}

func wrapConflict(err error, session SessionSummary, cart CartView) error {
	e := apperr.As(err)
	if e == nil {
		return err
	}
	if e.Code == apperr.CartVersionConflict || e.Code == apperr.SessionVersionConflict {
		e.Session = session
		e.Cart = cart
		if e.Details == nil {
			e.Details = map[string]string{}
		}
		e.Details["cart_version"] = fmt.Sprintf("%d", cart.Version)
		if !strings.Contains(e.Message, "cart_version=") {
			e.Message = fmt.Sprintf("%s cart_version=%d", e.Message, cart.Version)
		}
	}
	return e
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func newLineID() string { return ids.New(ids.Line) }
