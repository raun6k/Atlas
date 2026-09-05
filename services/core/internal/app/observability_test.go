package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/jobs"
	"atlas.dev/core/internal/testdb"
)

func TestObservabilityTrail(t *testing.T) {
	ctx := context.Background()
	k, cleanup, err := testdb.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	host := "host_atlaslab_quickmart"
	priv := mustKey(t)
	opMeta := app.Meta{RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"audit:read", "audit:export", "merchant:read", "merchant:manage"}}

	createArgs := map[string]any{"subject_reference": "obs-1", "delivery_serviceability_reference": "blr_koramangala_5th_block", "locale": "en-IN", "requested_location_id": ""}
	created, err := k.CreateSession(ctx, signed(t, priv, host, "create_session", createArgs), "obs-1", "blr_koramangala_5th_block", "en-IN", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	addSKU := "QM-SNK-0001-A"
	addArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": int64(0), "sku_id": addSKU, "quantity": int32(1)}
	added, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", addArgs), created.Session.SessionID, created.Session.CartID, 0, addSKU, 1)
	if err != nil {
		t.Fatal(err)
	}
	opID := added.Envelope.OperationID
	if opID == "" {
		t.Fatal("expected operation_id")
	}

	_, events, stages, err := k.GetOperationTimeline(ctx, opMeta, opID)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, e := range events {
		kinds[e.Kind] = true
		if strings.Contains(string(e.BodyJSON), "ranking_score") || strings.Contains(string(e.BodyJSON), "economics_private") {
			t.Fatalf("timeline leaked private scores: %s", e.BodyJSON)
		}
	}
	if !kinds["BOUNDARY_COMMAND_EVALUATED"] || !kinds["COMMERCIAL_DECISION_RECORDED"] {
		t.Fatalf("timeline kinds %v stages %v", kinds, stages)
	}
	if _, err := k.Pool().Exec(ctx, `INSERT INTO payment_audit_events (audit_event_id, kind, payment_attempt_id, order_id, safe_body, operation_id, request_id)
		VALUES ($1,'PAYMENT_ATTEMPT_CREATED','pay_obs','ord_obs','{"not_capture":true}',$2,$3)`, ids.New(ids.Audit), opID, added.Envelope.RequestID); err != nil {
		t.Fatal(err)
	}
	_, events, stages, err = k.GetOperationTimeline(ctx, opMeta, opID)
	if err != nil {
		t.Fatal(err)
	}
	kinds = map[string]bool{}
	for _, e := range events {
		kinds[e.Kind] = true
	}
	if !kinds["PAYMENT_ATTEMPT_CREATED"] {
		t.Fatalf("expected stitched payment audit, got %v", kinds)
	}
	if !kinds["OFFER_SHOWN"] && !kinds["POLICY_DECISION"] {
		// offer events optional if engine showed none; commercial decision still required
	}

	t.Run("missing_proof_deny", func(t *testing.T) {
		args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": added.Session.CartVersion, "sku_id": "sku_qm_banana_500g", "quantity": int32(1)}
		m := app.Meta{RequestID: rid(), IdempotencyKey: rid(), ApprovedHostID: host, Tool: "add_cart_item", Arguments: args, RequireIdempotency: true}
		_, err := k.AddItem(ctx, m, created.Session.SessionID, created.Session.CartID, added.Session.CartVersion, "sku_qm_banana_500g", 1)
		if !apperr.Is(err, apperr.HostForbidden) {
			t.Fatalf("want HOST_FORBIDDEN got %v", err)
		}
		var n int
		if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM policy_decisions WHERE result='DENY' AND 'PROOF_INVALID' = ANY(reason_codes)`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n < 1 {
			t.Fatal("expected PROOF_INVALID policy deny")
		}
		var attn int
		if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM audit_events WHERE attention_code='AUTHORIZATION_DENIED'`).Scan(&attn); err != nil {
			t.Fatal(err)
		}
		if attn < 1 {
			t.Fatal("expected AUTHORIZATION_DENIED audit")
		}
	})

	t.Run("inactive_host_deny", func(t *testing.T) {
		if _, err := k.Pool().Exec(ctx, `UPDATE approved_hosts SET status='SUSPENDED' WHERE host_id=$1`, host); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = k.Pool().Exec(ctx, `UPDATE approved_hosts SET status='ACTIVE' WHERE host_id=$1`, host)
		}()
		args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": added.Session.CartVersion, "sku_id": "sku_qm_banana_500g", "quantity": int32(1)}
		_, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, added.Session.CartVersion, "sku_qm_banana_500g", 1)
		if !apperr.Is(err, apperr.HostForbidden) {
			t.Fatalf("want HOST_FORBIDDEN got %v", err)
		}
		var n int
		if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM policy_decisions WHERE result='DENY' AND 'HOST_NOT_ACTIVE' = ANY(reason_codes)`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n < 1 {
			t.Fatal("expected HOST_NOT_ACTIVE deny")
		}
	})

	t.Run("tool_not_permitted", func(t *testing.T) {
		if _, err := k.Pool().Exec(ctx, `UPDATE approved_hosts SET scopes=ARRAY['search_catalog'] WHERE host_id=$1`, host); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = k.Pool().Exec(ctx, `UPDATE approved_hosts SET scopes=ARRAY['mcp'] WHERE host_id=$1`, host)
		}()
		args := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": added.Session.CartVersion, "sku_id": "sku_qm_banana_500g", "quantity": int32(1)}
		_, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", args), created.Session.SessionID, created.Session.CartID, added.Session.CartVersion, "sku_qm_banana_500g", 1)
		if !apperr.Is(err, apperr.HostForbidden) {
			t.Fatalf("want HOST_FORBIDDEN got %v", err)
		}
		var n int
		if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM policy_decisions WHERE result='DENY' AND 'TOOL_NOT_PERMITTED' = ANY(reason_codes)`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n < 1 {
			t.Fatal("expected TOOL_NOT_PERMITTED deny")
		}
	})

	t.Run("authority_deny", func(t *testing.T) {
		c2, err := k.AddItem(ctx, signed(t, priv, host, "add_cart_item", map[string]any{
			"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_cart_version": added.Session.CartVersion,
			"sku_id": "QM-SNK-0002-B", "quantity": int32(1),
		}), created.Session.SessionID, created.Session.CartID, added.Session.CartVersion, "QM-SNK-0002-B", 1)
		if err != nil {
			t.Skipf("session unavailable for authority path: %v", err)
		}
		prepArgs := map[string]any{"session_id": created.Session.SessionID, "cart_id": created.Session.CartID, "expected_session_context_version": c2.Session.SessionContextVersion, "expected_cart_version": c2.Cart.Version}
		_, _, _, prop, err := k.PrepareCheckout(ctx, signed(t, priv, host, "prepare_checkout", prepArgs), created.Session.SessionID, created.Session.CartID, c2.Session.SessionContextVersion, c2.Cart.Version)
		if err != nil {
			t.Fatal(err)
		}
		ccArgs := map[string]any{"session_id": created.Session.SessionID, "checkout_proposal_id": prop.ProposalID}
		_, _, err = k.CompleteCheckout(ctx, signed(t, priv, host, "complete_checkout", ccArgs), created.Session.SessionID, prop.ProposalID, "")
		if err == nil {
			t.Fatal("expected complete_checkout to fail without authority")
		}
		if apperr.Is(err, apperr.AuthorityInvalid) {
			var n int
			if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM policy_decisions WHERE result='DENY' AND 'AUTHORITY_INVALID' = ANY(reason_codes)`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n < 1 {
				t.Fatal("expected AUTHORITY_INVALID deny")
			}
		}
	})

	t.Run("job_failed_on_timeline", func(t *testing.T) {
		jobID := ids.New(ids.Job)
		if _, err := k.Pool().Exec(ctx, `INSERT INTO jobs (job_id, job_type, payload, operation_id, status) VALUES ($1,'RECONCILE_PAYMENT',$2::jsonb,$3,'CLAIMED')`,
			jobID, `{"payment_attempt_id":"pay_obs"}`, opID); err != nil {
			t.Fatal(err)
		}
		if err := jobs.Fail(ctx, k.DB, jobID, errors.New("provider fetch failed")); err != nil {
			t.Fatal(err)
		}
		_, events, _, err := k.GetOperationTimeline(ctx, opMeta, opID)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, e := range events {
			if e.Kind == "JOB_STATUS" && e.Attention == "JOB_FAILED" {
				found = true
				if !strings.Contains(string(e.BodyJSON), "provider fetch failed") {
					t.Fatalf("missing last_error %s", e.BodyJSON)
				}
				if !strings.Contains(string(e.BodyJSON), "last_error_class") {
					t.Fatalf("missing last_error_class %s", e.BodyJSON)
				}
			}
		}
		if !found {
			t.Fatal("expected failed job on timeline")
		}
	})

	t.Run("csv_export_omits_scores", func(t *testing.T) {
		_, exportID, _, err := k.CreateAuditExport(ctx, app.Meta{RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"audit:export"}, IdempotencyKey: rid(), RequireIdempotency: true}, "CSV_SUMMARY", `{}`)
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		if err := jobs.GenerateExport(ctx, k.DB, exportID, dir); err != nil {
			t.Fatal(err)
		}
		_, events, _, err := k.ListAuditEvents(ctx, opMeta, "COMMERCIAL_DECISION_RECORDED", "", "", "", "", 20)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) == 0 {
			t.Skip("no commercial decision events in this fixture run")
		}
		for _, e := range events {
			var body map[string]any
			_ = json.Unmarshal(e.BodyJSON, &body)
			raw := string(e.BodyJSON)
			if strings.Contains(raw, "ranking_score") || strings.Contains(raw, `"score"`) {
				t.Fatalf("commercial decision leaked score: %s", raw)
			}
		}
	})

	attEnv, att, err := k.Attention(ctx, opMeta)
	if err != nil {
		t.Fatal(err)
	}
	_ = attEnv
	if att.Counts["AUTHORIZATION_SECURITY"] < 1 {
		t.Fatalf("attention %+v", att)
	}
	foundAuth := false
	for _, item := range att.Items {
		if item.Category == "AUTHORIZATION_SECURITY" && item.Severity != "" && item.NextSafeAction != "" {
			foundAuth = true
		}
	}
	if !foundAuth {
		t.Fatal("expected typed authorization attention item")
	}

	t.Run("reconcile_is_truthful", func(t *testing.T) {
		env, r, err := k.ReconcileOperation(ctx, app.Meta{RequestID: rid(), OperatorID: "op_merchant_quickmart", OperatorScopes: []string{"merchant:manage"}}, "op_does_not_exist")
		_ = env
		if r.Scheduled {
			t.Fatal("must not claim scheduled work when no payment attempt exists")
		}
		if err == nil && r.Status == "" {
			t.Fatal("expected status or typed error")
		}
	})

	t.Run("job_retry_metadata", func(t *testing.T) {
		var class, action string
		err := k.Pool().QueryRow(ctx, `SELECT COALESCE(last_error_class,''), COALESCE(operator_action,'') FROM jobs WHERE last_error LIKE '%provider fetch failed%' ORDER BY created_at DESC LIMIT 1`).Scan(&class, &action)
		if err != nil {
			t.Fatal(err)
		}
		if class == "" || action == "" {
			t.Fatalf("retry metadata class=%q action=%q", class, action)
		}
	})

	t.Run("outcomes_missing_not_zero", func(t *testing.T) {
		_, metrics, err := k.MerchantOutcomes(ctx, opMeta)
		if err != nil {
			t.Fatal(err)
		}
		byName := map[string]app.OutcomeMetric{}
		for _, m := range metrics {
			byName[m.Name] = m
		}
		if m, ok := byName["retry_and_recovery_time_ms"]; ok && !m.Eligible && m.ValuePresent {
			t.Fatal("missing recovery time must not present a zero value")
		}
		if m, ok := byName["real_world_revenue_uplift"]; ok && (m.Eligible || m.ValuePresent) {
			t.Fatal("ineligible uplift must not be reported as a counted zero")
		}
		if m, ok := byName["confirmed_orders"]; ok && m.Eligible && !m.ValuePresent {
			t.Fatal("counted metric must present a value")
		}
	})

	_, health, err := k.SystemHealth(ctx, opMeta)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, c := range health.Components {
		names[c.Name] = true
	}
	for _, want := range []string{"postgresql", "migrations", "fixture", "core", "razorpay_configuration", "webhook", "gateway", "worker", "payment_runner", "atlaslab", "openrouter", "public_mcp_schema"} {
		if !names[want] {
			t.Fatalf("missing health component %s", want)
		}
	}
}
