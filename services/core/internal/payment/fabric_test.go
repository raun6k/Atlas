package payment

import (
	"context"
	"sync"
	"testing"

	"atlas.dev/core/internal/provider"
)

type harness struct {
	t     *testing.T
	fake  *provider.FakeRazorpay
	store *MemoryStore
	svc   *Service
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	fake := provider.NewFakeRazorpay()
	t.Cleanup(fake.Close)
	client, err := provider.NewClient(fake.ClientConfig())
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemoryStore()
	svc := &Service{Store: store, Client: client, Cfg: fake.ClientConfig()}
	return &harness{t: t, fake: fake, store: store, svc: svc}
}

func (h *harness) complete(scenario string) CompleteCheckoutResult {
	h.t.Helper()
	res, err := h.svc.CompleteCheckout(context.Background(), CompleteCheckoutCommand{
		HostID: "host_atlaslab", IdempotencyKey: "idem-" + scenario + "-" + NewOperationID(),
		CheckoutProposalID: "cpo_" + scenario, SessionID: "ses_test", LocationID: "loc_test",
		ExecutionPassportID: "xpass_test", QuoteHash: "qh_test", AmountMinor: 24900, Currency: "INR",
		CapabilityID: CapabilityRazorpayTest, Scenario: scenario,
		Lines: []OrderLine{{SKUId: "sku_atta_5kg", Quantity: 1, AmountMinor: 24900, Currency: "INR"}},
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return res
}

func (h *harness) drain() {
	h.t.Helper()
	if err := h.svc.DrainJobs(context.Background()); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) attempt(id string) PaymentAttempt {
	h.t.Helper()
	a, err := h.svc.loadAttempt(context.Background(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return a
}

func (h *harness) order(id string) MerchantOrder {
	h.t.Helper()
	o, _, _, err := h.svc.GetOrder(context.Background(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return o
}

func (h *harness) webhook(event, orderID, paymentID, eventID, status string, amount int64) error {
	body := h.fake.WebhookPayload(event, orderID, paymentID, eventID, amount, "INR", status)
	return h.svc.IngestWebhook(context.Background(), WebhookIngest{
		RawBody: body, Signature: h.fake.SignWebhook(body), EventID: eventID,
	})
}

func (h *harness) callback(orderID, paymentID string) error {
	return h.svc.IngestCallback(context.Background(), CallbackIngest{
		RazorpayOrderID: orderID, RazorpayPaymentID: paymentID,
		Signature: h.fake.SignCallback(orderID, paymentID),
	})
}

func TestCreateProviderOrderExactAmount(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	if a.RazorpayOrderID == "" {
		t.Fatal("expected razorpay order")
	}
	amt, cur, ok := h.fake.Order(a.RazorpayOrderID)
	if !ok || amt != 24900 || cur != "INR" {
		t.Fatalf("provider order mismatch %d %s", amt, cur)
	}
	if a.State != StateRunnerQueued && a.State != StateCheckoutInProgress {
		t.Fatalf("state %s", a.State)
	}
}

func TestWebhookSignatureAndDuplicateEventID(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_abc")

	body := h.fake.WebhookPayload("payment.captured", a.RazorpayOrderID, "pay_abc", "evt_1", 24900, "INR", "captured")
	if err := h.svc.IngestWebhook(context.Background(), WebhookIngest{RawBody: body, Signature: "deadbeef", EventID: "evt_1"}); err == nil || !Is(err, ErrInvalidSignature.Code) {
		t.Fatalf("expected invalid signature, got %v", err)
	}
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_abc", "evt_1", "captured", 24900); err != nil {
		t.Fatal(err)
	}
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_abc", "evt_1", "captured", 24900); err == nil || !Is(err, ErrDuplicateEvent.Code) {
		t.Fatalf("expected duplicate, got %v", err)
	}
}

func TestBrowserSuccessIsNotCapture(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	job, err := h.svc.ClaimRunnerJob(context.Background(), "executor")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RecordRunnerObservation(context.Background(), RunnerObservation{
		JobID: job.JobID, ExecutorToken: job.ExecutorToken, ObservedScreen: "success_screen",
	}); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	if a.State == StateCapturedReconciled {
		t.Fatal("browser success must not capture")
	}
	o := h.order(res.MerchantOrderID)
	if o.State == OrderConfirmed {
		t.Fatal("browser success must not confirm order")
	}
}

func TestCapturedReconciledRequiresFetchAndBinding(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_ok")
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_ok", "evt_ok", "captured", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a = h.attempt(res.PaymentAttemptID)
	if a.State != StateCapturedReconciled {
		t.Fatalf("state %s", a.State)
	}
	o := h.order(res.MerchantOrderID)
	if o.State != OrderConfirmed || o.CapturedRazorpayPaymentID != "pay_ok" {
		t.Fatalf("order %+v", o)
	}
	var converted bool
	_ = h.store.RunInTx(context.Background(), func(tx Tx) error {
		converted = tx.HoldConverted(a.CheckoutProposalID)
		return nil
	})
	if !converted {
		t.Fatal("expected reservation convert in the confirm transaction")
	}
	kinds := auditKindSet(h, res.PaymentAttemptID)
	if !kinds["PROVIDER_EVIDENCE_EVALUATED"] || !kinds["ASYNC_DECISION_APPLIED"] {
		t.Fatalf("expected evidence and async audit, got %v", kinds)
	}
}

func TestFetchCapturedWithoutBindingStaysNonTerminal(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_nobind")
	if err := h.svc.ReconcilePayment(context.Background(), a.PaymentAttemptID); err != nil {
		t.Fatal(err)
	}
	a = h.attempt(res.PaymentAttemptID)
	if a.State == StateCapturedReconciled {
		t.Fatal("fetch without event binding must not confirm")
	}
}

func TestCallbackLossWebhookPresent(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_cb_loss")
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_cb_loss", "evt_cb_loss", "captured", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateCapturedReconciled {
		t.Fatal("webhook binding + fetch should confirm without callback")
	}
}

func TestWebhookLossCallbackPresent(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_wh_loss")
	if err := h.callback(a.RazorpayOrderID, "pay_wh_loss"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateCapturedReconciled {
		t.Fatal("callback binding + fetch should confirm without webhook")
	}
}

func TestFailedVerified(t *testing.T) {
	h := newHarness(t)
	res := h.complete("failure")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutFailed(a.RazorpayOrderID, "pay_fail")
	if err := h.webhook("payment.failed", a.RazorpayOrderID, "pay_fail", "evt_fail", "failed", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a = h.attempt(res.PaymentAttemptID)
	if a.State != StateFailedVerified {
		t.Fatalf("state %s", a.State)
	}
	if h.order(res.MerchantOrderID).State != OrderPaymentFailed {
		t.Fatal("expected PAYMENT_FAILED")
	}
}

func TestFetchMismatchDoesNotConfirm(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateMismatchedCapture(a.RazorpayOrderID, "pay_mis", 1)
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_mis", "evt_mis", "captured", 1); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a = h.attempt(res.PaymentAttemptID)
	if a.State == StateCapturedReconciled {
		t.Fatal("provider fetch amount mismatch must not confirm")
	}
	o := h.order(res.MerchantOrderID)
	if o.State == OrderConfirmed {
		t.Fatal("mismatched capture must not confirm merchant order")
	}
}

func TestAuthorizedOnlyDoesNotFulfill(t *testing.T) {
	h := newHarness(t)
	h.svc.Cfg.CaptureMode = provider.CaptureModeManual
	res := h.complete("authorized")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutAuthorized(a.RazorpayOrderID, "pay_auth")
	if err := h.callback(a.RazorpayOrderID, "pay_auth"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a = h.attempt(res.PaymentAttemptID)
	if a.State == StateCapturedReconciled {
		t.Fatal("authorized-only must not confirm")
	}
	if !a.FulfillmentFrozen {
		t.Fatal("fulfillment must stay frozen")
	}
	if h.order(res.MerchantOrderID).State == OrderConfirmed {
		t.Fatal("authorized-only must not confirm merchant order")
	}
}

func TestCaptureAuthorizedThenReconcile(t *testing.T) {
	h := newHarness(t)
	h.svc.Cfg.CaptureMode = provider.CaptureModeManual
	client, err := provider.NewClient(h.svc.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	h.svc.Client = client
	res := h.complete("authorized")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutAuthorized(a.RazorpayOrderID, "pay_auth2")
	if err := h.callback(a.RazorpayOrderID, "pay_auth2"); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.CaptureAuthorizedPayment(context.Background(), a.PaymentAttemptID, "pay_auth2"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateCapturedReconciled {
		t.Fatalf("state %s", h.attempt(res.PaymentAttemptID).State)
	}
}

func TestDuplicateAndOutOfOrderWebhooks(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_oo")
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_oo", "evt_later", "captured", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if err := h.webhook("payment.authorized", a.RazorpayOrderID, "pay_oo", "evt_earlier", "authorized", 24900); err != nil {
		t.Fatal(err)
	}
	if h.attempt(res.PaymentAttemptID).State != StateCapturedReconciled {
		t.Fatal("out-of-order authorized after captured must not move backward")
	}
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_oo", "evt_later", "captured", 24900); !Is(err, ErrDuplicateEvent.Code) {
		t.Fatalf("duplicate event id: %v", err)
	}
}

func TestOutcomeUnknownThenRecoverCaptured(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	job, err := h.svc.ClaimRunnerJob(context.Background(), "executor")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RecordRunnerObservation(context.Background(), RunnerObservation{
		JobID: job.JobID, ExecutorToken: job.ExecutorToken, ObservedScreen: "timeout",
	}); err != nil {
		t.Fatal(err)
	}
	a := h.attempt(res.PaymentAttemptID)
	if a.State != StateOutcomeUnknown || !a.DuplicateFrozen || !a.FulfillmentFrozen || !a.HoldReleaseFrozen {
		t.Fatalf("expected freeze, got %+v", a)
	}
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_unk")
	if err := h.webhook("payment.captured", a.RazorpayOrderID, "pay_unk", "evt_unk", "captured", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	a = h.attempt(res.PaymentAttemptID)
	if a.State != StateCapturedReconciled {
		t.Fatalf("expected recover to captured, got %s", a.State)
	}
	if a.DuplicateFrozen {
		t.Fatal("freeze should lift after terminal success")
	}
}

func TestOutcomeUnknownThenRecoverFailed(t *testing.T) {
	h := newHarness(t)
	res := h.complete("failure")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	_ = h.store.RunInTx(context.Background(), func(tx Tx) error {
		return h.svc.applyUnknown(tx, a, ReasonPossibleSubmission)
	})
	a = h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutFailed(a.RazorpayOrderID, "pay_unkf")
	if err := h.webhook("payment.failed", a.RazorpayOrderID, "pay_unkf", "evt_unkf", "failed", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateFailedVerified {
		t.Fatalf("got %s", h.attempt(res.PaymentAttemptID).State)
	}
}

func TestRefundRemainingBalanceAndIdempotency(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_rf")
	if err := h.callback(a.RazorpayOrderID, "pay_rf"); err != nil {
		t.Fatal(err)
	}
	h.drain()
	rf, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
		OrderID: res.MerchantOrderID, AmountMinor: 10000, ReasonCode: "TEST", IdempotencyKey: "rf-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	h.drain()
	replay, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
		OrderID: res.MerchantOrderID, AmountMinor: 10000, ReasonCode: "TEST", IdempotencyKey: "rf-1",
	})
	if err != nil || replay.RefundID != rf.RefundID {
		t.Fatalf("idempotent replay %v %+v", err, replay)
	}
	if _, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
		OrderID: res.MerchantOrderID, AmountMinor: 20000, ReasonCode: "TEST", IdempotencyKey: "rf-1",
	}); !Is(err, ErrIdempotencyConflict.Code) {
		t.Fatalf("expected conflict, got %v", err)
	}
	second, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
		OrderID: res.MerchantOrderID, AmountMinor: 14900, ReasonCode: "TEST", IdempotencyKey: "rf-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	h.drain()
	if _, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
		OrderID: res.MerchantOrderID, AmountMinor: 1, ReasonCode: "TEST", IdempotencyKey: "rf-3",
	}); !Is(err, ErrReservationInsufficient.Code) {
		t.Fatalf("expected remaining-balance rejection, got %v", err)
	}
	_ = second
}

func TestConcurrentPartialRefunds(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.SimulateCheckoutCaptured(a.RazorpayOrderID, "pay_conc")
	if err := h.callback(a.RazorpayOrderID, "pay_conc"); err != nil {
		t.Fatal(err)
	}
	h.drain()

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := h.svc.RequestRefund(context.Background(), RequestRefundCommand{
				OrderID: res.MerchantOrderID, AmountMinor: 24900, ReasonCode: "TEST",
				IdempotencyKey: "conc-" + string(rune('a'+i)),
			})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	ok, fail := 0, 0
	for err := range errs {
		if err == nil {
			ok++
		} else {
			fail++
		}
	}
	if ok != 1 || fail != 1 {
		t.Fatalf("expected one winner one loser, ok=%d fail=%d", ok, fail)
	}
}

func TestLiveModeRejectedOnComplete(t *testing.T) {
	h := newHarness(t)
	h.svc.Cfg.KeyID = "rzp_live_nope"
	_, err := h.svc.CompleteCheckout(context.Background(), CompleteCheckoutCommand{
		HostID: "h", IdempotencyKey: "k", CheckoutProposalID: "cpo_x", AmountMinor: 1, Currency: "INR",
		CapabilityID: CapabilityRazorpayTest,
	})
	if err == nil {
		t.Fatal("expected live mode rejection")
	}
}

func TestIdempotentCompleteCheckout(t *testing.T) {
	h := newHarness(t)
	cmd := CompleteCheckoutCommand{
		HostID: "host_atlaslab", IdempotencyKey: "same", CheckoutProposalID: "cpo_id",
		SessionID: "ses", LocationID: "loc", ExecutionPassportID: "xp", QuoteHash: "qh",
		AmountMinor: 100, Currency: "INR", CapabilityID: CapabilityRazorpayTest,
	}
	a, err := h.svc.CompleteCheckout(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.svc.CompleteCheckout(context.Background(), cmd)
	if err != nil || a.PaymentAttemptID != b.PaymentAttemptID {
		t.Fatalf("replay %v %+v %+v", err, a, b)
	}
	cmd.AmountMinor = 200
	if _, err := h.svc.CompleteCheckout(context.Background(), cmd); !Is(err, ErrIdempotencyConflict.Code) {
		t.Fatalf("expected conflict got %v", err)
	}
}

func TestCancelledVerified(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	h.fake.CancelOrder(a.RazorpayOrderID)
	if err := h.webhook("order.paid", a.RazorpayOrderID, "", "evt_cancel", "cancelled", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateCancelledVerified {
		t.Fatalf("got %s", h.attempt(res.PaymentAttemptID).State)
	}
}

func TestOutcomeUnknownThenRecoverCancelled(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	_ = h.store.RunInTx(context.Background(), func(tx Tx) error {
		return h.svc.applyUnknown(tx, a, ReasonPossibleSubmission)
	})
	h.fake.CancelOrder(a.RazorpayOrderID)
	if err := h.webhook("order.paid", a.RazorpayOrderID, "", "evt_unkc", "cancelled", 24900); err != nil {
		t.Fatal(err)
	}
	h.drain()
	if h.attempt(res.PaymentAttemptID).State != StateCancelledVerified {
		t.Fatalf("got %s", h.attempt(res.PaymentAttemptID).State)
	}
}

func TestOutcomeUnknownWritesAsyncDecision(t *testing.T) {
	h := newHarness(t)
	res := h.complete("success")
	h.drain()
	a := h.attempt(res.PaymentAttemptID)
	_ = h.store.RunInTx(context.Background(), func(tx Tx) error {
		return h.svc.applyUnknown(tx, a, ReasonPossibleSubmission)
	})
	kinds := auditKindSet(h, res.PaymentAttemptID)
	if !kinds["OUTCOME_UNKNOWN"] || !kinds["ASYNC_DECISION_APPLIED"] {
		t.Fatalf("expected unknown + async, got %v", kinds)
	}
}

func auditKindSet(h *harness, attemptID string) map[string]bool {
	h.t.Helper()
	kinds := map[string]bool{}
	_ = h.store.RunInTx(context.Background(), func(tx Tx) error {
		for _, e := range tx.ListAudit(attemptID) {
			kinds[e.Kind] = true
		}
		return nil
	})
	return kinds
}

func TestRegisterHook(t *testing.T) {
	h := newHarness(t)
	mod := Register(h.svc)
	if len(mod.JobTypes()) != 6 {
		t.Fatalf("expected 6 job types, got %d", len(mod.JobTypes()))
	}
}
