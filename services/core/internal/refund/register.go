package refund

import (
	"context"

	"atlas.dev/core/internal/payment"
)

// Service exposes refund use cases. Kernel admin maps POST /admin/v1/commerce/orders/{id}/refunds here.
type Service struct {
	Payments *payment.Service
}

func New(payments *payment.Service) *Service {
	return &Service{Payments: payments}
}

type Module struct {
	Service *Service
}

type Request struct {
	OrderID     string
	AmountMinor int64
	Currency    string
	Reason      string
	OperatorID  string
	RequestID   string
}

type Result struct {
	Code    string
	Message string
}

type kernelHook interface {
	RequestRefund(ctx context.Context, in Request) (Result, error)
}

type kernelNoop struct{}

func (kernelNoop) RequestRefund(context.Context, Request) (Result, error) {
	return Result{Code: "PAYMENT_FABRIC_REQUIRED", Message: "Refund execution is owned by Payment Fabric"}, nil
}

var registered kernelHook = kernelNoop{}

func Current() kernelHook { return registered }

func Register(payments *payment.Service) Module {
	svc := New(payments)
	mod := Module{Service: svc}
	registered = kernelAdapter{svc: svc}
	return mod
}

type kernelAdapter struct{ svc *Service }

func (a kernelAdapter) RequestRefund(ctx context.Context, in Request) (Result, error) {
	res, err := a.svc.RequestRefund(ctx, payment.RequestRefundCommand{
		OrderID: in.OrderID, AmountMinor: in.AmountMinor, ReasonCode: in.Reason, IdempotencyKey: in.RequestID,
	})
	if err != nil {
		return Result{Code: "REFUND_FAILED", Message: err.Error()}, err
	}
	return Result{Code: res.PublicStatus, Message: res.RefundID}, nil
}

func (s *Service) RequestRefund(ctx context.Context, cmd payment.RequestRefundCommand) (payment.RequestRefundResult, error) {
	return s.Payments.RequestRefund(ctx, cmd)
}

func (s *Service) ReconcileRefund(ctx context.Context, refundID string) error {
	return s.Payments.ReconcileRefund(ctx, refundID)
}

func (m Module) JobTypes() []string {
	return []string{payment.JobRequestRefund, payment.JobReconcileRefund}
}
