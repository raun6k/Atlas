package app

import (
	"context"
	"encoding/json"
	"time"

	"atlas.dev/core/internal/commerce"

	"github.com/jackc/pgx/v5"
)

func (k *Kernel) attachCommerceSignals(ctx context.Context, tx pgx.Tx, s SessionSummary, cctx *commerce.Context, in *commerce.Inputs) error {
	now := cctx.Now
	market, err := loadPurchaseEvents(ctx, tx, "")
	if err != nil {
		return err
	}
	buyerEvents, err := loadPurchaseEvents(ctx, tx, s.SubjectReference)
	if err != nil {
		return err
	}
	search, err := loadSearchEvents(ctx, tx, s.SubjectReference)
	if err != nil {
		return err
	}
	routines, err := loadRoutines(ctx, tx, s.SubjectReference)
	if err != nil {
		return err
	}
	in.Buyer = commerce.BuildBuyerSignals(s.SubjectReference, buyerEvents, search, routines, now)
	in.Market = commerce.BuildBasketIndex(market, buyerEvents)
	camps, err := loadCampaigns(ctx, tx)
	if err != nil {
		return err
	}
	in.Campaigns = camps
	terms, err := loadPromoTerms(ctx, tx)
	if err != nil {
		return err
	}
	in.PromoTerms = terms
	return nil
}

func loadPurchaseEvents(ctx context.Context, tx pgx.Tx, buyerID string) ([]commerce.PurchaseEvent, error) {
	q := `
		SELECT o.order_id, o.ordered_at, l.sku_id, l.quantity, l.price_paid_minor,
		       s.product_id, s.brand, COALESCE(pr.brand_id,''), COALESCE(pr.category_id,'')
		FROM buyer_orders o
		JOIN buyer_order_lines l ON l.order_id=o.order_id
		JOIN skus s ON s.sku_id=l.sku_id
		JOIN products pr ON pr.product_id=s.product_id
		WHERE o.status='COMPLETED'`
	args := []any{}
	if buyerID != "" {
		q += ` AND o.buyer_id=$1`
		args = append(args, buyerID)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []commerce.PurchaseEvent
	for rows.Next() {
		var e commerce.PurchaseEvent
		if err := rows.Scan(&e.OrderID, &e.OrderedAt, &e.SKUID, &e.Quantity, &e.PricePaid, &e.ProductID, &e.Brand, &e.BrandID, &e.CategoryID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func loadSearchEvents(ctx context.Context, tx pgx.Tx, buyerID string) ([]commerce.SearchEvent, error) {
	if buyerID == "" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT search_query, sku_id, event_type, occurred_at FROM search_events WHERE buyer_id=$1`, buyerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []commerce.SearchEvent
	for rows.Next() {
		var e commerce.SearchEvent
		if err := rows.Scan(&e.Query, &e.SKUID, &e.EventType, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func loadRoutines(ctx context.Context, tx pgx.Tx, buyerID string) ([]commerce.Routine, error) {
	if buyerID == "" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT r.routine_id, r.name, r.cadence_days, r.last_ordered_at, i.sku_id, i.usual_quantity
		FROM buyer_routines r
		JOIN buyer_routine_items i ON i.routine_id=r.routine_id
		WHERE r.buyer_id=$1
		ORDER BY r.routine_id, i.sku_id`, buyerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]*commerce.Routine{}
	var order []string
	for rows.Next() {
		var id, name, sku string
		var cadence, qty int
		var last *time.Time
		if err := rows.Scan(&id, &name, &cadence, &last, &sku, &qty); err != nil {
			return nil, err
		}
		r, ok := byID[id]
		if !ok {
			rr := commerce.Routine{ID: id, Name: name, CadenceDays: cadence}
			if last != nil {
				rr.LastOrderedAt = *last
			}
			byID[id] = &rr
			r = byID[id]
			order = append(order, id)
		}
		r.Items = append(r.Items, commerce.RoutineItem{SKUID: sku, UsualQuantity: qty})
	}
	out := make([]commerce.Routine, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, rows.Err()
}

func loadCampaigns(ctx context.Context, tx pgx.Tx) ([]commerce.Campaign, error) {
	rows, err := tx.Query(ctx, `
		SELECT campaign_id, COALESCE(brand_id,''), COALESCE(brand,''), promotion_ids,
		       budget_minor, budget_consumed_minor, brand_funding_pct, merchant_funding_pct
		FROM campaigns`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []commerce.Campaign
	for rows.Next() {
		var c commerce.Campaign
		var raw []byte
		if err := rows.Scan(&c.ID, &c.BrandID, &c.Brand, &raw, &c.BudgetMinor, &c.BudgetConsumed, &c.BrandFundingPct, &c.MerchantFundingPct); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &c.PromotionIDs)
		out = append(out, c)
	}
	return out, rows.Err()
}

func loadPromoTerms(ctx context.Context, tx pgx.Tx) (map[string]commerce.PromoTerms, error) {
	rows, err := tx.Query(ctx, `SELECT promotion_id, COALESCE(funding,'{}'), COALESCE(benefit,'{}'), COALESCE(condition,'{}') FROM promotions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]commerce.PromoTerms{}
	for rows.Next() {
		var id string
		var fundRaw, benRaw, condRaw []byte
		if err := rows.Scan(&id, &fundRaw, &benRaw, &condRaw); err != nil {
			return nil, err
		}
		var fund, ben, cond map[string]any
		_ = json.Unmarshal(fundRaw, &fund)
		_ = json.Unmarshal(benRaw, &ben)
		_ = json.Unmarshal(condRaw, &cond)
		t := commerce.PromoTerms{
			DiscountRate:    jsonFloat(ben["discount_rate"]),
			DiscountCap:     jsonInt(ben["discount_cap_minor"]),
			MinimumSpend:    jsonInt(cond["minimum_cart_value_minor"]),
			BrandFundPct:    int(jsonInt(fund["brand_funding_pct"])),
			MerchantFundPct: int(jsonInt(fund["merchant_funding_pct"])),
		}
		out[id] = t
	}
	return out, rows.Err()
}

func jsonFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case json.Number:
		n, _ := t.Float64()
		return n
	default:
		return 0
	}
}

func jsonInt(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	case json.Number:
		n, _ := t.Int64()
		return n
	default:
		return 0
	}
}
