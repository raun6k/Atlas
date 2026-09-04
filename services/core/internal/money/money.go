package money

import "fmt"

// Amount is integer minor units plus an ISO 4217 currency. No floating-point.
type Amount struct {
	Minor    int64
	Currency string
}

func INR(minor int64) Amount {
	return Amount{Minor: minor, Currency: "INR"}
}

func (a Amount) Add(b Amount) (Amount, error) {
	if err := a.sameCurrency(b); err != nil {
		return Amount{}, err
	}
	return Amount{Minor: a.Minor + b.Minor, Currency: a.Currency}, nil
}

func (a Amount) Sub(b Amount) (Amount, error) {
	if err := a.sameCurrency(b); err != nil {
		return Amount{}, err
	}
	return Amount{Minor: a.Minor - b.Minor, Currency: a.Currency}, nil
}

func (a Amount) MulInt(n int64) Amount {
	return Amount{Minor: a.Minor * n, Currency: a.Currency}
}

func (a Amount) NonNegative() error {
	if a.Minor < 0 {
		return fmt.Errorf("money amount must be non-negative")
	}
	if a.Currency == "" {
		return fmt.Errorf("money currency is required")
	}
	return nil
}

func (a Amount) sameCurrency(b Amount) error {
	if a.Currency != b.Currency {
		return fmt.Errorf("currency mismatch %s vs %s", a.Currency, b.Currency)
	}
	return nil
}

func (a Amount) String() string {
	return fmt.Sprintf("%d %s", a.Minor, a.Currency)
}
