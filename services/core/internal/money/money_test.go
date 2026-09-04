package money

import "testing"

func TestNoFloat(t *testing.T) {
	a := INR(13200)
	b := INR(3500)
	got, err := a.Add(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.Minor != 16700 || got.Currency != "INR" {
		t.Fatalf("got %+v", got)
	}
	if _, err := a.Add(Amount{Minor: 1, Currency: "USD"}); err == nil {
		t.Fatal("expected currency mismatch")
	}
}
