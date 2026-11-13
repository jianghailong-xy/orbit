package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// resetLocalRunGate forgets the last check, so a test starts from a runner that has measured nothing.
func resetLocalRunGate(t *testing.T) {
	t.Helper()
	reset := func() {
		localRunGate.mu.Lock()
		localRunGate.checked, localRunGate.fingerprint, localRunGate.err = false, "", nil
		localRunGate.mu.Unlock()
	}
	reset()
	t.Cleanup(reset)
}

// ── A scripted claude, to show what the check catches ───────────────────────────────────────────────

// fakeLocalRunClaudeEnv names how the scripted claude behaves (runFakeLocalRunClaude).
const fakeLocalRunClaudeEnv = "ORBIT_FAKE_LOCAL_RUN_CLAUDE"

// fakeLocalRunSettings is the env and apiKeyHelper of the managed settings file the check made, if any.
func fakeLocalRunSettings() (map[string]string, string) {
	var settings struct {
		Env          map[string]string `json:"env"`
		APIKeyHelper string            `json:"apiKeyHelper"`
	}
	if path := os.Getenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH"); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &settings)
		}
	}
	return settings.Env, settings.APIKeyHelper
}

// runFakeLocalRunClaude sends one model request the way mode says a CLI might:
//
//	obedient        to the environment's base URL with its token, and nothing else
//	silent          nothing at all
//	settings-route  to the base URL a settings file names
//	settings-header with the custom header a settings file names
//	helper-key      with the key a settings file's apiKeyHelper prints
//	delayed-decoy   obediently first, then — after the check's old two-second grace — to the base URL a
//	                settings file names, before exiting cleanly
//	hangs           obediently, then never exits
func runFakeLocalRunClaude(mode string) int {
	if mode == "silent" {
		return 0
	}
	if mode == "delayed-decoy" {
		fakeLocalRunSend("obedient")
		time.Sleep(3 * time.Second)
		fakeLocalRunSend("settings-route")
		return 0
	}
	if mode == "hangs" {
		fakeLocalRunSend("obedient")
		select {}
	}
	fakeLocalRunSend(mode)
	return 0
}

// fakeLocalRunSend sends one model request the way mode says (runFakeLocalRunClaude).
func fakeLocalRunSend(mode string) {
	settingsEnv, helper := fakeLocalRunSettings()
	base := os.Getenv("ANTHROPIC_BASE_URL")
	if mode == "settings-route" && settingsEnv["ANTHROPIC_BASE_URL"] != "" {
		base = settingsEnv["ANTHROPIC_BASE_URL"]
	}
	req, err := http.NewRequest(http.MethodPost, base+"/v1/messages", strings.NewReader(`{"model":"x"}`))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("ANTHROPIC_AUTH_TOKEN"))
	if mode == "settings-header" {
		if name, value, ok := strings.Cut(settingsEnv["ANTHROPIC_CUSTOM_HEADERS"], ":"); ok {
			req.Header.Set(strings.TrimSpace(name), strings.TrimSpace(value))
		}
	}
	if mode == "helper-key" && helper != "" {
		if out, err := exec.Command("sh", "-c", helper).Output(); err == nil {
			req.Header.Set("X-Api-Key", strings.TrimSpace(string(out)))
		}
	}
	if res, err := http.DefaultClient.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
}

// fakeLocalRunClaudeOnPath puts a `claude` first on PATH that is this test binary in mode.
func fakeLocalRunClaudeOnPath(t *testing.T, mode string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" + fakeLocalRunClaudeEnv + "=" + mode + " exec '" + exe + "' \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

// The production check against each way a CLI could leak: only the CLI that sends nothing but the local
// endpoint's own request passes; one that follows a settings file's base URL, adds its custom header or its
// helper's key, or sends nothing, fails. A CLI's version is never consulted: its behaviour is.
func TestVerifyLocalProviderRunCatchesEveryLeak(t *testing.T) {
	localRunCheckTimeout = 8 * time.Second
	t.Cleanup(func() { localRunCheckTimeout = 45 * time.Second })
	for mode, wantPass := range map[string]bool{
		"obedient": true, "silent": false, "settings-route": false, "settings-header": false, "helper-key": false,
		// Local first, the leak only after the old grace: the whole life of the CLI is watched now.
		"delayed-decoy": false,
		// A CLI that never finishes its turn fails at the deadline, closed.
		"hangs": false,
	} {
		t.Run(mode, func(t *testing.T) {
			fakeLocalRunClaudeOnPath(t, mode)
			err := verifyLocalProviderRun(context.Background())
			if wantPass && err != nil {
				t.Fatalf("an isolated CLI failed the check: %v", err)
			}
			if !wantPass && err == nil {
				t.Fatalf("a CLI that leaks (%s) passed the check", mode)
			}
		})
	}
}

// A CLI that fails the check means no capability, and a local session refused at spawn; an ordinary
// session is started as before.
func TestLocalProviderRunFailsClosedAtSpawn(t *testing.T) {
	resetLocalRunGate(t)
	localRunCheckTimeout = 10 * time.Second
	t.Cleanup(func() { localRunCheckTimeout = 45 * time.Second })
	fakeLocalRunClaudeOnPath(t, "settings-header")
	if err := ensureLocalProviderRun(context.Background()); err == nil {
		t.Fatal("a leaking CLI passed")
	}
	job := &ClaimedSession{SessionID: "local-job", Agent: AgentExecConfig{Env: localJobEnv(t.TempDir())}}
	settings, err := writeClaudeSettings(t.TempDir(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := spawnClaude(context.Background(), job, t.TempDir(), []string{"-p", "--settings", settings}); err == nil ||
		!strings.Contains(err.Error(), "cannot keep a local provider's session on its local endpoint") {
		t.Fatalf("a local session was started on a runner that failed the check: %v", err)
	}
}

// A replaced binary is a new binary, even of the same size with its modification time put back.
func TestLocalRunFingerprintFollowsTheBinarysContents(t *testing.T) {
	path := fakeLocalRunClaudeOnPath(t, "obedient")
	before, err := claudeLocalRunFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	b, _ := os.ReadFile(path)
	swapped := []byte(strings.Replace(string(b), "obedient", "silent!!", 1))
	if len(swapped) != len(b) {
		t.Fatal("the replacement is not the same size")
	}
	if err := os.WriteFile(path, swapped, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, st.ModTime(), st.ModTime()); err != nil {
		t.Fatal(err)
	}
	after, err := claudeLocalRunFingerprint()
	if err != nil {
		t.Fatal(err)
	}
	if after == before {
		t.Fatal("a same-size, same-mtime replacement kept the fingerprint: the old check would stand for a new binary")
	}
	// And a managed settings file changing is a new answer too.
	managed := filepath.Join(t.TempDir(), "managed-settings.json")
	t.Setenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH", managed)
	withNone, _ := claudeLocalRunFingerprint()
	if err := os.WriteFile(managed, []byte(`{"env":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if withFile, _ := claudeLocalRunFingerprint(); withFile == withNone {
		t.Fatal("a new managed settings file kept the fingerprint")
	}
}

// Claude Code's documented managed policy locations, on each OS, with their drop-in directories.
func TestClaudeManagedSettingsPathsPerOS(t *testing.T) {
	dropIns := func(dir string) ([]os.DirEntry, error) {
		if strings.HasSuffix(dir, "managed-settings.d") {
			return os.ReadDir(t.TempDir())
		}
		return nil, os.ErrNotExist
	}
	for goos, want := range map[string][]string{
		"linux":   {"/etc/claude-code/managed-settings.json"},
		"darwin":  {"/Library/Application Support/ClaudeCode/managed-settings.json"},
		"windows": {`C:\Program Files\ClaudeCode\managed-settings.json`},
	} {
		if got := claudeManagedSettingsPathsFor(goos, dropIns); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", goos, got, want)
		}
	}
	// The legacy C:\ProgramData location is not one Claude Code reads.
	for _, p := range claudeManagedSettingsPathsFor("windows", dropIns) {
		if strings.Contains(p, "ProgramData") {
			t.Fatalf("windows names %s", p)
		}
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "10-team.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	withDropIn := claudeManagedSettingsPathsFor("linux", func(d string) ([]os.DirEntry, error) {
		if d == "/etc/claude-code/managed-settings.d" {
			return os.ReadDir(dir)
		}
		return nil, os.ErrNotExist
	})
	if want := []string{"/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d/10-team.json"}; !reflect.DeepEqual(withDropIn, want) {
		t.Fatalf("drop-ins: %v", withDropIn)
	}
}

// ── Against the Claude Code installed on this machine ───────────────────────────────────────────────

// The production check, on the installed CLI, on a runner whose own environment is hostile too: it passes.
// The control: the same check with Claude Code's host-managed switch taken out of the CLI's environment
// fails, because the hostile settings the check itself writes then win. Skipped only where no claude is
// installed.
func TestVerifyLocalProviderRunOnTheInstalledClaude(t *testing.T) {
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("no claude on PATH")
	}
	t.Setenv("ANTHROPIC_API_KEY", "ambient-real-key")
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	t.Setenv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bedrock-token")
	t.Setenv(claudeProviderManagedByHostVar, "0")
	if err := verifyLocalProviderRun(context.Background()); err != nil {
		t.Fatalf("the installed Claude Code failed the local provider check: %v", err)
	}
	localRunCheckEnvHook = func(env []string) []string {
		out := env[:0:0]
		for _, entry := range env {
			if !strings.HasPrefix(entry, claudeProviderManagedByHostVar+"=") {
				out = append(out, entry)
			}
		}
		return out
	}
	t.Cleanup(func() { localRunCheckEnvHook = nil })
	err := verifyLocalProviderRun(context.Background())
	if err == nil {
		t.Fatal("the check passed without the host-managed switch: it cannot see the hostility it guards against")
	}
	if !strings.Contains(err.Error(), "against hostile settings") {
		t.Fatalf("the control failed for another reason: %v", err)
	}
	t.Logf("control: %v", err)
}

// ── The declaration follows the check ───────────────────────────────────────────────────────────────

// declaredOn is what one HTTPS call from t declares, as the control plane reads it off the request.
func declaredOn(t *testing.T) string {
	t.Helper()
	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case got <- r.Header.Get(runnerCapabilitiesHeader):
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer srv.Close()
	tr := NewTransport(srv.URL, "runner-token")
	if err := tr.doHTTP(context.Background(), http.DefaultClient, http.MethodGet, "/runner/ping", nil, nil, 5*time.Second, nil); err != nil {
		t.Fatal(err)
	}
	return <-got
}

func declaresLocalRun(list string) bool {
	return strings.Contains(","+list+",", ","+localProviderRunCapabilityV1+",")
}

// A runner declares ollama-run/v1 after a passing check, and stops declaring it — on the very next HTTPS call,
// in the next link Hello, with the link told to open its next connection now — once its Claude Code changes
// on disk into one that fails. A local session that still reaches it is refused with the stable code.
func TestLocalProviderRunCapabilityIsWithdrawnWhenTheCheckStopsPassing(t *testing.T) {
	resetLocalRunGate(t)
	localRunDeclaring.Store(true)
	t.Cleanup(func() { localRunDeclaring.Store(false); localRunDeclared.Store(false) })
	localRunCheckTimeout = 8 * time.Second
	t.Cleanup(func() { localRunCheckTimeout = 45 * time.Second })
	drain := func() bool {
		select {
		case <-runnerCapabilitiesChanged:
			return true
		default:
			return false
		}
	}
	drain()

	path := fakeLocalRunClaudeOnPath(t, "obedient")
	seen := localRunDiskKey()
	if err := ensureLocalProviderRun(context.Background()); err != nil {
		t.Fatalf("an isolated CLI failed: %v", err)
	}
	if !declaresLocalRun(runnerCapabilities()) || !declaresLocalRun(declaredOn(t)) || !declaresLocalRun(strings.Join(linkHello("p").GetCapabilities(), ",")) {
		t.Fatal("a passing check is not declared")
	}
	if !drain() {
		t.Fatal("the link was not told the declaration changed")
	}

	// Claude Code updates itself into one that sends a settings file's header along: the watch notices the
	// binary changed, checks again, and the declaration goes.
	b, _ := os.ReadFile(path)
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), "=obedient ", "=settings-header ", 1)), 0o755); err != nil {
		t.Fatal(err)
	}
	if next := localRunWatchTick(context.Background(), seen); next == seen {
		t.Fatal("the watch did not see the binary change")
	}
	if declaresLocalRun(runnerCapabilities()) || declaresLocalRun(declaredOn(t)) || declaresLocalRun(strings.Join(linkHello("p").GetCapabilities(), ",")) {
		t.Fatal("a runner whose check now fails still declares " + localProviderRunCapabilityV1)
	}
	if !drain() {
		t.Fatal("the link was not told the declaration changed")
	}
	// A watch tick with nothing changed checks nothing again.
	if again := localRunWatchTick(context.Background(), localRunDiskKey()); again != localRunDiskKey() {
		t.Fatal("unchanged")
	}

	job := &ClaimedSession{SessionID: "local-job", Agent: AgentExecConfig{Env: localJobEnv(t.TempDir())}}
	settings, _ := writeClaudeSettings(t.TempDir(), "", false)
	if _, err := spawnClaude(context.Background(), job, t.TempDir(), []string{"-p", "--settings", settings}); err == nil ||
		!strings.HasPrefix(err.Error(), "LOCAL_PROVIDER_RUNNER_OUTDATED: ") {
		t.Fatalf("a local session reaching a runner that lost the capability: %v", err)
	}
}
