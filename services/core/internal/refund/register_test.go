package refund

import (
	"testing"

	"atlas.dev/core/internal/payment"
	"atlas.dev/core/internal/provider"
)

func TestRegisterExposesRefundJobs(t *testing.T) {
	fake := provider.NewFakeRazorpay()
	t.Cleanup(fake.Close)
	client, err := provider.NewClient(fake.ClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	pay := &payment.Service{Store: payment.NewMemoryStore(), Client: client, Cfg: fake.ClientConfig()}
	mod := Register(pay)
	if len(mod.JobTypes()) != 2 {
		t.Fatalf("got %v", mod.JobTypes())
	}
}
