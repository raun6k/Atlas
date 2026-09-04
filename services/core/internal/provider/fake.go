package provider

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// FakeRazorpay is an in-process Test Mode API. It is not a capture bypass:
// Atlas still has to fetch and bind events. Browser success is not modeled here.
type FakeRazorpay struct {
	Server        *httptest.Server
	KeyID         string
	KeySecret     string
	WebhookSecret string

	mu              sync.Mutex
	orders          map[string]*fakeOrder
	payments        map[string]*fakePayment
	refunds         map[string]*fakeRefund
	seq             atomic.Int64
	FailNextCreate  bool
	FailNextFetch   bool
	FailNextCapture bool
	FailNextRefund  bool
	DropNextCreate  bool // simulate possible submission: accept then lose the response
	acceptedCreates int
}

type fakeOrder struct {
	ID             string
	Amount         int64
	Currency       string
	Status         string
	Receipt        string
	PaymentCapture int
	Notes          map[string]string
	PaymentIDs     []string
}

type fakePayment struct {
	ID       string
	OrderID  string
	Amount   int64
	Currency string
	Status   string
	Captured bool
}

type fakeRefund struct {
	ID             string
	PaymentID      string
	Amount         int64
	Currency       string
	Status         string
	IdempotencyKey string
}

func NewFakeRazorpay() *FakeRazorpay {
	f := &FakeRazorpay{
		KeyID:         "rzp_test_atlas_fabric",
		KeySecret:     "test_key_secret_atlas_fabric",
		WebhookSecret: "test_webhook_secret_atlas_fabric",
		orders:        map[string]*fakeOrder{},
		payments:      map[string]*fakePayment{},
		refunds:       map[string]*fakeRefund{},
	}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *FakeRazorpay) Close() { f.Server.Close() }

func (f *FakeRazorpay) ClientConfig() Config {
	return Config{
		KeyID:         f.KeyID,
		KeySecret:     f.KeySecret,
		WebhookSecret: f.WebhookSecret,
		APIBaseURL:    f.Server.URL,
		CaptureMode:   CaptureModeAutomatic,
	}
}

func (f *FakeRazorpay) nextID(prefix string) string {
	n := f.seq.Add(1)
	return prefix + strconv.FormatInt(n, 10)
}

func (f *FakeRazorpay) serve(w http.ResponseWriter, r *http.Request) {
	user, pass, ok := r.BasicAuth()
	if !ok || user != f.KeyID || pass != f.KeySecret {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/orders":
		f.handleCreateOrder(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/orders/") && strings.HasSuffix(r.URL.Path, "/payments"):
		f.handleListPayments(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/orders/"):
		f.handleGetOrder(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/payments/") && !strings.Contains(r.URL.Path, "/capture") && !strings.Contains(r.URL.Path, "/refund"):
		f.handleGetPayment(w, r)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/capture"):
		f.handleCapture(w, r)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/refund"):
		f.handleCreateRefund(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/refunds/"):
		f.handleGetRefund(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *FakeRazorpay) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	if f.FailNextCreate {
		f.FailNextCreate = false
		http.Error(w, `{"error":"create_failed"}`, http.StatusBadGateway)
		return
	}
	var req struct {
		Amount         int64             `json:"amount"`
		Currency       string            `json:"currency"`
		Receipt        string            `json:"receipt"`
		PaymentCapture int               `json:"payment_capture"`
		Notes          map[string]string `json:"notes"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	id := f.nextID("order_")
	f.orders[id] = &fakeOrder{
		ID: id, Amount: req.Amount, Currency: req.Currency, Status: "created",
		Receipt: req.Receipt, PaymentCapture: req.PaymentCapture, Notes: req.Notes,
	}
	f.acceptedCreates++
	f.mu.Unlock()
	if f.DropNextCreate {
		f.DropNextCreate = false
		w.WriteHeader(http.StatusOK)
		return // empty body simulates lost response after accept
	}
	writeJSON(w, map[string]any{
		"id": id, "amount": req.Amount, "currency": req.Currency, "status": "created", "receipt": req.Receipt, "notes": req.Notes,
	})
}

func (f *FakeRazorpay) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	if f.FailNextFetch {
		f.FailNextFetch = false
		http.Error(w, `{"error":"fetch_failed"}`, http.StatusBadGateway)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/orders/")
	f.mu.Lock()
	o, ok := f.orders[id]
	f.mu.Unlock()
	if !ok {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{"id": o.ID, "amount": o.Amount, "currency": o.Currency, "status": o.Status, "receipt": o.Receipt, "notes": o.Notes})
}

func (f *FakeRazorpay) handleListPayments(w http.ResponseWriter, r *http.Request) {
	if f.FailNextFetch {
		f.FailNextFetch = false
		http.Error(w, `{"error":"fetch_failed"}`, http.StatusBadGateway)
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/payments")
	orderID := strings.TrimPrefix(path, "/v1/orders/")
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.orders[orderID]
	if !ok {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	items := make([]map[string]any, 0, len(o.PaymentIDs))
	for _, pid := range o.PaymentIDs {
		p := f.payments[pid]
		items = append(items, paymentJSON(p))
	}
	writeJSON(w, map[string]any{"items": items})
}

func (f *FakeRazorpay) handleGetPayment(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/payments/")
	f.mu.Lock()
	p, ok := f.payments[id]
	f.mu.Unlock()
	if !ok {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	writeJSON(w, paymentJSON(p))
}

func (f *FakeRazorpay) handleCapture(w http.ResponseWriter, r *http.Request) {
	if f.FailNextCapture {
		f.FailNextCapture = false
		http.Error(w, `{"error":"capture_failed"}`, http.StatusBadGateway)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/payments/"), "/capture")
	var req struct {
		Amount   int64  `json:"amount"`
		Currency string `json:"currency"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	p, ok := f.payments[id]
	if !ok {
		f.mu.Unlock()
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	if p.Status != "authorized" {
		f.mu.Unlock()
		http.Error(w, `{"error":"not_authorized"}`, http.StatusBadRequest)
		return
	}
	if req.Amount != p.Amount || req.Currency != p.Currency {
		f.mu.Unlock()
		http.Error(w, `{"error":"amount_mismatch"}`, http.StatusBadRequest)
		return
	}
	p.Status = "captured"
	p.Captured = true
	if o := f.orders[p.OrderID]; o != nil {
		o.Status = "paid"
	}
	f.mu.Unlock()
	writeJSON(w, paymentJSON(p))
}

func (f *FakeRazorpay) handleCreateRefund(w http.ResponseWriter, r *http.Request) {
	if f.FailNextRefund {
		f.FailNextRefund = false
		http.Error(w, `{"error":"refund_failed"}`, http.StatusBadGateway)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/payments/"), "/refund")
	raw, _ := io.ReadAll(r.Body)
	var req struct {
		Amount int64 `json:"amount"`
	}
	_ = json.Unmarshal(raw, &req)
	idem := r.Header.Get("X-Razorpay-Idempotency")
	f.mu.Lock()
	defer f.mu.Unlock()
	if idem != "" {
		for _, existing := range f.refunds {
			if existing.IdempotencyKey == idem {
				writeJSON(w, refundJSON(existing))
				return
			}
		}
	}
	p, ok := f.payments[id]
	if !ok || !p.Captured {
		http.Error(w, `{"error":"not_captured"}`, http.StatusBadRequest)
		return
	}
	rf := &fakeRefund{
		ID: f.nextID("rfnd_"), PaymentID: p.ID, Amount: req.Amount,
		Currency: p.Currency, Status: "processed", IdempotencyKey: idem,
	}
	f.refunds[rf.ID] = rf
	writeJSON(w, refundJSON(rf))
}

func (f *FakeRazorpay) handleGetRefund(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/refunds/")
	f.mu.Lock()
	rf, ok := f.refunds[id]
	f.mu.Unlock()
	if !ok {
		http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
		return
	}
	writeJSON(w, refundJSON(rf))
}

// SimulateCheckoutCaptured records a captured Test Mode payment on an order.
// This is the provider's state, not an Atlas capture.
func (f *FakeRazorpay) SimulateCheckoutCaptured(orderID, paymentID string) {
	f.simulatePayment(orderID, paymentID, "captured", true)
}

func (f *FakeRazorpay) SimulateCheckoutAuthorized(orderID, paymentID string) {
	f.simulatePayment(orderID, paymentID, "authorized", false)
}

func (f *FakeRazorpay) SimulateCheckoutFailed(orderID, paymentID string) {
	f.simulatePayment(orderID, paymentID, "failed", false)
}

// SimulateMismatchedCapture records a captured payment with a different amount than the order.
func (f *FakeRazorpay) SimulateMismatchedCapture(orderID, paymentID string, amount int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := f.orders[orderID]
	if o == nil {
		return
	}
	if paymentID == "" {
		paymentID = f.nextID("pay_")
	}
	p := &fakePayment{
		ID: paymentID, OrderID: orderID, Amount: amount, Currency: o.Currency,
		Status: "captured", Captured: true,
	}
	f.payments[paymentID] = p
	o.PaymentIDs = append(o.PaymentIDs, paymentID)
}

func (f *FakeRazorpay) simulatePayment(orderID, paymentID, status string, captured bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := f.orders[orderID]
	if o == nil {
		return
	}
	if paymentID == "" {
		paymentID = f.nextID("pay_")
	}
	p := &fakePayment{
		ID: paymentID, OrderID: orderID, Amount: o.Amount, Currency: o.Currency,
		Status: status, Captured: captured,
	}
	f.payments[paymentID] = p
	o.PaymentIDs = append(o.PaymentIDs, paymentID)
	if captured {
		o.Status = "paid"
	} else if status == "failed" {
		o.Status = "attempted"
	} else if status == "authorized" {
		o.Status = "attempted"
	}
}

func (f *FakeRazorpay) CancelOrder(orderID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o := f.orders[orderID]; o != nil {
		o.Status = "cancelled"
	}
}

func (f *FakeRazorpay) SetPaymentStatus(paymentID, status string, captured bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.payments[paymentID]
	if p == nil {
		return
	}
	p.Status = status
	p.Captured = captured
	if captured {
		if o := f.orders[p.OrderID]; o != nil {
			o.Status = "paid"
		}
	}
}

func (f *FakeRazorpay) SetRefundStatus(refundID, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if rf := f.refunds[refundID]; rf != nil {
		rf.Status = status
	}
}

func (f *FakeRazorpay) Order(orderID string) (amount int64, currency string, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := f.orders[orderID]
	if o == nil {
		return 0, "", false
	}
	return o.Amount, o.Currency, true
}

func (f *FakeRazorpay) SignWebhook(rawBody []byte) string {
	mac := hmac.New(sha256.New, []byte(f.WebhookSecret))
	_, _ = mac.Write(rawBody)
	return hex.EncodeToString(mac.Sum(nil))
}

func (f *FakeRazorpay) SignCallback(orderID, paymentID string) string {
	mac := hmac.New(sha256.New, []byte(f.KeySecret))
	_, _ = mac.Write([]byte(orderID + "|" + paymentID))
	return hex.EncodeToString(mac.Sum(nil))
}

func (f *FakeRazorpay) WebhookPayload(event, orderID, paymentID, eventID string, amount int64, currency, status string) []byte {
	payload := map[string]any{
		"event": event,
		"payload": map[string]any{
			"payment": map[string]any{
				"entity": map[string]any{
					"id": paymentID, "order_id": orderID, "amount": amount,
					"currency": currency, "status": status,
				},
			},
			"order": map[string]any{
				"entity": map[string]any{
					"id": orderID, "amount": amount, "currency": currency,
				},
			},
		},
	}
	raw, _ := json.Marshal(payload)
	return raw
}

func paymentJSON(p *fakePayment) map[string]any {
	return map[string]any{
		"id": p.ID, "order_id": p.OrderID, "amount": p.Amount, "currency": p.Currency,
		"status": p.Status, "captured": p.Captured, "method": "netbanking",
	}
}

func refundJSON(r *fakeRefund) map[string]any {
	return map[string]any{
		"id": r.ID, "payment_id": r.PaymentID, "amount": r.Amount,
		"currency": r.Currency, "status": r.Status,
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
