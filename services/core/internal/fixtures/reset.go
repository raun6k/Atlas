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
			payment_audit_events, payment_hold_flags, provider_reconciliations, provider_events,
			test_runner_jobs, refund_reservations, refunds, payment_attempts,
			inventory, prices, product_relationships, bundles, promotions, commercial_strategies,
			search_events, buyer_routine_items, buyer_routines, buyer_order_lines, buyer_orders,
			campaigns, buyers, service_areas, skus, products, locations, merchant_profile, host_keys, approved_hosts,
			operator_credentials, fixture_control_credentials, fixture_state
		RESTART IDENTITY CASCADE`); err != nil {
		return ResetResult{}, err
	}

	if err := loadMerchantPack(ctx, tx, fixtureDir); err != nil {
		return ResetResult{}, err
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
	if _, err := tx.Exec(ctx, `INSERT INTO operator_credentials (operator_id, display_name, credential_salt, credential_hash, scopes, status) VALUES ('op_merchant_quickmart','Merchant operator',$1,$2,ARRAY['merchant:read','merchant:manage','audit:read','audit:export'],'ACTIVE')`, as, ah); err != nil {
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
	var n int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM skus s JOIN locations l ON true WHERE s.sku_id='sku_qm_eggs_white_6' AND l.location_id='loc_qm_koramangala'`).Scan(&n); err != nil || n == 0 {
		return nil
	}
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
	return nil
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
		Files []struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
		} `json:"files"`
	}
	if err := json.Unmarshal(manifest, &m); err != nil || len(m.Files) == 0 {
		sum := sha256.Sum256(manifest)
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	h := sha256.New()
	for _, f := range m.Files {
		b, err := os.ReadFile(filepath.Join(dir, f.Path))
		if err != nil {
			continue
		}
		sum := sha256.Sum256(b)
		h.Write([]byte(f.Path))
		h.Write(sum[:])
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
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
