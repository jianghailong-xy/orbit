package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func useTempOrbitHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if runtime.GOOS != "windows" {
		if err := os.Chmod(home, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("ORBIT_HOME", home)
	return home
}

func TestOrchestrationCredentialStorageIsPrivateAndAtomic(t *testing.T) {
	home := useTempOrbitHome(t)
	if err := storeOrchestrationCredential("session-1", "first-token"); err != nil {
		t.Fatal(err)
	}

	dirInfo, err := os.Lstat(filepath.Join(home, orchestrationCredentialsDirName))
	if err != nil {
		t.Fatal(err)
	}
	path, err := orchestrationCredentialPath("session-1")
	if err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if got := dirInfo.Mode().Perm(); got != 0o700 {
			t.Fatalf("credential directory mode = %04o, want 0700", got)
		}
		if got := fileInfo.Mode().Perm(); got != 0o600 {
			t.Fatalf("credential file mode = %04o, want 0600", got)
		}
	}
	if got, err := loadOrchestrationCredential("session-1"); err != nil || got != "first-token" {
		t.Fatalf("load first credential = (%q, %v)", got, err)
	}

	if err := storeOrchestrationCredential("session-1", "second-token"); err != nil {
		t.Fatal(err)
	}
	if got, err := loadOrchestrationCredential("session-1"); err != nil || got != "second-token" {
		t.Fatalf("load replaced credential = (%q, %v)", got, err)
	}
	if replacedInfo, err := os.Lstat(path); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && replacedInfo.Mode().Perm() != 0o600 {
		t.Fatalf("replaced credential file mode = %04o, want 0600", replacedInfo.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Join(home, orchestrationCredentialsDirName))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "session-1" {
		t.Fatalf("credential directory entries = %#v", entries)
	}
}

func TestOrchestrationCredentialStorageRejectsSymlink(t *testing.T) {
	useTempOrbitHome(t)
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation may require elevated privileges on Windows")
	}
	if err := storeOrchestrationCredential("session-1", "token"); err != nil {
		t.Fatal(err)
	}
	path, _ := orchestrationCredentialPath("session-1")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("must-not-be-read-or-replaced"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrchestrationCredential("session-1"); err == nil || !strings.Contains(err.Error(), "private regular file") {
		t.Fatalf("load symlink credential error = %v", err)
	}
	if err := storeOrchestrationCredential("session-1", "replacement"); err == nil || !strings.Contains(err.Error(), "private regular file") {
		t.Fatalf("replace symlink credential error = %v", err)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "must-not-be-read-or-replaced" {
		t.Fatalf("symlink target changed = (%q, %v)", got, err)
	}
}

func TestOrchestrationCredentialStorageRejectsUnsafePathsAndModes(t *testing.T) {
	useTempOrbitHome(t)
	for _, id := range []string{"", "..", "nested/session", `nested\session`} {
		if err := storeOrchestrationCredential(id, "token"); err == nil {
			t.Errorf("store accepted unsafe session id %q", id)
		}
	}
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix credential permission bits")
	}
	if err := storeOrchestrationCredential("session-1", "token"); err != nil {
		t.Fatal(err)
	}
	path, _ := orchestrationCredentialPath("session-1")
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrchestrationCredential("session-1"); err == nil || !strings.Contains(err.Error(), "want 0600") {
		t.Fatalf("load insecure credential error = %v", err)
	}
	if err := storeOrchestrationCredential("session-1", "replacement"); err == nil || !strings.Contains(err.Error(), "want 0600") {
		t.Fatalf("replace insecure credential error = %v", err)
	}
}

func TestPruneAndRemoveOrchestrationCredentials(t *testing.T) {
	useTempOrbitHome(t)
	for _, id := range []string{"live", "stale-1", "stale-2"} {
		if err := storeOrchestrationCredential(id, "token-"+id); err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneOrchestrationCredentials(map[string]bool{"live": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrchestrationCredential("live"); err != nil {
		t.Fatalf("live credential was pruned: %v", err)
	}
	for _, id := range []string{"stale-1", "stale-2"} {
		if _, err := loadOrchestrationCredential(id); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("stale credential %s still exists: %v", id, err)
		}
	}
	if err := removeOrchestrationCredential("live"); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrchestrationCredential("live"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed credential still exists: %v", err)
	}
	if err := removeOrchestrationCredential("live"); err != nil {
		t.Fatalf("removing an absent credential: %v", err)
	}
}

func TestStageOrchestrationCredentialMovesProofOutOfJob(t *testing.T) {
	useTempOrbitHome(t)
	job := &ClaimedSession{
		SessionID:          "caller-session",
		AllowOrchestration: true,
		OrchestrationToken: "claim-token",
	}
	if err := stageOrchestrationCredential(job); err != nil {
		t.Fatal(err)
	}
	if job.OrchestrationToken != "" {
		t.Fatal("staged credential remained in the in-memory job")
	}
	if got, err := loadOrchestrationCredential(job.SessionID); err != nil || got != "claim-token" {
		t.Fatalf("staged credential = (%q, %v)", got, err)
	}

	job.AllowOrchestration = false
	job.OrchestrationToken = "must-not-survive"
	if err := stageOrchestrationCredential(job); err != nil {
		t.Fatal(err)
	}
	if job.OrchestrationToken != "" {
		t.Fatal("disabled credential remained in the in-memory job")
	}
	if _, err := loadOrchestrationCredential(job.SessionID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("disabled session credential still exists: %v", err)
	}
}

func TestOrchestrationTransportReadsCredentialDynamically(t *testing.T) {
	useTempOrbitHome(t)
	if err := storeOrchestrationCredential("caller-session", "file-token-1"); err != nil {
		t.Fatal(err)
	}
	var gotTokens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTokens = append(gotTokens, r.Header.Get("X-Orbit-Session-Token"))
		if got := r.Header.Get(runnerCapabilitiesHeader); got != runnerCapabilitiesV1 {
			t.Errorf("runner capability header = %q", got)
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	transport := NewTransport(srv.URL, "runner-token")
	if _, err := transport.listSessions("caller-session", "environment-fallback", ""); err != nil {
		t.Fatal(err)
	}
	if err := storeOrchestrationCredential("caller-session", "file-token-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.listSessions("caller-session", "environment-fallback", ""); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(gotTokens, ","), "file-token-1,file-token-2"; got != want {
		t.Fatalf("dynamic request tokens = %q, want %q", got, want)
	}
}

func TestOrchestrationTransportRefreshesAndRetriesOnce(t *testing.T) {
	useTempOrbitHome(t)
	if err := storeOrchestrationCredential("caller-session", "stale-token"); err != nil {
		t.Fatal(err)
	}
	orchestrationRequests := 0
	refreshRequests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get(runnerCapabilitiesHeader); got != runnerCapabilitiesV1 {
			t.Errorf("runner capability header = %q", got)
		}
		switch r.URL.Path {
		case "/api/runner/sessions":
			orchestrationRequests++
			if orchestrationRequests == 1 {
				if got := r.Header.Get("X-Orbit-Session-Token"); got != "stale-token" {
					t.Errorf("initial credential = %q", got)
				}
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"invalid orchestration credential"}`))
				return
			}
			if got := r.Header.Get("X-Orbit-Session-Token"); got != "fresh-token" {
				t.Errorf("retried credential = %q", got)
			}
			_, _ = w.Write([]byte(`[]`))
		case "/api/runner/sessions/caller-session/orchestration-credential":
			refreshRequests++
			if r.Method != http.MethodPost {
				t.Errorf("refresh method = %s", r.Method)
			}
			if got := r.Header.Get("Authorization"); got != "Bearer runner-token" {
				t.Errorf("refresh authorization = %q", got)
			}
			if got := r.Header.Get("X-Orbit-Session-Token"); got != "" {
				t.Errorf("refresh carried stale session credential")
			}
			_, _ = w.Write([]byte(`{"orchestrationToken":"fresh-token"}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	if _, err := NewTransport(srv.URL, "runner-token").listSessions("caller-session", "environment-fallback", ""); err != nil {
		t.Fatal(err)
	}
	if orchestrationRequests != 2 || refreshRequests != 1 {
		t.Fatalf("requests = orchestration:%d refresh:%d, want 2/1", orchestrationRequests, refreshRequests)
	}
	if got, err := loadOrchestrationCredential("caller-session"); err != nil || got != "fresh-token" {
		t.Fatalf("persisted refreshed credential = (%q, %v)", got, err)
	}
}

func TestOrchestrationTransportAcquiresInitiallyMissingCredential(t *testing.T) {
	useTempOrbitHome(t)
	orchestrationRequests := 0
	refreshRequests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions":
			orchestrationRequests++
			if orchestrationRequests == 1 {
				if got := r.Header.Get("X-Orbit-Session-Token"); got != "" {
					t.Errorf("initial request unexpectedly carried credential %q", got)
				}
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"missing orchestration credential"}`))
				return
			}
			if got := r.Header.Get("X-Orbit-Session-Token"); got != "fresh-token" {
				t.Errorf("retried credential = %q", got)
			}
			_, _ = w.Write([]byte(`[]`))
		case "/api/runner/sessions/caller-session/orchestration-credential":
			refreshRequests++
			_, _ = w.Write([]byte(`{"orchestrationToken":"fresh-token"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	if _, err := NewTransport(srv.URL, "runner-token").listSessions("caller-session", "", ""); err != nil {
		t.Fatal(err)
	}
	if orchestrationRequests != 2 || refreshRequests != 1 {
		t.Fatalf("requests = orchestration:%d refresh:%d, want 2/1", orchestrationRequests, refreshRequests)
	}
	if got, err := loadOrchestrationCredential("caller-session"); err != nil || got != "fresh-token" {
		t.Fatalf("persisted acquired credential = (%q, %v)", got, err)
	}
}

func TestOrchestrationTransportDoesNotRetryOtherForbidden(t *testing.T) {
	useTempOrbitHome(t)
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"session orchestration disabled"}`))
	}))
	defer srv.Close()

	_, err := NewTransport(srv.URL, "runner-token").listSessions("caller-session", "fallback-token", "")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("forbidden error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("request count = %d, want 1", requests)
	}
}

func TestOrchestrationTransportStopsAfterSingleRetry(t *testing.T) {
	useTempOrbitHome(t)
	orchestrationRequests := 0
	refreshRequests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions":
			orchestrationRequests++
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"invalid orchestration credential"}`))
		case "/api/runner/sessions/caller-session/orchestration-credential":
			refreshRequests++
			_, _ = w.Write([]byte(`{"orchestrationToken":"fresh-but-rejected"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	_, err := NewTransport(srv.URL, "runner-token").listSessions("caller-session", "stale-token", "")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("second forbidden error = %v", err)
	}
	if orchestrationRequests != 2 || refreshRequests != 1 {
		t.Fatalf("requests = orchestration:%d refresh:%d, want 2/1", orchestrationRequests, refreshRequests)
	}
}

func TestRefreshableCredentialErrorPrefersStableProtocolCode(t *testing.T) {
	err := &transportHTTPError{
		statusCode: http.StatusForbidden,
		body:       `{"code":"ORCHESTRATION_CREDENTIAL_INVALID","message":"wording may change"}`,
	}
	if !isRefreshableOrchestrationCredentialError(err) {
		t.Fatal("stable invalid-credential code was not refreshable")
	}
	err.body = `{"code":"ORCHESTRATION_DISABLED","message":"invalid orchestration credential"}`
	if !isRefreshableOrchestrationCredentialError(err) {
		// During a rolling deployment the legacy message remains an intentional
		// fallback even when an older server supplies no recognized code.
		t.Fatal("legacy invalid-credential message fallback was not refreshable")
	}
	err.body = `{"code":"ORCHESTRATION_DISABLED","message":"session orchestration disabled"}`
	if isRefreshableOrchestrationCredentialError(err) {
		t.Fatal("non-credential orchestration denial became refreshable")
	}
}

func TestTransportSendsRunnerCapabilityHeader(t *testing.T) {
	got := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(runnerCapabilitiesHeader)
		_, _ = w.Write([]byte(`{"agents":[]}`))
	}))
	defer srv.Close()
	if _, err := NewTransport(srv.URL, "runner-token").me(); err != nil {
		t.Fatal(err)
	}
	if got != runnerCapabilitiesV1 {
		t.Fatalf("runner capability header = %q, want %q", got, runnerCapabilitiesV1)
	}
}
