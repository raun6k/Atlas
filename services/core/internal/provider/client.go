package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to Razorpay Test Mode over HTTP. It never treats browser events as truth.
type Client struct {
	cfg  Config
	http *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Client{
		cfg: cfg,
		http: &http.Client{
			Timeout: 15 * time.Second,
		},
	}, nil
}

func (c *Client) Config() Config { return c.cfg }

func (c *Client) CreateOrder(ctx context.Context, req CreateOrderRequest) (Order, error) {
	if err := c.cfg.Validate(); err != nil {
		return Order{}, err
	}
	body := map[string]any{
		"amount":          req.AmountMinor,
		"currency":        req.Currency,
		"receipt":         req.Receipt,
		"payment_capture": req.PaymentCapture,
	}
	if req.Notes != nil {
		body["notes"] = req.Notes
	}
	var out rzpOrder
	if err := c.do(ctx, http.MethodPost, "/v1/orders", body, req.IdempotencyKey, &out); err != nil {
		return Order{}, err
	}
	order := out.toOrder()
	if order.ID == "" {
		return Order{}, &AmbiguousResponse{Op: "CreateOrder", Detail: "missing provider order id"}
	}
	return order, nil
}

func (c *Client) FetchOrder(ctx context.Context, orderID string) (Order, error) {
	var out rzpOrder
	if err := c.do(ctx, http.MethodGet, "/v1/orders/"+orderID, nil, "", &out); err != nil {
		return Order{}, err
	}
	return out.toOrder(), nil
}

func (c *Client) FetchOrderPayments(ctx context.Context, orderID string) ([]Payment, error) {
	var out rzpPaymentList
	if err := c.do(ctx, http.MethodGet, "/v1/orders/"+orderID+"/payments", nil, "", &out); err != nil {
		return nil, err
	}
	payments := make([]Payment, 0, len(out.Items))
	for _, item := range out.Items {
		payments = append(payments, item.toPayment())
	}
	return payments, nil
}

func (c *Client) FetchPayment(ctx context.Context, paymentID string) (Payment, error) {
	var out rzpPayment
	if err := c.do(ctx, http.MethodGet, "/v1/payments/"+paymentID, nil, "", &out); err != nil {
		return Payment{}, err
	}
	return out.toPayment(), nil
}

func (c *Client) CapturePayment(ctx context.Context, req CaptureRequest) (Payment, error) {
	if err := c.cfg.Validate(); err != nil {
		return Payment{}, err
	}
	body := map[string]any{
		"amount":   req.AmountMinor,
		"currency": req.Currency,
	}
	var out rzpPayment
	if err := c.do(ctx, http.MethodPost, "/v1/payments/"+req.PaymentID+"/capture", body, req.IdempotencyKey, &out); err != nil {
		return Payment{}, err
	}
	p := out.toPayment()
	if p.ID == "" {
		return Payment{}, &AmbiguousResponse{Op: "CapturePayment", Detail: "missing provider payment id"}
	}
	return p, nil
}

func (c *Client) CreateRefund(ctx context.Context, req CreateRefundRequest) (Refund, error) {
	if err := c.cfg.Validate(); err != nil {
		return Refund{}, err
	}
	body := map[string]any{
		"amount": req.AmountMinor,
	}
	if req.Notes != nil {
		body["notes"] = req.Notes
	}
	var out rzpRefund
	if err := c.do(ctx, http.MethodPost, "/v1/payments/"+req.PaymentID+"/refund", body, req.IdempotencyKey, &out); err != nil {
		return Refund{}, err
	}
	return out.toRefund(), nil
}

func (c *Client) FetchRefund(ctx context.Context, refundID string) (Refund, error) {
	var out rzpRefund
	if err := c.do(ctx, http.MethodGet, "/v1/refunds/"+refundID, nil, "", &out); err != nil {
		return Refund{}, err
	}
	return out.toRefund(), nil
}

func (c *Client) do(ctx context.Context, method, path string, body any, idempotencyKey string, dest any) error {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(raw)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL()+path, rdr)
	if err != nil {
		return err
	}
	httpReq.SetBasicAuth(c.cfg.KeyID, c.cfg.KeySecret)
	if body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		httpReq.Header.Set("X-Razorpay-Idempotency", idempotencyKey)
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("provider transport: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return &APIError{Status: resp.StatusCode, Body: string(respBody)}
	}
	if dest == nil {
		return nil
	}
	if len(respBody) == 0 {
		return &AmbiguousResponse{Op: method + " " + path, Detail: "empty successful body"}
	}
	if err := json.Unmarshal(respBody, dest); err != nil {
		return &AmbiguousResponse{Op: method + " " + path, Detail: "malformed json: " + err.Error()}
	}
	return nil
}

// APIError is a Razorpay HTTP error. Callers must not treat it as capture.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("razorpay api status %d", e.Status)
}

// AmbiguousResponse is a 2xx with empty or unusable body. Possible provider submission.
type AmbiguousResponse struct {
	Op     string
	Detail string
}

func (e *AmbiguousResponse) Error() string {
	return fmt.Sprintf("provider response ambiguous %s: %s", e.Op, e.Detail)
}

func IsAmbiguous(err error) bool {
	_, ok := err.(*AmbiguousResponse)
	return ok
}

type rzpOrder struct {
	ID       string            `json:"id"`
	Amount   int64             `json:"amount"`
	Currency string            `json:"currency"`
	Status   string            `json:"status"`
	Receipt  string            `json:"receipt"`
	Notes    map[string]string `json:"notes"`
}

func (o rzpOrder) toOrder() Order {
	return Order{ID: o.ID, Amount: o.Amount, Currency: o.Currency, Status: o.Status, Receipt: o.Receipt, Notes: o.Notes}
}

type rzpPayment struct {
	ID       string `json:"id"`
	OrderID  string `json:"order_id"`
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
	Status   string `json:"status"`
	Captured bool   `json:"captured"`
	Method   string `json:"method"`
}

func (p rzpPayment) toPayment() Payment {
	captured := p.Captured || p.Status == "captured"
	return Payment{
		ID: p.ID, OrderID: p.OrderID, Amount: p.Amount, Currency: p.Currency,
		Status: p.Status, Captured: captured, Method: p.Method,
	}
}

type rzpPaymentList struct {
	Items []rzpPayment `json:"items"`
}

type rzpRefund struct {
	ID        string `json:"id"`
	PaymentID string `json:"payment_id"`
	Amount    int64  `json:"amount"`
	Currency  string `json:"currency"`
	Status    string `json:"status"`
}

func (r rzpRefund) toRefund() Refund {
	return Refund{ID: r.ID, PaymentID: r.PaymentID, Amount: r.Amount, Currency: r.Currency, Status: r.Status}
}
