package fixtures

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

const SnapshotID = "fix_quickmart_v1"

type ResetResult struct {
	SnapshotID string
	Digest     string
}

func LoadDir(ctx context.Context, db *store.DB, fixtureDir, hostPEMPath string) (ResetResult, error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return ResetResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		TRUNCATE TABLE
			substitution_responses, substitution_requests, order_lines, orders,
			execution_passports, policy_decisions, reservations, checkout_proposals,
			offer_events, offers, opportunity_candidates, cart_lines, carts, shopping_sessions,
			replay_nonces, idempotency_records, audit_events, audit_exports, jobs, outbox_events,
			inventory, prices, product_relationships, bundles, promotions, commercial_strategies,
			skus, products, locations, merchant_profile, host_keys, approved_hosts,
			operator_credentials, fixture_control_credentials, fixture_state
		RESTART IDENTITY CASCADE`); err != nil {
		return ResetResult{}, err
	}

	type merchant struct {
		MerchantProfileKey     string `json:"merchant_profile_key"`
		DisplayName            string `json:"display_name"`
		LegalName              string `json:"legal_name"`
		Description            string `json:"description"`
		Currency               string `json:"currency"`
		Locale                 string `json:"locale"`
		Country                string `json:"country"`
		City                   string `json:"city"`
		TimezoneDisplay        string `json:"timezone_display"`
		TermsURL               string `json:"terms_url"`
		PrivacyURL             string `json:"privacy_url"`
		SupportEmail           string `json:"support_email"`
		CapabilitySummary      string `json:"capability_summary"`
		AffiliationDisclaimer  string `json:"affiliation_disclaimer"`
	}
	var m merchant
	if err := readJSON(filepath.Join(fixtureDir, "merchant.json"), &m); err != nil {
		return ResetResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO merchant_profile (singleton_key, display_name, legal_name, description, currency, locale, country, city, timezone_display, terms_url, privacy_url, support_email, capability_summary, affiliation_disclaimer)
		VALUES ('singleton',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		m.DisplayName, m.LegalName, m.Description, m.Currency, m.Locale, m.Country, m.City, m.TimezoneDisplay, m.TermsURL, m.PrivacyURL, m.SupportEmail, m.CapabilitySummary, m.AffiliationDisclaimer); err != nil {
		return ResetResult{}, err
	}

	var locations []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "locations.json"), &locations); err != nil {
		return ResetResult{}, err
	}
	for _, loc := range locations {
		eta := loc["eta_minutes"].(map[string]any)
		hours, _ := json.Marshal(loc["fulfillment_hours"])
		if _, err := tx.Exec(ctx, `INSERT INTO locations (location_id, name, neighbourhood, city, region, country, serviceability_reference, address_public, active, is_reference_location, fulfillment_hours, delivery_fee_minor, minimum_order_value_minor, free_delivery_threshold_minor, eta_min_minutes, eta_max_minutes, handling_fee_minor)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
			loc["location_id"], loc["name"], loc["neighbourhood"], loc["city"], loc["region"], loc["country"], loc["serviceability_reference"], loc["address_public"],
			loc["active"], loc["is_reference_location"], hours, asInt(loc["delivery_fee_minor"]), asInt(loc["minimum_order_value_minor"]), asInt(loc["free_delivery_threshold_minor"]),
			asInt(eta["min"]), asInt(eta["max"]), asInt(loc["handling_fee_minor"])); err != nil {
			return ResetResult{}, err
		}
	}

	var products []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "products.json"), &products); err != nil {
		return ResetResult{}, err
	}
	for _, p := range products {
		diet, _ := json.Marshal(p["dietary"])
		imgs, _ := json.Marshal(p["image_refs"])
		if _, err := tx.Exec(ctx, `INSERT INTO products (product_id, name, brand, category, subcategory, canonical_description, dietary, lifecycle, image_refs, search_document)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_tsvector('simple', $2||' '||$3||' '||$6))`,
			p["product_id"], p["name"], p["brand"], p["category"], p["subcategory"], p["canonical_description"], diet, p["lifecycle"], imgs); err != nil {
			return ResetResult{}, err
		}
	}

	var skus []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "skus.json"), &skus); err != nil {
		return ResetResult{}, err
	}
	for _, s := range skus {
		diet, _ := json.Marshal(s["dietary"])
		attrs, _ := json.Marshal(s["attributes"])
		imgs, _ := json.Marshal(s["image_refs"])
		if _, err := tx.Exec(ctx, `INSERT INTO skus (sku_id, product_id, name, brand, variant, pack_size, unit_of_measure, barcode, canonical_description, dietary, attributes, lifecycle, image_refs, search_document)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, to_tsvector('simple', $3||' '||$4||' '||$9))`,
			s["sku_id"], s["product_id"], s["name"], s["brand"], s["variant"], asInt(s["pack_size"]), s["unit_of_measure"], s["barcode"], s["canonical_description"], diet, attrs, s["lifecycle"], imgs); err != nil {
			return ResetResult{}, err
		}
	}

	var prices []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "prices.json"), &prices); err != nil {
		return ResetResult{}, err
	}
	for _, p := range prices {
		econ, _ := p["economics_private"].(map[string]any)
		if _, err := tx.Exec(ctx, `INSERT INTO prices (location_id, sku_id, currency, list_price_minor, selling_price_minor, tax_inclusive, tax_rate_bps, tax_amount_minor, cogs_minor, variable_cost_minor, supplier_funding_minor, contribution_margin_minor)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			p["location_id"], p["sku_id"], p["currency"], asInt(p["list_price_minor"]), asInt(p["selling_price_minor"]), p["tax_inclusive"], asInt(p["tax_rate_bps"]), asInt(p["tax_amount_minor"]),
			asInt(econ["cogs_minor"]), asInt(econ["variable_cost_minor"]), asInt(econ["supplier_funding_minor"]), asInt(econ["contribution_margin_minor"])); err != nil {
			return ResetResult{}, err
		}
	}

	var inv []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "inventory.json"), &inv); err != nil {
		return ResetResult{}, err
	}
	for _, i := range inv {
		if _, err := tx.Exec(ctx, `INSERT INTO inventory (location_id, sku_id, assorted, on_hand_quantity, reserved_quantity, safety_buffer, stock_status, stock_confidence, expiry_risk)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			i["location_id"], i["sku_id"], i["assorted"], asInt(i["on_hand_quantity"]), asInt(i["reserved_quantity"]), asInt(i["safety_buffer"]), i["stock_status"], i["stock_confidence"], i["expiry_risk"]); err != nil {
			return ResetResult{}, err
		}
	}

	var rel []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "relationships.json"), &rel); err != nil {
		return ResetResult{}, err
	}
	for _, r := range rel {
		if _, err := tx.Exec(ctx, `INSERT INTO product_relationships (source_id, target_id, relationship_type, confidence, provenance) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
			r["source"], r["target"], r["type"], r["confidence"], r["provenance"]); err != nil {
			return ResetResult{}, err
		}
	}

	var promos []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "promotions.json"), &promos); err != nil {
		return ResetResult{}, err
	}
	for _, p := range promos {
		skusB, _ := json.Marshal(p["eligible_sku_ids"])
		locsB, _ := json.Marshal(p["location_ids"])
		if _, err := tx.Exec(ctx, `INSERT INTO promotions (promotion_id, type, name, eligible_sku_ids, minimum_quantity, discount_amount_minor, stacking, location_ids, supplier_funding_minor, starts_at, ends_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			p["promotion_id"], p["type"], p["name"], skusB, asInt(p["minimum_quantity"]), asInt(p["discount_amount_minor"]), p["stacking"], locsB, asInt(p["supplier_funding_minor"]), p["starts_at"], p["ends_at"]); err != nil {
			return ResetResult{}, err
		}
	}

	var bundles []map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "bundles.json"), &bundles); err != nil {
		return ResetResult{}, err
	}
	for _, b := range bundles {
		qty, _ := json.Marshal(b["sku_quantities"])
		locs, _ := json.Marshal(b["location_ids"])
		if _, err := tx.Exec(ctx, `INSERT INTO bundles (bundle_id, name, sku_quantities, standalone_total_minor, bundle_total_minor, discount_amount_minor, location_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			b["bundle_id"], b["name"], qty, asInt(b["standalone_total_minor"]), asInt(b["bundle_total_minor"]), asInt(b["discount_amount_minor"]), locs); err != nil {
			return ResetResult{}, err
		}
	}

	var strategies map[string]map[string]any
	if err := readJSON(filepath.Join(fixtureDir, "strategies.json"), &strategies); err != nil {
		return ResetResult{}, err
	}
	for t, s := range strategies {
		if _, err := tx.Exec(ctx, `INSERT INTO commercial_strategies (strategy_type, enabled, revision) VALUES ($1,$2,$3)`, t, s["enabled"], s["revision"]); err != nil {
			return ResetResult{}, err
		}
	}

	if err := seedTrust(ctx, tx, hostPEMPath); err != nil {
		return ResetResult{}, err
	}
	if err := seedConfirmedOrder(ctx, tx); err != nil {
		return ResetResult{}, err
	}

	digest := contentDigest(fixtureDir)
	if _, err := tx.Exec(ctx, `INSERT INTO fixture_state (singleton_key, fixture_snapshot_id, content_digest) VALUES ('current',$1,$2)`, SnapshotID, digest); err != nil {
		return ResetResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetResult{}, err
	}
	return ResetResult{SnapshotID: SnapshotID, Digest: digest}, nil
}

func seedTrust(ctx context.Context, tx pgx.Tx, hostPEMPath string) error {
	hostBearer := getenv("ATLAS_TEST_HOST_BEARER", "atlaslab-test-bearer")
	adminBearer := getenv("ATLAS_TEST_ADMIN_BEARER", "operator-test-bearer")
	fixBearer := getenv("ATLAS_TEST_FIXTURE_BEARER", "fixture-test-control")
	hs, hh, err := store.HashSecret(hostBearer)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO approved_hosts (host_id, display_name, status, credential_salt, credential_hash, scopes, environment) VALUES ('host_atlaslab_quickmart','AtlasLab Quickmart','ACTIVE',$1,$2,ARRAY['mcp'],'test')`, hs, hh); err != nil {
		return err
	}
	if hostPEMPath != "" {
		if pem, err := os.ReadFile(hostPEMPath); err == nil {
			key, err := jwk.ParseKey(pem, jwk.WithPEM(true))
			if err == nil {
				_ = key.Set(jwk.KeyIDKey, "host_atlaslab_test_key")
				_ = key.Set(jwk.AlgorithmKey, "ES256")
				pub, _ := key.PublicKey()
				raw, _ := json.Marshal(pub)
				if _, err := tx.Exec(ctx, `INSERT INTO host_keys (host_id, key_id, algorithm, public_jwk, status) VALUES ('host_atlaslab_quickmart','host_atlaslab_test_key','ES256',$1,'ACTIVE')`, raw); err != nil {
					return err
				}
			}
		}
	}
	as, ah, err := store.HashSecret(adminBearer)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO operator_credentials (operator_id, display_name, credential_salt, credential_hash, scopes, status) VALUES ('op_merchant_quickmart','Merchant operator',$1,$2,ARRAY['merchant:read','merchant:manage','audit:read','audit:export','refund:manage'],'ACTIVE')`, as, ah); err != nil {
		return err
	}
	fs, fh, err := store.HashSecret(fixBearer)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fixture_control_credentials (credential_id, credential_salt, credential_hash, status) VALUES ('fixctl_atlaslab',$1,$2,'ACTIVE')`, fs, fh)
	return err
}

func seedConfirmedOrder(ctx context.Context, tx pgx.Tx) error {
	sessionID := "ses_fixture_confirmed_order"
	cartID := "cart_fixture_confirmed_order"
	orderID := "ord_fixture_confirmed_breakfast"
	exp := time.Now().UTC().Add(24 * time.Hour)
	if _, err := tx.Exec(ctx, `INSERT INTO shopping_sessions (session_id, approved_host_id, subject_reference, location_id, serviceability_reference, locale, session_context_version, status, expires_at)
		VALUES ($1,'host_atlaslab_quickmart','subject_fixture','loc_qm_koramangala','blr_koramangala_5th_block','en-IN',1,'ORDER_CONFIRMED',$2)`, sessionID, exp); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO carts (cart_id, session_id, cart_version, currency, merchandise_minor, delivery_fee_minor, all_in_total_minor) VALUES ($1,$2,3,'INR',13200,3500,16700)`, cartID, sessionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO orders (order_id, session_id, location_id, status, currency, total_amount_minor, quote_hash, captured_payment_id, payment_public_status, confirmed_at)
		VALUES ($1,$2,'loc_qm_koramangala','CONFIRMED','INR',16700,'fixture_quote','pay_fixture_captured','CAPTURED_RECONCILED', now())`, orderID, sessionID); err != nil {
		return err
	}
	lines := []struct {
		sku, prd string
		qty      int
		unit     int64
	}{
		{"sku_qm_eggs_white_6", "prd_qm_eggs_white", 1, 5400},
		{"sku_qm_britannia_white_400g", "prd_qm_britannia_white_bread", 1, 4200},
		{"sku_qm_banana_500g", "prd_qm_banana", 1, 3600},
	}
	for _, l := range lines {
		if _, err := tx.Exec(ctx, `INSERT INTO order_lines (order_line_id, order_id, sku_id, product_id, quantity, unit_amount_minor, line_total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			ids.New(ids.OrderLine), orderID, l.sku, l.prd, l.qty, l.unit, l.unit); err != nil {
			return err
		}
	}
	opts, _ := json.Marshal([]map[string]any{
		{"option_id": "sop_brown_eggs", "sku_id": "sku_qm_eggs_brown_6", "quantity": 1, "unit_price_minor": 6400, "price_impact": "HIGHER"},
		{"option_id": "sop_same_eggs", "sku_id": "sku_qm_eggs_white_6", "quantity": 1, "unit_price_minor": 5400, "price_impact": "SAME"},
	})
	_, err := tx.Exec(ctx, `INSERT INTO substitution_requests (substitution_request_id, order_id, original_sku_id, original_quantity, options, substitution_version, status, deadline_at)
		VALUES ('sub_fixture_eggs',$1,'sku_qm_eggs_white_6',1,$2,1,'OPEN', now() + interval '15 minutes')`, orderID, opts)
	return err
}

func Current(ctx context.Context, db *store.DB) (ResetResult, error) {
	var id, dig string
	err := db.Pool.QueryRow(ctx, `SELECT fixture_snapshot_id, content_digest FROM fixture_state WHERE singleton_key='current'`).Scan(&id, &dig)
	return ResetResult{SnapshotID: id, Digest: dig}, err
}

func contentDigest(dir string) string {
	manifest, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		sum := sha256.Sum256([]byte(dir))
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	var m struct {
		ContentDigest string `json:"content_digest"`
	}
	if err := json.Unmarshal(manifest, &m); err == nil && m.ContentDigest != "" {
		return m.ContentDigest
	}
	sum := sha256.Sum256(manifest)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func asInt(v any) int64 {
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

func getenv(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}
