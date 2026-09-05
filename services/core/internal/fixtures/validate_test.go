package fixtures

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packDir(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	dir := wd
	for i := 0; i < 8; i++ {
		p := filepath.Join(dir, "db/atlas/fixtures/quickmart-v1")
		if _, err := os.Stat(filepath.Join(p, "merchant.json")); err == nil {
			return p
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("quickmart pack not found")
	return ""
}

func TestValidateQuickmartPack(t *testing.T) {
	dir := packDir(t)
	if err := ValidateDir(dir); err != nil {
		t.Fatal(err)
	}
	d, err := DigestDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(d, "sha256:") || len(d) != 71 {
		t.Fatalf("digest %s", d)
	}
	cur, err := MerchantCurrency(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cur != "INR" {
		t.Fatalf("currency %s", cur)
	}
}

func TestDigestFailsOnHashMismatch(t *testing.T) {
	src := packDir(t)
	tmp := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(tmp, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, "merchant.json"), []byte(`{"default_currency":"INR","display_name":"x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := DigestDir(tmp); err == nil {
		t.Fatal("expected hash mismatch")
	}
}
