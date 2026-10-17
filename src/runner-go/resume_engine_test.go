package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// resumeHelperSessionEnv names the session TestOrbitResumeHelperProcess resumes in its own process.
const resumeHelperSessionEnv = "ORBIT_T5_RESUME_SESSION"

// T5 (docs/provider-engine-contract.md §6.3, §8.2 item 7): a session `orbit resume` knows only from
// the control plane is resumed on the engine the server reports for it — `engine`, or from a control
// plane older than that field, `provider`, which carried it — and the rest of the record comes along.
func TestResumeMetaTakesTheSessionEngineFromTheServer(t *testing.T) {
	workDir := "/srv/repo"
	for _, tc := range []struct {
		name string
		resp SessionMetaResponse
		want string
	}{
		{name: "engine and provider agree", resp: SessionMetaResponse{Engine: "dsh", Provider: "dsh"}, want: "dsh"},
		{name: "the engine field wins", resp: SessionMetaResponse{Engine: "codex", Provider: "claude"}, want: "codex"},
		{name: "an older control plane names it in provider", resp: SessionMetaResponse{Provider: "kimi"}, want: "kimi"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.resp.SessionUUID, tc.resp.RuntimeSessionID, tc.resp.Title, tc.resp.WorkDir = "rt-1", "rt-1", "Review", &workDir
			meta := resumeMetaFromServer(&tc.resp)
			want := &sessionMeta{Provider: tc.want, SessionUUID: "rt-1", RuntimeSessionID: "rt-1", Title: "Review", WorkDir: workDir}
			if !reflect.DeepEqual(meta, want) {
				t.Fatalf("meta = %#v, want %#v", meta, want)
			}
		})
	}
}

// `orbit resume` on a DeepSeek Harness session takes the dsh branch. Before it, a dsh session fell
// through to the claude fallback and started Claude Code on a Harness conversation id. Orbit runs
// Harness only over ACP in a sealed per-session home, the install has no terminal interface and the
// session's key is never stored on the machine, so the branch refuses, saying why and how to go on —
// while every other engine keeps the CLI it reopens with.
func TestResumeOnADshSessionTakesTheDshBranch(t *testing.T) {
	const sessionID = "01a113f1-eec1-77dc-b73f-d222d66a53e5"
	cmd, err := resumeCommand(sessionID, t.TempDir(), &sessionMeta{
		Provider: providerDsh, SessionUUID: "a068effa-91bd-4ef4-9949-cd7e5d095546",
		RuntimeSessionID: "a068effa-91bd-4ef4-9949-cd7e5d095546", WorkDir: t.TempDir(),
	})
	if cmd != nil || err == nil {
		t.Fatalf("a DeepSeek Harness session resumed as %v (err %v)", cmd, err)
	}
	for _, want := range []string{"DeepSeek Harness", "cannot open in a terminal", "ACP", "DeepSeek key",
		"orbit session send " + publicID(sessionID)} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("refusal does not say %q: %q", want, err)
		}
	}

	for _, tc := range []struct {
		meta sessionMeta
		want []string
	}{
		{meta: sessionMeta{Provider: providerClaude, SessionUUID: "claude-uuid"}, want: []string{"claude", "--resume", "claude-uuid"}},
		{meta: sessionMeta{Provider: "", SessionUUID: "claude-uuid"}, want: []string{"claude", "--resume", "claude-uuid"}},
		{meta: sessionMeta{Provider: providerOpenCode, RuntimeSessionID: "ses_1"}, want: []string{"opencode", "--session", "ses_1"}},
		{meta: sessionMeta{Provider: providerKimi, RuntimeSessionID: "session_1"}, want: []string{"kimi", "--resume", "session_1"}},
	} {
		meta := tc.meta
		cmd, err := resumeCommand(sessionID, t.TempDir(), &meta)
		if err != nil {
			t.Fatalf("%s session: %v", tc.meta.Provider, err)
		}
		if got := append([]string{filepath.Base(cmd.Args[0])}, cmd.Args[1:]...); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%q session resumes as %q, want %q", tc.meta.Provider, got, tc.want)
		}
	}
}

// The same, end to end: `orbit resume` in a process of its own, on a DeepSeek Harness session it
// knows from this machine's own record and on one it knows only from the control plane's meta. Each
// exits 1 with the refusal, and no CLI — claude least of all — is started.
func TestOrbitResumeOfADshSessionStartsNoCLI(t *testing.T) {
	const sessionID = "01a113f1-eec1-77dc-b73f-d222d66a53e5"
	const runtimeID = "a068effa-91bd-4ef4-9949-cd7e5d095546"
	for _, tc := range []struct {
		name  string
		local bool
	}{
		{name: "from the local record", local: true},
		{name: "from the server meta", local: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			var metaReads int
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/"+sessionID+"/meta" {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				metaReads++
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"engine": "dsh", "provider": "dsh", "sessionUuid": runtimeID, "runtimeSessionId": runtimeID,
					"workDir": workDir, "title": "Harness session",
				})
			}))
			defer srv.Close()
			configureCLITestRunner(t, srv.URL)
			if tc.local {
				if err := os.MkdirAll(runDir(sessionID), 0o700); err != nil {
					t.Fatal(err)
				}
				record, _ := json.Marshal(sessionMeta{Provider: providerDsh, SessionUUID: runtimeID, RuntimeSessionID: runtimeID, WorkDir: workDir})
				if err := os.WriteFile(filepath.Join(runDir(sessionID), "meta.json"), record, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			// Every CLI a resume could start, each leaving a mark if it ever runs.
			bin, marks := t.TempDir(), t.TempDir()
			for _, cli := range []string{"claude", "dsh", "codex", "kimi", "opencode", agyExecutable} {
				script := "#!/bin/sh\necho \"$0 $*\" >> " + filepath.Join(marks, "started") + "\n"
				if err := os.WriteFile(filepath.Join(bin, cli), []byte(script), 0o755); err != nil {
					t.Fatal(err)
				}
			}

			child := exec.Command(os.Args[0], "-test.run=^TestOrbitResumeHelperProcess$")
			child.Env = append(os.Environ(), resumeHelperSessionEnv+"="+publicID(sessionID),
				"PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			out, err := child.CombinedOutput()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
				t.Fatalf("orbit resume ended with %v, want exit 1; output:\n%s", err, out)
			}
			if !strings.Contains(string(out), "this session runs on DeepSeek Harness, which orbit resume cannot open in a terminal") {
				t.Fatalf("orbit resume output:\n%s", out)
			}
			if strings.Contains(string(out), "resuming session") {
				t.Fatalf("orbit resume announced a resume it refused:\n%s", out)
			}
			if started, err := os.ReadFile(filepath.Join(marks, "started")); err == nil {
				t.Fatalf("orbit resume started a CLI: %s", started)
			}
			if tc.local && metaReads != 0 {
				t.Fatalf("a session with its own record asked the control plane %d times", metaReads)
			}
			if !tc.local {
				if metaReads != 1 {
					t.Fatalf("meta reads = %d, want 1", metaReads)
				}
				cached := readSessionMeta(filepath.Join(runDir(sessionID), "meta.json"))
				if cached == nil || cached.Provider != providerDsh || cached.RuntimeSessionID != runtimeID {
					t.Fatalf("cached record = %#v, want the dsh session the server described", cached)
				}
			}
		})
	}
}

// TestOrbitResumeHelperProcess is the child half of TestOrbitResumeOfADshSessionStartsNoCLI:
// `orbit resume <session>` as the command line runs it, in its own process because a refusal exits.
func TestOrbitResumeHelperProcess(t *testing.T) {
	sessionID := os.Getenv(resumeHelperSessionEnv)
	if sessionID == "" {
		t.Skip("child process of TestOrbitResumeOfADshSessionStartsNoCLI")
	}
	cmdResume([]string{sessionID})
	os.Exit(0)
}
