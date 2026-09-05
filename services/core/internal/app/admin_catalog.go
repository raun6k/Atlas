package app

import (
	"context"
	"encoding/json"
	"errors"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"

	"github.com/jackc/pgx/v5"
)

type InventoryRowView struct {
	LocationID       string
	SKUID            string
	OnHand           int32
	Reserved         int32
	SafetyBuffer     int32
	SellableQuantity int32
	StockStatus      string
}

type ProductRowView struct {
	ProductID   string
	Name        string
	Brand       string
	Category    string
	Subcategory string
	Description string
	Lifecycle   string
}

type PromotionView struct {
	ID                 string
	Type               string
	Name               string
	EligibleSKUs       []string
	EligibleLocations  []string
	MinQty             int32
	DiscountMinor      int64
	Enabled            bool
	Revision           int64
	MinBasketMinor     int64
	BenefitType        string
	FundingSplit       string
	BudgetCapMinor     int64
	CurrentUsageMinor  int64
	StartsAt           string
	EndsAt             string
	AttributionStatus  string
}

type HostRowView struct {
	HostID      string
	DisplayName string
	Status      string
	Scopes      []string
}

type RelationshipView struct {
	Source string
	Target string
	Type   string
}

func (k *Kernel) ListInventory(ctx context.Context, m Meta, locationID string) (Envelope, []InventoryRowView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT location_id, sku_id, on_hand_quantity, reserved_quantity, safety_buffer, GREATEST(on_hand_quantity-reserved_quantity-safety_buffer,0), stock_status FROM inventory WHERE ($1='' OR location_id=$1) ORDER BY sku_id LIMIT 500`, locationID)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []InventoryRowView
	for rows.Next() {
		var r InventoryRowView
		if err := rows.Scan(&r.LocationID, &r.SKUID, &r.OnHand, &r.Reserved, &r.SafetyBuffer, &r.SellableQuantity, &r.StockStatus); err != nil {
			return Envelope{}, nil, err
		}
		out = append(out, r)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ListProductsAdmin(ctx context.Context, m Meta) (Envelope, []ProductRowView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT product_id, name, brand, category, subcategory, canonical_description, lifecycle FROM products ORDER BY name LIMIT 200`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []ProductRowView
	for rows.Next() {
		var p ProductRowView
		if err := rows.Scan(&p.ProductID, &p.Name, &p.Brand, &p.Category, &p.Subcategory, &p.Description, &p.Lifecycle); err != nil {
			return Envelope{}, nil, err
		}
		out = append(out, p)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ListPromotions(ctx context.Context, m Meta) (Envelope, []PromotionView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `
		SELECT promotion_id, type, name, COALESCE(eligible_sku_ids, '[]'::jsonb), COALESCE(minimum_quantity,0),
		       COALESCE(discount_amount_minor,0), enabled, promotion_version, COALESCE(location_ids, '[]'::jsonb),
		       COALESCE((condition->>'minimum_basket_minor')::bigint, 0), COALESCE(benefit->>'type', type),
		       COALESCE(funding::text, '{}'), COALESCE((funding->>'budget_cap_minor')::bigint, 0),
		       COALESCE((
		         SELECT SUM(COALESCE(a.attributed_revenue_minor, a.quote_delta_minor, 0))
		         FROM offers o
		         JOIN commercial_attributions a ON a.offer_id = o.offer_id
		         WHERE o.source_promotion_id = promotions.promotion_id
		       ), 0),
		       COALESCE(starts_at::text, ''), COALESCE(ends_at::text, ''),
		       CASE WHEN EXISTS (
		         SELECT 1 FROM offers o
		         JOIN commercial_attributions a ON a.offer_id = o.offer_id
		         WHERE o.source_promotion_id = promotions.promotion_id
		           AND a.attribution_state IN ('REVENUE_ATTRIBUTED','ATTRIBUTED')
		       ) THEN 'ATTRIBUTED' ELSE 'METADATA_ONLY' END
		FROM promotions ORDER BY name LIMIT 200`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []PromotionView
	for rows.Next() {
		var p PromotionView
		var skus, locs []byte
		if err := rows.Scan(&p.ID, &p.Type, &p.Name, &skus, &p.MinQty, &p.DiscountMinor, &p.Enabled, &p.Revision, &locs,
			&p.MinBasketMinor, &p.BenefitType, &p.FundingSplit, &p.BudgetCapMinor, &p.CurrentUsageMinor, &p.StartsAt, &p.EndsAt, &p.AttributionStatus); err != nil {
			return Envelope{}, nil, err
		}
		_ = json.Unmarshal(skus, &p.EligibleSKUs)
		_ = json.Unmarshal(locs, &p.EligibleLocations)
		if p.EligibleSKUs == nil {
			p.EligibleSKUs = []string{}
		}
		if p.EligibleLocations == nil {
			p.EligibleLocations = []string{}
		}
		out = append(out, p)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ListHostsAdmin(ctx context.Context, m Meta) (Envelope, []HostRowView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT host_id, display_name, status, scopes FROM approved_hosts ORDER BY host_id`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []HostRowView
	for rows.Next() {
		var h HostRowView
		if err := rows.Scan(&h.HostID, &h.DisplayName, &h.Status, &h.Scopes); err != nil {
			return Envelope{}, nil, err
		}
		out = append(out, h)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ListRelationshipsAdmin(ctx context.Context, m Meta) (Envelope, []RelationshipView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT source_id, target_id, relationship_type FROM product_relationships LIMIT 500`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []RelationshipView
	for rows.Next() {
		var r RelationshipView
		if err := rows.Scan(&r.Source, &r.Target, &r.Type); err != nil {
			return Envelope{}, nil, err
		}
		out = append(out, r)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) ListSessionsAdmin(ctx context.Context, m Meta) (Envelope, []SessionSummary, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT s.session_id, s.session_context_version, s.location_id, s.status, c.cart_id, c.cart_version, COALESCE(s.planning_budget_minor,0), COALESCE(s.mission,''), COALESCE(c.currency,''), COALESCE(c.all_in_total_minor,0)
		FROM shopping_sessions s LEFT JOIN carts c ON c.session_id=s.session_id
		ORDER BY s.updated_at DESC LIMIT 100`)
	if err != nil {
		return Envelope{}, nil, err
	}
	defer rows.Close()
	var out []SessionSummary
	for rows.Next() {
		var s SessionSummary
		var total int64
		if err := rows.Scan(&s.SessionID, &s.SessionContextVersion, &s.LocationID, &s.Status, &s.CartID, &s.CartVersion, &s.PlanningBudgetMinor, &s.Mission, &s.Currency, &total); err != nil {
			return Envelope{}, nil, err
		}
		s.HasBudget = s.PlanningBudgetMinor > 0
		out = append(out, s)
	}
	return k.withMeta(k.env(), m, ""), out, rows.Err()
}

func (k *Kernel) UpdateMerchantProfile(ctx context.Context, m Meta, displayName, description, supportEmail string, expectedVersion int64) error {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return err
	}
	tag, err := k.Pool().Exec(ctx, `
		UPDATE merchant_profile SET
			display_name=COALESCE(NULLIF($1,''), display_name),
			description=COALESCE(NULLIF($2,''), description),
			support_email=COALESCE(NULLIF($3,''), support_email),
			profile_version=profile_version+1, updated_at=now()
		WHERE singleton_key='singleton' AND ($4=0 OR profile_version=$4)`, displayName, description, supportEmail, expectedVersion)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.New(apperr.VersionConflict, "merchant profile version conflict")
	}
	return nil
}

func (k *Kernel) UpdatePromotionEnabled(ctx context.Context, m Meta, promotionID string, enabled bool, expectedVersion int64) (PromotionView, error) {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return PromotionView{}, err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return PromotionView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rev int64
	err = tx.QueryRow(ctx, `
		UPDATE promotions SET enabled=$2, promotion_version=promotion_version+1
		WHERE promotion_id=$1 AND promotion_version=$3
		RETURNING promotion_version`, promotionID, enabled, expectedVersion).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM promotions WHERE promotion_id=$1)`, promotionID).Scan(&exists)
		if !exists {
			return PromotionView{}, apperr.New(apperr.NotFound, "promotion not found")
		}
		return PromotionView{}, apperr.New(apperr.VersionConflict, "promotion version conflict")
	}
	if err != nil {
		return PromotionView{}, err
	}
	_, _ = audit.Append(ctx, tx, audit.Event{
		Kind: "BOUNDARY_COMMAND_EVALUATED", RequestID: m.RequestID, PrincipalType: "OPERATOR", PrincipalID: m.OperatorID,
		Channel: "admin", Action: "update_promotion", ResourceType: "promotion", ResourceID: promotionID, ResourceVer: rev,
		Body: map[string]any{"enabled": enabled, "revision": rev, "expected_version": expectedVersion},
		Summary: "Operator updated promotion enabled flag.",
	})
	if err := tx.Commit(ctx); err != nil {
		return PromotionView{}, err
	}
	_, list, err := k.ListPromotions(ctx, m)
	if err != nil {
		return PromotionView{ID: promotionID, Enabled: enabled, Revision: rev}, nil
	}
	for _, p := range list {
		if p.ID == promotionID {
			return p, nil
		}
	}
	return PromotionView{ID: promotionID, Enabled: enabled, Revision: rev}, nil
}
