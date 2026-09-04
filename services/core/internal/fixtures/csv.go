package fixtures

import (
	"encoding/csv"
	"encoding/json"
	"os"
	"strconv"
	"strings"
)

func readCSV(path string) ([]map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.TrimLeadingSpace = true
	r.ReuseRecord = false
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	headers := rows[0]
	out := make([]map[string]string, 0, len(rows)-1)
	for _, rec := range rows[1:] {
		m := map[string]string{}
		empty := true
		for i, h := range headers {
			val := ""
			if i < len(rec) {
				val = strings.TrimSpace(rec[i])
			}
			m[h] = val
			if val != "" {
				empty = false
			}
		}
		if empty {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

func csvString(row map[string]string, key string) string {
	return strings.TrimSpace(row[key])
}

func csvBool(row map[string]string, key string, fallback bool) bool {
	v := strings.ToLower(csvString(row, key))
	switch v {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return fallback
	}
}

func csvInt(row map[string]string, key string, fallback int64) int64 {
	v := csvString(row, key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		f, ferr := strconv.ParseFloat(v, 64)
		if ferr != nil {
			return fallback
		}
		return int64(f)
	}
	return n
}

func csvIntPtr(row map[string]string, key string) *int64 {
	v := csvString(row, key)
	if v == "" {
		return nil
	}
	n := csvInt(row, key, 0)
	return &n
}

func csvFloatPtr(row map[string]string, key string) any {
	v := csvString(row, key)
	if v == "" {
		return nil
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return nil
	}
	return f
}

func csvJSON(row map[string]string, key string, empty any) any {
	v := csvString(row, key)
	if v == "" {
		return empty
	}
	var parsed any
	if err := json.Unmarshal([]byte(v), &parsed); err != nil {
		return empty
	}
	return parsed
}

func jsonBytes(v any) []byte {
	if v == nil {
		return []byte("null")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("null")
	}
	return b
}
