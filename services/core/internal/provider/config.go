package provider

import (
	"fmt"
	"strings"
)

const (
	CapabilityRazorpayTest = "pcap_razorpay_test"
	DefaultAPIBaseURL      = "https://api.razorpay.com"
	CaptureModeAutomatic   = "automatic"
	CaptureModeManual      = "manual"
)

// Config is Razorpay Test Mode adapter configuration. Secrets stay in process env.
type Config struct {
	KeyID          string
	KeySecret      string
	WebhookSecret  string
	CallbackOrigin string
	CaptureMode    string
	APIBaseURL     string
}

// Validate rejects Live Mode-like keys before any provider call.
func (c Config) Validate() error {
	if strings.HasPrefix(c.KeyID, "rzp_live_") || strings.HasPrefix(c.KeySecret, "rzp_live_") {
		return fmt.Errorf("razorpay live mode configuration is rejected")
	}
	if c.KeyID != "" && !strings.HasPrefix(c.KeyID, "rzp_test_") {
		return fmt.Errorf("razorpay key id must be Test Mode (rzp_test_)")
	}
	if c.CaptureMode != "" && c.CaptureMode != CaptureModeAutomatic && c.CaptureMode != CaptureModeManual {
		return fmt.Errorf("unsupported RAZORPAY_CAPTURE_MODE %q", c.CaptureMode)
	}
	return nil
}

func (c Config) CaptureModeOrDefault() string {
	if c.CaptureMode == "" {
		return CaptureModeAutomatic
	}
	return c.CaptureMode
}

func (c Config) BaseURL() string {
	if c.APIBaseURL == "" {
		return DefaultAPIBaseURL
	}
	return strings.TrimRight(c.APIBaseURL, "/")
}

func (c Config) PaymentCaptureFlag() int {
	if c.CaptureModeOrDefault() == CaptureModeManual {
		return 0
	}
	return 1
}
