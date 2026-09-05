package jobs

import (
	"strings"
	"time"
)

const (
	StatusRequested      = "REQUESTED"
	StatusQueued         = "QUEUED"
	StatusPending        = "PENDING"
	StatusClaimed        = "CLAIMED"
	StatusRunning        = "RUNNING"
	StatusWaitingProvider = "WAITING_PROVIDER"
	StatusCompleted      = "COMPLETED"
	StatusFailed         = "FAILED"
	StatusCancelled      = "CANCELLED"
	StatusNotRetryable   = "NOT_RETRYABLE"
)

func PublicStatus(dbStatus string) string {
	switch dbStatus {
	case StatusPending:
		return StatusQueued
	case StatusRequested:
		return StatusRequested
	case "":
		return StatusRequested
	default:
		return dbStatus
	}
}

func ErrorClass(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "timeout"):
		return "TIMEOUT"
	case strings.Contains(m, "forbidden"), strings.Contains(m, "unauth"), strings.Contains(m, "denied"):
		return "AUTHORIZATION"
	case strings.Contains(m, "provider"), strings.Contains(m, "razorpay"), strings.Contains(m, "fetch"):
		return "PROVIDER"
	case strings.Contains(m, "sql"), strings.Contains(m, "postgres"):
		return "INTERNAL"
	default:
		return "INTERNAL"
	}
}

func NextRetry(attempts int, now time.Time) time.Time {
	d := time.Duration(attempts) * 5 * time.Second
	if d > 2*time.Minute {
		d = 2 * time.Minute
	}
	if d < 5*time.Second {
		d = 5 * time.Second
	}
	return now.Add(d)
}
