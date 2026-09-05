package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"atlas.dev/core/internal/jobs"
	"atlas.dev/core/internal/payment"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/provider"
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
		Store:                payment.NewPostgresStore(db.Pool, payment.InventoryHooks{}),
		Client:               pClient,
		Cfg:                  pClient.Config(),
		RunnerCredentialHash: payment.HashToken(os.Getenv("ATLAS_RUNNER_EXECUTOR_CREDENTIAL")),
		RunnerIdentity:       "test-runner",
		OperatorAssisted:     os.Getenv("ATLAS_OPERATOR_ASSISTED_PAYMENTS") == "1",
	}
	payMod := payment.Register(pay)
	workerID := "worker-" + time.Now().Format("150405")
	types := append([]string{"EXPIRE_HOLD", "GENERATE_AUDIT_EXPORT", "PUBLISH_OUTBOX"}, payMod.JobTypes()...)
	health := newWorkerHealth(func(ctx context.Context) error {
		return db.Ready(ctx, cfg.RequiredMigration)
	}, 5*time.Second)
	go func() {
		addr := getenv("ATLAS_WORKER_HTTP_ADDR", "0.0.0.0:9092")
		log.Printf("worker health listening on %s", addr)
		if err := http.ListenAndServe(addr, health.handler()); err != nil {
			log.Fatalf("worker health: %v", err)
		}
	}()
	for {
		health.markLoop()
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
			if err := jobs.Fail(ctx, db, jobID, jobErr); err != nil {
				log.Printf("job fail persist %s: %v", jobID, err)
			}
			continue
		}
		_ = jobs.Complete(ctx, db, jobID)
	}
}

type workerHealth struct {
	dbReady      func(context.Context) error
	loopDeadline time.Duration
	lastLoopUnix atomic.Int64
}

func newWorkerHealth(dbReady func(context.Context) error, loopDeadline time.Duration) *workerHealth {
	h := &workerHealth{dbReady: dbReady, loopDeadline: loopDeadline}
	h.markLoop()
	return h
}

func (h *workerHealth) markLoop() {
	h.lastLoopUnix.Store(time.Now().UnixNano())
}

func (h *workerHealth) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeHealth(w, http.StatusOK, map[string]any{
			"status":     "live",
			"process":    "worker",
			"components": map[string]bool{"process": true},
		})
	})
	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		dbErr := h.dbReady(r.Context())
		lastLoop := time.Unix(0, h.lastLoopUnix.Load())
		loopReady := !lastLoop.IsZero() && time.Since(lastLoop) <= h.loopDeadline
		ready := dbErr == nil && loopReady
		status := http.StatusOK
		state := "ready"
		if !ready {
			status = http.StatusServiceUnavailable
			state = "not_ready"
		}
		database := dbErr == nil
		writeHealth(w, status, map[string]any{
			"status":  state,
			"process": "worker",
			"components": map[string]bool{
				"process":  true,
				"database": database,
				"loop":     loopReady,
			},
			"last_loop_at": lastLoop.UTC().Format(time.RFC3339Nano),
		})
	})
	return mux
}

func writeHealth(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
