package app

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"atlas.dev/core/internal/apperr"
)

type TimelineStage struct {
	Stage          string
	Reached        bool
	Authoritative  bool
	Note           string
}

func (k *Kernel) GetOperationTimeline(ctx context.Context, m Meta, operationID string) (Envelope, []AuditEventView, []TimelineStage, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, nil, nil, err
	}
	if strings.TrimSpace(operationID) == "" {
		return Envelope{}, nil, nil, apperr.New(apperr.InvalidArgument, "operation_id is required")
	}
	var events []AuditEventView
	events = append(events, k.timelineFromAudit(ctx, `operation_id=$1`, operationID)...)
	events = append(events, k.timelineFromPayment(ctx, `operation_id=$1`, operationID)...)
	events = append(events, k.timelineFromOffers(ctx, `operation_id=$1`, operationID)...)
	events = append(events, k.timelineFromPolicy(ctx, `operation_id=$1`, operationID)...)
	events = append(events, k.timelineFromJobs(ctx, `operation_id=$1`, operationID)...)
	sortTimeline(events)
	markNonAuthoritative(events)
	return k.withMeta(k.env(), m, operationID), events, paymentAssuranceTimeline(events), nil
}

func (k *Kernel) GetResourceTimeline(ctx context.Context, m Meta, resourceType, resourceID string) (Envelope, []AuditEventView, error) {
	if err := k.requireScope(m, "audit:read"); err != nil {
		return Envelope{}, nil, err
	}
	if resourceType == "" || resourceID == "" {
		return Envelope{}, nil, apperr.New(apperr.InvalidArgument, "resource_type and resource_id are required")
	}
	var events []AuditEventView
	events = append(events, k.timelineFromAudit(ctx, `primary_resource_type=$1 AND primary_resource_id=$2`, resourceType, resourceID)...)
	switch resourceType {
	case "order", "payment_attempt":
		col := "order_id"
		if resourceType == "payment_attempt" {
			col = "payment_attempt_id"
		}
		events = append(events, k.timelineFromPayment(ctx, col+`=$1`, resourceID)...)
	case "offer":
		events = append(events, k.timelineFromOffers(ctx, `offer_id=$1`, resourceID)...)
	case "session":
		events = append(events, k.timelineFromPolicy(ctx, `session_id=$1`, resourceID)...)
	}
	sortTimeline(events)
	markNonAuthoritative(events)
	return k.withMeta(k.env(), m, ""), events, nil
}

func (k *Kernel) timelineFromAudit(ctx context.Context, where string, args ...any) []AuditEventView {
	q := `
		SELECT audit_event_id, record_sequence, event_kind, occurred_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), COALESCE(action,''),
		       COALESCE(primary_resource_type,''), COALESCE(primary_resource_id,''), COALESCE(summary_sentence,''), COALESCE(attention_code,''), event_body
		FROM audit_events WHERE ` + where + ` ORDER BY occurred_at, record_sequence`
	return k.scanTimeline(ctx, q, args...)
}

func (k *Kernel) timelineFromPayment(ctx context.Context, where string, args ...any) []AuditEventView {
	q := `
		SELECT audit_event_id, record_sequence, kind, occurred_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), kind,
		       CASE WHEN COALESCE(refund_id,'')<>'' THEN 'refund' WHEN COALESCE(order_id,'')<>'' THEN 'order' ELSE 'payment_attempt' END,
		       COALESCE(NULLIF(refund_id,''), NULLIF(order_id,''), payment_attempt_id), '', '', safe_body
		FROM payment_audit_events WHERE ` + where + ` ORDER BY occurred_at, record_sequence`
	return k.scanTimeline(ctx, q, args...)
}

func (k *Kernel) timelineFromOffers(ctx context.Context, where string, args ...any) []AuditEventView {
	q := `
		SELECT offer_event_id, 0, event_type, created_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), event_type,
		       'offer', offer_id, '', '', payload
		FROM offer_events WHERE ` + where + ` ORDER BY created_at`
	return k.scanTimeline(ctx, q, args...)
}

func (k *Kernel) timelineFromPolicy(ctx context.Context, where string, args ...any) []AuditEventView {
	q := `
		SELECT policy_decision_id, 0, 'POLICY_DECISION', created_at::text, COALESCE(request_id,''), COALESCE(operation_id,''), COALESCE(action,''),
		       'policy_decision', policy_decision_id, COALESCE(summary_sentence,''),
		       CASE WHEN result='DENY' THEN 'AUTHORIZATION_DENIED' ELSE '' END,
		       jsonb_build_object('result', result, 'reason_codes', reason_codes, 'host_id', COALESCE(host_id,''))
		FROM policy_decisions WHERE ` + where + ` ORDER BY created_at`
	return k.scanTimeline(ctx, q, args...)
}

func (k *Kernel) timelineFromJobs(ctx context.Context, where string, args ...any) []AuditEventView {
	q := `
		SELECT job_id, 0, 'JOB_STATUS', created_at::text, '', COALESCE(operation_id,''), job_type,
		       'job', job_id, COALESCE(last_error,''),
		       CASE WHEN status IN ('FAILED','NOT_RETRYABLE') THEN 'JOB_FAILED' ELSE '' END,
		       jsonb_build_object(
		         'status', status, 'job_type', job_type, 'last_error', COALESCE(last_error,''),
		         'attempt_count', attempt_count, 'last_error_class', COALESCE(last_error_class,''),
		         'retryable', COALESCE(retryable, TRUE), 'dead_letter_reason', COALESCE(dead_letter_reason,''),
		         'operator_action', COALESCE(operator_action,''), 'lease_owner', COALESCE(lease_owner,''),
		         'lease_expires_at', lease_expires_at, 'next_retry_at', available_at
		       )
		FROM jobs WHERE ` + where + ` ORDER BY created_at`
	return k.scanTimeline(ctx, q, args...)
}

func (k *Kernel) scanTimeline(ctx context.Context, q string, args ...any) []AuditEventView {
	rows, err := k.Pool().Query(ctx, q, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AuditEventView
	for rows.Next() {
		var e AuditEventView
		if err := rows.Scan(&e.ID, &e.Sequence, &e.Kind, &e.OccurredAt, &e.RequestID, &e.OperationID, &e.Action, &e.ResourceType, &e.ResourceID, &e.Summary, &e.Attention, &e.BodyJSON); err != nil {
			continue
		}
		e.Correlation = correlationFromBody(e.BodyJSON)
		e.BodyJSON = redactPrivateJSON(e.BodyJSON)
		out = append(out, e)
	}
	return out
}

func correlationFromBody(raw []byte) map[string]string {
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	c, _ := v["correlation"].(map[string]any)
	if c == nil {
		return nil
	}
	out := map[string]string{}
	for k, val := range c {
		if s, ok := val.(string); ok && s != "" {
			out[k] = s
		}
	}
	return out
}

func markNonAuthoritative(events []AuditEventView) {
	for i := range events {
		if events[i].Kind == "RUNNER_OBSERVATION" {
			events[i].NonAuthoritative = true
			if events[i].Summary == "" {
				events[i].Summary = "Runner/browser observation is not capture evidence."
			}
		}
	}
}

func sortTimeline(events []AuditEventView) {
	sort.SliceStable(events, func(i, j int) bool {
		ti, errI := time.Parse(time.RFC3339Nano, events[i].OccurredAt)
		tj, errJ := time.Parse(time.RFC3339Nano, events[j].OccurredAt)
		if errI != nil {
			ti, _ = time.Parse("2006-01-02 15:04:05.999999-07", events[i].OccurredAt)
		}
		if errJ != nil {
			tj, _ = time.Parse("2006-01-02 15:04:05.999999-07", events[j].OccurredAt)
		}
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return events[i].Sequence < events[j].Sequence
	})
}

type paymentStageSpec struct {
	Name          string
	Authoritative bool
	Note          string
	Match         func(AuditEventView) bool
}

func paymentAssuranceTimeline(events []AuditEventView) []TimelineStage {
	specs := []paymentStageSpec{
		{"AUTHORITY_CREATED", true, "", func(e AuditEventView) bool {
			return e.Action == "complete_checkout" || strings.Contains(strings.ToLower(e.Summary), "authority")
		}},
		{"PAYMENT_ATTEMPT_CREATED", true, "", kindIs("PAYMENT_ATTEMPT_CREATED")},
		{"PROVIDER_ORDER_REQUEST", true, "", func(e AuditEventView) bool {
			return e.Kind == "PROVIDER_ORDER_CREATED" || (e.Kind == "JOB_STATUS" && e.Action == "CREATE_PROVIDER_ORDER")
		}},
		{"PROVIDER_ORDER_RESPONSE", true, "", kindIs("PROVIDER_ORDER_CREATED")},
		{"RUNNER_OBSERVATION", false, "non-authoritative; never treated as capture", kindIs("RUNNER_OBSERVATION")},
		{"WEBHOOK_RECEIVED", true, "", kindIs("PROVIDER_WEBHOOK_BOUND")},
		{"PROVIDER_ORDER_FETCHED", true, "", kindIs("PROVIDER_EVIDENCE_EVALUATED")},
		{"PROVIDER_PAYMENT_FETCHED", true, "", kindIs("PROVIDER_EVIDENCE_EVALUATED")},
		{"AMOUNT_CURRENCY_VERIFIED", true, "", func(e AuditEventView) bool {
			return e.Kind == "PROVIDER_EVIDENCE_EVALUATED" && !strings.Contains(string(e.BodyJSON), `"decision":"REJECT"`)
		}},
		{"EVENT_BINDING_VERIFIED", true, "", kindIs("PROVIDER_WEBHOOK_BOUND", "PROVIDER_CALLBACK_BOUND")},
		{"PAYMENT_RECONCILED", true, "", kindIs("ASYNC_DECISION_APPLIED")},
		{"HOLD_CONVERTED_OR_RELEASED", true, "", func(e AuditEventView) bool {
			return e.Kind == "ORDER_CONFIRMED" || e.Kind == "ASYNC_DECISION_APPLIED"
		}},
		{"MERCHANT_ORDER_CONFIRMED", true, "", kindIs("ORDER_CONFIRMED")},
	}
	var out []TimelineStage
	for _, spec := range specs {
		st := TimelineStage{Stage: spec.Name, Authoritative: spec.Authoritative, Note: spec.Note}
		for _, e := range events {
			if spec.Match(e) {
				st.Reached = true
				break
			}
		}
		out = append(out, st)
	}
	return out
}

func kindIs(kinds ...string) func(AuditEventView) bool {
	set := map[string]bool{}
	for _, k := range kinds {
		set[k] = true
	}
	return func(e AuditEventView) bool { return set[e.Kind] }
}

var privateJSONKeys = map[string]bool{
	"ranking_score": true, "economics_private": true, "score": true, "private": true,
}

func redactPrivateJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return raw
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	return mustJSON(stripPrivate(v))
}

func stripPrivate(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			if privateJSONKeys[k] {
				continue
			}
			out[k] = stripPrivate(val)
		}
		return out
	case []any:
		for i := range t {
			t[i] = stripPrivate(t[i])
		}
		return t
	default:
		return v
	}
}
