package provider

import (
	"context"
	"testing"
)

func TestValidateRejectsLiveMode(t *testing.T) {
	err := Config{KeyID: "rzp_live_abc"}.Validate()
	if err == nil {
		t.Fatal("expected live mode rejection")
	}
	err = Config{KeySecret: "rzp_live_secret"}.Validate()
	if err == nil {
		t.Fatal("expected live secret rejection")
	}
	if err := (Config{KeyID: "rzp_test_ok"}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookHMAC(t *testing.T) {
	secret := "whsec"
	body := []byte(`{"event":"payment.captured"}`)
	f := FakeRazorpay{WebhookSecret: secret}
	sig := f.SignWebhook(body)
	if err := VerifyWebhookHMAC(body, sig, secret); err != nil {
		t.Fatal(err)
	}
	if err := VerifyWebhookHMAC(body, sig, "other"); err == nil {
		t.Fatal("expected mismatch")
	}
	tampered := []byte(`{"event":"payment.captured","x":1}`)
	if err := VerifyWebhookHMAC(tampered, sig, secret); err == nil {
		t.Fatal("expected mismatch on re-encoded body")
	}
}

func TestCallbackHMAC(t *testing.T) {
	secret := "keysec"
	f := FakeRazorpay{KeySecret: secret}
	sig := f.SignCallback("order_1", "pay_1")
	if err := VerifyCheckoutCallbackHMAC("order_1", "pay_1", sig, secret); err != nil {
		t.Fatal(err)
	}
	if err := VerifyCheckoutCallbackHMAC("order_1", "pay_1", "deadbeef", secret); err == nil {
		t.Fatal("expected mismatch")
	}
}

func TestCreateOrderExactAmount(t *testing.T) {
	fake := NewFakeRazorpay()
	defer fake.Close()
	client, err := NewClient(fake.ClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	order, err := client.CreateOrder(context.Background(), CreateOrderRequest{
		AmountMinor: 24900, Currency: "INR", Receipt: "cpo_test", PaymentCapture: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if order.Amount != 24900 || order.Currency != "INR" {
		t.Fatalf("got %+v", order)
	}
	fetched, err := client.FetchOrder(context.Background(), order.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.Amount != 24900 {
		t.Fatalf("fetch mismatch %+v", fetched)
	}
}

func TestLiveModeRejectedBeforeCall(t *testing.T) {
	_, err := NewClient(Config{KeyID: "rzp_live_nope", KeySecret: "x", APIBaseURL: "http://127.0.0.1:1"})
	if err == nil {
		t.Fatal("expected constructor rejection")
	}
}
