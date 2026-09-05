package app

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"atlas.dev/core/internal/apperr"
)

func (k *Kernel) GetOperationTimeline(ctx context.Context, m Meta, operationID string) (Envelope, []AuditEventView, []string, error) {
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
	return k.withRequest(k.env(), m.RequestID, operationID), events, timelineStages(events), nil
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
	return k.withRequest(k.env(), m.RequestID, ""), events, nil
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
		       CASE WHEN status='FAILED' THEN 'JOB_FAILED' ELSE '' END,
		       jsonb_build_object('status', status, 'job_type', job_type, 'last_error', COALESCE(last_error,''))
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
		e.BodyJSON = redactPrivateJSON(e.BodyJSON)
		out = append(out, e)
	}
	return out
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

func timelineStages(events []AuditEventView) []string {
	order := []string{"GATE", "COMMAND", "COMMERCIAL", "PAYMENT", "EVIDENCE", "ASYNC"}
	reached := map[string]bool{}
	for _, e := range events {
		switch {
		case e.Kind == "POLICY_DECISION" || e.Attention == "AUTHORIZATION_DENIED":
			reached["GATE"] = true
		case e.Kind == "BOUNDARY_COMMAND_EVALUATED":
			reached["COMMAND"] = true
		case e.Kind == "COMMERCIAL_DECISION_RECORDED" || e.Kind == "OFFER_SHOWN" || e.Kind == "COMMERCIAL_REPRESENTATION_ISSUED":
			reached["COMMERCIAL"] = true
		case strings.Contains(e.Kind, "PAYMENT") || e.ResourceType == "payment_attempt":
			reached["PAYMENT"] = true
		case e.Kind == "PROVIDER_EVIDENCE_EVALUATED":
			reached["EVIDENCE"] = true
		case e.Kind == "ASYNC_DECISION_APPLIED" || e.Kind == "JOB_STATUS":
			reached["ASYNC"] = true
		}
	}
	var out []string
	for _, s := range order {
		if reached[s] {
			out = append(out, s)
		}
	}
	return out
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
