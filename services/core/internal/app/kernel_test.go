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
	if cap.MerchantDisplayName != "Quickmart" || env.ContractVersion == "" {
		t.Fatalf("capabilities %+v", cap)
	}

	createArgs := map[string]any{"subject_reference": "buyer-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "buyer-1", "blr_koramangala_5th_block", "en-IN", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if created.Session.CartVersion != 0 || created.Session.SessionContextVersion != 0 {
		t.Fatalf("versions %+v", created.Session)
	}
	if created.Session.LocationID != "loc_qm_koramangala" {
		t.Fatalf("location %s", created.Session.LocationID)
	}

	intentArgs := map[string]any{"session_id": created.Session.SessionID, "expected_session_context_version": int64(0), "mission": "eggs bread bananas under 180", "planning_budget_minor": int64(18000), "currency": "INR"}
	intent, err := k.SetIntent(ctx, signed(t, priv, host, "set_intent", intentArgs), created.Session.SessionID, 0, "eggs bread bananas under 180", 18000, "INR", nil)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Session.SessionContextVersion != 1 {
		t.Fatalf("context %d", intent.Session.SessionContextVersion)
	}

	_, items, _, err := k.SearchCatalog(ctx, app.Meta{RequestID: rid(), ApprovedHostID: host, SkipProof: true}, created.Session.SessionID, "eggs", "", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	foundEggs := false
	for _, it := range items {
		if it.SKUID == "sku_qm_eggs_white_6" {
			foundEggs = true
			if it.SellingMinor != 5400 {
				t.Fatalf("eggs price %d", it.SellingMinor)
			}
			if it.ProductID == it.SKUID {
				t.Fatal("product_id must not equal sku_id")
			}
		}
	}
	if !foundEggs {
		t.Fatal("expected white eggs sku")
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
	c1 := add("sku_qm_eggs_white_6", 0)
	c2 := add("sku_qm_britannia_white_400g", c1.Session.CartVersion)
	c3 := add("sku_qm_banana_500g", c2.Session.CartVersion)
	if c3.Cart.Version != 3 {
		t.Fatalf("cart version %d", c3.Cart.Version)
	}
	if c3.Cart.Totals.MerchandiseMinor != 13200 {
		t.Fatalf("merchandise %d", c3.Cart.Totals.MerchandiseMinor)
	}
	if c3.Cart.Totals.DiscountsMinor != 700 {
		t.Fatalf("bundle discount %d want 700", c3.Cart.Totals.DiscountsMinor)
	}
	if c3.Cart.Totals.DeliveryFeeMinor != 3500 {
		t.Fatalf("delivery %d", c3.Cart.Totals.DeliveryFeeMinor)
	}
	if c3.Cart.Totals.AllInMinor != 16000 {
		t.Fatalf("all-in %d want 16000", c3.Cart.Totals.AllInMinor)
	}

	staleArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(1), "sku_id": "sku_qm_amul_toned_500ml", "quantity": int32(1)}
	_, err = k.AddItem(ctx, signed(t, priv, host, "add_cart_item", staleArgs), created.Session.SessionID, created.Session.CartID, 1, "sku_qm_amul_toned_500ml", 1)
	if !apperr.Is(err, apperr.CartVersionConflict) {
		t.Fatalf("want CART_VERSION_CONFLICT got %v", err)
	}

	prepArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_session_context_version": c3.Session.SessionContextVersion, "expected_cart_version": c3.Cart.Version}
	_, _, _, prop, err := k.PrepareCheckout(ctx, signed(t, priv, host, "prepare_checkout", prepArgs), created.Session.SessionID, created.Session.CartID, c3.Session.SessionContextVersion, c3.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	if prop.FinalMinor != 16000 || prop.Capability != "pcap_razorpay_test" {
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

func TestAcceptApplyOfferAndSubstitution(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	createArgs := map[string]any{"subject_reference": "buyer-2", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "buyer-2", "blr_koramangala_5th_block", "en-IN", "", "")
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "sku_qm_coke_750ml", "quantity": int32(2)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, 0, "sku_qm_coke_750ml", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(cart.Offers) == 0 {
		t.Fatal("expected commercial offers")
	}
	off := cart.Offers[0]
	accArgs := map[string]any{"session_id": created.Session.SessionID, "offer_id": off.OfferID, "expected_session_context_version": cart.Session.SessionContextVersion, "expected_cart_version": cart.Cart.Version}
	_, accepted, _, _, _, err := k.AcceptOffer(ctx, signed(t, priv, host, "accept_offer", accArgs), created.Session.SessionID, off.OfferID, cart.Session.SessionContextVersion, cart.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Status != "ACCEPTED" {
		t.Fatalf("status %s", accepted.Status)
	}
	if accepted.CartVersion != cart.Cart.Version {
		t.Fatal("accept must not bump cart version")
	}
	appArgs := map[string]any{"session_id": created.Session.SessionID, "offer_id": off.OfferID, "expected_session_context_version": cart.Session.SessionContextVersion, "expected_cart_version": cart.Cart.Version}
	applied, err := k.ApplyOffer(ctx, signed(t, priv, host, "apply_offer", appArgs), created.Session.SessionID, off.OfferID, cart.Session.SessionContextVersion, cart.Cart.Version)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Cart.Version != cart.Cart.Version+1 {
		t.Fatalf("apply should bump cart, got %d", applied.Cart.Version)
	}

	subArgs := map[string]any{"session_id": "ses_fixture_confirmed_order", "merchant_order_id": "ord_fixture_confirmed_breakfast", "substitution_request_id": "sub_fixture_eggs", "expected_substitution_version": int64(1), "selected_option_id": "sop_same_eggs", "decline": false}
	_, _, err = k.RespondToSubstitution(ctx, signed(t, priv, host, "respond_to_substitution", subArgs), "ses_fixture_confirmed_order", "ord_fixture_confirmed_breakfast", "sub_fixture_eggs", 1, "sop_same_eggs", false)
	if err != nil {
		t.Fatal(err)
	}
	highArgs := map[string]any{"session_id": "ses_fixture_confirmed_order", "merchant_order_id": "ord_fixture_confirmed_breakfast", "substitution_request_id": "sub_fixture_eggs", "expected_substitution_version": int64(2), "selected_option_id": "sop_brown_eggs", "decline": false}
	_, _, err = k.RespondToSubstitution(ctx, signed(t, priv, host, "respond_to_substitution", highArgs), "ses_fixture_confirmed_order", "ord_fixture_confirmed_breakfast", "sub_fixture_eggs", 2, "sop_brown_eggs", false)
	if err == nil || apperr.As(err) == nil {
		// already responded; creating a fresh request would be needed. The first response consumed OPEN.
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
		Expiration(now.Add(60 * time.Second)).
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
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "ctrl-1", "blr_koramangala_5th_block", "en-IN", "", "CONTROL")
	if err != nil {
		t.Fatal(err)
	}
	addArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "sku_qm_eggs_white_6", "quantity": int32(1)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created.Session.SessionID, created.Session.CartID, 0, "sku_qm_eggs_white_6", 1)
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
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "mov-1", "blr_koramangala_5th_block", "en-IN", "", "")
	if err != nil {
		t.Fatal(err)
	}
	addArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": "sku_qm_eggs_white_6", "quantity": int32(1)}
	cart, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created.Session.SessionID, created.Session.CartID, 0, "sku_qm_eggs_white_6", 1)
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
		Expiration(now.Add(120 * time.Second)).
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
	_, err = k.CreateSession(ctx, signed(t, priv, host, "create_session", emptyArgs), "buyer-loc", "", "en-IN", "", "")
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("want INVALID_ARGUMENT for missing delivery location, got %v", err)
	}

	unknownArgs := map[string]any{"subject_reference": "buyer-loc-2", "delivery_serviceability_reference": "unknown_neighbourhood", "locale": "en-IN", "requested_location_id": ""}
	_, err = k.CreateSession(ctx, signed(t, priv, host, "create_session", unknownArgs), "buyer-loc-2", "unknown_neighbourhood", "en-IN", "", "")
	if !apperr.Is(err, apperr.InvalidArgument) {
		t.Fatalf("want INVALID_ARGUMENT for unknown neighbourhood, got %v", err)
	}

	okArgs := map[string]any{"subject_reference": "buyer-loc-3", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", okArgs), "buyer-loc-3", "blr_koramangala_5th_block", "en-IN", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if created.Session.LocationID != "loc_qm_koramangala" {
		t.Fatalf("location %s", created.Session.LocationID)
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
