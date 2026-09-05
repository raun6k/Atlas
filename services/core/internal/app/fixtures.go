package app

import (
	"context"
	"os"
	"path/filepath"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/fixtures"
)

func (k *Kernel) ResetFixtures(ctx context.Context) (fixtures.ResetResult, error) {
	return fixtures.LoadDir(ctx, k.DB, k.FixtureDir, k.hostPEM())
}

func (k *Kernel) CurrentFixture(ctx context.Context) (fixtures.ResetResult, error) {
	return fixtures.Current(ctx, k.DB)
}

// InvalidateInventory is a test-only fixture hook: remaining sellable quantity
// becomes zero and ACTIVE checkout proposals covering the SKU are INVALIDATED so
// complete_checkout must return REQUOTE_REQUIRED. Lab still signs from its
// cached ACTIVE proposal.
func (k *Kernel) InvalidateInventory(ctx context.Context, locationID, skuID string) error {
	if locationID == "" || skuID == "" {
		return apperr.New(apperr.InvalidArgument, "location_id and sku_id required")
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE inventory
		SET on_hand_quantity = reserved_quantity + safety_buffer, updated_at=now()
		WHERE location_id=$1 AND sku_id=$2`, locationID, skuID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.New(apperr.NotFound, "inventory row not found")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE checkout_proposals
		SET status='INVALIDATED'
		WHERE status='ACTIVE' AND location_id=$1 AND snapshot::text LIKE '%' || $2 || '%'`, locationID, skuID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (k *Kernel) InvalidateInventoryEval(ctx context.Context, locationID, skuID, evaluationID, reason string) error {
	if k.Cfg.Environment != "test" {
		return apperr.New(apperr.Forbidden, "fixture control requires test environment")
	}
	var before string
	_ = k.Pool().QueryRow(ctx, `SELECT md5(concat_ws(':', on_hand_quantity, reserved_quantity, safety_buffer)) FROM inventory WHERE location_id=$1 AND sku_id=$2`, locationID, skuID).Scan(&before)
	if err := k.InvalidateInventory(ctx, locationID, skuID); err != nil {
		return err
	}
	var after string
	_ = k.Pool().QueryRow(ctx, `SELECT md5(concat_ws(':', on_hand_quantity, reserved_quantity, safety_buffer)) FROM inventory WHERE location_id=$1 AND sku_id=$2`, locationID, skuID).Scan(&after)
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = audit.Append(ctx, tx, audit.Event{
		Kind: "BOUNDARY_COMMAND_EVALUATED", PrincipalType: "FIXTURE_CONTROL", PrincipalID: "fixture-control",
		Channel: "test", Action: "invalidate_inventory", ResourceType: "inventory", ResourceID: skuID,
		Body: map[string]any{"location_id": locationID, "evaluation_id": evaluationID, "reason": reason, "before_digest": before, "after_digest": after},
		Summary: "Fixture control invalidated inventory for evaluation.",
	})
	return tx.Commit(ctx)
}

func (k *Kernel) hostPEM() string {
	if v := os.Getenv("ATLAS_HOST_TEST_PUBKEY"); v != "" {
		return v
	}
	return findUp("testdata/hostkeys/host_test_public.pem")
}

func findUp(rel string) string {
	wd, err := os.Getwd()
	if err != nil {
		return rel
	}
	dir := wd
	for i := 0; i < 8; i++ {
		p := filepath.Join(dir, rel)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return rel
}
