package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// cursorTestToken is a login token shaped like the CLI's: a JWT expiring at exp.
func cursorTestToken(t *testing.T, exp time.Time) string {
	t.Helper()
	part := func(v interface{}) string {
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	return part(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." + part(map[string]interface{}{"sub": "user", "exp": exp.Unix()}) + ".signature"
}

// signInCursorDefault saves token as the Default account's login, where `agent login` would.
func signInCursorDefault(t *testing.T, token string) string {
	t.Helper()
	path := cursorStoredLoginPath(cursorDefaultAccountDir())
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"accessToken":"`+token+`","refreshToken":"`+token+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// cursorHealth is the engine report for Cursor CLI, as the heartbeat carries it, beside what checkEngine
// (and `orbit doctor`) found.
func cursorHealth(t *testing.T) (engineHealth, EngineHealthReport) {
	t.Helper()
	h := checkEngine(cursorSpecForTest(t), serviceLoginPath())
	reports := probeEngineHealthOf(providerCursor)
	if len(reports) != 1 || reports[0].Engine != providerCursor {
		t.Fatalf("Cursor CLI's engine report = %+v", reports)
	}
	return h, reports[0]
}

func callsWith(calls []fakeCursorCall, arg string) []fakeCursorCall {
	var out []fakeCursorCall
	for _, call := range calls {
		if len(call.Args) > 0 && call.Args[0] == arg {
			out = append(out, call)
		}
	}
	return out
}

// The engine report tells the four states apart — nothing installed, a build that is not the pinned
// one, a platform no build was measured on, the Default account signed out — and says signed in only
// on the CLI's own `agent models` with the Default account's login. The ACP handshake succeeds signed
// out (contract §2.3), so it never counts as a credential.
func TestCursorHealthStates(t *testing.T) {
	t.Run("not-installed", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		h, report := cursorHealth(t)
		if h.installed || !strings.HasPrefix(h.installError, "CURSOR_NOT_INSTALLED:") || report.Installed ||
			!strings.HasPrefix(report.InstallationError, "CURSOR_NOT_INSTALLED:") || report.Auth != "unknown" {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		if !strings.HasPrefix(formatEngineLine(h), "✗ Cursor CLI — CURSOR_NOT_INSTALLED:") {
			t.Fatalf("doctor line = %q", formatEngineLine(h))
		}
		if cursorInstallReady.Load() {
			t.Fatal("nothing installed reads as ready")
		}
	})

	t.Run("version-mismatch", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		// A build an earlier pin installed, still kept for its sessions, and no pinned build beside it.
		publishFakeCursorVersion(t, r, "2026.10.01-0000001", "2026.10.01-0000001")
		h, report := cursorHealth(t)
		if !h.installed || h.version != "2026.10.01-0000001" || !strings.HasPrefix(h.installError, "CURSOR_VERSION_INCOMPATIBLE:") ||
			!report.Installed || !strings.HasPrefix(report.InstallationError, "CURSOR_VERSION_INCOMPATIBLE:") {
			t.Fatalf("an older build: health = %+v, report = %+v", h, report)
		}
		// The pinned version's directory, holding a build that says it is another version.
		publishFakeCursorVersion(t, r, cursorSupportedVersion, "2026.10.16-e3cb207")
		h, report = cursorHealth(t)
		if !h.installed || h.version != "2026.10.16-e3cb207" || !strings.HasPrefix(h.installError, "CURSOR_VERSION_INCOMPATIBLE:") ||
			!strings.HasPrefix(report.InstallationError, "CURSOR_VERSION_INCOMPATIBLE:") || report.Version != "2026.10.16-e3cb207" {
			t.Fatalf("a mislabelled build: health = %+v, report = %+v", h, report)
		}
		if cursorInstallReady.Load() {
			t.Fatal("a build of another version reads as ready")
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("platform-unsupported", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		installFakeCursor(t)
		previous := cursorArtifacts
		cursorArtifacts = map[string]cursorArtifact{"plan9/mips": {path: "plan9/mips", sha256: "0", size: 1}}
		t.Cleanup(func() { cursorArtifacts = previous })
		h, report := cursorHealth(t)
		if h.installed || !strings.HasPrefix(h.installError, "CURSOR_PLATFORM_UNSUPPORTED:") || report.Installed ||
			!strings.HasPrefix(report.InstallationError, "CURSOR_PLATFORM_UNSUPPORTED:") {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		engineInstall.mu.Lock()
		err := installCursor(context.Background(), nil)
		engineInstall.mu.Unlock()
		if err == nil || !strings.HasPrefix(err.Error(), "CURSOR_PLATFORM_UNSUPPORTED:") {
			t.Fatalf("install on an unsupported platform = %v", err)
		}
		if cursorInstallReady.Load() {
			t.Fatal("an unsupported platform reads as ready")
		}
	})

	t.Run("signed-out", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		h, report := cursorHealth(t)
		if !h.installed || h.installError != "" || h.version != cursorSupportedVersion || h.auth != authNo ||
			report.Auth != "no" || !report.signedOut() || report.InstallationError != "" {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		if line := formatEngineLine(h); !strings.Contains(line, "not signed in") {
			t.Fatalf("doctor line = %q", line)
		}
		if hint := cursorSpecForTest(t).loginHint(); !strings.Contains(hint, "xdg-config") || !strings.Contains(hint, "login") {
			t.Fatalf("sign-in hint = %q", hint)
		}
		// No saved login is the answer: neither `agent models` nor an ACP handshake is asked.
		if calls := r.calls(t); len(callsWith(calls, "models")) != 0 || len(callsWith(calls, "acp")) != 0 {
			t.Fatalf("a signed-out probe ran %v", calls)
		}
		if !cursorInstallReady.Load() {
			t.Fatal("an installed pinned build signed out does not read as ready")
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("signed-in", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		token := cursorTestToken(t, time.Now().Add(time.Hour))
		saved := signInCursorDefault(t, token)
		before, _ := os.ReadFile(saved)
		h, report := cursorHealth(t)
		if h.auth != authYes || report.Auth != "yes" || !report.signedIn() {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		models := callsWith(r.calls(t), "models")
		if len(models) == 0 {
			t.Fatal("signed in without asking `agent models`")
		}
		for _, call := range models {
			if got, _ := call.env("CURSOR_AUTH_TOKEN"); got != token {
				t.Fatalf("`agent models` ran without the Default account's token")
			}
			assertProbeHome(t, call, home)
		}
		if after, _ := os.ReadFile(saved); string(after) != string(before) {
			t.Fatal("the probe rewrote the Default account's saved login")
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("handshake-is-not-a-credential", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		exe := installFakeCursor(t)
		// This build's ACP handshake succeeds for anyone (the recorded initialize), whatever the login.
		if catalog, err := fetchCursorModelCatalogWith(context.Background(), exe, "CURSOR_AUTH_TOKEN=revoked"); err != nil || len(catalog) == 0 {
			t.Fatalf("the fake's handshake = %v", err)
		}
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
		for mode, want := range map[string]authState{"rejected": authNo, "offline": authUnknown, "garbled": authUnknown} {
			r.behave(t, "models-mode", mode)
			if h, _ := cursorHealth(t); h.auth != want {
				t.Fatalf("`agent models` %s: auth = %v, want %v", mode, h.auth, want)
			}
		}
		r.behave(t, "models-mode", "")
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(2*time.Minute)))
		before := len(callsWith(r.calls(t), "models"))
		if h, report := cursorHealth(t); h.auth != authNo || report.Auth != "no" {
			t.Fatalf("a login past the CLI's own expiry threshold: health = %+v", h)
		}
		if after := len(callsWith(r.calls(t), "models")); after != before {
			t.Fatal("an expired login was still offered to `agent models`")
		}
	})
}

// registerCursorDriverForTest stands in for the Cursor CLI session driver the ACP task adds (present),
// or takes the one there is away (absent), for the test's duration.
func registerCursorDriverForTest(t *testing.T, present bool) {
	t.Helper()
	previous, had := providerRuntimes[providerCursor]
	if present {
		providerRuntimes[providerCursor] = providerRuntime{transport: transportJSONRPC,
			run: func(sessionProcessArgs) (string, bool, bool) { return stFailed, true, false }}
	} else {
		delete(providerRuntimes, providerCursor)
	}
	t.Cleanup(func() {
		if had {
			providerRuntimes[providerCursor] = previous
		} else {
			delete(providerRuntimes, providerCursor)
		}
	})
}

// sentSupportedProviders is the X-Orbit-Supported-Providers a real request from this runner carries.
func sentSupportedProviders(t *testing.T) string {
	t.Helper()
	var mu sync.Mutex
	var header string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		header = req.Header.Get("X-Orbit-Supported-Providers")
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()
	if err := NewTransport(server.URL, "runner-token").do(context.Background(), http.MethodGet, "/runner/heartbeat-probe", nil, nil, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	return header
}

// provider:cursor rides every request, the heartbeat's included, only while the pinned build is installed
// and admitted here, and only from a binary with a session driver for it; signed in or not, since a
// session can bring its own credential. The six engines' declaration is the same either way.
func TestCursorProviderDeclaredOnlyWhenAvailable(t *testing.T) {
	without, with := runnerSupportedProviders, runnerSupportedProviders+",cursor"
	declared := func(t *testing.T, want string) {
		t.Helper()
		probeEngineHealthOf(providerCursor)
		if got := supportedProvidersHeader(); got != want {
			t.Fatalf("declared providers = %q, want %q", got, want)
		}
		if got := sentSupportedProviders(t); got != want {
			t.Fatalf("a request declared %q, want %q", got, want)
		}
	}
	t.Run("not-installed", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		registerCursorDriverForTest(t, true)
		declared(t, without)
	})
	t.Run("installed-and-signed-out", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		registerCursorDriverForTest(t, true)
		installFakeCursor(t)
		declared(t, with)
	})
	t.Run("version-mismatch", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		registerCursorDriverForTest(t, true)
		publishFakeCursorVersion(t, r, cursorSupportedVersion, "2026.10.16-e3cb207")
		declared(t, without)
	})
	t.Run("platform-unsupported", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		registerCursorDriverForTest(t, true)
		installFakeCursor(t)
		previous := cursorArtifacts
		cursorArtifacts = map[string]cursorArtifact{"plan9/mips": {path: "plan9/mips", sha256: "0", size: 1}}
		t.Cleanup(func() { cursorArtifacts = previous })
		declared(t, without)
	})
	t.Run("no-session-driver", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		registerCursorDriverForTest(t, false)
		installFakeCursor(t)
		declared(t, without)
	})
	t.Run("withdrawn-when-the-build-goes", func(t *testing.T) {
		useCursorRealHome(t)
		newFakeCursorRelease(t)
		registerCursorDriverForTest(t, true)
		installFakeCursor(t)
		declared(t, with)
		if err := os.RemoveAll(cursorVersionDir()); err != nil {
			t.Fatal(err)
		}
		declared(t, without)
	})
}

// A Cursor CLI session reaching a runner with no session driver for it is refused with that said, and
// nothing is installed or started for it — not Claude Code, not an install of Cursor CLI.
func TestCursorSessionWithoutDriverStartsNothing(t *testing.T) {
	useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	registerCursorDriverForTest(t, false)
	var events []string
	emit := func(eventType string, payload map[string]interface{}) {
		msg, _ := payload["message"].(string)
		events = append(events, eventType+": "+msg)
	}
	job := &ClaimedSession{SessionID: "s-cursor-no-driver", Provider: providerCursor}
	st, ended, reload := runSessionProcess(context.Background(), context.Background(), nil, job, "", "", t.TempDir(),
		emit, nil, func(string) {}, true, nil, nil, nil, nil, nil)
	if st != stFailed || !ended || reload {
		t.Fatalf("runSessionProcess = (%s, ended=%v, reload=%v), want a failed end", st, ended, reload)
	}
	if len(events) != 1 || !strings.HasPrefix(events[0], evError+": Cursor CLI sessions cannot run on this Orbit runner yet") {
		t.Fatalf("events = %q", events)
	}
	if len(r.requestPaths()) != 0 || len(r.calls(t)) != 0 {
		t.Fatalf("something was installed or started: downloads %v, calls %v", r.requestPaths(), r.calls(t))
	}
}
