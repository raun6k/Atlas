package commerce

import "fmt"

func errUnknownStrategy(t string) error {
	return fmt.Errorf("unknown strategy type %q", t)
}

func errExploratoryStrategy(t string) error {
	return fmt.Errorf("strategy %q is exploratory and unavailable", t)
}
