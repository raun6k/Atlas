package search

import "strings"

func NormalizeQuery(q string) string {
	return strings.TrimSpace(q)
}
