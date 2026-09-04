package payment

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"time"
)

func newPrefixedID(prefix string) string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	binary.BigEndian.PutUint64(b[0:8], ms<<16)
	if _, err := rand.Read(b[6:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return prefix + hex.EncodeToString(b[:])
}

func NewPaymentAttemptID() string { return newPrefixedID("pay_") }
func NewOrderID() string          { return newPrefixedID("ord_") }
func NewOperationID() string      { return newPrefixedID("op_") }
func NewJobID() string            { return newPrefixedID("job_") }
func NewRefundID() string         { return newPrefixedID("rfd_") }
func NewReservationID() string    { return newPrefixedID("rrv_") }
func NewRunnerJobID() string      { return newPrefixedID("rjob_") }
func NewAuditID() string          { return newPrefixedID("aud_") }
func NewEventRowID() string       { return newPrefixedID("pev_") }
func NewReconcileID() string      { return newPrefixedID("prc_") }

func NewExecutorToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func AmountString(minor int64) string {
	return fmt.Sprintf("%d", minor)
}
