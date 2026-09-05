package fixtures

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Manifest struct {
	SchemaVersion string         `json:"schema_version"`
	SnapshotID    string         `json:"snapshot_id"`
	Currency      string         `json:"currency"`
	Files         []ManifestFile `json:"files"`
}

type ManifestFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func ReadManifest(dir string) (Manifest, error) {
	var m Manifest
	if err := readJSON(filepath.Join(dir, "manifest.json"), &m); err != nil {
		return Manifest{}, fmt.Errorf("manifest.json: %w", err)
	}
	if strings.TrimSpace(m.SnapshotID) == "" {
		return Manifest{}, fmt.Errorf("manifest.json missing snapshot_id")
	}
	if len(m.Files) == 0 {
		return Manifest{}, fmt.Errorf("manifest.json has no files")
	}
	return m, nil
}

func MerchantCurrency(dir string) (string, error) {
	var m struct {
		DefaultCurrency string `json:"default_currency"`
	}
	if err := readJSON(filepath.Join(dir, "merchant.json"), &m); err != nil {
		return "", fmt.Errorf("merchant.json: %w", err)
	}
	cur := strings.ToUpper(strings.TrimSpace(m.DefaultCurrency))
	if len(cur) != 3 {
		return "", fmt.Errorf("merchant.json default_currency must be ISO-4217")
	}
	return cur, nil
}

// DigestDir hashes merchant currency plus each manifest file. It fails closed on
// missing files or a declared sha256 that does not match bytes.
func DigestDir(dir string) (string, error) {
	m, err := ReadManifest(dir)
	if err != nil {
		return "", err
	}
	currency, err := MerchantCurrency(dir)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte("currency:" + currency + "\n"))
	for _, f := range m.Files {
		if strings.TrimSpace(f.Path) == "" {
			return "", fmt.Errorf("manifest file path is empty")
		}
		b, err := os.ReadFile(filepath.Join(dir, f.Path))
		if err != nil {
			return "", fmt.Errorf("manifest file %s: %w", f.Path, err)
		}
		sum := sha256.Sum256(b)
		got := hex.EncodeToString(sum[:])
		if declared := strings.ToLower(strings.TrimSpace(f.SHA256)); declared != "" && declared != got {
			return "", fmt.Errorf("manifest hash mismatch for %s", f.Path)
		}
		h.Write([]byte(f.Path))
		h.Write(sum[:])
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}
