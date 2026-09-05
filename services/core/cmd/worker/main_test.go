package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerHealthLiveAndReady(t *testing.T) {
	h := newWorkerHealth(func(context.Context) error { return nil }, time.Second)

	for _, tc := range []struct {
		path string
		code int
	}{
		{path: "/health/live", code: http.StatusOK},
		{path: "/health/ready", code: http.StatusOK},
	} {
		rec := httptest.NewRecorder()
		h.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.code {
			t.Fatalf("%s: got %d, want %d: %s", tc.path, rec.Code, tc.code, rec.Body.String())
		}
	}
}

func TestWorkerHealthReadyRequiresDatabaseAndFreshLoop(t *testing.T) {
	dbErr := errors.New("database unavailable")
	h := newWorkerHealth(func(context.Context) error { return dbErr }, time.Second)

	rec := httptest.NewRecorder()
	h.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("database failure: got %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	h.dbReady = func(context.Context) error { return nil }
	h.lastLoopUnix.Store(time.Now().Add(-2 * time.Second).UnixNano())
	rec = httptest.NewRecorder()
	h.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("stale loop: got %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
