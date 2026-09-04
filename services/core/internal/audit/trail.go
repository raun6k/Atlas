package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"atlas.dev/core/internal/ids"

	"github.com/jackc/pgx/v5"
)

type Event struct {
	ID             string
	Kind           string
	OccurredAt     time.Time
	RequestID      string
	OperationID    string
	PrincipalType  string
	PrincipalID    string
	Channel        string
	Action         string
	ResourceType   string
	ResourceID     string
	ResourceVer    int64
	Body           map[string]any
	RetentionClass string
	Attention      string
	Summary        string
}

func Append(ctx context.Context, tx pgx.Tx, ev Event) (string, error) {
	if ev.ID == "" {
		ev.ID = ids.New(ids.Audit)
	}
	if ev.OccurredAt.IsZero() {
		ev.OccurredAt = time.Now().UTC()
	}
	if ev.RetentionClass == "" {
		ev.RetentionClass = "effects_365d"
		if ev.Kind == "COMMERCIAL_REPRESENTATION_ISSUED" {
			ev.RetentionClass = "representations_90d"
		}
	}
	if ev.PrincipalType == "" {
		ev.PrincipalType = "ATLAS_SYSTEM"
	}
	body, err := json.Marshal(ev.Body)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (
			audit_event_id, event_kind, occurred_at, request_id, operation_id,
			initiating_principal_type, initiating_principal_id, executing_component,
			source_channel, contract_version, action, primary_resource_type, primary_resource_id,
			primary_resource_version, event_body, event_body_digest, retention_class,
			attention_code, summary_sentence
		) VALUES ($1,$2,$3,$4,$5,$6,$7,'core',$8,'atlas.merchant.v1',$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		ev.ID, ev.Kind, ev.OccurredAt, ev.RequestID, ev.OperationID,
		ev.PrincipalType, ev.PrincipalID, ev.Channel, ev.Action, ev.ResourceType, ev.ResourceID,
		ev.ResourceVer, body, digest, ev.RetentionClass, ev.Attention, ev.Summary,
	)
	return ev.ID, err
}
