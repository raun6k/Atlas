package app

import (
	"context"
	"fmt"

	"atlas.dev/core/internal/audit"
)

type AttentionItem struct {
	Category       string
	Severity       string
	State          string
	Owner          string
	ResourceIDs    map[string]string
	Explanation    string
	NextSafeAction string
	RetryAllowed   bool
}

type AttentionReport struct {
	Completeness string
	Headline     string
	Counts       map[string]int
	Items        []AttentionItem
}

func (k *Kernel) Attention(ctx context.Context, m Meta) (Envelope, AttentionReport, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, AttentionReport{}, err
	}
	rep := AttentionReport{Completeness: "PARTIAL", Counts: map[string]int{}}
	add := func(cat string, items []AttentionItem) {
		rep.Counts[cat] = len(items)
		rep.Items = append(rep.Items, items...)
	}

	add("UNRESOLVED_MONEY", k.attentionRows(ctx, `
		SELECT payment_attempt_id, COALESCE(operation_id,''), COALESCE(merchant_order_id,'')
		FROM payment_attempts WHERE state='OUTCOME_UNKNOWN' LIMIT 50`,
		"UNRESOLVED_MONEY", "HIGH", "OPEN", "PAYMENT_FABRIC",
		"Payment outcome is unknown; captured money may be unbound from a merchant order.",
		"Run admin reconcile after provider fetch is possible.", true))

	add("CAPTURED_UNBOUND", k.attentionRows(ctx, `
		SELECT payment_attempt_id, COALESCE(operation_id,''), COALESCE(merchant_order_id,'')
		FROM payment_attempts WHERE state='CAPTURED_RECONCILED' AND NOT (has_callback_binding OR has_webhook_binding) LIMIT 50`,
		"CAPTURED_UNBOUND", "HIGH", "OPEN", "PAYMENT_FABRIC",
		"Payment is captured but missing authenticated event binding.",
		"Do not release fulfillment; wait for a signed webhook or bound callback.", false))

	add("EVIDENCE_REJECTED", k.attentionRows(ctx, `
		SELECT COALESCE(payment_attempt_id,''), COALESCE(operation_id,''), COALESCE(order_id,'')
		FROM payment_audit_events WHERE kind='PROVIDER_EVIDENCE_EVALUATED' AND (safe_body->>'decision') IN ('REJECT','FAIL') LIMIT 50`,
		"EVIDENCE_REJECTED", "HIGH", "OPEN", "PAYMENT_FABRIC",
		"Authenticated provider evidence was rejected.",
		"Inspect mismatch_reason; do not treat runner screens as capture.", false))

	add("AUTHORIZATION_SECURITY", k.attentionRows(ctx, `
		SELECT COALESCE(host_id,''), COALESCE(operation_id,''), COALESCE(session_id,'')
		FROM policy_decisions WHERE result='DENY' ORDER BY created_at DESC LIMIT 50`,
		"AUTHORIZATION_SECURITY", "HIGH", "OPEN", "ADMIN",
		"A boundary command was denied.",
		"Review host proof, scopes, and authority before retrying.", false))

	add("FAILED_JOB", k.attentionRows(ctx, `
		SELECT job_id, COALESCE(operation_id,''), COALESCE(last_error_class,'')
		FROM jobs WHERE status IN ('FAILED','NOT_RETRYABLE') LIMIT 50`,
		"FAILED_JOB", "MEDIUM", "OPEN", "WORKER",
		"A background job failed.",
		"Retry only when retryable is true; otherwise inspect dead-letter reason.", true))

	add("DELAYED_RECOVERY", k.attentionRows(ctx, `
		SELECT job_id, COALESCE(operation_id,''), COALESCE(last_error_class,'')
		FROM jobs WHERE status IN ('FAILED','PENDING','QUEUED') AND retryable AND available_at > now() LIMIT 50`,
		"DELAYED_RECOVERY", "MEDIUM", "WAITING", "WORKER",
		"Recovery is scheduled but not yet claimed.",
		"Wait for next_retry_at or reconcile from admin if the delay is stale.", true))

	add("INVENTORY_HOLD_LEAK", k.attentionRows(ctx, `
		SELECT r.checkout_proposal_id, COALESCE(p.session_id,''), r.sku_id
		FROM reservations r
		JOIN checkout_proposals p ON p.checkout_proposal_id=r.checkout_proposal_id
		WHERE r.status='ACTIVE' AND p.status IN ('EXPIRED','CONSUMED') LIMIT 50`,
		"INVENTORY_HOLD_LEAK", "HIGH", "OPEN", "CORE",
		"An inventory reservation is still active after the proposal ended.",
		"Release the leftover hold; do not oversell.", false))

	add("STALE_STRATEGY", k.attentionRows(ctx, `
		SELECT strategy_type, revision, '' FROM commercial_strategies WHERE enabled AND (revision IS NULL OR revision='') LIMIT 50`,
		"STALE_STRATEGY", "LOW", "OPEN", "ADMIN",
		"An enabled commercial strategy has no revision pin.",
		"Set a revision before attributing order delta to the strategy.", false))

	add("INCOMPLETE_MERCHANT_DATA", k.attentionProfile(ctx))

	add("MISSING_EVALUATION_EVIDENCE", k.attentionRows(ctx, `
		SELECT payment_attempt_id, COALESCE(operation_id,''), COALESCE(merchant_order_id,'')
		FROM payment_attempts
		WHERE state IN ('RECONCILING','PROVIDER_SUBMITTED','OUTCOME_UNKNOWN')
		  AND payment_attempt_id NOT IN (SELECT payment_attempt_id FROM payment_audit_events WHERE kind='PROVIDER_EVIDENCE_EVALUATED')
		LIMIT 50`,
		"MISSING_EVALUATION_EVIDENCE", "MEDIUM", "OPEN", "PAYMENT_FABRIC",
		"A payment left the buyer flow without authenticated provider evidence.",
		"Fetch the provider order and payment before confirming the merchant order.", false))

	n := 0
	for _, c := range rep.Counts {
		n += c
	}
	if n == 0 {
		rep.Headline = "No unresolved merchant attention."
		rep.Completeness = "COMPLETE"
	} else {
		rep.Headline = "Unresolved merchant attention items exist."
		rep.Completeness = "COMPLETE"
	}
	return k.withMeta(k.env(), m, ""), rep, nil
}

func (k *Kernel) attentionRows(ctx context.Context, q, cat, sev, state, owner, expl, next string, retry bool) []AttentionItem {
	rows, err := k.Pool().Query(ctx, q)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AttentionItem
	for rows.Next() {
		var a, b, c string
		if err := rows.Scan(&a, &b, &c); err != nil {
			continue
		}
		out = append(out, AttentionItem{
			Category: cat, Severity: sev, State: state, Owner: owner,
			ResourceIDs:    map[string]string{"primary": a, "operation_id": b, "related": c},
			Explanation:    expl, NextSafeAction: next, RetryAllowed: retry,
		})
	}
	return out
}

func (k *Kernel) attentionProfile(ctx context.Context) []AttentionItem {
	var display, legal, email string
	if err := k.Pool().QueryRow(ctx, `SELECT COALESCE(display_name,''), COALESCE(legal_name,''), COALESCE(support_email,'') FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&display, &legal, &email); err != nil {
		return []AttentionItem{{
			Category: "INCOMPLETE_MERCHANT_DATA", Severity: "MEDIUM", State: "OPEN", Owner: audit.ChannelAdmin,
			Explanation: "Merchant profile could not be read.", NextSafeAction: "Restore merchant_profile fixture data.",
		}}
	}
	var unsellable int
	_ = k.Pool().QueryRow(ctx, `
		SELECT COUNT(*) FROM products p
		WHERE NOT EXISTS (
			SELECT 1 FROM skus s
			JOIN prices pr ON pr.sku_id = s.sku_id AND pr.selling_price_minor > 0
			JOIN inventory i ON i.sku_id = s.sku_id AND GREATEST(i.on_hand_quantity - i.reserved_quantity - i.safety_buffer, 0) > 0
			WHERE s.product_id = p.product_id AND s.lifecycle = 'ACTIVE'
		)`).Scan(&unsellable)

	var out []AttentionItem
	if display == "" || legal == "" || email == "" {
		out = append(out, AttentionItem{
			Category: "INCOMPLETE_MERCHANT_DATA", Severity: "MEDIUM", State: "OPEN", Owner: audit.ChannelAdmin,
			ResourceIDs: map[string]string{"merchant_profile": "singleton"},
			Explanation: fmt.Sprintf("Merchant profile is incomplete (display=%t legal=%t support_email=%t).", display != "", legal != "", email != ""),
			NextSafeAction: "Fill legal name and support email before publishing the storefront.",
		})
	}
	if unsellable > 0 {
		out = append(out, AttentionItem{
			Category: "INCOMPLETE_MERCHANT_DATA", Severity: "MEDIUM", State: "OPEN", Owner: audit.ChannelAdmin,
			ResourceIDs: map[string]string{"unsellable_products": fmt.Sprintf("%d", unsellable)},
			Explanation: fmt.Sprintf("Merchant data incomplete — %d products have no positive sellable offer.", unsellable),
			NextSafeAction: "Add a priced, in-stock SKU before treating the family as sellable.",
		})
	}
	return out
}
