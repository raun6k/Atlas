package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/commerce"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/inventory"

	"github.com/jackc/pgx/v5"
)

func (k *Kernel) invalidateOffers(ctx context.Context, tx pgx.Tx, sessionID, reason string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT offer_id FROM offers WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','ACCEPTED')`, sessionID)
	if err != nil {
		return nil, err
	}
	var idsList []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		idsList = append(idsList, id)
	}
	rows.Close()
	if len(idsList) == 0 {
		return nil, nil
	}
	_, err = tx.Exec(ctx, `UPDATE offers SET status='INVALIDATED', updated_at=now() WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','ACCEPTED')`, sessionID)
	_ = reason
	return idsList, err
}

func (k *Kernel) currentOffers(ctx context.Context, tx pgx.Tx, s SessionSummary) ([]OfferView, error) {
	rows, err := tx.Query(ctx, `
		SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor
		FROM offers WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','ACCEPTED') AND session_context_version=$2 AND cart_version=$3 AND expires_at > now()
		ORDER BY display_order, offer_id`, s.SessionID, s.SessionContextVersion, s.CartVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OfferView
	for rows.Next() {
		var o OfferView
		if err := rows.Scan(&o.OfferID, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &o.ExpiresAt, &o.Status, &o.GroundedReason, &o.Terms, &o.PatchJSON, &o.BuyerImpactMinor); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (k *Kernel) writeOfferEvent(ctx context.Context, tx pgx.Tx, offerID, eventType string, payload map[string]any) error {
	if offerID == "" {
		return nil
	}
	body, _ := json.Marshal(payload)
	_, err := tx.Exec(ctx, `INSERT INTO offer_events (offer_event_id, offer_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
		ids.New(ids.OfferEvent), offerID, eventType, body)
	return err
}

func (k *Kernel) writeOfferEventStandalone(ctx context.Context, offerID, eventType string, payload map[string]any) {
	if offerID == "" {
		return
	}
	body, _ := json.Marshal(payload)
	_, _ = k.Pool().Exec(ctx, `INSERT INTO offer_events (offer_event_id, offer_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
		ids.New(ids.OfferEvent), offerID, eventType, body)
}

func (k *Kernel) commerceInputs(ctx context.Context, tx pgx.Tx, s SessionSummary, cv CartView) (commerce.Context, commerce.Inputs, error) {
	enabled := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT strategy_type, enabled FROM commercial_strategies`)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	for rows.Next() {
		var t string
		var on bool
		if err := rows.Scan(&t, &on); err != nil {
			rows.Close()
			return commerce.Context{}, commerce.Inputs{}, err
		}
		enabled[t] = on
	}
	rows.Close()
	promos, bundles, err := k.pricingRules(ctx, tx)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	skus := map[string]commerce.CatalogSKU{}
	srows, err := tx.Query(ctx, `
		SELECT s.sku_id, s.product_id, s.name, s.brand, p.selling_price_minor, p.cogs_minor, i.on_hand_quantity, i.reserved_quantity, i.safety_buffer, pr.category
		FROM skus s
		JOIN products pr ON pr.product_id=s.product_id
		JOIN prices p ON p.sku_id=s.sku_id AND p.location_id=$1
		JOIN inventory i ON i.sku_id=s.sku_id AND i.location_id=$1
		WHERE s.lifecycle='sellable' AND i.assorted=TRUE
		  AND p.effective_from <= now() AND (p.effective_to IS NULL OR p.effective_to > now())`, s.LocationID)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	for srows.Next() {
		var sku commerce.CatalogSKU
		var on, res, buf int
		var cogs int64
		if err := srows.Scan(&sku.SKUID, &sku.ProductID, &sku.Name, &sku.Brand, &sku.SellingMinor, &cogs, &on, &res, &buf, &sku.Category); err != nil {
			srows.Close()
			return commerce.Context{}, commerce.Inputs{}, err
		}
		if cogs > 0 {
			v := cogs
			sku.COGSMinor = &v
		}
		sku.Sellable = inventory.Sellable(on, res, buf)
		skus[sku.SKUID] = sku
	}
	srows.Close()
	erows, err := tx.Query(ctx, `SELECT source_id, target_id, relationship_type, COALESCE(confidence,0) FROM product_relationships`)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	var edges []commerce.GraphEdge
	for erows.Next() {
		var e commerce.GraphEdge
		if err := erows.Scan(&e.Source, &e.Target, &e.Type, &e.Confidence); err != nil {
			erows.Close()
			return commerce.Context{}, commerce.Inputs{}, err
		}
		edges = append(edges, e)
	}
	erows.Close()
	fees, err := k.locationFees(ctx, tx, s.LocationID)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	var lines []cart.Line
	for _, l := range cv.Lines {
		lines = append(lines, cart.Line{LineID: l.LineID, SKUID: l.SKUID, ProductID: l.ProductID, Name: l.Name, Quantity: int(l.Quantity), UnitMinor: l.UnitMinor, LineMinor: l.LineMinor})
	}
	cctx := commerce.Context{
		LocationID: s.LocationID, MerchandiseMinor: cv.Totals.MerchandiseMinor, AllInMinor: cv.Totals.AllInMinor,
		BudgetMinor: s.PlanningBudgetMinor, HasBudget: s.HasBudget, FreeDeliveryThresholdMinor: fees.FreeDeliveryThresholdMinor,
		DeliveryFeeMinor: fees.DeliveryFeeMinor, Lines: lines, Enabled: enabled, Fees: fees,
		Constraints: s.Constraints, Mission: s.Mission, EvaluationArm: s.EvaluationArm, Now: k.Now(),
	}
	return cctx, commerce.Inputs{Promotions: promos, Bundles: bundles, SKUs: skus, Edges: edges}, nil
}

func (k *Kernel) regenerateOffers(ctx context.Context, tx pgx.Tx, s SessionSummary, cv CartView) ([]OfferView, []string, error) {
	cctx, in, err := k.commerceInputs(ctx, tx, s, cv)
	if err != nil {
		return nil, nil, err
	}
	cands := commerce.Select(cctx, in)
	exp := k.Now().Add(k.Cfg.OfferTTL)
	var views []OfferView
	for i, c := range cands {
		oid := ids.New(ids.Offer)
		cid := ids.New(ids.Candidate)
		feat, _ := json.Marshal(map[string]any{"strategy": c.Strategy, "eligibility": c.Eligibility})
		econ, _ := json.Marshal(map[string]any{"private": true, "score": c.Rank})
		arm := s.EvaluationArm
		var armArg any
		if arm != "" {
			armArg = arm
		}
		if _, err := tx.Exec(ctx, `INSERT INTO opportunity_candidates (candidate_id, session_id, cart_id, session_context_version, cart_version, strategy_type, features, economics_private, ranking_score, experiment_assignment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			cid, s.SessionID, s.CartID, s.SessionContextVersion, s.CartVersion, c.Strategy, feat, econ, c.Rank, armArg); err != nil {
			return nil, nil, err
		}
		patch, _ := json.Marshal(c.Patch)
		if _, err := tx.Exec(ctx, `INSERT INTO offers (offer_id, candidate_id, session_id, cart_id, session_context_version, cart_version, strategy_type, status, grounded_reason, terms, cart_patch, buyer_impact_minor, expires_at, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,'SHOWN',$8,$9,$10,$11,$12,$13)`,
			oid, cid, s.SessionID, s.CartID, s.SessionContextVersion, s.CartVersion, c.Strategy, c.Reason, c.Terms, patch, c.BuyerImpact, exp, i); err != nil {
			return nil, nil, err
		}
		if err := k.writeOfferEvent(ctx, tx, oid, "OFFER_SHOWN", map[string]any{
			"display_order": i, "session_id": s.SessionID, "cart_version": s.CartVersion, "strategy": c.Strategy,
		}); err != nil {
			return nil, nil, err
		}
		views = append(views, OfferView{
			OfferID: oid, StrategyType: c.Strategy, SessionContextVersion: s.SessionContextVersion, CartVersion: s.CartVersion,
			ExpiresAt: exp, Status: "SHOWN", GroundedReason: c.Reason, Terms: c.Terms, PatchJSON: patch, BuyerImpactMinor: c.BuyerImpact,
			BaseAllInMinor: c.BaseAllInMinor, PatchedAllInMinor: c.PatchedAllIn,
		})
	}
	return views, nil, nil
}

func (k *Kernel) AcceptOffer(ctx context.Context, m Meta, sessionID, offerID string, expectedSession, expectedCart int64) (Envelope, OfferView, SessionSummary, CartView, []OfferView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	m.RequireIdempotency = true
	m.Tool = "accept_offer"
	if m.Arguments == nil {
		m.Arguments = map[string]any{"session_id": sessionID, "offer_id": offerID, "expected_session_context_version": expectedSession, "expected_cart_version": expectedCart}
	}
	tx, replay, op, err := k.beginMutation(ctx, m, "accept_offer", m.Arguments)
	if err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	if replay != nil {
		var out struct {
			Env Envelope
			Off OfferView
			S   SessionSummary
			C   CartView
			O   []OfferView
		}
		_ = json.Unmarshal(replay, &out)
		return out.Env, out.Off, out.S, out.C, out.O, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	cv, _ := k.loadCart(ctx, tx, s.CartID)
	if err := k.guardMutable(s); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	if err := k.expectSession(s, expectedSession); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, wrapConflict(err, s, cv)
	}
	if err := k.expectCart(s, expectedCart); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, wrapConflict(err, s, cv)
	}
	var o OfferView
	err = tx.QueryRow(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor FROM offers WHERE offer_id=$1 AND session_id=$2 FOR UPDATE`, offerID, sessionID).
		Scan(&o.OfferID, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &o.ExpiresAt, &o.Status, &o.GroundedReason, &o.Terms, &o.PatchJSON, &o.BuyerImpactMinor)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, apperr.New(apperr.NotFound, "offer not found")
	}
	if err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	if o.Status == "EXPIRED" || k.Now().After(o.ExpiresAt) {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, apperr.New(apperr.OfferExpired, "offer expired")
	}
	if o.SessionContextVersion != s.SessionContextVersion || o.CartVersion != s.CartVersion {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, apperr.New(apperr.OfferContextInvalid, "offer is bound to a different context")
	}
	if o.Status != "GENERATED" && o.Status != "SHOWN" && o.Status != "ACCEPTED" {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, apperr.New(apperr.OfferContextInvalid, "offer cannot be accepted")
	}
	if _, err := tx.Exec(ctx, `UPDATE offers SET status='ACCEPTED', updated_at=now() WHERE offer_id=$1`, offerID); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	o.Status = "ACCEPTED"
	if err := k.writeOfferEvent(ctx, tx, offerID, "OFFER_ACCEPTED", map[string]any{"session_id": sessionID, "signal": true}); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	offers, err := k.currentOffers(ctx, tx, s)
	if err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	env := k.withRequest(k.env(), m.RequestID, op)
	aid, err := auditMutation(ctx, tx, m, op, "accept_offer", "offer", offerID, 0, map[string]any{"signal": true}, "Approved Host accepted an offer. Cart was not changed.")
	if err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	payload := struct {
		Env Envelope
		Off OfferView
		S   SessionSummary
		C   CartView
		O   []OfferView
	}{env, o, s, cv, offers}
	if err := k.storeIdempotency(ctx, tx, m, "accept_offer", m.Arguments, payload, aid); err != nil {
		return Envelope{}, OfferView{}, SessionSummary{}, CartView{}, nil, err
	}
	return env, o, s, cv, offers, tx.Commit(ctx)
}

func (k *Kernel) ApplyOffer(ctx context.Context, m Meta, sessionID, offerID string, expectedSession, expectedCart int64) (CartMutation, error) {
	out, err := k.mutateCart(ctx, m, "apply_offer", sessionID, "", expectedCart, func(ctx context.Context, tx pgx.Tx, s *SessionSummary) error {
		if err := k.expectSession(*s, expectedSession); err != nil {
			return err
		}
		var status string
		var patchRaw []byte
		var exp time.Time
		var scv, cv, shownImpact int64
		var strategy, candidateID string
		err := tx.QueryRow(ctx, `SELECT status, cart_patch, expires_at, session_context_version, cart_version, buyer_impact_minor, strategy_type, COALESCE(candidate_id,'') FROM offers WHERE offer_id=$1 AND session_id=$2 FOR UPDATE`, offerID, sessionID).
			Scan(&status, &patchRaw, &exp, &scv, &cv, &shownImpact, &strategy, &candidateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(apperr.NotFound, "offer not found")
		}
		if err != nil {
			return err
		}
		if status != "ACCEPTED" {
			return apperr.New(apperr.OfferNotAccepted, "offer must be accepted before apply")
		}
		if k.Now().After(exp) {
			return apperr.New(apperr.OfferExpired, "offer expired")
		}
		if scv != s.SessionContextVersion || cv != s.CartVersion {
			return apperr.New(apperr.OfferContextInvalid, "offer is bound to a different context")
		}
		var patch commerce.Patch
		if err := json.Unmarshal(patchRaw, &patch); err != nil {
			return err
		}
		cvw, err := k.loadCart(ctx, tx, s.CartID)
		if err != nil {
			return err
		}
		cctx, in, err := k.commerceInputs(ctx, tx, *s, cvw)
		if err != nil {
			return err
		}
		sim, err := commerce.Simulate(cctx, in, commerce.Candidate{Patch: patch}, k.Now())
		if err != nil {
			return apperr.New(apperr.OfferContextInvalid, "offer patch cannot be repriced")
		}
		if sim.Eligibility == "OVER_BUDGET" {
			return apperr.New(apperr.OfferContextInvalid, "offer would exceed the planning budget")
		}
		if sim.BuyerImpact > shownImpact {
			return apperr.New(apperr.RequoteRequired, "current economics are worse than the shown offer")
		}
		if err := k.applyPatch(ctx, tx, s, patch); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE offers SET status='APPLIED', updated_at=now() WHERE offer_id=$1`, offerID); err != nil {
			return err
		}
		if err := k.writeOfferEvent(ctx, tx, offerID, "OFFER_APPLIED", map[string]any{
			"session_id": sessionID, "buyer_impact_minor": sim.BuyerImpact, "strategy": strategy,
		}); err != nil {
			return err
		}
		appliedQty := 0
		for _, l := range patch.Lines {
			appliedQty += l.Quantity
		}
		_, err = tx.Exec(ctx, `INSERT INTO commercial_attributions (attribution_id, offer_id, candidate_id, session_id, strategy_type, experiment_assignment, applied_quantity, outcome_completeness)
			VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,'APPLIED_ONLY')`,
			ids.New(ids.Attribution), offerID, candidateID, sessionID, strategy, nullIfEmpty(s.EvaluationArm), appliedQty)
		return err
	})
	if err != nil {
		k.writeOfferEventStandalone(ctx, offerID, "OFFER_APPLY_FAILED", map[string]any{"session_id": sessionID, "error": err.Error()})
	}
	return out, err
}

func (k *Kernel) applyPatch(ctx context.Context, tx pgx.Tx, s *SessionSummary, patch commerce.Patch) error {
	if patch.Type == "REPLACE_ITEM" {
		if patch.SourceLineID == "" || len(patch.Lines) != 1 {
			return apperr.New(apperr.InvalidArgument, "invalid replace patch")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM cart_lines WHERE cart_line_id=$1 AND cart_id=$2`, patch.SourceLineID, s.CartID); err != nil {
			return err
		}
	}
	for _, l := range patch.Lines {
		if l.Op == "REMOVE" {
			if _, err := tx.Exec(ctx, `DELETE FROM cart_lines WHERE cart_id=$1 AND sku_id=$2`, s.CartID, l.SKUID); err != nil {
				return err
			}
			continue
		}
		productID, _, price, sellable, err := k.skuPriceQty(ctx, tx, s.LocationID, l.SKUID)
		if err != nil {
			return err
		}
		var existingID string
		var existingQty int32
		err = tx.QueryRow(ctx, `SELECT cart_line_id, quantity FROM cart_lines WHERE cart_id=$1 AND sku_id=$2`, s.CartID, l.SKUID).Scan(&existingID, &existingQty)
		if errors.Is(err, pgx.ErrNoRows) {
			if l.Quantity > sellable {
				return apperr.New(apperr.ItemUnavailable, "insufficient sellable quantity for offer patch")
			}
			_, err = tx.Exec(ctx, `INSERT INTO cart_lines (cart_line_id, cart_id, sku_id, product_id, quantity, unit_price_minor, line_total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				newLineID(), s.CartID, l.SKUID, productID, l.Quantity, price, price*int64(l.Quantity))
			if err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		next := existingQty
		if l.Op == "REPLACE" {
			next = int32(l.Quantity)
		} else {
			next = existingQty + int32(l.Quantity)
		}
		if int(next) > sellable {
			return apperr.New(apperr.ItemUnavailable, "insufficient sellable quantity for offer patch")
		}
		if _, err := tx.Exec(ctx, `UPDATE cart_lines SET quantity=$2, unit_price_minor=$3, line_total_minor=($3::bigint)*($2::int) WHERE cart_line_id=$1`, existingID, next, price); err != nil {
			return err
		}
	}
	return nil
}
