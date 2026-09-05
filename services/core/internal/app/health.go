package app

import (
	"context"
	"fmt"
	"os"
	"strings"

	"atlas.dev/core/internal/platform"
)

type HealthComponent struct {
	Name   string
	Status string
	Detail string
}

type HealthReport struct {
	Status     string
	Database   bool
	Migrations bool
	Components []HealthComponent
}

func (k *Kernel) SystemHealth(ctx context.Context, m Meta) (Envelope, HealthReport, error) {
	if err := k.requireScope(m, "merchant:read"); err != nil {
		if err2 := k.requireScope(m, "audit:read"); err2 != nil {
			return Envelope{}, HealthReport{}, err
		}
	}
	rep := HealthReport{Status: "ready"}
	pingErr := k.DB.Pool.Ping(ctx)
	migErr := k.DB.Ready(ctx, k.Cfg.RequiredMigration)
	rep.Database = pingErr == nil
	rep.Migrations = migErr == nil
	testMode := k.Cfg.Environment == "test"
	runnerSet := strings.TrimSpace(os.Getenv("ATLAS_RUNNER_EXECUTOR_CREDENTIAL")) != ""
	workerSet := strings.TrimSpace(os.Getenv("ATLAS_WORKER_CREDENTIAL")) != ""
	rep.Components = append(rep.Components,
		comp("postgresql", pingErr == nil, errDetail(pingErr, "pool ping ok")),
		comp("migrations", migErr == nil, errDetail(migErr, k.Cfg.RequiredMigration)),
		k.fixtureComponent(ctx),
		k.razorpayComponent(),
		k.webhookComponent(),
		HealthComponent{Name: "test_mode", Status: map[bool]string{true: "READY", false: "LIVE"}[testMode], Detail: "ATLAS_ENVIRONMENT=" + k.Cfg.Environment},
		HealthComponent{Name: "runner_auth", Status: map[bool]string{true: "READY", false: "DEGRADED"}[runnerSet], Detail: "ATLAS_RUNNER_EXECUTOR_CREDENTIAL"},
		HealthComponent{Name: "worker_heartbeat", Status: map[bool]string{true: "CONFIGURED", false: "UNKNOWN"}[workerSet], Detail: "ATLAS_WORKER_CREDENTIAL"},
		k.jobComponent(ctx, "worker", false),
		k.jobComponent(ctx, "payment_runner", true),
		k.reconcileComponent(ctx),
		HealthComponent{Name: "core", Status: "READY", Detail: "grpc process serving"},
		HealthComponent{Name: "gateway", Status: "UNKNOWN", Detail: "reported by Gateway, not Core"},
		HealthComponent{Name: "atlaslab", Status: "UNKNOWN", Detail: "AtlasLab readiness is independent of Core"},
		HealthComponent{Name: "openrouter", Status: "UNKNOWN", Detail: "OpenRouter is an AtlasLab dependency"},
		HealthComponent{Name: "public_mcp_schema", Status: "READY", Detail: "atlas.merchant.v1 public tools"},
	)
	for _, c := range rep.Components {
		if c.Name == "postgresql" || c.Name == "migrations" || c.Name == "fixture" || c.Name == "core" {
			if c.Status == "NOT_READY" {
				rep.Status = "not_ready"
			}
		}
	}
	return k.withMeta(k.env(), m, ""), rep, nil
}

func (k *Kernel) fixtureComponent(ctx context.Context) HealthComponent {
	cur, err := k.CurrentFixture(ctx)
	if err != nil || cur.Digest == "" {
		return HealthComponent{Name: "fixture", Status: "NOT_READY", Detail: "no current fixture snapshot"}
	}
	return HealthComponent{Name: "fixture", Status: "READY", Detail: cur.SnapshotID + " " + cur.Digest}
}

func (k *Kernel) razorpayComponent() HealthComponent {
	id := strings.TrimSpace(k.Cfg.RazorpayKeyID)
	if id == "" {
		return HealthComponent{Name: "razorpay_configuration", Status: "DEGRADED", Detail: "Test Mode key unset; checkout cannot create provider orders"}
	}
	if err := platform.RejectLiveMode(id); err != nil {
		return HealthComponent{Name: "razorpay_configuration", Status: "NOT_READY", Detail: "Live Mode rejected"}
	}
	return HealthComponent{Name: "razorpay_configuration", Status: "READY", Detail: "Test Mode key configured"}
}

func (k *Kernel) webhookComponent() HealthComponent {
	if strings.TrimSpace(k.Cfg.RazorpayWebhookSecret) == "" {
		return HealthComponent{Name: "webhook", Status: "DEGRADED", Detail: "webhook secret unset"}
	}
	return HealthComponent{Name: "webhook", Status: "READY", Detail: "webhook secret configured"}
}

func (k *Kernel) reconcileComponent(ctx context.Context) HealthComponent {
	var n int
	if err := k.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM jobs WHERE job_type='RECONCILE_PAYMENT'`).Scan(&n); err != nil {
		return HealthComponent{Name: "reconcile_loop", Status: "UNKNOWN", Detail: "jobs table unread"}
	}
	return HealthComponent{Name: "reconcile_loop", Status: "READY", Detail: fmt.Sprintf("%d RECONCILE_PAYMENT jobs recorded", n)}
}

func (k *Kernel) jobComponent(ctx context.Context, name string, runner bool) HealthComponent {
	q := `SELECT COUNT(*) FROM jobs WHERE status IN ('CLAIMED','RUNNING','QUEUED','PENDING')`
	if runner {
		q = `SELECT COUNT(*) FROM jobs WHERE job_type ILIKE '%RUNNER%' OR job_type ILIKE '%CHECKOUT%'`
	}
	var n int
	if err := k.Pool().QueryRow(ctx, q).Scan(&n); err != nil {
		return HealthComponent{Name: name, Status: "UNKNOWN", Detail: "jobs table unread"}
	}
	if runner {
		return HealthComponent{Name: name, Status: "READY", Detail: fmt.Sprintf("%d checkout/runner jobs recorded (not a live heartbeat)", n)}
	}
	return HealthComponent{Name: name, Status: "READY", Detail: fmt.Sprintf("%d in-flight worker jobs", n)}
}

func comp(name string, ok bool, detail string) HealthComponent {
	st := "READY"
	if !ok {
		st = "NOT_READY"
	}
	return HealthComponent{Name: name, Status: st, Detail: detail}
}

func errDetail(err error, ok string) string {
	if err == nil {
		return ok
	}
	return "unavailable"
}
