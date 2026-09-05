package app

import (
	"strings"
	"testing"
)

func TestRedactPrivateJSON(t *testing.T) {
	raw := []byte(`{"shown":[{"strategy":"FBT"}],"ranking_score":99.1,"economics_private":{"score":1},"nested":{"score":3}}`)
	out := redactPrivateJSON(raw)
	s := string(out)
	if strings.Contains(s, "ranking_score") || strings.Contains(s, "economics_private") || strings.Contains(s, `"score"`) {
		t.Fatalf("leaked private fields: %s", s)
	}
	if !strings.Contains(s, "FBT") {
		t.Fatalf("stripped public fields: %s", s)
	}
}
