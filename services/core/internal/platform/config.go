package platform

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment            string
	PostgresURL            string
	GRPCAddr               string
	HTTPAddr               string
	PublicOrigin           string
	RazorpayKeyID          string
	RazorpayKeySecret      string
	RazorpayWebhookSecret  string
	RazorpayCallbackOrigin string
	RazorpayCaptureMode    string
	HostProofTTL           time.Duration
	CheckoutAuthorityTTL   time.Duration
	ProposalHoldTTL        time.Duration
	JobLease               time.Duration
	OfferTTL               time.Duration
	SubstitutionDeadline   time.Duration
	RequiredMigration      string
	HostAudience           string
}

func Load() (Config, error) {
	cfg := Config{
		Environment:            getenv("ATLAS_ENVIRONMENT", "test"),
		PostgresURL:            os.Getenv("ATLAS_POSTGRES_URL"),
		GRPCAddr:               getenv("ATLAS_CORE_GRPC_ADDR", "127.0.0.1:9090"),
		HTTPAddr:               getenv("ATLAS_CORE_HTTP_ADDR", "127.0.0.1:9091"),
		PublicOrigin:           os.Getenv("ATLAS_PUBLIC_ORIGIN"),
		RazorpayKeyID:          os.Getenv("RAZORPAY_KEY_ID"),
		RazorpayKeySecret:      os.Getenv("RAZORPAY_KEY_SECRET"),
		RazorpayWebhookSecret:  os.Getenv("RAZORPAY_WEBHOOK_SECRET"),
		RazorpayCallbackOrigin: os.Getenv("RAZORPAY_CALLBACK_ORIGIN"),
		RazorpayCaptureMode:    getenv("RAZORPAY_CAPTURE_MODE", "automatic"),
		HostProofTTL:           durationSeconds("ATLAS_HOST_PROOF_TTL_SECONDS", 60),
		CheckoutAuthorityTTL:   durationSeconds("ATLAS_CHECKOUT_AUTHORITY_TTL_SECONDS", 120),
		ProposalHoldTTL:        durationSeconds("ATLAS_PROPOSAL_HOLD_TTL_SECONDS", 600),
		JobLease:               durationSeconds("ATLAS_JOB_LEASE_SECONDS", 30),
		OfferTTL:               durationSeconds("ATLAS_OFFER_TTL_SECONDS", 90),
		SubstitutionDeadline:   durationSeconds("ATLAS_SUBSTITUTION_DEADLINE_SECONDS", 900),
		RequiredMigration:      getenv("ATLAS_REQUIRED_MIGRATION", "0190_observability_trail.sql"),
		HostAudience:           getenv("ATLAS_HOST_AUDIENCE", "atlas.merchant.v1"),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	var missing []string
	if c.PostgresURL == "" {
		missing = append(missing, "ATLAS_POSTGRES_URL")
	}
	if c.Environment == "" {
		missing = append(missing, "ATLAS_ENVIRONMENT")
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required configuration: %s", strings.Join(missing, ", "))
	}
	if c.Environment != "test" {
		return fmt.Errorf("ATLAS_ENVIRONMENT must be test; unknown mode %q rejected", c.Environment)
	}
	if err := RejectLiveMode(c.RazorpayKeyID); err != nil {
		return err
	}
	return nil
}

func RejectLiveMode(keyID string) error {
	id := strings.TrimSpace(keyID)
	if id == "" {
		return nil
	}
	if strings.HasPrefix(id, "rzp_live_") || strings.Contains(strings.ToLower(id), "live") && !strings.HasPrefix(id, "rzp_test_") {
		return fmt.Errorf("Live Mode Razorpay configuration is rejected at process start")
	}
	if !strings.HasPrefix(id, "rzp_test_") {
		return fmt.Errorf("Razorpay key ID must be Test Mode (rzp_test_) or empty")
	}
	return nil
}

func Logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func durationSeconds(key string, fallback int) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return time.Duration(fallback) * time.Second
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return time.Duration(fallback) * time.Second
	}
	return time.Duration(n) * time.Second
}
