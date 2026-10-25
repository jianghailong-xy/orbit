package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A Cursor API key saved in Orbit (project P2; docs/cursor-runtime-contract.md §8.2, §9, §16.2, §16.3):
// dispatched as ORBIT_CURSOR_API_KEY, handed to the CLI as its own CURSOR_API_KEY with its credentials
// held in memory, checked first with `agent models` — never the ACP handshake — and never written down,
// printed, or sent anywhere but to the CLI. scripts/test-cursor-api-key.mjs runs every test here by name.

// cursorTestKey is shaped like a Cursor User API Key, and is found nowhere unless something leaked it.
const cursorTestKey = "key_p2-plaintext-0f3c9a7e51d24b88a6e0c4d29b17f3aa"

type cursorKeyReport struct {
	sessionID string
	report    CursorKeyCheckReport
}

// cursorKeyReports stands in for the control plane's door and keeps what reached it.
type cursorKeyReports struct {
	mu      sync.Mutex
	reports []cursorKeyReport
	err     error
}

func (r *cursorKeyReports) report(sessionID string, report CursorKeyCheckReport) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reports = append(r.reports, cursorKeyReport{sessionID, report})
	return r.err
}

func (r *cursorKeyReports) all() []cursorKeyReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cursorKeyReport(nil), r.reports...)
}

// cursorKeyJob is a Cursor CLI session as the control plane hands it over, with env as its agent env.
func cursorKeyJob(sessionID string, env map[string]string) *ClaimedSession {
	return &ClaimedSession{SessionID: sessionID, AgentID: "a", TaskID: "t",
		Agent: AgentExecConfig{Provider: providerCursor, Env: env}}
}

// filesHolding lists every regular file under root whose content holds needle, but those under skip.
func filesHolding(t *testing.T, root, needle string, skip ...string) []string {
	t.Helper()
	var held []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, s := range skip {
			if path == s {
				return filepath.SkipDir
			}
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), needle) {
			held = append(held, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return held
}

// assertKeyNowhere fails when anything the runner or the CLI left behind — under the runner user's home
// (Orbit's home and every session directory in it), TMPDIR or the session's checkout — holds the key,
// or when the runner printed it. The fake CLI's own record of its starts is test instrumentation, and
// lives apart from all of these.
func assertKeyNowhere(t *testing.T, logs string, roots ...string) {
	t.Helper()
	for _, root := range append(roots, os.TempDir()) {
		if held := filesHolding(t, root, cursorTestKey); len(held) != 0 {
			t.Errorf("the API key was written to disk: %v", held)
		}
	}
	if strings.Contains(logs, cursorTestKey) {
		t.Errorf("the runner printed the API key: %s", logs)
	}
}

// A session on a Cursor key starts Cursor CLI with the key as its own CURSOR_API_KEY and its credentials
// in memory: once checked with `agent models` in a throwaway home, then in the session's process. The
// dispatch variable never reaches the CLI, a CURSOR_API_KEY typed into the workspace is not what it runs
// on, and the key is written nowhere and printed nowhere — the control plane hears of it by fingerprint.
func TestCursorAPIKeyLaunchInjectsTheKeyInMemory(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	execDir := t.TempDir()
	job := cursorKeyJob("51111111-2222-4333-8444-555555555555", map[string]string{
		cursorAPIKeyVar: cursorTestKey, "CURSOR_API_KEY": "key_typed-into-the-workspace", "FOO": "bar"})
	var reports cursorKeyReports
	var spec CursorLaunchSpec
	logs := captureLogs(t, func() {
		var err error
		if spec, err = PrepareCursorSessionLaunch(context.Background(), job, execDir, reports.report); err != nil {
			t.Error(err)
		}
	})
	if t.Failed() {
		t.FailNow()
	}

	held := 0
	for _, entry := range spec.Env {
		if strings.HasPrefix(entry, "CURSOR_API_KEY=") {
			held++
		}
		if strings.HasPrefix(entry, cursorAPIKeyVar+"=") || strings.Contains(entry, "key_typed-into-the-workspace") {
			t.Errorf("the launch environment carries %q", entry)
		}
	}
	env := envMap(spec.Env)
	if held != 1 || env["CURSOR_API_KEY"] != cursorTestKey {
		t.Fatalf("CURSOR_API_KEY set %d times, to the session's key: %v", held, env["CURSOR_API_KEY"] == cursorTestKey)
	}
	if env["AGENT_CLI_CREDENTIAL_STORE"] != "memory" {
		t.Fatalf("AGENT_CLI_CREDENTIAL_STORE = %q, want memory", env["AGENT_CLI_CREDENTIAL_STORE"])
	}

	// Checked first, the contract's way: `agent models` with the key, in a throwaway home, in memory.
	models := callsWith(r.calls(t), "models")
	if len(models) != 1 {
		t.Fatalf("`agent models` ran %d times before the session, want once", len(models))
	}
	if key, _ := models[0].env("CURSOR_API_KEY"); key != cursorTestKey {
		t.Fatal("the key was not checked with the key the session runs on")
	}
	assertProbeHome(t, models[0], home)
	if got := reports.all(); len(got) != 1 || got[0].sessionID != job.SessionID ||
		got[0].report != (CursorKeyCheckReport{State: "VALID", KeyFingerprint: cursorKeyFingerprint(cursorTestKey)}) {
		t.Fatalf("reported %+v, want the session's key VALID by its fingerprint", got)
	}

	// The process the launch describes runs on the key, in memory, and opens a session.
	ask, stop := startCursorSession(t, spec, "ORBIT_P2_PROBE=1")
	if line := ask(1, "initialize"); !strings.Contains(line, `"protocolVersion":1`) {
		t.Fatalf("initialize = %q", line)
	}
	if line := ask(2, "session/new"); !strings.Contains(line, `"sessionId":"fake-session"`) {
		t.Fatalf("session/new = %q", line)
	}
	stop()
	acp := callsWith(r.calls(t), "acp")
	if len(acp) != 1 {
		t.Fatalf("%d session processes started, want 1", len(acp))
	}
	if key, _ := acp[0].env("CURSOR_API_KEY"); key != cursorTestKey {
		t.Error("the session's CLI did not get the session's key")
	}
	if store, _ := acp[0].env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
		t.Errorf("the session's CLI kept credentials in %q", store)
	}
	if _, ok := acp[0].env(cursorAPIKeyVar); ok {
		t.Error("the dispatch variable reached the CLI")
	}
	for _, call := range r.calls(t) {
		for _, arg := range call.Args {
			if strings.Contains(arg, cursorTestKey) {
				t.Errorf("%v carries the key on its command line", call.Args)
			}
		}
	}

	// Nothing holds the key at rest, in a log, or in the spec as it prints.
	assertKeyNowhere(t, logs, home, execDir)
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{spec.String(), fmt.Sprintf("%v", spec), fmt.Sprintf("%+v", spec), fmt.Sprintf("%#v", spec), string(encoded)} {
		if strings.Contains(text, cursorTestKey) {
			t.Fatalf("the launch spec printed the key: %s", text)
		}
	}
	// The fake, like the pinned build, writes auth.json whenever its credentials are not held in memory.
	_ = filepath.WalkDir(home, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Name() == "auth.json" {
			t.Errorf("a credential store was written: %s", path)
		}
		return nil
	})
	assertNoCursorStateIn(t, home)
}

// A key Cursor refuses ends the session's start with CURSOR_API_KEY_INVALID — Cursor's own words and
// what to do, never the key — tells the control plane INVALID, and starts no session process. It is
// `agent models` that says so, not the ACP handshake, which succeeds with any key or none.
func TestCursorAPIKeyRefusedByCursorStartsNothing(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	r.behave(t, "models-mode", "invalid-key")
	execDir := t.TempDir()
	job := cursorKeyJob("61111111-2222-4333-8444-555555555555", map[string]string{cursorAPIKeyVar: cursorTestKey})
	var reports cursorKeyReports
	var err error
	logs := captureLogs(t, func() {
		_, err = PrepareCursorSessionLaunch(context.Background(), job, execDir, reports.report)
	})
	if err == nil || !strings.HasPrefix(err.Error(), "CURSOR_API_KEY_INVALID: ") {
		t.Fatalf("a refused key = %v, want CURSOR_API_KEY_INVALID", err)
	}
	for _, said := range []string{"Cursor refused this session's API key", "The provided API key is invalid.", "save a new key"} {
		if !strings.Contains(err.Error(), said) {
			t.Errorf("the refusal %q does not say %q", err, said)
		}
	}
	if strings.Contains(err.Error(), cursorTestKey) {
		t.Fatal("the refusal carries the key")
	}
	if got := reports.all(); len(got) != 1 ||
		got[0].report != (CursorKeyCheckReport{State: "INVALID", KeyFingerprint: cursorKeyFingerprint(cursorTestKey)}) {
		t.Fatalf("reported %+v, want INVALID by the key's fingerprint", got)
	}
	if acp := callsWith(r.calls(t), "acp"); len(acp) != 0 {
		t.Fatalf("a session process started on a refused key: %v", acp)
	}
	if _, statErr := os.Stat(filepath.Join(runDir(job.SessionID), "cursor")); !os.IsNotExist(statErr) {
		t.Fatal("the session's Cursor CLI directories were laid out for a refused key")
	}
	assertKeyNowhere(t, logs, home, execDir)
	assertNoCursorStateIn(t, home)
}

// A Cursor API the CLI could not reach says nothing about the key: the control plane hears UNREACHABLE,
// and the session starts on the key, which its CLI tries for itself. An answer `agent models` gave that
// nobody can read is no verdict at all and is not reported; and a report that does not reach the control
// plane does not stop the session.
func TestCursorAPIKeyUnreachableOrUnreadIsNoRefusal(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	execDir := t.TempDir()
	for i, c := range []struct {
		mode, want string
		fails      bool
	}{
		{mode: "offline", want: "UNREACHABLE"},
		{mode: "garbled"},
		{mode: "", want: "VALID", fails: true},
	} {
		r.behave(t, "models-mode", c.mode)
		job := cursorKeyJob(fmt.Sprintf("7111111%d-2222-4333-8444-555555555555", i), map[string]string{cursorAPIKeyVar: cursorTestKey})
		reports := cursorKeyReports{}
		if c.fails {
			reports.err = errors.New("the control plane did not answer")
		}
		var spec CursorLaunchSpec
		var err error
		logs := captureLogs(t, func() {
			spec, err = PrepareCursorSessionLaunch(context.Background(), job, execDir, reports.report)
		})
		if err != nil {
			t.Fatalf("%q: %v, want the session to start", c.mode, err)
		}
		if envMap(spec.Env)["CURSOR_API_KEY"] != cursorTestKey {
			t.Fatalf("%q: the session does not run on its key", c.mode)
		}
		got := reports.all()
		if c.want == "" {
			if len(got) != 0 {
				t.Fatalf("%q: reported %+v, want nothing", c.mode, got)
			}
		} else if len(got) != 1 || got[0].report.State != c.want {
			t.Fatalf("%q: reported %+v, want %s", c.mode, got, c.want)
		}
		if c.fails && !strings.Contains(logs, "could not report the API key check") {
			t.Fatalf("%q: a report that failed was not logged: %s", c.mode, logs)
		}
		assertKeyNowhere(t, logs, home, execDir)
	}
}

// The runner's report reaches the control plane's door for the session, carrying the answer and the key's
// fingerprint — the first 16 hex digits of the SHA-256 of the trimmed key, as the control plane computes it
// (providers/provider-engine-resolution.ts keyFingerprint) — and no key.
func TestCursorAPIKeyCheckReachesTheControlPlaneByFingerprint(t *testing.T) {
	useCursorRealHome(t)
	newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	type request struct {
		path, body string
	}
	var mu sync.Mutex
	var requests []request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, request{r.URL.Path, string(body)})
		mu.Unlock()
		_, _ = w.Write([]byte(`{"recorded":true}`))
	}))
	t.Cleanup(srv.Close)
	transport := NewTransport(srv.URL, "runner-token")

	sum := sha256.Sum256([]byte(cursorTestKey))
	if fingerprint := cursorKeyFingerprint("  " + cursorTestKey + "\n"); fingerprint != hex.EncodeToString(sum[:])[:16] {
		t.Fatalf("fingerprint = %q", fingerprint)
	}
	job := cursorKeyJob("81111111-2222-4333-8444-555555555555", map[string]string{cursorAPIKeyVar: cursorTestKey})
	logs := captureLogs(t, func() {
		if _, err := PrepareCursorSessionLaunch(context.Background(), job, t.TempDir(), transport.cursorKeyCheck); err != nil {
			t.Error(err)
		}
	})
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 1 || !strings.HasSuffix(requests[0].path, "/runner/sessions/"+job.SessionID+"/cursor-key-check") {
		t.Fatalf("requests = %+v", requests)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(requests[0].body), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{"state": "VALID", "keyFingerprint": hex.EncodeToString(sum[:])[:16]}
	if fmt.Sprint(body) != fmt.Sprint(want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
	for _, r := range requests {
		if strings.Contains(r.body, cursorTestKey) || strings.Contains(r.path, cursorTestKey) {
			t.Fatal("the report carries the key")
		}
	}
	if strings.Contains(logs, cursorTestKey) {
		t.Fatal("the runner printed the key")
	}
}

// Only a key Orbit dispatched is checked and reported. A CURSOR_API_KEY typed into the workspace is the
// workspace's own: it reaches the CLI as the workspace's other variables do (cursor_launch.go), unchecked
// and unreported, and like a dispatched one it makes the runner's sign-in irrelevant — the control plane's
// sign-in preflight counts it the same way.
func TestCursorAPIKeyOnlyWhenDispatchedOne(t *testing.T) {
	useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	job := cursorKeyJob("91111111-2222-4333-8444-555555555555", map[string]string{"CURSOR_API_KEY": "key_typed-into-the-workspace"})
	var reports cursorKeyReports
	spec, err := PrepareCursorSessionLaunch(context.Background(), job, t.TempDir(), reports.report)
	if err != nil {
		t.Fatal(err)
	}
	if key := envMap(spec.Env)["CURSOR_API_KEY"]; key != "key_typed-into-the-workspace" {
		t.Fatalf("the CLI runs on CURSOR_API_KEY %q, want the workspace's own", key)
	}
	if models := callsWith(r.calls(t), "models"); len(models) != 0 || len(reports.all()) != 0 {
		t.Fatalf("a workspace's own key was checked or reported: %v %v", models, reports.all())
	}
	for _, c := range []struct {
		env  map[string]string
		want bool
	}{
		{map[string]string{cursorAPIKeyVar: cursorTestKey}, true},
		{map[string]string{cursorAPIKeyVar: "  "}, false},
		{map[string]string{"CURSOR_API_KEY": "key_typed-into-the-workspace"}, true},
		{map[string]string{"CURSOR_AUTH_TOKEN": "a-token-typed-into-the-workspace"}, true},
		{map[string]string{"CURSOR_API_KEY": " "}, false},
		{map[string]string{"ANTHROPIC_API_KEY": "sk-ant-api"}, false},
		{nil, false},
	} {
		if got := hasInjectedCredentials(providerCursor, c.env); got != c.want {
			t.Errorf("hasInjectedCredentials(cursor, %v) = %v, want %v", c.env, got, c.want)
		}
	}
	if msg := engineAuthPreflight(providerCursor, map[string]string{cursorAPIKeyVar: cursorTestKey}); msg != "" {
		t.Fatalf("a session on a Cursor key was held to the runner's sign-in: %s", msg)
	}
}
