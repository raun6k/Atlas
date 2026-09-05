package app

import (
	"context"
	"encoding/json"
	"strings"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/commerce"
	"atlas.dev/core/internal/ids"

	"github.com/jackc/pgx/v5"
)

func (k *Kernel) resolveAndStampPolicy(ctx context.Context, tx pgx.Tx, sessionID, arm string, requested []string) (commerce.TreatmentPolicy, error) {
	if err := commerce.ValidateAllowlist(requested); err != nil {
		return commerce.TreatmentPolicy{}, apperr.New(apperr.InvalidArgument, err.Error())
	}
	type row struct {
		Type, Rev, Vis string
		Enabled        bool
	}
	srows, err := tx.Query(ctx, `SELECT strategy_type, revision, enabled, visibility FROM commercial_strategies`)
	if err != nil {
		return commerce.TreatmentPolicy{}, err
	}
	var rows []row
	revs := map[string]string{}
	for srows.Next() {
		var r row
		if err := srows.Scan(&r.Type, &r.Rev, &r.Enabled, &r.Vis); err != nil {
			srows.Close()
			return commerce.TreatmentPolicy{}, err
		}
		if !commerce.IsKnownType(r.Type) {
			continue
		}
		rows = append(rows, r)
		revs[r.Type] = r.Rev
	}
	srows.Close()
	var allow []string
	if strings.TrimSpace(arm) == "CONTROL" {
		allow = []string{}
	} else if len(requested) > 0 {
		want := map[string]bool{}
		for _, t := range requested {
			want[t] = true
		}
		for _, r := range rows {
			if want[r.Type] && r.Enabled && r.Vis == commerce.VisibilityDemo {
				allow = append(allow, r.Type)
			}
		}
	} else {
		for _, r := range rows {
			if r.Enabled && r.Vis == commerce.VisibilityDemo {
				allow = append(allow, r.Type)
			}
		}
	}
	crows, err := tx.Query(ctx, `SELECT campaign_id, revision FROM campaigns`)
	if err != nil {
		return commerce.TreatmentPolicy{}, err
	}
	camps := map[string]string{}
	for crows.Next() {
		var id, rev string
		if err := crows.Scan(&id, &rev); err != nil {
			crows.Close()
			return commerce.TreatmentPolicy{}, err
		}
		camps[id] = rev
	}
	crows.Close()
	p := commerce.TreatmentPolicy{
		PolicyID:                 ids.New(ids.Policy),
		Arm:                      arm,
		StrategyAllowlist:        allow,
		StrategyRevisions:        revs,
		CampaignRevisions:        camps,
		RankingVersion:           commerce.RankingVersion,
		EconomicObjectiveVersion: commerce.EconomicObjective,
		EffectiveAt:              k.Now(),
	}
	p.PolicyDigest = commerce.DigestPolicy(p)
	srev, _ := json.Marshal(p.StrategyRevisions)
	crev, _ := json.Marshal(p.CampaignRevisions)
	if _, err := tx.Exec(ctx, `
		INSERT INTO session_treatment_policies (
			policy_id, session_id, arm, strategy_allowlist, strategy_revisions, campaign_revisions,
			ranking_version, economic_objective_version, policy_digest, effective_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		p.PolicyID, sessionID, p.Arm, allow, srev, crev, p.RankingVersion, p.EconomicObjectiveVersion, p.PolicyDigest, p.EffectiveAt); err != nil {
		return commerce.TreatmentPolicy{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE shopping_sessions SET strategy_allowlist=$2, treatment_policy_id=$3 WHERE session_id=$1`, sessionID, allow, p.PolicyID); err != nil {
		return commerce.TreatmentPolicy{}, err
	}
	return p, nil
}

func (k *Kernel) loadTreatment(ctx context.Context, tx pgx.Tx, sessionID string) *commerce.TreatmentPolicy {
	var p commerce.TreatmentPolicy
	var srev, crev []byte
	err := tx.QueryRow(ctx, `
		SELECT policy_id, arm, COALESCE(strategy_allowlist,'{}'), strategy_revisions, campaign_revisions,
		       ranking_version, economic_objective_version, policy_digest, effective_at
		FROM session_treatment_policies WHERE session_id=$1`, sessionID).Scan(
		&p.PolicyID, &p.Arm, &p.StrategyAllowlist, &srev, &crev, &p.RankingVersion, &p.EconomicObjectiveVersion, &p.PolicyDigest, &p.EffectiveAt)
	if err != nil {
		return nil
	}
	_ = json.Unmarshal(srev, &p.StrategyRevisions)
	_ = json.Unmarshal(crev, &p.CampaignRevisions)
	return &p
}
