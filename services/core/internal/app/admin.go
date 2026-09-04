package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/cart"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/refund"
	"atlas.dev/core/internal/store"

	"github.com/jackc/pgx/v5"
)

type AuditEventView struct {
	ID           string
	Sequence     int64
	Kind         string
	OccurredAt   string
	RequestID    string
	OperationID  string
	Action       string
	ResourceType string
	ResourceID   string
	Summary      string
	Attention    string
	BodyJSON     []byte
}

func (k *Kernel) ListAuditEvents(ctx context.Context, m Meta, kind, resourceType, resourceID, requestID, operationID string, pageSize int32) (Envelope, []AuditEventView, string, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, nil, "", err
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	rows, err := k.Pool().Query(ctx, `
		SELECT audit_event_id, record_sequence, event_kind, occurred_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), COALESCE(action,''),
		       COALESCE(primary_resource_type,''), COALESCE(primary_resource_id,''), COALESCE(summary_sentence,''), COALESCE(attention_code,''), event_body
		FROM audit_events
		WHERE ($1 = '' OR event_kind = $1)
		  AND ($2 = '' OR primary_resource_type = $2)
		  AND ($3 = '' OR primary_resource_id = $3)
		  AND ($4 = '' OR request_id = $4)
		  AND ($5 = '' OR operation_id = $5)
		ORDER BY record_sequence DESC
		LIMIT $6`, kind, resourceType, resourceID, requestID, operationID, pageSize+1)
	if err != nil {
		return Envelope{}, nil, "", err
	}
	defer rows.Close()
	var out []AuditEventView
	for rows.Next() {
		var e AuditEventView
		if err := rows.Scan(&e.ID, &e.Sequence, &e.Kind, &e.OccurredAt, &e.RequestID, &e.OperationID, &e.Action, &e.ResourceType, &e.ResourceID, &e.Summary, &e.Attention, &e.BodyJSON); err != nil {
			return Envelope{}, nil, "", err
		}
		out = append(out, e)
	}
	var cursor string
	if int32(len(out)) > pageSize {
		out = out[:pageSize]
		cursor = out[len(out)-1].ID
	}
	return k.withRequest(k.env(), m.RequestID, ""), out, cursor, nil
}

func (k *Kernel) GetAuditEvent(ctx context.Context, m Meta, id string) (Envelope, AuditEventView, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, AuditEventView{}, err
	}
	var e AuditEventView
	err := k.Pool().QueryRow(ctx, `
		SELECT audit_event_id, record_sequence, event_kind, occurred_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), COALESCE(action,''),
		       COALESCE(primary_resource_type,''), COALESCE(primary_resource_id,''), COALESCE(summary_sentence,''), COALESCE(attention_code,''), event_body
		FROM audit_events WHERE audit_event_id=$1`, id).Scan(
		&e.ID, &e.Sequence, &e.Kind, &e.OccurredAt, &e.RequestID, &e.OperationID, &e.Action, &e.ResourceType, &e.ResourceID, &e.Summary, &e.Attention, &e.BodyJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, AuditEventView{}, apperr.New(apperr.NotFound, "audit event not found")
	}
	return k.withRequest(k.env(), m.RequestID, ""), e, err
}

func (k *Kernel) CreateAuditExport(ctx context.Context, m Meta, format, filterJSON string) (Envelope, string, string, error) {
	if err := k.requireScope(m, "audit:export"); err != nil {
		return Envelope{}, "", "", err
	}
	m.RequireIdempotency = true
	if format != "CSV_SUMMARY" && format != "JSON_SAFE_DETAIL" {
		return Envelope{}, "", "", apperr.New(apperr.InvalidArgument, "unsupported export format")
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return Envelope{}, "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	exportID := ids.New(ids.Export)
	var maxSeq int64
	_ = tx.QueryRow(ctx, `SELECT COALESCE(MAX(record_sequence),0) FROM audit_events`).Scan(&maxSeq)
	if _, err := tx.Exec(ctx, `INSERT INTO audit_exports (export_id, operator_id, format, filter_digest, filter_json, projection, status, maximum_record_sequence)
		VALUES ($1,$2,$3,$4,$5::jsonb,'safe',$6,$7)`, exportID, m.OperatorID, format, digestOf(filterJSON), nullJSON(filterJSON), "REQUESTED", maxSeq); err != nil {
		return Envelope{}, "", "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO jobs (job_id, job_type, payload, status, dedupe_key) VALUES ($1,'GENERATE_AUDIT_EXPORT',$2,'PENDING',$3)`,
		ids.New(ids.Job), mustJSON(map[string]any{"export_id": exportID}), "export:"+exportID); err != nil {
		return Envelope{}, "", "", err
	}
	_, _ = audit.Append(ctx, tx, audit.Event{Kind: "BOUNDARY_COMMAND_EVALUATED", RequestID: m.RequestID, PrincipalType: "OPERATOR", PrincipalID: m.OperatorID, Channel: "admin", Action: "create_audit_export", ResourceType: "audit_export", ResourceID: exportID, Body: map[string]any{"format": format}, Summary: "Operator requested an audit export."})
	if err := tx.Commit(ctx); err != nil {
		return Envelope{}, "", "", err
	}
	return k.withRequest(k.env(), m.RequestID, ""), exportID, "REQUESTED", nil
}

func (k *Kernel) GetAuditExport(ctx context.Context, m Meta, exportID string) (Envelope, string, string, string, error) {
	if err := k.requireScope(m, "audit:export"); err != nil {
		return Envelope{}, "", "", "", err
	}
	var status, path, digest string
	err := k.Pool().QueryRow(ctx, `SELECT status, COALESCE(artifact_path,''), COALESCE(artifact_digest,'') FROM audit_exports WHERE export_id=$1`, exportID).Scan(&status, &path, &digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, "", "", "", apperr.New(apperr.NotFound, "export not found")
	}
	return k.withRequest(k.env(), m.RequestID, ""), exportID, status, path, err
}

func (k *Kernel) Attention(ctx context.Context, m Meta) (Envelope, map[string]any, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, nil, err
	}
	var unknown, denied int
	_ = k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM audit_events WHERE attention_code IS NOT NULL AND attention_code <> ''`).Scan(&unknown)
	_ = k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM orders WHERE status='PENDING_PAYMENT'`).Scan(&denied)
	headline := "No unresolved merchant attention."
	if unknown+denied > 0 {
		headline = "Unresolved merchant attention items exist."
	}
	return k.withRequest(k.env(), m.RequestID, ""), map[string]any{
		"completeness": "COMPLETE", "unresolved_money": denied, "evidence_rejected": 0, "authorization_security": 0,
		"commerce_replan": 0, "recovery_delayed": 0, "headline": headline, "needs_attention_count": unknown + denied,
	}, nil
}

func (k *Kernel) SearchResources(ctx context.Context, m Meta, q string) (Envelope, []map[string]string, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return Envelope{}, nil, err
	}
	q = strings.TrimSpace(q)
	var hits []map[string]string
	add := func(t, id string) { hits = append(hits, map[string]string{"resource_type": t, "resource_id": id}) }
	var id string
	if err := k.Pool().QueryRow(ctx, `SELECT session_id FROM shopping_sessions WHERE session_id=$1`, q).Scan(&id); err == nil {
		add("session", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT cart_id FROM carts WHERE cart_id=$1`, q).Scan(&id); err == nil {
		add("cart", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT order_id FROM orders WHERE order_id=$1`, q).Scan(&id); err == nil {
		add("order", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT offer_id FROM offers WHERE offer_id=$1`, q).Scan(&id); err == nil {
		add("offer", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT sku_id FROM skus WHERE sku_id=$1`, q).Scan(&id); err == nil {
		add("sku", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT product_id FROM products WHERE product_id=$1`, q).Scan(&id); err == nil {
		add("product", id)
	}
	if err := k.Pool().QueryRow(ctx, `SELECT audit_event_id FROM audit_events WHERE audit_event_id=$1`, q).Scan(&id); err == nil {
		add("audit_event", id)
	}
	return k.withRequest(k.env(), m.RequestID, ""), hits, nil
}

func (k *Kernel) CreateRefund(ctx context.Context, m Meta, orderID string, amount int64, currency, reason string) (Envelope, string, string, error) {
	if err := k.requireScope(m, "refund:manage"); err != nil {
		return Envelope{}, "", "", err
	}
	res, err := refund.Current().RequestRefund(ctx, refund.Request{OrderID: orderID, AmountMinor: amount, Currency: currency, Reason: reason, OperatorID: m.OperatorID, RequestID: m.RequestID})
	if err != nil {
		return Envelope{}, "", "", err
	}
	return k.withRequest(k.env(), m.RequestID, ""), res.Code, res.Message, nil
}

func (k *Kernel) AdjustInventory(ctx context.Context, m Meta, locationID, skuID string, delta int32, reason string) error {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `UPDATE inventory SET on_hand_quantity = on_hand_quantity + $3, updated_at=now() WHERE location_id=$1 AND sku_id=$2 AND on_hand_quantity + $3 >= reserved_quantity`, locationID, skuID, delta)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.New(apperr.InvalidArgument, "inventory adjustment rejected")
	}
	_, _ = audit.Append(ctx, tx, audit.Event{Kind: "BOUNDARY_COMMAND_EVALUATED", RequestID: m.RequestID, PrincipalType: "OPERATOR", PrincipalID: m.OperatorID, Channel: "admin", Action: "inventory_adjust", ResourceType: "inventory", ResourceID: skuID, Body: map[string]any{"delta": delta, "reason": reason, "location_id": locationID}, Summary: "Operator adjusted inventory."})
	return tx.Commit(ctx)
}

func (k *Kernel) AuthenticateHostBearer(ctx context.Context, bearer string) (string, error) {
	if bearer == "" {
		return "", apperr.New(apperr.HostUnauthenticated, "missing host bearer")
	}
	rows, err := k.Pool().Query(ctx, `SELECT host_id, credential_salt, credential_hash, status FROM approved_hosts`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var id, status string
		var salt, hash []byte
		if err := rows.Scan(&id, &salt, &hash, &status); err != nil {
			return "", err
		}
		if status == "ACTIVE" && store.VerifySecret(bearer, salt, hash) {
			return id, nil
		}
	}
	return "", apperr.New(apperr.HostUnauthenticated, "invalid host bearer")
}

func (k *Kernel) AuthenticateOperator(ctx context.Context, bearer string) (string, []string, error) {
	if bearer == "" {
		return "", nil, apperr.New(apperr.Unauthenticated, "missing operator credential")
	}
	rows, err := k.Pool().Query(ctx, `SELECT operator_id, credential_salt, credential_hash, scopes, status FROM operator_credentials`)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, status string
		var salt, hash []byte
		var scopes []string
		if err := rows.Scan(&id, &salt, &hash, &scopes, &status); err != nil {
			return "", nil, err
		}
		if status == "ACTIVE" && store.VerifySecret(bearer, salt, hash) {
			return id, scopes, nil
		}
	}
	return "", nil, apperr.New(apperr.Unauthenticated, "invalid operator credential")
}

func (k *Kernel) AuthenticateFixtureControl(ctx context.Context, bearer string) error {
	rows, err := k.Pool().Query(ctx, `SELECT credential_salt, credential_hash, status FROM fixture_control_credentials`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var salt, hash []byte
		if err := rows.Scan(&salt, &hash, &status); err != nil {
			return err
		}
		if status == "ACTIVE" && store.VerifySecret(bearer, salt, hash) {
			return nil
		}
	}
	return apperr.New(apperr.Unauthenticated, "invalid fixture-control credential")
}

func (k *Kernel) ListStrategyConfigs(ctx context.Context) ([]StrategyRow, error) {
	rows, err := k.Pool().Query(ctx, `SELECT strategy_type, enabled, revision, COALESCE(surfaces, '{}') FROM commercial_strategies ORDER BY strategy_type`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StrategyRow
	for rows.Next() {
		var r StrategyRow
		if err := rows.Scan(&r.Type, &r.Enabled, &r.Revision, &r.Surfaces); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type StrategyRow struct {
	Type     string
	Enabled  bool
	Revision string
	Surfaces []string
}

func (k *Kernel) UpdateStrategyConfigs(ctx context.Context, m Meta, rows []StrategyRow) ([]StrategyRow, error) {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return nil, err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, r := range rows {
		surfs := r.Surfaces
		if surfs == nil {
			surfs = []string{}
		}
		tag, err := tx.Exec(ctx, `UPDATE commercial_strategies SET enabled=$2, revision=$3, surfaces=$4 WHERE strategy_type=$1`, r.Type, r.Enabled, r.Revision, surfs)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 0 {
			return nil, apperr.New(apperr.InvalidArgument, "unknown strategy "+r.Type)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k.ListStrategyConfigs(ctx)
}

func (k *Kernel) PreviewRuleEconomics(ctx context.Context, m Meta) (cart.Totals, []OfferView, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		return cart.Totals{}, nil, err
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return cart.Totals{}, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locID string
	if err := tx.QueryRow(ctx, `SELECT location_id FROM locations WHERE is_reference_location=TRUE`).Scan(&locID); err != nil {
		return cart.Totals{}, nil, err
	}
	fees, err := k.locationFees(ctx, tx, locID)
	if err != nil {
		return cart.Totals{}, nil, err
	}
	promos, bundles, err := k.pricingRules(ctx, tx)
	if err != nil {
		return cart.Totals{}, nil, err
	}
	tot := cart.PriceCart(nil, fees, promos, bundles, locID, k.Now())
	orows, err := tx.Query(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor FROM offers WHERE status IN ('SHOWN','ACCEPTED') ORDER BY created_at DESC LIMIT 10`)
	if err != nil {
		return tot, nil, err
	}
	defer orows.Close()
	var offers []OfferView
	for orows.Next() {
		var o OfferView
		if err := orows.Scan(&o.OfferID, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &o.ExpiresAt, &o.Status, &o.GroundedReason, &o.Terms, &o.PatchJSON, &o.BuyerImpactMinor); err != nil {
			return tot, nil, err
		}
		offers = append(offers, o)
	}
	return tot, offers, nil
}

func (k *Kernel) UpdatePromotionEnabled(ctx context.Context, m Meta, promotionID string, enabled bool) error {
	if err := k.requireScope(m, "merchant:manage"); err != nil {
		return err
	}
	tag, err := k.Pool().Exec(ctx, `UPDATE promotions SET enabled=$2 WHERE promotion_id=$1`, promotionID, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.New(apperr.NotFound, "promotion not found")
	}
	return nil
}

func nullJSON(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	if !json.Valid([]byte(s)) {
		b, _ := json.Marshal(map[string]string{"raw": s})
		return string(b)
	}
	return s
}
