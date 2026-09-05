package fixtures

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

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
	if err := ValidateDir(fixtureDir); err != nil {
		return ResetResult{}, err
	}
	digest, err := DigestDir(fixtureDir)
	if err != nil {
		return ResetResult{}, err
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return ResetResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		TRUNCATE TABLE
			substitution_responses, substitution_requests, order_lines, orders,
			execution_passports, policy_decisions, reservations, checkout_proposals,
			offer_events, offers, opportunity_candidates, commercial_attributions,
			campaign_budget_ledger, buyer_promo_redemptions, session_treatment_policies, commercial_strategy_snapshots,
			cart_lines, carts, shopping_sessions,
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

func Current(ctx context.Context, db *store.DB) (ResetResult, error) {
	var id, dig string
	err := db.Pool.QueryRow(ctx, `SELECT fixture_snapshot_id, content_digest FROM fixture_state WHERE singleton_key='current'`).Scan(&id, &dig)
	if err != nil {
		return ResetResult{}, err
	}
	if strings.TrimSpace(id) == "" || strings.TrimSpace(dig) == "" {
		return ResetResult{}, fmt.Errorf("fixture_state is empty")
	}
	return ResetResult{SnapshotID: id, Digest: dig}, nil
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
