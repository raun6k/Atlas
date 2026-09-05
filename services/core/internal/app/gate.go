package app

import (
	"context"
	"strings"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/ids"

	"github.com/jackc/pgx/v5"
)

func (k *Kernel) loadHost(ctx context.Context, tx pgx.Tx, hostID string) (status string, scopes []string, err error) {
	err = tx.QueryRow(ctx, `SELECT status, COALESCE(scopes, ARRAY[]::TEXT[]) FROM approved_hosts WHERE host_id=$1`, hostID).Scan(&status, &scopes)
	if err != nil {
		return "", nil, apperr.New(apperr.HostUnauthenticated, "unknown host")
	}
	return status, scopes, nil
}

func hostToolPermitted(scopes []string, tool string) bool {
	if tool == "" || len(scopes) == 0 {
		return true
	}
	if hasScope(scopes, "mcp") || hasScope(scopes, "*") {
		return true
	}
	return hasScope(scopes, tool)
}

func (k *Kernel) assertHostGate(ctx context.Context, tx pgx.Tx, m Meta) error {
	if m.ApprovedHostID == "" {
		return nil
	}
	status, scopes, err := k.loadHost(ctx, tx, m.ApprovedHostID)
	if err != nil {
		return err
	}
	if status != "ACTIVE" {
		return apperr.New(apperr.HostForbidden, "host is not active")
	}
	if !hostToolPermitted(scopes, m.Tool) {
		return apperr.New(apperr.HostForbidden, "tool not permitted for this host")
	}
	return nil
}

func gateReasonCodes(err error) []string {
	e := apperr.As(err)
	if e == nil {
		return []string{"GATE_DENIED"}
	}
	switch e.Code {
	case apperr.HostUnauthenticated:
		return []string{"HOST_UNKNOWN"}
	case apperr.HostForbidden:
		switch {
		case strings.Contains(e.Message, "not active"):
			return []string{"HOST_NOT_ACTIVE"}
		case strings.Contains(e.Message, "not permitted"):
			return []string{"TOOL_NOT_PERMITTED"}
		default:
			return []string{"PROOF_INVALID"}
		}
	case apperr.AuthorityExpired:
		return []string{"AUTHORITY_EXPIRED"}
	case apperr.AuthorityAmountExceeded:
		return []string{"CONSENT_OR_AMOUNT_EXCEEDED"}
	case apperr.AuthorityInvalid:
		return []string{"AUTHORITY_INVALID"}
	default:
		return []string{e.Code}
	}
}

func (k *Kernel) recordGateDecision(ctx context.Context, m Meta, op, sessionID, proposalID, result string, reasons []string, summary string) {
	if m.RequestID == "" {
		return
	}
	if summary == "" {
		summary = "Atlas recorded a host authorization decision."
	}
	tx, err := k.Pool().Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertPolicyDecision(ctx, tx, m, op, sessionID, proposalID, result, reasons, summary); err != nil {
		return
	}
	attention := ""
	if result == "DENY" {
		attention = "AUTHORIZATION_DENIED"
	}
	body := map[string]any{"result": result, "reason_codes": reasons, "tool": m.Tool}
	_, err = audit.Append(ctx, tx, audit.Event{
		Kind: "BOUNDARY_COMMAND_EVALUATED", RequestID: m.RequestID, OperationID: op,
		PrincipalType: "APPROVED_HOST", PrincipalID: m.ApprovedHostID, Channel: "mcp",
		Action: m.Tool, ResourceType: "host", ResourceID: m.ApprovedHostID,
		Body: body, Attention: attention, Summary: summary,
	})
	if err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func insertPolicyDecision(ctx context.Context, tx pgx.Tx, m Meta, op, sessionID, proposalID, result string, reasons []string, summary string) error {
	id := ids.New(ids.Policy)
	if reasons == nil {
		reasons = []string{}
	}
	digest := digestOf(map[string]any{"tool": m.Tool, "host": m.ApprovedHostID, "proposal": proposalID, "reasons": reasons})
	_, err := tx.Exec(ctx, `
		INSERT INTO policy_decisions (
			policy_decision_id, session_id, checkout_proposal_id, result, reason_codes, revision, input_digest,
			operation_id, request_id, host_id, action, summary_sentence
		) VALUES ($1,NULLIF($2,''),NULLIF($3,''),$4,$5,'tg_v1',$6,NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11)`,
		id, sessionID, proposalID, result, reasons, digest, op, m.RequestID, m.ApprovedHostID, m.Tool, summary)
	return err
}

func insertAllowPolicy(ctx context.Context, tx pgx.Tx, m Meta, op, sessionID, proposalID, inputDigest string, reasons []string) (string, error) {
	id := ids.New(ids.Policy)
	if reasons == nil {
		reasons = []string{"TRUST_GATE_ALLOW"}
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO policy_decisions (
			policy_decision_id, session_id, checkout_proposal_id, result, reason_codes, revision, input_digest,
			operation_id, request_id, host_id, action, summary_sentence
		) VALUES ($1,$2,$3,'ALLOW',$4,'tg_v1',$5,$6,$7,$8,'complete_checkout',$9)`,
		id, sessionID, proposalID, reasons, inputDigest, op, m.RequestID, m.ApprovedHostID,
		"Atlas allowed complete checkout after host, proof, authority, amount, and capability checks.")
	return id, err
}
