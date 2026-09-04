package app

import (
	"context"
	"os"
	"path/filepath"

	"atlas.dev/core/internal/fixtures"
)

func (k *Kernel) ResetFixtures(ctx context.Context) (fixtures.ResetResult, error) {
	return fixtures.LoadDir(ctx, k.DB, k.FixtureDir, k.hostPEM())
}

func (k *Kernel) CurrentFixture(ctx context.Context) (fixtures.ResetResult, error) {
	return fixtures.Current(ctx, k.DB)
}

func (k *Kernel) hostPEM() string {
	if v := os.Getenv("ATLAS_HOST_TEST_PUBKEY"); v != "" {
		return v
	}
	return findUp("testdata/hostkeys/host_test_public.pem")
}

func findUp(rel string) string {
	wd, err := os.Getwd()
	if err != nil {
		return rel
	}
	dir := wd
	for i := 0; i < 8; i++ {
		p := filepath.Join(dir, rel)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return rel
}
