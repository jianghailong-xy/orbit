package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func setTestVersion(t *testing.T, v string) {
	t.Helper()
	old := version
	version = v
	t.Cleanup(func() { version = old })
}

// setTestInstallable pins whether an update is considered swappable, so these
// tests do not depend on where the test binary happens to live.
func setTestInstallable(t *testing.T, dir string, ok bool) {
	t.Helper()
	old := selfUpdateInstallable
	selfUpdateInstallable = func() (string, bool) { return dir, ok }
	t.Cleanup(func() { selfUpdateInstallable = old })
}

func TestAvailableSelfUpdate(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.80")
	setTestInstallable(t, "/usr/local/bin", true)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dl/version.json" {
			t.Errorf("path = %q, want /dl/version.json", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"version":"0.1.81"}`))
	}))
	defer srv.Close()

	got, ok := availableSelfUpdate(context.Background(), srv.URL+"/")
	if !ok || got != "0.1.81" {
		t.Fatalf("availableSelfUpdate = %q, %v; want 0.1.81, true", got, ok)
	}
}

// A runner whose binary sits in a root-owned directory can never swap itself.
// Reporting the release anyway made runLoop drain and re-exec every check
// interval, tearing live sessions down mid-turn forever at an unchanged version.
func TestAvailableSelfUpdateSkipsUninstallableRelease(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.86")
	setTestInstallable(t, "/usr/local/bin", false)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.1.96"}`))
	}))
	defer srv.Close()

	if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; want no drain for an uninstallable release", got, ok)
	}
}

func TestAvailableSelfUpdateIgnoresCurrentAndOlderVersions(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.80")
	t.Setenv("ORBIT_NO_SELFUPDATE", "")

	for _, remote := range []string{"0.1.80", "0.1.79"} {
		t.Run(remote, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"version":"` + remote + `"}`))
			}))
			defer srv.Close()
			if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
				t.Fatalf("availableSelfUpdate = %q, %v; want no update", got, ok)
			}
		})
	}
}

func TestAvailableSelfUpdateDisabledDoesNotFetch(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"version":"99.0.0"}`))
	}))
	defer srv.Close()

	t.Run("environment", func(t *testing.T) {
		setTestVersion(t, "0.1.80")
		t.Setenv("ORBIT_NO_SELFUPDATE", "1")
		if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
			t.Fatalf("availableSelfUpdate = %q, %v; want disabled", got, ok)
		}
	})
	t.Run("dev build", func(t *testing.T) {
		setTestVersion(t, "dev")
		t.Setenv("ORBIT_NO_SELFUPDATE", "")
		if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
			t.Fatalf("availableSelfUpdate = %q, %v; want disabled", got, ok)
		}
	})
	if got := requests.Load(); got != 0 {
		t.Fatalf("disabled self-update made %d request(s), want 0", got)
	}
}
