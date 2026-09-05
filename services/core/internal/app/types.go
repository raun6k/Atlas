package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"time"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/audit"
	"atlas.dev/core/internal/commerce"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const ContractVersion = "atlas.merchant.v1"

type Kernel struct {
	DB         *store.DB
	Cfg        platform.Config
	Log        *slog.Logger
	FixtureDir string
	Now        func() time.Time
}

type Meta struct {
	RequestID          string
	IdempotencyKey     string
	HostRequestProof   string
	ApprovedHostID     string
	OperatorID         string
	OperatorScopes     []string
	Tool               string
	Arguments          map[string]any
	SkipProof          bool
	RequireIdempotency bool
	Correlation        map[string]string
}

type Envelope struct {
	ContractVersion string
	RequestID       string
	OccurredAt      time.Time
	OperationID     string
	Correlation     map[string]string
}

type SessionSummary struct {
	SessionID             string
	SessionContextVersion int64
	LocationID            string
	Status                string
	CartID                string
	CartVersion           int64
	PlanningBudgetMinor   int64
	HasBudget             bool
	Mission               string
	Currency              string
	HostID                string
	SubjectReference      string
	EvaluationArm         string
	StrategyAllowlist     []string
	TreatmentPolicyID     string
	Treatment             *commerce.TreatmentPolicy
	Constraints           map[string]string
}

type CartView struct {
	CartID    string
	SessionID string
	Version   int64
	Lines     []LineView
	Totals    TotalsView
	Currency  string
}

type LineView struct {
	LineID    string
	SKUID     string
	ProductID string
	Name      string
	Quantity  int32
	UnitMinor int64
	LineMinor int64
}

type TotalsView struct {
	MerchandiseMinor int64
	DiscountsMinor   int64
	DeliveryFeeMinor int64
	HandlingFeeMinor int64
	TaxMinor         int64
	AllInMinor       int64
	Currency         string
}

type OfferView struct {
	OfferID               string
	StrategyType          string
	SessionContextVersion int64
	CartVersion           int64
	ExpiresAt             time.Time
	Status                string
	GroundedReason        string
	Terms                 string
	PatchJSON             []byte
	BuyerImpactMinor      int64
	BaseAllInMinor        int64
	PatchedAllInMinor     int64
	StrategyRevision      string
	DiscountAmountMinor   int64
	MerchantFundedMinor   int64
	PartnerFundedMinor    int64
	ExpectedMarginMinor   int64
	QuoteDeltaMinor       int64
	ExplanationJSON       []byte
}

type CartMutation struct {
	Envelope            Envelope
	Session             SessionSummary
	Cart                CartView
	Offers              []OfferView
	InvalidatedOfferIDs []string
}

func New(db *store.DB, cfg platform.Config, log *slog.Logger, fixtureDir string) *Kernel {
	if log == nil {
		log = platform.Logger()
	}
	if fixtureDir == "" {
		fixtureDir = os.Getenv("ATLAS_FIXTURE_DIR")
	}
	return &Kernel{DB: db, Cfg: cfg, Log: log, FixtureDir: fixtureDir, Now: func() time.Time { return time.Now().UTC() }}
}

func (k *Kernel) Pool() *pgxpool.Pool { return k.DB.Pool }

func (k *Kernel) env() Envelope {
	return Envelope{ContractVersion: ContractVersion, OccurredAt: k.Now()}
}

func (k *Kernel) withRequest(env Envelope, requestID, operationID string) Envelope {
	env.RequestID = requestID
	env.OperationID = operationID
	env.Correlation = audit.Merge(env.Correlation, map[string]string{
		"request_id":   requestID,
		"operation_id": operationID,
	})
	return env
}

func (k *Kernel) withMeta(env Envelope, m Meta, operationID string) Envelope {
	env = k.withRequest(env, m.RequestID, operationID)
	env.Correlation = audit.Merge(env.Correlation, m.Correlation)
	env.Correlation = audit.Merge(env.Correlation, map[string]string{"host_id": m.ApprovedHostID})
	return env
}

func requireHost(m Meta) error {
	if strings.TrimSpace(m.ApprovedHostID) == "" {
		return apperr.New(apperr.HostUnauthenticated, "Approved Host credential is required")
	}
	return nil
}

func digestOf(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func newOp() string { return ids.New(ids.Operation) }

func (k *Kernel) hostStatus(ctx context.Context, tx pgx.Tx, hostID string) (string, error) {
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM approved_hosts WHERE host_id=$1`, hostID).Scan(&status)
	if err != nil {
		return "", apperr.New(apperr.HostUnauthenticated, "unknown host")
	}
	if status != "ACTIVE" {
		return "", apperr.New(apperr.HostForbidden, "host is not active")
	}
	return status, nil
}

func hasScope(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want || s == "*" {
			return true
		}
	}
	return false
}

func (k *Kernel) RequireScope(m Meta, scope string) error {
	return k.requireScope(m, scope)
}

func (k *Kernel) requireScope(m Meta, scope string) error {
	if strings.TrimSpace(m.OperatorID) == "" {
		return apperr.New(apperr.Unauthenticated, "operator identity is required")
	}
	if !hasScope(m.OperatorScopes, scope) {
		return apperr.New(apperr.Forbidden, "missing operator scope "+scope)
	}
	return nil
}

func ctxTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 15*time.Second)
}
