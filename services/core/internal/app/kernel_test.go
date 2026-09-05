package app_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/testdb"
	"atlas.dev/core/internal/trust"

	"github.com/google/uuid"
	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

func TestKernelCatalogCartOffersCheckout(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	host := "host_atlaslab_quickmart"
	priv := mustKey(t)

	env, cap, err := k.GetCapabilities(ctx, app.Meta{RequestID: rid()})
	if err != nil {
		t.Fatal(err)
	}
	if cap.MerchantDisplayName != "QuickMart" || env.ContractVersion == "" {
		t.Fatalf("capabilities %+v", cap)
	}

	createArgs := map[string]any{"subject_reference": "buyer-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "buyer-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Session.CartVersion != 0 || created.Session.SessionContextVersion != 0 {
		t.Fatalf("versions %+v", created.Session)
	}
	if created.Session.LocationID != "loc_qm_koramangala" {
		t.Fatalf("location %s", created.Session.LocationID)
	}
	if created.Offers != nil {
		t.Fatalf("create_session must omit offers, got %d", len(created.Offers))
	}

	intentArgs := map[string]any{"session_id": created.Session.SessionID, "expected_session_context_version": int64(0), "mission": "eggs bread bananas under 180", "planning_budget_minor": int64(18000), "currency": "INR"}
	intent, err := k.SetIntent(ctx, signed(t, priv, host, "set_intent", intentArgs), created.Session.SessionID, 0, "eggs bread bananas under 180", 18000, "INR", nil)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Session.SessionContextVersion != 1 {
		t.Fatalf("context %d", intent.Session.SessionContextVersion)
	}

	_, items, _, _, err := k.SearchCatalog(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, "biscuits", "", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	foundSKU := false
	for _, it := range items {
		if it.SKUID == "QM-SNK-0001-A" {
			foundSKU = true
			if it.SellingMinor != 4400 {
				t.Fatalf("biscuit price %d", it.SellingMinor)
			}
			if it.ProductID == it.SKUID {
				t.Fatal("product_id must not equal sku_id")
			}
		}
	}
	if !foundSKU {
		t.Fatal("expected tea biscuits sku")
	}

	add := func(sku string, ver int64) app.CartMutation {
		t.Helper()
		args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": ver, "sku_id": sku, "quantity": int32(1)}
		out, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, ver, sku, 1)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	c1 := add("QM-SNK-0001-A", 0)
	c2 := add("QM-SNK-0002-B", c1.Session.CartVersion)
	c3 := add("QM-SNK-0003-B", c2.Session.CartVersion)
	if c3.Cart.Version != 3 {
		t.Fatalf("cart version %d", c3.Cart.Version)
	}
	if c3.Cart.Totals.MerchandiseMinor <= 0 || c3.Cart.Totals.AllInMinor <= 0 {
		t.Fatalf("totals %+v", c3.Cart.Totals)
	}

	staleArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(1), "sku_id": "QM-SNK-0007-A", "quantity": int32(1)}
	_, err = k.AddItem(ctx, signed(t, priv, host, "add_cart_item", staleArgs), created.Session.SessionID, created.Session.CartID, 1, "QM-SNK-0007-A", 1)
	if !apperr.Is(err, apperr.CartVersionConflict) {
		t.Fatalf("want CART_VERSION_CONFLICT got %v", err)
	}

	prepArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_session_context_version": c3.Session.SessionContextVersion, "expected_cart_version": c3.Cart.Version}
	_, _, _, prop, err := k.PrepareCheckout(ctx, signed(t, priv, host, "prepare_checkout", prepArgs), created.Session.SessionID, created.Session.CartID, c3.Session.SessionContextVersion, c3.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	if prop.FinalMinor != c3.Cart.Totals.AllInMinor || prop.Capability != "pcap_razorpay_test" {
		t.Fatalf("proposal %+v", prop)
	}

	auth := mustAuthority(t, priv, host, prop)
	ccArgs := map[string]any{"session_id": created.Session.SessionID, "checkout_proposal_id": prop.ProposalID}
	m := signed(t, priv, host, "complete_checkout", ccArgs)
	_, ord, err := k.CompleteCheckout(ctx, m, created.Session.SessionID, prop.ProposalID, auth)
	if err != nil {
		t.Fatal(err)
	}
	if ord.Status != "PENDING_PAYMENT" || ord.PaymentPublicStatus != "PAYMENT_PROCESSING" {
		t.Fatalf("order %+v", ord)
	}

	_, got, err := k.GetOrder(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, ord.OrderID)
	if err != nil {
		t.Fatal(err)
	}
	if got.OrderID == "" {
		t.Fatal("missing order")
	}

	if err := platform.RejectLiveMode("rzp_live_x"); err == nil {
		t.Fatal("live mode")
	}
}

func TestApplyOffer(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "buyer-2", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "buyer-2", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "QM-SNK-0006-A", "quantity": int32(2)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, 0, "QM-SNK-0006-A", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(cart.Offers) == 0 {
		t.Fatal("expected commercial offers")
	}
	off := cart.Offers[0]
	appArgs := map[string]any{"session_id": created.Session.SessionID, "offer_id": off.OfferID, "expected_session_context_version": cart.Session.SessionContextVersion, "expected_cart_version": cart.Cart.Version}
	applied, err := k.ApplyOffer(ctx, signed(t, priv, host, "apply_offer", appArgs), created.Session.SessionID, off.OfferID, cart.Session.SessionContextVersion, cart.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Cart.Version != cart.Cart.Version+1 {
		t.Fatalf("apply should bump cart, got %d", applied.Cart.Version)
	}
}

func signed(t *testing.T, key jwk.Key, host, tool string, args map[string]any) app.Meta {
	t.Helper()
	requestID := rid()
	idem := rid()
	proof := mustProof(t, key, host, tool, requestID, idem, args)
	return app.Meta{RequestID: requestID, IdempotencyKey: idem, HostRequestProof: proof, ApprovedHostID: host, Tool: tool, Arguments: args, RequireIdempotency: true}
}

func mustProof(t *testing.T, key jwk.Key, host, tool, requestID, idem string, args map[string]any) string {
	t.Helper()
	dig, err := trust.ArgDigest(args)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	tok, err := jwt.NewBuilder().
		JwtID(rid()).
		Issuer(host).
		Audience([]string{"atlas.merchant.v1"}).
		IssuedAt(now).
		Expiration(now.Add(60*time.Second)).
		Claim("tool", tool).
		Claim("request_id", requestID).
		Claim("idempotency_key", idem).
		Claim("arg_digest", dig).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	_ = key.Set(jwk.KeyIDKey, "host_atlaslab_test_key")
	_ = key.Set(jwk.AlgorithmKey, jwa.ES256)
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.ES256, key))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func TestControlArmSuppressesOffers(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "ctrl-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": "", "evaluation_arm": "CONTROL"}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "ctrl-1", "blr_koramangala_5th_block", "en-IN", "", "CONTROL", nil)
	if err != nil {
		t.Fatal(err)
	}
	addArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "QM-SNK-0001-A", "quantity": int32(1)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created.Session.SessionID, created.Session.CartID, 0, "QM-SNK-0001-A", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(cart.Offers) != 0 {
		t.Fatalf("control arm must return no proactive offers, got %d", len(cart.Offers))
	}
	if cart.Cart.Totals.AllInMinor <= 0 {
		t.Fatal("control checkout pricing must still produce totals")
	}
}

func TestMinimumOrderDenied(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "mov-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "mov-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	addArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "QM-SNK-0001-A", "quantity": int32(1)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created.Session.SessionID, created.Session.CartID, 0, "QM-SNK-0001-A", 1)
	if err != nil {
		t.Fatal(err)
	}
	prepArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_session_context_version": cart.Session.SessionContextVersion, "expected_cart_version": cart.Cart.Version}
	_, _, _, _, err = k.PrepareCheckout(ctx, signed(t, priv, host, "prepare_checkout", prepArgs), created.Session.SessionID, created.Session.CartID, cart.Session.SessionContextVersion, cart.Cart.Version)
	if !apperr.Is(err, apperr.MerchantPolicyDenied) {
		t.Fatalf("want MERCHANT_POLICY_DENIED for below-MOV cart, got %v", err)
	}
}

func mustAuthority(t *testing.T, key jwk.Key, host string, prop app.ProposalView) string {
	t.Helper()
	now := time.Now().UTC()
	tok, err := jwt.NewBuilder().
		JwtID(rid()).
		Issuer(host).
		Audience([]string{"atlas.merchant.v1"}).
		IssuedAt(now).
		Expiration(now.Add(120*time.Second)).
		Claim("checkout_proposal_id", prop.ProposalID).
		Claim("quote_hash", prop.QuoteHash).
		Claim("amount_minor", prop.FinalMinor).
		Claim("currency", "INR").
		Claim("payment_capability_id", "pcap_razorpay_test").
		Claim("session_id", prop.SessionID).
		Claim("session_context_version", prop.SessionContextVersion).
		Claim("cart_id", prop.CartID).
		Claim("cart_version", prop.CartVersion).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	_ = key.Set(jwk.KeyIDKey, "host_atlaslab_test_key")
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.ES256, key))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func TestCreateSessionRequiresDeliveryLocation(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)

	emptyArgs := map[string]any{"subject_reference": "buyer-loc", "delivery_serviceability_reference": "", "locale": "en-IN", "requested_location_id": ""}
	_, err = k.CreateSession(ctx, signed(t, priv, host, "create_session", emptyArgs), "buyer-loc", "", "en-IN", "", "", nil)
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("want INVALID_ARGUMENT for missing delivery location, got %v", err)
	}

	unknownArgs := map[string]any{"subject_reference": "buyer-loc-2", "delivery_serviceability_reference": "unknown_neighbourhood", "locale": "en-IN", "requested_location_id": ""}
	_, err = k.CreateSession(ctx, signed(t, priv, host, "create_session", unknownArgs), "buyer-loc-2", "unknown_neighbourhood", "en-IN", "", "", nil)
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("want INVALID_ARGUMENT for unknown neighbourhood, got %v", err)
	}

	okArgs := map[string]any{"subject_reference": "buyer-loc-3", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", okArgs), "buyer-loc-3", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Session.LocationID != "loc_qm_koramangala" {
		t.Fatalf("location %s", created.Session.LocationID)
	}
}

func TestStrategySurfacesUpdate(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	rows, err := k.ListStrategyConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("expected strategy rows")
	}
	var rev, vis string
	found := false
	for _, r := range rows {
		if r.Type != "FREE_DELIVERY" {
			continue
		}
		found = true
		if len(r.Surfaces) == 0 {
			t.Fatal("FREE_DELIVERY should have surfaces")
		}
		rev = r.Revision
		vis = r.Visibility
	}
	if !found {
		t.Fatal("FREE_DELIVERY missing")
	}
	updated, err := k.UpdateStrategyConfigs(ctx, app.Meta{
		RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:manage"},
	}, []app.StrategyRow{{
		Type: "FREE_DELIVERY", Enabled: true, ExpectedRevision: rev, Surfaces: []string{"get_cart"}, Visibility: vis,
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range updated {
		if r.Type != "FREE_DELIVERY" {
			continue
		}
		if len(r.Surfaces) != 1 || r.Surfaces[0] != "get_cart" {
			t.Fatalf("surfaces %+v", r.Surfaces)
		}
		if r.Revision == rev {
			t.Fatal("revision must change")
		}
	}
}

func TestEmptySurfacesSkipOffers(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	rows, err := k.ListStrategyConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	clear := []app.StrategyRow{}
	for _, r := range rows {
		clear = append(clear, app.StrategyRow{Type: r.Type, Enabled: r.Enabled, ExpectedRevision: r.Revision, Surfaces: []string{}, Visibility: r.Visibility})
	}
	if _, err := k.UpdateStrategyConfigs(ctx, app.Meta{
		RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:manage"},
	}, clear); err != nil {
		t.Fatal(err)
	}
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "surf-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "surf-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Offers != nil {
		t.Fatalf("create_session must omit offers, got %d", len(created.Offers))
	}
	_, _, _, searchOffers, err := k.SearchCatalog(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, "Biscuits", "", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if searchOffers != nil {
		t.Fatalf("search_catalog must omit offers when none assigned, got %d", len(searchOffers))
	}
	got, err := k.GetCart(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Offers != nil {
		t.Fatalf("get_cart must omit offers when none assigned, got %d", len(got.Offers))
	}
}

func TestSearchCatalogAssignedSurfaces(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "search-off", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "search-off", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Offers != nil {
		t.Fatalf("create_session must omit offers, got %d", len(created.Offers))
	}
	_, _, _, _, err = k.SearchCatalog(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, "Biscuits", "", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
}

func mustKey(t *testing.T) jwk.Key {
	t.Helper()
	root := testdbRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "testdata/hostkeys/host_test_private.pem"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := jwk.ParseKey(b, jwk.WithPEM(true))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func testdbRoot(t *testing.T) string {
	wd, _ := os.Getwd()
	dir := wd
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "testdata/hostkeys/host_test_private.pem")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("repo root not found")
	return ""
}

func rid() string {
	id, _ := uuid.NewV7()
	sum := sha256.Sum256([]byte(id.String()))
	return hex.EncodeToString(sum[:8]) + id.String()
}

func TestTreatmentPolicyStampedAndUnknownRejected(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "pol-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": "", "evaluation_arm": "TREATMENT", "strategy_allowlist": []string{"FBT"}}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "pol-1", "blr_koramangala_5th_block", "en-IN", "", "TREATMENT", []string{"FBT"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Session.Treatment == nil || created.Session.Treatment.PolicyDigest == "" {
		t.Fatal("treatment policy must be stamped")
	}
	if created.Session.Treatment.EconomicObjectiveVersion != "incremental_confirmed_revenue_v1" {
		t.Fatalf("objective %s", created.Session.Treatment.EconomicObjectiveVersion)
	}
	if len(created.Session.StrategyAllowlist) != 1 || created.Session.StrategyAllowlist[0] != "FBT" {
		t.Fatalf("allowlist %+v", created.Session.StrategyAllowlist)
	}
	bad := map[string]any{"subject_reference": "pol-2", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": "", "evaluation_arm": "TREATMENT", "strategy_allowlist": []string{"REORDER"}}
	if _, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", bad), "pol-2", "blr_koramangala_5th_block", "en-IN", "", "TREATMENT", []string{"REORDER"}); err == nil {
		t.Fatal("exploratory allowlist must be rejected")
	}
	invented := map[string]any{"subject_reference": "pol-3", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created2, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", invented), "pol-3", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	addArgs := map[string]any{"session_id": created2.Session.SessionID, "cart_id": created2.Session.CartID, "expected_cart_version": int64(0), "sku_id": "QM-SNK-0001-A", "quantity": int32(1), "discount_amount_minor": int64(9999)}
	if _, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created2.Session.SessionID, created2.Session.CartID, 0, "QM-SNK-0001-A", 1); err == nil {
		t.Fatal("invented discount must be rejected")
	}
	if _, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", map[string]any{"session_id": created2.Session.SessionID, "cart_id": created2.Session.CartID, "expected_cart_version": int64(0), "sku_id": "QM-FAKE-9999-A", "quantity": int32(1)}), created2.Session.SessionID, created2.Session.CartID, 0, "QM-FAKE-9999-A", 1); err == nil {
		t.Fatal("invented SKU must be rejected")
	}
}

func TestUnknownStrategyUpdateRejected(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if _, err := k.UpdateStrategyConfigs(ctx, app.Meta{
		RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:manage"},
	}, []app.StrategyRow{{Type: "MADE_UP", Enabled: true, ExpectedRevision: "x"}}); err == nil {
		t.Fatal("unknown strategy must be rejected")
	}
}
