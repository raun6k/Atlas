package ids

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const (
	Session      = "ses"
	Cart         = "cart"
	Line         = "lin"
	Offer        = "off"
	Candidate    = "cand"
	Proposal     = "cpo"
	Payment      = "pay"
	Order        = "ord"
	OrderLine    = "oln"
	Audit        = "aud"
	Operation    = "opr"
	Passport     = "pas"
	Reservation  = "rsv"
	Policy       = "pol"
	Export       = "aex"
	Job          = "job"
	Outbox       = "obx"
	Substitution = "sub"
	SubOption    = "sop"
	SubResponse  = "srp"
	OfferEvent   = "oev"
	Attribution  = "attr"
)

func New(prefix string) string {
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	return prefix + "_" + strings.ReplaceAll(id.String(), "-", "")
}

func HasPrefix(id, prefix string) bool {
	return strings.HasPrefix(id, prefix+"_")
}

func Require(id, prefix string) error {
	if !HasPrefix(id, prefix) {
		return fmt.Errorf("id %q must use prefix %s_", id, prefix)
	}
	return nil
}
