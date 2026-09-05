package app_test

import (
	"context"
	"testing"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/testdb"
)

func TestAdminReadsRequireOperator(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	empty := app.Meta{RequestID: rid()}
	if _, _, err := k.ListInventory(ctx, empty, ""); !apperr.Is(err, apperr.Unauthenticated) && !apperr.Is(err, apperr.Forbidden) {
		t.Fatalf("empty operator ListInventory got %v", err)
	}
	if _, _, err := k.ListPromotions(ctx, empty); !apperr.Is(err, apperr.Unauthenticated) && !apperr.Is(err, apperr.Forbidden) {
		t.Fatalf("empty operator ListPromotions got %v", err)
	}
	readOnly := app.Meta{RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:read"}}
	if _, err := k.UpdatePromotionEnabled(ctx, readOnly, "does-not-matter", false, 1); !apperr.Is(err, apperr.Forbidden) {
		t.Fatalf("merchant:read must not manage promotions: %v", err)
	}
}

func TestEmptyHostScopesDenyTools(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	if _, err := k.Pool().Exec(ctx, `UPDATE approved_hosts SET scopes='{}'::text[] WHERE host_id=$1`, host); err != nil {
		t.Fatal(err)
	}
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "scope-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	if _, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "scope-1", "blr_koramangala_5th_block", "en-IN", "", "", nil); err == nil || !apperr.Is(err, apperr.HostForbidden) {
		t.Fatalf("empty host scopes must deny create_session: %v", err)
	}
	if _, err := k.Pool().Exec(ctx, `UPDATE approved_hosts SET scopes=ARRAY['mcp:discover'] WHERE host_id=$1`, host); err != nil {
		t.Fatal(err)
	}
	if _, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "scope-1", "blr_koramangala_5th_block", "en-IN", "", "", nil); err == nil || !apperr.Is(err, apperr.HostForbidden) {
		t.Fatalf("discover-only host must deny create_session: %v", err)
	}
}

func TestPromotionOCCAndReconcile(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	op := app.Meta{RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:read", "merchant:manage"}}
	_, promos, err := k.ListPromotions(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	if len(promos) == 0 {
		t.Fatal("expected seeded promotions")
	}
	p := promos[0]
	if p.CurrentUsageMinor < 0 {
		t.Fatalf("usage %d", p.CurrentUsageMinor)
	}
	if _, err := k.UpdatePromotionEnabled(ctx, op, p.ID, p.Enabled, p.Revision+99); !apperr.Is(err, apperr.VersionConflict) {
		t.Fatalf("want VERSION_CONFLICT got %v", err)
	}
	updated, err := k.UpdatePromotionEnabled(ctx, op, p.ID, p.Enabled, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != p.Revision+1 {
		t.Fatalf("revision %d want %d", updated.Revision, p.Revision+1)
	}
	_, rec, err := k.ReconcileOperation(ctx, op, "op_not_a_payment")
	if err == nil || !apperr.Is(err, apperr.NotReconcilable) {
		t.Fatalf("want NOT_RECONCILABLE got rec=%+v err=%v", rec, err)
	}
}

func TestPaymentCapabilityID(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	_, cap, err := k.GetCapabilities(ctx, app.Meta{RequestID: rid()})
	if err != nil {
		t.Fatal(err)
	}
	if cap.PaymentCapabilityID != "pcap_razorpay_test" {
		t.Fatalf("capability id %s", cap.PaymentCapabilityID)
	}
}

func TestPassportConsumedOnCheckout(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "pass-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "pass-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	add := func(sku string, ver int64) int64 {
		t.Helper()
		args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": ver, "sku_id": sku, "quantity": int32(1)}
		out, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, ver, sku, 1)
		if err != nil {
			t.Fatal(err)
		}
		return out.Session.CartVersion
	}
	ver := add("QM-SNK-0001-A", 0)
	ver = add("QM-SNK-0002-B", ver)
	_ = add("QM-SNK-0003-B", ver)
	intentArgs := map[string]any{"session_id": created.Session.SessionID, "expected_session_context_version": int64(0), "mission": "snacks", "planning_budget_minor": int64(18000), "currency": "INR"}
	intent, err := k.SetIntent(ctx, signed(t, priv, host, "set_intent", intentArgs), created.Session.SessionID, 0, "snacks", 18000, "INR", nil)
	if err != nil {
		t.Fatal(err)
	}
	prepArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": intent.Cart.CartID, "expected_session_context_version": intent.Session.SessionContextVersion, "expected_cart_version": intent.Cart.Version}
	_, _, _, prop, err := k.PrepareCheckout(ctx, signed(t, priv, host, "prepare_checkout", prepArgs), created.Session.SessionID, intent.Cart.CartID, intent.Session.SessionContextVersion, intent.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	auth := mustAuthority(t, priv, host, prop)
	ccArgs := map[string]any{"session_id": created.Session.SessionID, "checkout_proposal_id": prop.ProposalID}
	if _, _, err := k.CompleteCheckout(ctx, signed(t, priv, host, "complete_checkout", ccArgs), created.Session.SessionID, prop.ProposalID, auth); err != nil {
		t.Fatal(err)
	}
	var status string
	var consumed bool
	if err := k.Pool().QueryRow(ctx, `SELECT status, consumed_at IS NOT NULL FROM execution_passports WHERE checkout_proposal_id=$1`, prop.ProposalID).Scan(&status, &consumed); err != nil {
		t.Fatal(err)
	}
	if status != "consumed" || !consumed {
		t.Fatalf("passport status=%s consumed=%v", status, consumed)
	}
}
