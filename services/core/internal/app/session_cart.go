package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/commerce"
	"atlas.dev/core/internal/ids"

	"github.com/jackc/pgx/v5"
)

var PublicTools = []string{
	"get_capabilities", "create_session", "set_intent", "search_catalog", "get_product",
	"get_cart", "add_cart_item", "update_cart_item", "remove_cart_item",
	"accept_offer", "apply_offer", "prepare_checkout", "complete_checkout",
	"get_order", "respond_to_substitution",
}

type Capabilities struct {
	ContractFamily         string
	ContractVersion        string
	MerchantDisplayName    string
	Currency               string
	Locale                 string
	Tools                  []string
	MaxPageSize            int32
	OfferTTLSeconds        int32
	ProposalHoldTTLSeconds int32
}

func (k *Kernel) GetCapabilities(ctx context.Context, m Meta) (Envelope, Capabilities, error) {
	env := k.withRequest(k.env(), m.RequestID, "")
	var name, currency, locale string
	err := k.Pool().QueryRow(ctx, `SELECT display_name, currency, locale FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&name, &currency, &locale)
	if err != nil {
		name, currency, locale = "Quickmart", "INR", "en-IN"
	}
	return env, Capabilities{
		ContractFamily:         "atlas.merchant.v1",
		ContractVersion:        ContractVersion,
		MerchantDisplayName:    name,
		Currency:               currency,
		Locale:                 locale,
		Tools:                  PublicTools,
		MaxPageSize:            25,
		OfferTTLSeconds:        int32(k.Cfg.OfferTTL.Seconds()),
		ProposalHoldTTLSeconds: int32(k.Cfg.ProposalHoldTTL.Seconds()),
	}, nil
}

func (k *Kernel) CreateSession(ctx context.Context, m Meta, subject, serviceability, locale, requestedLocation, evaluationArm string) (CartMutation, error) {
	if err := requireHost(m); err != nil {
		return CartMutation{}, err
	}
	m.RequireIdempotency = true
	m.Tool = "create_session"
	if m.Arguments == nil {
		m.Arguments = map[string]any{
			"subject_reference": subject, "delivery_serviceability_reference": serviceability, "locale": locale, "requested_location_id": requestedLocation, "evaluation_arm": evaluationArm,
		}
	}
	input := m.Arguments
	tx, replay, op, err := k.beginMutation(ctx, m, "create_session", input)
	if err != nil {
		return CartMutation{}, err
	}
	if replay != nil {
		var out CartMutation
		_ = json.Unmarshal(replay, &out)
		return out, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	locID, err := k.resolveLocation(ctx, tx, requestedLocation, serviceability)
	if err != nil {
		return CartMutation{}, err
	}
	sessionID := ids.New(ids.Session)
	cartID := ids.New(ids.Cart)
	if locale == "" {
		locale = "en-IN"
	}
	exp := k.Now().Add(24 * time.Hour)
	arm := strings.TrimSpace(evaluationArm)
	if arm != "" && arm != "CONTROL" && arm != "TREATMENT" {
		return CartMutation{}, apperr.New(apperr.InvalidArgument, "evaluation_arm must be CONTROL, TREATMENT, or empty")
	}
	var armArg any
	if arm != "" {
		armArg = arm
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shopping_sessions (session_id, approved_host_id, subject_reference, location_id, serviceability_reference, locale, session_context_version, status, expires_at, evaluation_arm)
		VALUES ($1,$2,$3,$4,$5,$6,0,'ACTIVE',$7,$8)`, sessionID, m.ApprovedHostID, subject, locID, serviceability, locale, exp, armArg); err != nil {
		return CartMutation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO carts (cart_id, session_id, cart_version, currency) VALUES ($1,$2,0,'INR')`, cartID, sessionID); err != nil {
		return CartMutation{}, err
	}
	session, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return CartMutation{}, err
	}
	cv, err := k.recalcAndStoreCart(ctx, tx, session)
	if err != nil {
		return CartMutation{}, err
	}
	aid, err := auditMutation(ctx, tx, m, op, "create_session", "session", sessionID, 0, map[string]any{"location_id": locID}, "Approved Host created a shopping session.")
	if err != nil {
		return CartMutation{}, err
	}
	out := CartMutation{Envelope: k.withRequest(k.env(), m.RequestID, op), Session: session, Cart: cv}
	if err := k.storeIdempotency(ctx, tx, m, "create_session", input, out, aid); err != nil {
		return CartMutation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CartMutation{}, err
	}
	return out, nil
}

func (k *Kernel) resolveLocation(ctx context.Context, tx pgx.Tx, requested, serviceability string) (string, error) {
	requested = strings.TrimSpace(requested)
	serviceability = strings.TrimSpace(serviceability)
	if requested == "" && serviceability == "" {
		return "", apperr.New(apperr.InvalidArgument, "delivery location is required")
	}
	if requested != "" {
		var id string
		var active bool
		err := tx.QueryRow(ctx, `SELECT location_id, active FROM locations WHERE location_id=$1`, requested).Scan(&id, &active)
		if errors.Is(err, pgx.ErrNoRows) || !active {
			return "", apperr.New(apperr.InvalidArgument, "requested location is not serviceable")
		}
		return id, err
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT location_id FROM locations WHERE serviceability_reference=$1 AND active=TRUE`, serviceability).Scan(&id)
	if err != nil {
		return "", apperr.New(apperr.InvalidArgument, "delivery location is not serviceable")
	}
	return id, nil
}

func (k *Kernel) SetIntent(ctx context.Context, m Meta, sessionID string, expected int64, mission string, budgetMinor int64, currency string, constraints map[string]string) (CartMutation, error) {
	if err := requireHost(m); err != nil {
		return CartMutation{}, err
	}
	m.RequireIdempotency = true
	m.Tool = "set_intent"
	if m.Arguments == nil {
		m.Arguments = map[string]any{"session_id": sessionID, "expected_session_context_version": expected, "mission": mission, "planning_budget_minor": budgetMinor, "currency": currency}
	}
	tx, replay, op, err := k.beginMutation(ctx, m, "set_intent", m.Arguments)
	if err != nil {
		return CartMutation{}, err
	}
	if replay != nil {
		var out CartMutation
		_ = json.Unmarshal(replay, &out)
		return out, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	session, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return CartMutation{}, err
	}
	cv, _ := k.loadCart(ctx, tx, session.CartID)
	if err := k.guardMutable(session); err != nil {
		return CartMutation{}, err
	}
	if err := k.expectSession(session, expected); err != nil {
		return CartMutation{}, wrapConflict(err, session, cv)
	}
	if err := k.invalidateActiveProposal(ctx, tx, &session); err != nil {
		return CartMutation{}, err
	}
	inv, err := k.invalidateOffers(ctx, tx, session.SessionID, "context change")
	if err != nil {
		return CartMutation{}, err
	}
	cur := currency
	if cur == "" {
		cur = "INR"
	}
	cj, _ := json.Marshal(constraints)
	if err := tx.QueryRow(ctx, `
		UPDATE shopping_sessions SET mission=$2, planning_budget_minor=$3, planning_budget_currency=$4, constraints=$5,
			session_context_version = session_context_version + 1, updated_at=now()
		WHERE session_id=$1 RETURNING session_context_version`, sessionID, mission, budgetMinor, cur, cj).Scan(&session.SessionContextVersion); err != nil {
		return CartMutation{}, err
	}
	session.Mission = mission
	session.PlanningBudgetMinor = budgetMinor
	session.HasBudget = true
	session, err = k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return CartMutation{}, err
	}
	cv, err = k.recalcAndStoreCart(ctx, tx, session)
	if err != nil {
		return CartMutation{}, err
	}
	offers, _, err := k.regenerateOffers(ctx, tx, session, cv, "set_intent")
	if err != nil {
		return CartMutation{}, err
	}
	aid, err := auditMutation(ctx, tx, m, op, "set_intent", "session", sessionID, session.SessionContextVersion, map[string]any{"mission": mission}, "Approved Host set session intent.")
	if err != nil {
		return CartMutation{}, err
	}
	out := CartMutation{Envelope: k.withRequest(k.env(), m.RequestID, op), Session: session, Cart: cv, Offers: offers, InvalidatedOfferIDs: inv}
	if err := k.storeIdempotency(ctx, tx, m, "set_intent", m.Arguments, out, aid); err != nil {
		return CartMutation{}, err
	}
	return out, tx.Commit(ctx)
}

func (k *Kernel) GetSession(ctx context.Context, m Meta, sessionID string) (Envelope, SessionSummary, CartView, error) {
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	host := m.ApprovedHostID
	if m.OperatorID != "" {
		host = ""
	}
	s, err := k.loadSession(ctx, tx, sessionID, host)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, err
	}
	c, err := k.loadCart(ctx, tx, s.CartID)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, err
	}
	_ = tx.Commit(ctx)
	return k.withRequest(k.env(), m.RequestID, ""), s, c, nil
}

func (k *Kernel) GetCart(ctx context.Context, m Meta, sessionID string) (CartMutation, error) {
	if err := requireHost(m); err != nil {
		return CartMutation{}, err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return CartMutation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return CartMutation{}, err
	}
	c, err := k.loadCart(ctx, tx, s.CartID)
	if err != nil {
		return CartMutation{}, err
	}
	offers, err := k.offersForSurface(ctx, tx, s, c, "get_cart")
	if err != nil {
		return CartMutation{}, err
	}
	_, _ = audit.Append(ctx, tx, audit.Event{
		Kind: "COMMERCIAL_REPRESENTATION_ISSUED", RequestID: m.RequestID, PrincipalType: "APPROVED_HOST", PrincipalID: m.ApprovedHostID,
		Channel: "mcp", Action: "get_cart", ResourceType: "cart", ResourceID: c.CartID, ResourceVer: c.Version,
		Body: map[string]any{"session_id": sessionID}, RetentionClass: "representations_90d",
		Summary: "Approved Host read the authoritative cart.",
	})
	if err := tx.Commit(ctx); err != nil {
		return CartMutation{}, err
	}
	return CartMutation{Envelope: k.withRequest(k.env(), m.RequestID, ""), Session: s, Cart: c, Offers: offers}, nil
}

func (k *Kernel) AddItem(ctx context.Context, m Meta, sessionID, cartID string, expected int64, skuID string, qty int32) (CartMutation, error) {
	return k.mutateCart(ctx, m, "add_cart_item", sessionID, cartID, expected, func(ctx context.Context, tx pgx.Tx, s *SessionSummary) error {
		if qty <= 0 {
			return apperr.New(apperr.InvalidArgument, "quantity must be positive")
		}
		if s.CartID != cartID {
			return apperr.New(apperr.InvalidArgument, "cart does not belong to session")
		}
		productID, name, price, sellable, err := k.skuPriceQty(ctx, tx, s.LocationID, skuID)
		if err != nil {
			return err
		}
		_ = name
		var existingID string
		var existingQty int32
		err = tx.QueryRow(ctx, `SELECT cart_line_id, quantity FROM cart_lines WHERE cart_id=$1 AND sku_id=$2`, cartID, skuID).Scan(&existingID, &existingQty)
		if errors.Is(err, pgx.ErrNoRows) {
			if int(qty) > sellable {
				return apperr.New(apperr.ItemUnavailable, "insufficient sellable quantity")
			}
			_, err = tx.Exec(ctx, `INSERT INTO cart_lines (cart_line_id, cart_id, sku_id, product_id, quantity, unit_price_minor, line_total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				newLineID(), cartID, skuID, productID, qty, price, price*int64(qty))
			return err
		}
		if err != nil {
			return err
		}
		next := existingQty + qty
		if int(next) > sellable {
			return apperr.New(apperr.ItemUnavailable, "insufficient sellable quantity")
		}
		_, err = tx.Exec(ctx, `UPDATE cart_lines SET quantity=$2, unit_price_minor=$3, line_total_minor=($3::bigint)*($2::int) WHERE cart_line_id=$1`, existingID, next, price)
		return err
	})
}

func (k *Kernel) UpdateItem(ctx context.Context, m Meta, sessionID, cartID string, expected int64, lineID string, qty int32) (CartMutation, error) {
	return k.mutateCart(ctx, m, "update_cart_item", sessionID, cartID, expected, func(ctx context.Context, tx pgx.Tx, s *SessionSummary) error {
		if qty <= 0 {
			return apperr.New(apperr.InvalidArgument, "quantity zero is not an update; use remove_cart_item")
		}
		var skuID string
		err := tx.QueryRow(ctx, `SELECT sku_id FROM cart_lines WHERE cart_line_id=$1 AND cart_id=$2`, lineID, cartID).Scan(&skuID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.New(apperr.NotFound, "cart line not found")
		}
		if err != nil {
			return err
		}
		_, _, price, sellable, err := k.skuPriceQty(ctx, tx, s.LocationID, skuID)
		if err != nil {
			return err
		}
		if int(qty) > sellable {
			return apperr.New(apperr.InventoryChanged, "insufficient sellable quantity")
		}
		_, err = tx.Exec(ctx, `UPDATE cart_lines SET quantity=$2, unit_price_minor=$3, line_total_minor=($3::bigint)*($2::int) WHERE cart_line_id=$1`, lineID, qty, price)
		return err
	})
}

func (k *Kernel) RemoveItem(ctx context.Context, m Meta, sessionID, cartID string, expected int64, lineID string) (CartMutation, error) {
	return k.mutateCart(ctx, m, "remove_cart_item", sessionID, cartID, expected, func(ctx context.Context, tx pgx.Tx, s *SessionSummary) error {
		tag, err := tx.Exec(ctx, `DELETE FROM cart_lines WHERE cart_line_id=$1 AND cart_id=$2`, lineID, cartID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apperr.New(apperr.NotFound, "cart line not found")
		}
		return nil
	})
}

func (k *Kernel) mutateCart(ctx context.Context, m Meta, tool, sessionID, cartID string, expected int64, fn func(context.Context, pgx.Tx, *SessionSummary) error) (CartMutation, error) {
	if err := requireHost(m); err != nil {
		return CartMutation{}, err
	}
	m.RequireIdempotency = true
	m.Tool = tool
	if m.Arguments == nil {
		m.Arguments = map[string]any{"session_id": sessionID, "cart_id": cartID, "expected_cart_version": expected}
	}
	tx, replay, op, err := k.beginMutation(ctx, m, tool, m.Arguments)
	if err != nil {
		return CartMutation{}, err
	}
	if replay != nil {
		var out CartMutation
		_ = json.Unmarshal(replay, &out)
		return out, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	session, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return CartMutation{}, err
	}
	cv, _ := k.loadCart(ctx, tx, session.CartID)
	if err := k.guardMutable(session); err != nil {
		return CartMutation{}, err
	}
	if err := k.expectCart(session, expected); err != nil {
		return CartMutation{}, wrapConflict(err, session, cv)
	}
	if cartID != "" && session.CartID != cartID {
		return CartMutation{}, apperr.New(apperr.InvalidArgument, "cart does not belong to session")
	}
	if err := k.invalidateActiveProposal(ctx, tx, &session); err != nil {
		return CartMutation{}, err
	}
	if err := fn(ctx, tx, &session); err != nil {
		cv2, _ := k.loadCart(ctx, tx, session.CartID)
		return CartMutation{}, wrapConflict(err, session, cv2)
	}
	if err := k.bumpCart(ctx, tx, &session); err != nil {
		return CartMutation{}, err
	}
	inv, err := k.invalidateOffers(ctx, tx, session.SessionID, "cart mutation")
	if err != nil {
		return CartMutation{}, err
	}
	session, _ = k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	cv, err = k.recalcAndStoreCart(ctx, tx, session)
	if err != nil {
		return CartMutation{}, err
	}
	offers, _, err := k.regenerateOffers(ctx, tx, session, cv, tool)
	if err != nil {
		return CartMutation{}, err
	}
	aid, err := auditMutation(ctx, tx, m, op, tool, "cart", session.CartID, session.CartVersion, map[string]any{"expected_cart_version": expected}, "Approved Host mutated the cart.")
	if err != nil {
		return CartMutation{}, err
	}
	out := CartMutation{Envelope: k.withRequest(k.env(), m.RequestID, op), Session: session, Cart: cv, Offers: offers, InvalidatedOfferIDs: inv}
	if err := k.storeIdempotency(ctx, tx, m, tool, m.Arguments, out, aid); err != nil {
		return CartMutation{}, err
	}
	return out, tx.Commit(ctx)
}

func (k *Kernel) SearchCatalog(ctx context.Context, m Meta, sessionID, query, category, brand, cursor string, pageSize int32) (Envelope, []SKUView, string, []OfferView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, nil, "", nil, err
	}
	if pageSize <= 0 || pageSize > 25 {
		pageSize = 20
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return Envelope{}, nil, "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return Envelope{}, nil, "", nil, err
	}
	q := strings.TrimSpace(query)
	rows, err := tx.Query(ctx, `
		SELECT s.sku_id, s.product_id, s.name, s.brand, s.variant, s.pack_size, s.unit_of_measure, s.barcode,
		       s.canonical_description, s.lifecycle, p.selling_price_minor,
		       GREATEST(i.on_hand_quantity - i.reserved_quantity - i.safety_buffer, 0), i.stock_status, i.assorted,
		       pr.category
		FROM skus s
		JOIN products pr ON pr.product_id = s.product_id
		JOIN prices p ON p.sku_id=s.sku_id AND p.location_id=$1
		JOIN inventory i ON i.sku_id=s.sku_id AND i.location_id=$1
		WHERE s.lifecycle IN ('sellable','active') AND i.assorted=TRUE
		  AND ($2 = '' OR s.name ILIKE '%'||$2||'%' OR pr.name ILIKE '%'||$2||'%' OR s.brand ILIKE '%'||$2||'%' OR pr.canonical_description ILIKE '%'||$2||'%' OR s.name % $2 OR pr.name % $2)
		  AND ($3 = '' OR pr.category = $3)
		  AND ($4 = '' OR s.brand = $4)
		  AND ($5 = '' OR s.sku_id > $5)
		ORDER BY CASE WHEN $2 = '' THEN 0 ELSE greatest(similarity(s.name, $2), similarity(pr.name, $2)) END DESC, s.sku_id
		LIMIT $6`, s.LocationID, q, category, brand, cursor, pageSize+1)
	if err != nil {
		return Envelope{}, nil, "", nil, err
	}
	var items []SKUView
	for rows.Next() {
		var v SKUView
		var cat string
		if err := rows.Scan(&v.SKUID, &v.ProductID, &v.Name, &v.Brand, &v.Variant, &v.PackSize, &v.UOM, &v.Barcode, &v.Description, &v.Lifecycle, &v.SellingMinor, &v.Sellable, &v.StockStatus, &v.Assorted, &cat); err != nil {
			rows.Close()
			return Envelope{}, nil, "", nil, err
		}
		v.Category = cat
		items = append(items, v)
	}
	rows.Close()
	var next string
	if int32(len(items)) > pageSize {
		items = items[:pageSize]
		next = items[len(items)-1].SKUID
	}
	cv, err := k.loadCart(ctx, tx, s.CartID)
	if err != nil {
		return Envelope{}, nil, "", nil, err
	}
	cctx, in, err := k.commerceInputs(ctx, tx, s, cv, "search_catalog")
	if err != nil {
		return Envelope{}, nil, "", nil, err
	}
	cctx.Query = q
	if cctx.Enabled["SEARCH_RANKING"] || cctx.Enabled["PAST_PURCHASE"] {
		hits := make([]commerce.RankedHit, len(items))
		for i, it := range items {
			sku := in.SKUs[it.SKUID]
			hits[i] = commerce.RankedHit{
				SKUID: it.SKUID, QueryRelevance: commerce.QueryRelevance(q, it.Name, it.Brand, it.Category),
				PriceMinor: it.SellingMinor, Rating: sku.Rating, Sellable: int(it.Sellable),
				ProductID: it.ProductID, Brand: it.Brand, BrandID: sku.BrandID, CategoryID: sku.CategoryID,
			}
		}
		ranked := commerce.RankCatalog(cctx, in, hits)
		byID := make(map[string]SKUView, len(items))
		for _, it := range items {
			byID[it.SKUID] = it
		}
		items = items[:0]
		for _, h := range ranked {
			if v, ok := byID[h.SKUID]; ok {
				items = append(items, v)
			}
		}
	}
	var offers []OfferView
	if anyStrategyEnabled(cctx.Enabled) {
		if _, err := k.invalidateOffers(ctx, tx, s.SessionID, "search_catalog"); err != nil {
			return Envelope{}, nil, "", nil, err
		}
		offers, _, err = k.regenerateOffers(ctx, tx, s, cv, "search_catalog")
		if err != nil {
			return Envelope{}, nil, "", nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Envelope{}, nil, "", nil, err
	}
	return k.withRequest(k.env(), m.RequestID, ""), items, next, offers, nil
}

type SKUView struct {
	SKUID        string
	ProductID    string
	Name         string
	Brand        string
	Variant      string
	PackSize     int32
	UOM          string
	Barcode      string
	Description  string
	Lifecycle    string
	SellingMinor int64
	Sellable     int32
	StockStatus  string
	Assorted     bool
	Category     string
	Dietary      []string
}

type ProductView struct {
	ProductID   string
	Name        string
	Brand       string
	Category    string
	Subcategory string
	Description string
	Dietary     []string
	Lifecycle   string
	SKUs        []SKUView
}

func (k *Kernel) GetProduct(ctx context.Context, m Meta, sessionID, productID, locationID string) (Envelope, ProductView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, ProductView{}, err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return Envelope{}, ProductView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return Envelope{}, ProductView{}, err
	}
	_ = locationID
	loc := s.LocationID
	var p ProductView
	var diet []byte
	err = tx.QueryRow(ctx, `SELECT product_id, name, brand, category, subcategory, canonical_description, dietary, lifecycle FROM products WHERE product_id=$1`, productID).
		Scan(&p.ProductID, &p.Name, &p.Brand, &p.Category, &p.Subcategory, &p.Description, &diet, &p.Lifecycle)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, ProductView{}, apperr.New(apperr.NotFound, "product not found")
	}
	if err != nil {
		return Envelope{}, ProductView{}, err
	}
	_ = json.Unmarshal(diet, &p.Dietary)
	rows, err := tx.Query(ctx, `
		SELECT s.sku_id, s.product_id, s.name, s.brand, s.variant, s.pack_size, s.unit_of_measure, s.barcode,
		       s.canonical_description, s.lifecycle, p.selling_price_minor,
		       GREATEST(i.on_hand_quantity - i.reserved_quantity - i.safety_buffer, 0), i.stock_status, i.assorted
		FROM skus s
		JOIN prices p ON p.sku_id=s.sku_id AND p.location_id=$2
		JOIN inventory i ON i.sku_id=s.sku_id AND i.location_id=$2
		WHERE s.product_id=$1 AND i.assorted=TRUE`, productID, loc)
	if err != nil {
		return Envelope{}, ProductView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var v SKUView
		if err := rows.Scan(&v.SKUID, &v.ProductID, &v.Name, &v.Brand, &v.Variant, &v.PackSize, &v.UOM, &v.Barcode, &v.Description, &v.Lifecycle, &v.SellingMinor, &v.Sellable, &v.StockStatus, &v.Assorted); err != nil {
			return Envelope{}, ProductView{}, err
		}
		p.SKUs = append(p.SKUs, v)
	}
	_ = tx.Commit(ctx)
	return k.withRequest(k.env(), m.RequestID, ""), p, nil
}

func (k *Kernel) GetProfile(ctx context.Context, m Meta) (Envelope, map[string]any, []map[string]any, error) {
	var display, legal, desc, currency, locale, country, city, tz, email, cap string
	var ver int64
	err := k.Pool().QueryRow(ctx, `SELECT display_name, legal_name, description, currency, locale, country, city, timezone_display, support_email, capability_summary, profile_version FROM merchant_profile WHERE singleton_key='singleton'`).
		Scan(&display, &legal, &desc, &currency, &locale, &country, &city, &tz, &email, &cap, &ver)
	if err != nil {
		return Envelope{}, nil, nil, err
	}
	rows, err := k.Pool().Query(ctx, `SELECT location_id, name, neighbourhood, city, delivery_fee_minor, minimum_order_value_minor, free_delivery_threshold_minor, eta_min_minutes, eta_max_minutes, active, serviceability_reference FROM locations ORDER BY location_id`)
	if err != nil {
		return Envelope{}, nil, nil, err
	}
	defer rows.Close()
	var locs []map[string]any
	for rows.Next() {
		var id, name, nhood, city2, svc string
		var fee, mov, free int64
		var emin, emax int32
		var active bool
		if err := rows.Scan(&id, &name, &nhood, &city2, &fee, &mov, &free, &emin, &emax, &active, &svc); err != nil {
			return Envelope{}, nil, nil, err
		}
		locs = append(locs, map[string]any{
			"location_id": id, "name": name, "neighbourhood": nhood, "city": city2,
			"delivery_fee_minor": fee, "minimum_order_value_minor": mov, "free_delivery_threshold_minor": free,
			"eta_min_minutes": emin, "eta_max_minutes": emax, "active": active, "serviceability_reference": svc, "currency": "INR",
		})
	}
	profile := map[string]any{
		"display_name": display, "legal_name": legal, "description": desc, "currency": currency, "locale": locale,
		"country": country, "city": city, "timezone_display": tz, "support_email": email, "capability_summary": cap, "profile_version": ver,
	}
	return k.withRequest(k.env(), m.RequestID, ""), profile, locs, nil
}
