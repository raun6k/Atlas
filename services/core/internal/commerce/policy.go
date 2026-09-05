package commerce

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

type TreatmentPolicy struct {
	PolicyID                 string            `json:"policy_id"`
	Arm                      string            `json:"arm"`
	StrategyAllowlist        []string          `json:"strategy_allowlist"`
	StrategyRevisions        map[string]string `json:"strategy_revisions"`
	CampaignRevisions        map[string]string `json:"campaign_revisions"`
	RankingVersion           string            `json:"ranking_version"`
	EconomicObjectiveVersion string            `json:"economic_objective_version"`
	PolicyDigest             string            `json:"policy_digest"`
	EffectiveAt              time.Time         `json:"effective_at"`
}

func DigestPolicy(p TreatmentPolicy) string {
	type wire struct {
		Arm          string            `json:"arm"`
		Allowlist    []string          `json:"strategy_allowlist"`
		StrategyRevs map[string]string `json:"strategy_revisions"`
		CampaignRevs map[string]string `json:"campaign_revisions"`
		Ranking      string            `json:"ranking_version"`
		Objective    string            `json:"economic_objective_version"`
	}
	allow := append([]string(nil), p.StrategyAllowlist...)
	sort.Strings(allow)
	body, _ := json.Marshal(wire{
		Arm: p.Arm, Allowlist: allow, StrategyRevs: p.StrategyRevisions,
		CampaignRevs: p.CampaignRevisions, Ranking: p.RankingVersion, Objective: p.EconomicObjectiveVersion,
	})
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
