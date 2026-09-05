package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/commerce"
	"atlas.dev/core/internal/fixtures"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/inventory"

	"github.com/jackc/pgx/v5"
)

func (k *Kernel) invalidateOffers(ctx context.Context, tx pgx.Tx, sessionID, reason string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT offer_id FROM offers WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','SELECTED')`, sessionID)
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
	_, err = tx.Exec(ctx, `UPDATE offers SET status='INVALIDATED', updated_at=now() WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','SELECTED')`, sessionID)
	_ = reason
	return idsList, err
}

func (k *Kernel) currentOffers(ctx context.Context, tx pgx.Tx, s SessionSummary) ([]OfferView, error) {
	rows, err := tx.Query(ctx, `
		SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor,
		       discount_amount_minor, quote_delta_minor, public_explanation
		FROM offers WHERE session_id=$1 AND status IN ('GENERATED','SHOWN','SELECTED') AND session_context_version=$2 AND cart_version=$3 AND expires_at > now()
		ORDER BY display_order, offer_id`, s.SessionID, s.SessionContextVersion, s.CartVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OfferView
	for rows.Next() {
		var o OfferView
		if err := rows.Scan(&o.OfferID, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &o.ExpiresAt, &o.Status, &o.GroundedReason, &o.Terms, &o.PatchJSON, &o.BuyerImpactMinor, &o.DiscountAmountMinor, &o.QuoteDeltaMinor, &o.ExplanationJSON); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (k *Kernel) writeOfferEvent(ctx context.Context, tx pgx.Tx, offerID, eventType string, payload map[string]any, requestID, operationID string) error {
	if offerID == "" {
		return nil
	}
	body, _ := json.Marshal(payload)
	_, err := tx.Exec(ctx, `INSERT INTO offer_events (offer_event_id, offer_id, event_type, payload, request_id, operation_id) VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''))`,
		ids.New(ids.OfferEvent), offerID, eventType, body, requestID, operationID)
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

func (k *Kernel) commerceInputs(ctx context.Context, tx pgx.Tx, s SessionSummary, cv CartView, surface string) (commerce.Context, commerce.Inputs, error) {
	enabled := map[string]bool{}
	copyByType := map[string]commerce.BuyerCopy{}
	strategyRev := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT strategy_type, enabled, COALESCE(surfaces, '{}'), COALESCE(config, '{}'::jsonb), visibility, revision FROM commercial_strategies`)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	for rows.Next() {
		var t, vis, rev string
		var on bool
		var surfaces []string
		var cfg []byte
		if err := rows.Scan(&t, &on, &surfaces, &cfg, &vis, &rev); err != nil {
			rows.Close()
			return commerce.Context{}, commerce.Inputs{}, err
		}
		copyByType[t] = commerce.BuyerCopyFromConfig(cfg)
		strategyRev[t] = rev
		if !commerce.IsKnownType(t) || vis != commerce.VisibilityDemo || !on {
			continue
		}
		if surface == "" || inSlice(surfaces, surface) {
			enabled[t] = true
		}
	}
	rows.Close()
	if s.EvaluationArm == "CONTROL" {
		enabled = map[string]bool{}
	} else if len(s.StrategyAllowlist) > 0 {
		allowed := map[string]bool{}
		for _, t := range s.StrategyAllowlist {
			if enabled[t] {
				allowed[t] = true
			}
		}
		enabled = allowed
	}
	promos, bundles, err := k.pricingRules(ctx, tx)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	skus := map[string]commerce.CatalogSKU{}
	srows, err := tx.Query(ctx, `
		SELECT s.sku_id, s.product_id, s.name, s.brand, p.selling_price_minor, p.cogs_minor, i.on_hand_quantity, i.reserved_quantity, i.safety_buffer, pr.category,
		       s.pack_size, s.pack_count, s.unit_of_measure, s.shelf_life_days,
		       COALESCE(pr.brand_id,''), COALESCE(pr.category_id,''), COALESCE(pr.subcategory_id,''),
		       COALESCE(pr.rating,0), COALESCE(pr.reviews,0), pr.lifecycle
		FROM skus s
		JOIN products pr ON pr.product_id=s.product_id
		JOIN prices p ON p.sku_id=s.sku_id AND p.location_id=$1
		JOIN inventory i ON i.sku_id=s.sku_id AND i.location_id=$1
		JOIN locations loc ON loc.location_id=$1
		WHERE s.lifecycle IN ('sellable','active') AND `+inventory.DiscoverableSQL+`
		  AND `+inventory.PriceEffectiveSQL+` AND `+inventory.LocationActiveSQL, s.LocationID)
	if err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	for srows.Next() {
		var sku commerce.CatalogSKU
		var on, res, buf int
		var cogs int64
		var shelf *int
		var lifecycle string
		if err := srows.Scan(&sku.SKUID, &sku.ProductID, &sku.Name, &sku.Brand, &sku.SellingMinor, &cogs, &on, &res, &buf, &sku.Category,
			&sku.PackSize, &sku.PackCount, &sku.NetUnit, &shelf, &sku.BrandID, &sku.CategoryID, &sku.SubcategoryID, &sku.Rating, &sku.Reviews, &lifecycle); err != nil {
			srows.Close()
			return commerce.Context{}, commerce.Inputs{}, err
		}
		if cogs > 0 {
			v := cogs
			sku.COGSMinor = &v
		}
		sku.ShelfLifeDays = shelf
		sku.ProductActive = lifecycle == "active" || lifecycle == "sellable"
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
	// Edges are fixture-advisory only. Strategies must not treat them as stock, substitution, or payment authority.
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
		BuyerID: s.SubjectReference,
	}
	in := commerce.Inputs{Promotions: promos, Bundles: bundles, SKUs: skus, Edges: edges, Copy: copyByType, Revisions: strategyRev}
	if err := k.attachCommerceSignals(ctx, tx, s, &cctx, &in); err != nil {
		return commerce.Context{}, commerce.Inputs{}, err
	}
	return cctx, in, nil
}

func (k *Kernel) regenerateOffers(ctx context.Context, tx pgx.Tx, s SessionSummary, cv CartView, surface, requestID, operationID string) ([]OfferView, []string, error) {
	cctx, in, err := k.commerceInputs(ctx, tx, s, cv, surface)
	if err != nil {
		return nil, nil, err
	}
	if !anyStrategyEnabled(cctx.Enabled) {
		return nil, nil, nil
	}
	cands, dropped := commerce.SelectTrace(cctx, in)
	exp := k.Now().Add(k.Cfg.OfferTTL)
	var views []OfferView
	var shown []map[string]any
	for i, c := range cands {
		oid := ids.New(ids.Offer)
		cid := ids.New(ids.Candidate)
		rev := in.Revisions[c.Strategy]
		feat, _ := json.Marshal(map[string]any{
			"strategy": c.Strategy, "eligibility": c.Eligibility, "inputs": c.Economics.EligibilityInputs,
			"relationship_source": "fixture", "relationship_authoritative": false,
			"relationship_revision": rev, "fixture_snapshot_id": fixtures.SnapshotID,
		})
		econ, _ := json.Marshal(map[string]any{
			"private": true, "score": c.Rank,
			"discount_amount_minor":        c.Economics.DiscountAmountMinor,
			"merchant_funded_minor":        c.Economics.MerchantFundedMinor,
			"partner_funded_minor":         c.Economics.PartnerFundedMinor,
			"expected_margin_impact_minor": c.Economics.ExpectedMarginImpactMinor,
			"quote_delta_minor":            c.Economics.QuoteDeltaMinor,
		})
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
		expl, _ := json.Marshal(c.Explanation)
		elig, _ := json.Marshal(c.Economics.EligibilityInputs)
		digest := strategyDigest(c.Strategy, rev)
		if _, err := tx.Exec(ctx, `INSERT INTO offers (
			offer_id, candidate_id, session_id, cart_id, session_context_version, cart_version, strategy_type, status,
			grounded_reason, terms, cart_patch, buyer_impact_minor, expires_at, display_order,
			strategy_revision, source_promotion_id, eligibility_inputs, discount_amount_minor, merchant_funded_minor,
			partner_funded_minor, expected_margin_impact_minor, quote_delta_minor, public_explanation)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'GENERATED',$8,$9,$10,$11,$12,$13,$14,NULLIF($15,''),$16,$17,$18,$19,$20,$21,$22)`,
			oid, cid, s.SessionID, s.CartID, s.SessionContextVersion, s.CartVersion, c.Strategy, c.Reason, c.Terms, patch, c.BuyerImpact, exp, i,
			rev, c.Economics.SourcePromotionID, elig, c.Economics.DiscountAmountMinor, c.Economics.MerchantFundedMinor,
			c.Economics.PartnerFundedMinor, c.Economics.ExpectedMarginImpactMinor, c.Economics.QuoteDeltaMinor, expl); err != nil {
			return nil, nil, err
		}
		if err := k.writeOfferEvent(ctx, tx, oid, "OFFER_GENERATED", map[string]any{
			"session_id": s.SessionID, "strategy": c.Strategy, "strategy_revision": rev, "strategy_digest": digest,
		}, requestID, operationID); err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE offers SET status='SHOWN', updated_at=now() WHERE offer_id=$1`, oid); err != nil {
			return nil, nil, err
		}
		if err := k.writeOfferEvent(ctx, tx, oid, "OFFER_SHOWN", map[string]any{
			"display_order": i, "session_id": s.SessionID, "cart_version": s.CartVersion, "strategy": c.Strategy,
		}, requestID, operationID); err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO commercial_attributions (
			attribution_id, offer_id, candidate_id, session_id, strategy_type, experiment_assignment,
			applied_quantity, outcome_completeness, attribution_state, strategy_revision, strategy_digest,
			quote_delta_minor, merchant_funded_minor, partner_funded_minor, cart_patch)
			VALUES ($1,$2,$3,$4,$5,$6,0,'INCOMPLETE','GENERATED',$7,$8,$9,$10,$11,$12)`,
			ids.New(ids.Attribution), oid, cid, s.SessionID, c.Strategy, armArg, rev, digest,
			c.Economics.QuoteDeltaMinor, c.Economics.MerchantFundedMinor, c.Economics.PartnerFundedMinor, patch); err != nil {
			return nil, nil, err
		}
		shown = append(shown, map[string]any{
			"offer_id": oid, "strategy": c.Strategy, "eligibility": c.Eligibility, "display_order": i, "drop_reason": "",
			"quote_delta_minor": c.Economics.QuoteDeltaMinor, "strategy_revision": rev,
		})
		views = append(views, OfferView{
			OfferID: oid, StrategyType: c.Strategy, SessionContextVersion: s.SessionContextVersion, CartVersion: s.CartVersion,
			ExpiresAt: exp, Status: "SHOWN", GroundedReason: c.Reason, Terms: c.Terms, PatchJSON: patch, BuyerImpactMinor: c.BuyerImpact,
			BaseAllInMinor: c.BaseAllInMinor, PatchedAllInMinor: c.PatchedAllIn, StrategyRevision: rev,
			DiscountAmountMinor: c.Economics.DiscountAmountMinor, MerchantFundedMinor: c.Economics.MerchantFundedMinor,
			PartnerFundedMinor: c.Economics.PartnerFundedMinor, ExpectedMarginMinor: c.Economics.ExpectedMarginImpactMinor,
			QuoteDeltaMinor: c.Economics.QuoteDeltaMinor, ExplanationJSON: expl,
		})
	}
	var droppedPublic []map[string]any
	for _, d := range dropped {
		droppedPublic = append(droppedPublic, map[string]any{
			"strategy": d.Strategy, "eligibility": d.Eligibility, "drop_reason": d.Reason,
		})
	}
	if err := k.recordCommercialDecision(ctx, tx, requestID, operationID, s.SessionID, surface, shown, droppedPublic); err != nil {
		return nil, nil, err
	}
	return views, nil, nil
}

func (k *Kernel) recordCommercialDecision(ctx context.Context, tx pgx.Tx, requestID, operationID, sessionID, surface string, shown, dropped []map[string]any) error {
	if requestID == "" && operationID == "" {
		return nil
	}
	body := map[string]any{"surface": surface, "session_id": sessionID, "shown": shown, "dropped": dropped}
	_, err := audit.Append(ctx, tx, audit.Event{
		Kind: "COMMERCIAL_DECISION_RECORDED", RequestID: requestID, OperationID: operationID,
		PrincipalType: audit.PrincipalSystem, Channel: audit.ChannelMCP, Action: "select_offers",
		ResourceType: "session", ResourceID: sessionID, Body: body,
		Summary:     "Atlas recorded why commercial offers were shown or dropped.",
		Correlation: map[string]string{"request_id": requestID, "operation_id": operationID, "session_id": sessionID},
	})
	return err
}

func (k *Kernel) ApplyOffer(ctx context.Context, m Meta, sessionID, offerID string, expectedSession, expectedCart int64) (CartMutation, error) {
	if err := rejectBuyerEconomics(m.Arguments); err != nil {
		return CartMutation{}, err
	}
	out, err := k.mutateCart(ctx, m, "apply_offer", sessionID, "", expectedCart, func(ctx context.Context, tx pgx.Tx, s *SessionSummary) error {
		if err := k.expectSession(*s, expectedSession); err != nil {
			return err
		}
		var status string
		var patchRaw []byte
		var exp time.Time
		var scv, cv, shownImpact int64
		var strategy string
		err := tx.QueryRow(ctx, `SELECT status, cart_patch, expires_at, session_context_version, cart_version, buyer_impact_minor, strategy_type FROM offers WHERE offer_id=$1 AND session_id=$2 FOR UPDATE`, offerID, sessionID).
			Scan(&status, &patchRaw, &exp, &scv, &cv, &shownImpact, &strategy)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(apperr.NotFound, "offer not found")
		}
		if err != nil {
			return err
		}
		if status != "GENERATED" && status != "SHOWN" && status != "SELECTED" {
			return apperr.New(apperr.OfferContextInvalid, "offer cannot be applied")
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
		cctx, in, err := k.commerceInputs(ctx, tx, *s, cvw, "")
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
		if _, err := tx.Exec(ctx, `UPDATE offers SET status='SELECTED', updated_at=now() WHERE offer_id=$1`, offerID); err != nil {
			return err
		}
		if err := k.writeOfferEvent(ctx, tx, offerID, "OFFER_SELECTED", map[string]any{"session_id": sessionID, "strategy": strategy}, m.RequestID, ""); err != nil {
			return err
		}
		if err := k.enforceEconomicConstraints(ctx, tx, *s, offerID, patch, m); err != nil {
			return err
		}
		if err := k.applyPatch(ctx, tx, s, patch); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE offers SET status='APPLIED', updated_at=now() WHERE offer_id=$1`, offerID); err != nil {
			return err
		}
		if err := k.writeOfferEvent(ctx, tx, offerID, "OFFER_APPLIED", map[string]any{
			"session_id": sessionID, "buyer_impact_minor": sim.BuyerImpact, "strategy": strategy,
			"quote_delta_minor": sim.PatchedAllInMinor - sim.BaseAllInMinor,
		}, m.RequestID, ""); err != nil {
			return err
		}
		appliedQty := 0
		for _, l := range patch.Lines {
			appliedQty += l.Quantity
		}
		_, err = tx.Exec(ctx, `UPDATE commercial_attributions SET
			applied_quantity=$2, outcome_completeness='APPLIED_ONLY', attribution_state='APPLIED',
			quote_delta_minor=$3, updated_at=now()
			WHERE offer_id=$1 AND session_id=$4`,
			offerID, appliedQty, sim.PatchedAllInMinor-sim.BaseAllInMinor, sessionID)
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

func anyStrategyEnabled(enabled map[string]bool) bool {
	for _, on := range enabled {
		if on {
			return true
		}
	}
	return false
}

func inSlice(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func filterOffersByEnabled(offers []OfferView, enabled map[string]bool) []OfferView {
	var out []OfferView
	for _, o := range offers {
		if enabled[o.StrategyType] {
			out = append(out, o)
		}
	}
	return out
}

func (k *Kernel) offersForSurface(ctx context.Context, tx pgx.Tx, s SessionSummary, cv CartView, surface string) ([]OfferView, error) {
	cctx, _, err := k.commerceInputs(ctx, tx, s, cv, surface)
	if err != nil {
		return nil, err
	}
	if !anyStrategyEnabled(cctx.Enabled) {
		return nil, nil
	}
	offers, err := k.currentOffers(ctx, tx, s)
	if err != nil {
		return nil, err
	}
	return filterOffersByEnabled(offers, cctx.Enabled), nil
}

func rejectBuyerEconomics(args map[string]any) error {
	if args == nil {
		return nil
	}
	banned := []string{"discount_amount_minor", "unit_price_minor", "merchant_funded_minor", "partner_funded_minor", "funding", "campaign_budget_minor", "price_override_minor"}
	for _, k := range banned {
		if _, ok := args[k]; ok {
			return apperr.New(apperr.InvalidArgument, "buyer cannot supply "+k)
		}
	}
	return nil
}

func strategyDigest(strategy, revision string) string {
	return digestOf(map[string]string{"strategy": strategy, "revision": revision})
}

func (k *Kernel) enforceEconomicConstraints(ctx context.Context, tx pgx.Tx, s SessionSummary, offerID string, patch commerce.Patch, m Meta) error {
	if patch.PromotionID == "" {
		return nil
	}
	var discount, partner int64
	_ = tx.QueryRow(ctx, `SELECT discount_amount_minor, partner_funded_minor FROM offers WHERE offer_id=$1`, offerID).Scan(&discount, &partner)
	consume := partner
	if consume <= 0 {
		consume = discount
	}
	var campID string
	_ = tx.QueryRow(ctx, `SELECT COALESCE(campaign_id,'') FROM promotions WHERE promotion_id=$1`, patch.PromotionID).Scan(&campID)
	if campID != "" && consume > 0 {
		tag, err := tx.Exec(ctx, `
			UPDATE campaigns SET budget_consumed_minor = budget_consumed_minor + $2
			WHERE campaign_id=$1 AND (budget_minor = 0 OR budget_consumed_minor + $2 <= budget_minor)`,
			campID, consume)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			_ = k.constraintAudit(ctx, tx, m, s.SessionID, offerID, "CAMPAIGN_BUDGET", "REJECTED", map[string]any{"campaign_id": campID, "amount_minor": consume})
			return apperr.New(apperr.OfferContextInvalid, "campaign budget would be exceeded")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO campaign_budget_ledger (ledger_id, campaign_id, session_id, offer_id, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
			ids.New("cbl"), campID, s.SessionID, offerID, consume); err != nil {
			return err
		}
		_ = k.constraintAudit(ctx, tx, m, s.SessionID, offerID, "CAMPAIGN_BUDGET", "ALLOWED", map[string]any{"campaign_id": campID, "amount_minor": consume})
	}
	buyer := s.SubjectReference
	if buyer == "" {
		buyer = "anonymous"
	}
	var maxBuyer int
	_ = tx.QueryRow(ctx, `SELECT COALESCE((condition->>'max_redemptions_per_buyer')::int, 0) FROM promotions WHERE promotion_id=$1`, patch.PromotionID).Scan(&maxBuyer)
	if maxBuyer > 0 {
		var n int
		_ = tx.QueryRow(ctx, `SELECT COUNT(*) FROM buyer_promo_redemptions WHERE buyer_id=$1 AND promotion_id=$2`, buyer, patch.PromotionID).Scan(&n)
		if n >= maxBuyer {
			_ = k.constraintAudit(ctx, tx, m, s.SessionID, offerID, "PER_BUYER_CAP", "REJECTED", map[string]any{"promotion_id": patch.PromotionID})
			return apperr.New(apperr.OfferContextInvalid, "per-buyer promotion cap reached")
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO buyer_promo_redemptions (redemption_id, buyer_id, promotion_id, session_id, offer_id) VALUES ($1,$2,$3,$4,$5)`,
		ids.New("red"), buyer, patch.PromotionID, s.SessionID, offerID); err != nil {
		_ = k.constraintAudit(ctx, tx, m, s.SessionID, offerID, "PER_SESSION_CAP", "REJECTED", map[string]any{"promotion_id": patch.PromotionID})
		return apperr.New(apperr.OfferContextInvalid, "promotion already applied in this session")
	}
	_ = k.constraintAudit(ctx, tx, m, s.SessionID, offerID, "PER_SESSION_CAP", "ALLOWED", map[string]any{"promotion_id": patch.PromotionID})
	return nil
}

func (k *Kernel) constraintAudit(ctx context.Context, tx pgx.Tx, m Meta, sessionID, offerID, kind, result string, detail map[string]any) error {
	body := map[string]any{"constraint": kind, "result": result, "offer_id": offerID, "detail": detail}
	_, err := audit.Append(ctx, tx, audit.Event{
		Kind: "COMMERCIAL_CONSTRAINT_DECISION", RequestID: m.RequestID, PrincipalType: "ATLAS_SYSTEM", Channel: "mcp",
		Action: "apply_offer", ResourceType: "offer", ResourceID: offerID, Body: body,
		Summary: "Atlas enforced a commercial economic constraint.",
	})
	_ = sessionID
	return err
}
