package payment

import "context"

const (
	JobCreateProviderOrderName      = JobCreateProviderOrder
	JobRunTestCheckoutName          = JobRunTestCheckout
	JobReconcilePaymentName         = JobReconcilePayment
	JobCaptureAuthorizedPaymentName = JobCaptureAuthorizedPayment
	JobRequestRefundName            = JobRequestRefund
	JobReconcileRefundName          = JobReconcileRefund
)

// HandleJob dispatches one durable money job. Worker must not invent a second state machine.
func (s *Service) HandleJob(ctx context.Context, job WorkerJob) error {
	switch job.Type {
	case JobCreateProviderOrder:
		return s.HandleCreateProviderOrder(ctx, job)
	case JobRunTestCheckout:
		return s.HandleRunTestCheckout(ctx, job)
	case JobReconcilePayment:
		return s.ReconcilePayment(ctx, payloadString(job.PayloadJSON, "payment_attempt_id"))
	case JobCaptureAuthorizedPayment:
		return s.CaptureAuthorizedPayment(ctx,
			payloadString(job.PayloadJSON, "payment_attempt_id"),
			payloadString(job.PayloadJSON, "razorpay_payment_id"),
		)
	case JobRequestRefund:
		return s.HandleRequestRefund(ctx, payloadString(job.PayloadJSON, "refund_id"))
	case JobReconcileRefund:
		return s.ReconcileRefund(ctx, payloadString(job.PayloadJSON, "refund_id"))
	default:
		return Err("UNKNOWN_JOB_TYPE", job.Type)
	}
}

func (s *Service) HandleRunTestCheckout(ctx context.Context, job WorkerJob) error {
	attemptID := payloadString(job.PayloadJSON, "payment_attempt_id")
	return s.Store.RunInTx(ctx, func(tx Tx) error {
		a, ok := tx.GetAttemptByID(attemptID)
		if !ok {
			return Err("NOT_FOUND", "payment attempt not found")
		}
		if a.State.Terminal() || a.State == StateOutcomeUnknown || a.State == StateCheckoutInProgress || a.State == StateProviderSubmitted || a.State == StateReconciling {
			return nil
		}
		if a.State == StateRunnerQueued || a.State == StateProviderOrderCreated {
			a.State = StateCheckoutInProgress
			return tx.UpdateAttempt(a)
		}
		return nil
	})
}

// DrainJobs claims and runs pending payment/refund jobs. Tests use this in place of the Kernel worker.
func (s *Service) DrainJobs(ctx context.Context) error {
	types := []string{
		JobCreateProviderOrder, JobRunTestCheckout, JobReconcilePayment,
		JobCaptureAuthorizedPayment, JobRequestRefund, JobReconcileRefund,
	}
	for round := 0; round < 16; round++ {
		progressed := false
		for _, typ := range types {
			var jobs []WorkerJob
			_ = s.Store.RunInTx(ctx, func(tx Tx) error {
				jobs = tx.ClaimJobs(typ, 32)
				return nil
			})
			for _, j := range jobs {
				if err := s.HandleJob(ctx, j); err != nil {
					return err
				}
				_ = s.Store.RunInTx(ctx, func(tx Tx) error {
					return tx.CompleteJob(j.JobID)
				})
				progressed = true
			}
		}
		if !progressed {
			return nil
		}
	}
	return nil
}

// Module is the Register hook Kernel stitches into cmd/core and cmd/worker (ID-003 / ID-202).
type Module struct {
	Service *Service
}

func (m Module) JobTypes() []string {
	return []string{
		JobCreateProviderOrder, JobRunTestCheckout, JobReconcilePayment,
		JobCaptureAuthorizedPayment, JobRequestRefund, JobReconcileRefund,
	}
}

func (m Module) HandleJob(ctx context.Context, jobType string, payload []byte) error {
	return m.Service.HandleJob(ctx, WorkerJob{Type: jobType, PayloadJSON: payload})
}

type Deps struct {
	Store  Store
	Client *Service
}

// Register is the only Core process hook this vertical adds.
// Kernel cmd/core and cmd/worker call:
//
//	payMod := payment.Register(payment.RegisterDeps{Service: svc})
//
// Join stitches those imports. This vertical does not own main.go.
func Register(svc *Service) Module {
	SetCurrent(serviceHook{svc})
	return Module{Service: svc}
}
