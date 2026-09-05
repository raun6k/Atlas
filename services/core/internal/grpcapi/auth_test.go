package grpcapi

import (
	"context"
	"testing"

	v1 "atlas.dev/core/internal/gen/atlas/merchant/v1"
)

func TestMethodClass(t *testing.T) {
	cases := map[string]string{
		"/atlas.merchant.v1.MerchantQueryService/GetCapabilities": "public",
		"/atlas.merchant.v1.SessionService/CreateSession":         "host",
		"/atlas.merchant.v1.AdminService/ListInventory":           "operator",
		"/atlas.merchant.v1.AuditService/ListAuditEvents":         "operator",
		"/atlas.merchant.v1.FixtureService/ResetFixtures":         "fixture",
		"/atlas.merchant.v1.PaymentFabricService/ClaimRunnerJob":  "payment",
		"/atlas.merchant.v1.WorkerService/ClaimJob":               "worker",
	}
	for method, want := range cases {
		if got := methodClass(method); got != want {
			t.Fatalf("%s class %s want %s", method, got, want)
		}
	}
}

func TestMetaIgnoresClientOperatorIdentity(t *testing.T) {
	ctx := withIdentity(context.Background(), identity{
		Kind: "operator", OperatorID: "op_real", OperatorScopes: []string{"merchant:read"},
	})
	got := meta(ctx, &v1.RequestMeta{
		RequestId: "req_1", ApprovedHostId: "spoof_host", OperatorId: "spoof_op", OperatorScopes: []string{"*"},
	})
	if got.OperatorID != "op_real" {
		t.Fatalf("operator id %s", got.OperatorID)
	}
	if len(got.OperatorScopes) != 1 || got.OperatorScopes[0] != "merchant:read" {
		t.Fatalf("scopes %+v", got.OperatorScopes)
	}
	if got.ApprovedHostID != "" {
		t.Fatalf("host must come from interceptor, got %s", got.ApprovedHostID)
	}
}

func TestMetaUsesAuthenticatedHost(t *testing.T) {
	ctx := withIdentity(context.Background(), identity{Kind: "host", HostID: "host_atlaslab_quickmart"})
	got := meta(ctx, &v1.RequestMeta{ApprovedHostId: "attacker_host", OperatorId: "spoof"})
	if got.ApprovedHostID != "host_atlaslab_quickmart" {
		t.Fatalf("host %s", got.ApprovedHostID)
	}
	if got.OperatorID != "" {
		t.Fatalf("host class must not mint operator id")
	}
}
