package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"atlas.dev/core/internal/jobs"
	"atlas.dev/core/internal/payment"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/provider"
	"atlas.dev/core/internal/refund"
	"atlas.dev/core/internal/store"
)

func main() {
	cfg, err := platform.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	ctx := context.Background()
	db, err := store.Connect(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	defer db.Close()
	pClient, err := provider.NewClient(provider.Config{
		KeyID: cfg.RazorpayKeyID, KeySecret: cfg.RazorpayKeySecret, WebhookSecret: cfg.RazorpayWebhookSecret,
		CallbackOrigin: cfg.RazorpayCallbackOrigin, CaptureMode: cfg.RazorpayCaptureMode,
	})
	if err != nil {
		log.Fatalf("razorpay config: %v", err)
	}
	pay := &payment.Service{
		Store:  payment.NewPostgresStore(db.Pool, payment.InventoryHooks{}),
		Client: pClient,
		Cfg:    pClient.Config(),
	}
	payMod := payment.Register(pay)
	refund.Register(pay)
	workerID := "worker-" + time.Now().Format("150405")
	types := append([]string{"EXPIRE_HOLD", "GENERATE_AUDIT_EXPORT", "PUBLISH_OUTBOX"}, payMod.JobTypes()...)
	for {
		if err := jobs.ExpireHolds(ctx, db, time.Now().UTC()); err != nil {
			log.Printf("expire holds: %v", err)
		}
		if err := jobs.PublishOutbox(ctx, db); err != nil {
			log.Printf("outbox: %v", err)
		}
		_, _ = db.Pool.Exec(ctx, `UPDATE jobs SET status='PENDING', lease_owner=NULL, lease_expires_at=NULL WHERE status='CLAIMED' AND lease_expires_at < now()`)
		jobID, jobType, payload, err := jobs.Claim(ctx, db, workerID, types, cfg.JobLease)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		var jobErr error
		switch jobType {
		case "GENERATE_AUDIT_EXPORT":
			var p struct {
				ExportID string `json:"export_id"`
			}
			_ = json.Unmarshal(payload, &p)
			jobErr = jobs.GenerateExport(ctx, db, p.ExportID, getenv("ATLAS_EXPORT_DIR", "/tmp/atlas-exports"))
		case "EXPIRE_HOLD", "PUBLISH_OUTBOX":
			jobErr = nil
		default:
			jobErr = payMod.HandleJob(ctx, jobType, payload)
		}
		if jobErr != nil {
			log.Printf("job %s %s: %v", jobType, jobID, jobErr)
			continue
		}
		_ = jobs.Complete(ctx, db, jobID)
	}
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
