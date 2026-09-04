package provider

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"
)

// VerifyWebhookHMAC verifies Razorpay's raw-body webhook signature.
// The body must be the exact bytes received; JSON re-encoding is forbidden.
func VerifyWebhookHMAC(rawBody []byte, signature, secret string) error {
	if secret == "" {
		return fmt.Errorf("webhook secret is not configured")
	}
	if signature == "" {
		return fmt.Errorf("missing X-Razorpay-Signature")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(expected)), []byte(strings.ToLower(signature))) != 1 {
		return fmt.Errorf("webhook signature mismatch")
	}
	return nil
}

// VerifyCheckoutCallbackHMAC verifies the Standard Checkout callback:
// HMAC_SHA256(order_id + "|" + razorpay_payment_id, key_secret).
func VerifyCheckoutCallbackHMAC(orderID, paymentID, signature, keySecret string) error {
	if keySecret == "" {
		return fmt.Errorf("key secret is not configured")
	}
	if orderID == "" || paymentID == "" || signature == "" {
		return fmt.Errorf("incomplete checkout callback")
	}
	mac := hmac.New(sha256.New, []byte(keySecret))
	_, _ = mac.Write([]byte(orderID + "|" + paymentID))
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(expected)), []byte(strings.ToLower(signature))) != 1 {
		return fmt.Errorf("checkout callback signature mismatch")
	}
	return nil
}

// BodyDigest returns a hex SHA-256 of the raw webhook body. The raw body is not stored.
func BodyDigest(rawBody []byte) string {
	sum := sha256.Sum256(rawBody)
	return hex.EncodeToString(sum[:])
}
