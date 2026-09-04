package platform

import "testing"

func TestRejectLiveMode(t *testing.T) {
	if err := RejectLiveMode("rzp_live_abc"); err == nil {
		t.Fatal("expected live key rejection")
	}
	if err := RejectLiveMode("rzp_test_abc"); err != nil {
		t.Fatal(err)
	}
	if err := RejectLiveMode(""); err != nil {
		t.Fatal(err)
	}
}

func TestEnvironmentMustBeTest(t *testing.T) {
	cfg := Config{Environment: "prod", PostgresURL: "postgres://x"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected unknown environment rejection")
	}
}
