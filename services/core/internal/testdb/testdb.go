package testdb

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/platform"
	"atlas.dev/core/internal/store"
)

func Open(ctx context.Context) (*app.Kernel, func(), error) {
	url := os.Getenv("ATLAS_POSTGRES_URL")
	if url == "" {
		url = "postgres://atlas:atlas@127.0.0.1:55434/atlas?sslmode=disable"
		if err := ensureDocker(ctx, url); err != nil {
			return nil, nil, err
		}
	}
	var db *store.DB
	var err error
	for i := 0; i < 30; i++ {
		db, err = store.Connect(ctx, url)
		if err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: %w", err)
	}
	root := findRepo()
	mig := filepath.Join(root, "db/atlas/migrations")
	if err := db.Migrate(ctx, mig); err != nil {
		db.Close()
		return nil, nil, err
	}
	cfg := platform.Config{
		Environment: "test", PostgresURL: url, HostProofTTL: 60 * time.Second, CheckoutAuthorityTTL: 120 * time.Second,
		ProposalHoldTTL: 10 * time.Minute, OfferTTL: 90 * time.Second, SubstitutionDeadline: 15 * time.Minute,
		HostAudience: "atlas.merchant.v1", RequiredMigration: "0071_inventory_status.sql",
	}
	k := app.New(db, cfg, platform.Logger(), filepath.Join(root, "db/atlas/fixtures/quickmart-v1"))
	os.Setenv("ATLAS_HOST_TEST_PUBKEY", filepath.Join(root, "testdata/hostkeys/host_test_public.pem"))
	if _, err := k.ResetFixtures(ctx); err != nil {
		db.Close()
		return nil, nil, err
	}
	return k, func() { db.Close() }, nil
}

func ensureDocker(ctx context.Context, url string) error {
	if db, err := store.Connect(ctx, url); err == nil {
		db.Close()
		return nil
	}
	name := "atlas-kernel-test-pg"
	_ = exec.Command("docker", "rm", "-f", name).Run()
	cmd := exec.CommandContext(ctx, "docker", "run", "-d", "--name", name, "-e", "POSTGRES_USER=atlas", "-e", "POSTGRES_PASSWORD=atlas", "-e", "POSTGRES_DB=atlas", "-p", "55434:5432", "postgres:16-alpine")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if db, err2 := store.Connect(ctx, url); err2 == nil {
			db.Close()
			return nil
		}
		return fmt.Errorf("docker postgres: %s %w", out, err)
	}
	return nil
}

func findRepo() string {
	wd, _ := os.Getwd()
	dir := wd
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "db/atlas/migrations")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	return wd
}
