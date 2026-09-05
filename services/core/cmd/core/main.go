package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/grpcapi"
	"atlas.dev/core/internal/payment"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/provider"
	"atlas.dev/core/internal/store"

	"google.golang.org/grpc"
)

func main() {
	logg := platform.Logger()
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
	mig := getenv("ATLAS_MIGRATIONS_DIR", "db/atlas/migrations")
	if err := db.Migrate(ctx, mig); err != nil {
		log.Fatalf("migrate: %v", err)
	}

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
	payment.Register(pay)

	k := app.New(db, cfg, logg, getenv("ATLAS_FIXTURE_DIR", "db/atlas/fixtures/quickmart-v1"))
	if _, err := k.CurrentFixture(ctx); err != nil {
		if _, err := k.ResetFixtures(ctx); err != nil {
			logg.Warn("fixture seed skipped", "err", err)
		}
	}

	gs := grpc.NewServer()
	grpcapi.Register(gs, k, pay)
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("listen grpc: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"live"}`))
	})
	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Ready(r.Context(), cfg.RequiredMigration); err != nil {
			http.Error(w, `{"status":"not_ready"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("/internal/v1/authenticate-host", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"code":"INVALID_ARGUMENT"}`, http.StatusMethodNotAllowed)
			return
		}
		token := bearer(r)
		id, err := k.AuthenticateHostBearer(r.Context(), token)
		if err != nil {
			http.Error(w, `{"code":"HOST_UNAUTHENTICATED"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"host_id": id})
	})
	mux.HandleFunc("/internal/v1/authenticate-operator", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"code":"INVALID_ARGUMENT"}`, http.StatusMethodNotAllowed)
			return
		}
		id, scopes, err := k.AuthenticateOperator(r.Context(), bearer(r))
		if err != nil {
			http.Error(w, `{"code":"UNAUTHENTICATED"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"operator_id": id, "scopes": scopes})
	})
	hs := &http.Server{Addr: cfg.HTTPAddr, Handler: mux}

	go func() {
		logg.Info("core grpc listening", "addr", cfg.GRPCAddr)
		if err := gs.Serve(lis); err != nil {
			logg.Error("grpc serve", "err", err)
		}
	}()
	go func() {
		logg.Info("core http listening", "addr", cfg.HTTPAddr)
		if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logg.Error("http serve", "err", err)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	gs.GracefulStop()
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hs.Shutdown(cctx)
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && h[:7] == "Bearer " {
		return h[7:]
	}
	return h
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
