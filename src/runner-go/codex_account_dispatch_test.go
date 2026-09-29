package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A workspace on another of the machine's Codex accounts has its sessions dispatched with that
// account's CODEX_HOME in their env: the control plane stores the slot's id and resolves it against
// the accounts this runner reports. From there the runner has to run the whole engine in that slot —
// the sign-in check before the spawn, the app-server that bootstraps the SQLite state, the session's
// own app-server, and the state partition both of them open. A partition is keyed by CODEX_HOME, so a
// slot's sessions get their own, and Default's state is neither opened nor created.
//
// Every case starts from the wire: the JSON a control plane serves on claim or reclaim, decoded by
// the runner's own transport, then run through runSessionProcess — the engine check, the sign-in
// preflight and the app-server — against this test binary posing as `codex`. The fake records the
// CODEX_HOME and argv of every app-server it is spawned as, and answers `codex login status` from the
// CODEX_HOME it is asked in: signed in when that directory holds an auth.json, as the real CLI's is.

const codexAccountDispatchUp = "orbit-test: the codex session is up"

// codexAccountDispatchMachine is a runner with two Codex accounts: Default, which the runner's own
// environment selects, and Work, a slot it added. Neither is signed in yet.
type codexAccountDispatchMachine struct {
	fake        *fakeCodexBinary
	defaultHome string
	work        accountSlot
}

func newCodexAccountDispatchMachine(t *testing.T) *codexAccountDispatchMachine {
	t.Helper()
	fake := newFakeCodexBinary(t, nil, nil)
	fake.useAsRunnerDefault(t)
	fake.answerSessionsWith(t, map[string]interface{}{
		"method": "item/agentMessage/delta", "params": map[string]interface{}{"delta": codexAccountDispatchUp},
	})
	// The shim the fake installed, extended with `codex login status`, answered the way the real
	// CLI answers it: from the CODEX_HOME it runs in.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := "#!/bin/sh\n" +
		"if [ \"$1\" = login ] && [ \"$2\" = status ]; then\n" +
		"  home=\"${CODEX_HOME:-$HOME/.codex}\"\n" +
		"  printf '%s\\n' \"$home\" >> '" + filepath.Join(fake.dir, "login-status.txt") + "'\n" +
		"  [ -f \"$home/auth.json\" ] && exit 0\n" +
		"  exit 1\n" +
		"fi\n" +
		fakeCodexDirEnv + "='" + fake.dir + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(fake.bin, "codex"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	// The engine check and the preflight resolve `codex` through the service PATH, which puts the
	// installer directories of this account's real home in front of anything not already on PATH —
	// where a development machine keeps its real codex. Named behind the fake, they stay where they
	// are, so the fake is what every door finds.
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", strings.Join(append(append([]string{fake.bin}, engineInstallerDirs(u.HomeDir)...), os.Getenv("PATH")), ":"))
	if path, ok := lookEngine(providerCodex); !ok || path != filepath.Join(fake.bin, "codex") {
		t.Fatalf("the runner resolves codex to %q, not the fake", path)
	}

	work, err := codexAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	defaultHome, err := codexAccountKind.home(accountSlotDefaultID)
	if err != nil {
		t.Fatal(err)
	}
	return &codexAccountDispatchMachine{fake: fake, defaultHome: defaultHome, work: work}
}

// signIn gives an account the auth.json its `codex login status` answers from.
func (m *codexAccountDispatchMachine) signIn(t *testing.T, codexHome string) {
	t.Helper()
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(`{"orbit-test":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

type codexAccountDispatchSpawn struct {
	Argv      []string `json:"argv"`
	CodexHome string   `json:"codexHome"`
}

// appServers is every `codex app-server` the fake was spawned as, in order.
func (m *codexAccountDispatchMachine) appServers(t *testing.T) []codexAccountDispatchSpawn {
	t.Helper()
	var out []codexAccountDispatchSpawn
	for _, line := range m.fake.lines(t, "spawns.jsonl") {
		var spawn codexAccountDispatchSpawn
		if err := json.Unmarshal([]byte(line), &spawn); err != nil {
			t.Fatal(err)
		}
		out = append(out, spawn)
	}
	return out
}

// askedToSignIn is the CODEX_HOME of every `codex login status`, in order.
func (m *codexAccountDispatchMachine) askedToSignIn(t *testing.T) []string {
	t.Helper()
	return m.fake.lines(t, "login-status.txt")
}

// sqliteHome is the state directory an app-server was pointed at (`-c sqlite_home="<dir>"`).
func (s codexAccountDispatchSpawn) sqliteHome(t *testing.T) string {
	t.Helper()
	for i, arg := range s.Argv {
		if arg != "-c" || i+1 == len(s.Argv) || !strings.HasPrefix(s.Argv[i+1], "sqlite_home=") {
			continue
		}
		dir, err := strconv.Unquote(strings.TrimPrefix(s.Argv[i+1], "sqlite_home="))
		if err != nil {
			t.Fatal(err)
		}
		return dir
	}
	t.Fatalf("app-server spawned without a sqlite_home: %v", s.Argv)
	return ""
}

// partitionDir is the shared state directory the runner keeps for one CODEX_HOME.
func codexAccountDispatchPartitionDir(t *testing.T, codexHome string) string {
	t.Helper()
	root, err := filepath.Abs(codexStateRoot())
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, codexStatePartition(codexHome))
}

// codexAccountDispatchControlPlane serves one session on both doors a runner is handed one
// through — claim, and the reclaim a restarted runner rebuilds from — as the JSON the control plane
// sends, and has nothing to say to it afterwards: every inbox poll ends empty.
func codexAccountDispatchControlPlane(t *testing.T, sessionID string, env map[string]string) string {
	t.Helper()
	agent := map[string]interface{}{"provider": providerCodex, "model": "gpt-5.5", "permissionMode": "default", "env": env}
	claim, err := json.Marshal(map[string]interface{}{
		"sessionId": sessionID, "title": "a codex session", "provider": providerCodex, "prompt": "hello",
		"sessionUuid": sessionID, "maxSeq": 0, "agent": agent,
	})
	if err != nil {
		t.Fatal(err)
	}
	reclaim, err := json.Marshal(map[string]interface{}{"sessions": []interface{}{map[string]interface{}{
		"sessionId": sessionID, "title": "a codex session", "status": stRunning, "provider": providerCodex,
		"sessionUuid": sessionID, "maxSeq": 0, "agent": agent,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions/claim":
			_, _ = w.Write(claim)
		case "/api/runner/sessions/reclaim":
			_, _ = w.Write(reclaim)
		default:
			select {
			case <-r.Context().Done():
			case <-time.After(200 * time.Millisecond):
			}
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	return server.URL
}

// claimedThrough takes the session through one door of the control plane at url, decoded by the
// runner's own transport the way the run loop decodes it.
func claimedThrough(t *testing.T, door, url string) *ClaimedSession {
	t.Helper()
	transport := NewTransport(url, "runner-token")
	switch door {
	case "claim":
		job, err := transport.claimSession(context.Background())
		if err != nil || job == nil {
			t.Fatalf("claim: %v, %+v", err, job)
		}
		return job
	case "reclaim":
		resp, err := transport.reclaim(context.Background())
		if err != nil || len(resp.Sessions) != 1 {
			t.Fatalf("reclaim: %v, %+v", err, resp)
		}
		return claimedSessionFromReclaim(resp.Sessions[0])
	}
	t.Fatalf("no door %q", door)
	return nil
}

// runCodexAccountDispatchSession runs job as a claim runs it — engine check, sign-in preflight,
// app-server — in scratchDir, until the session is up or ends on its own, then stops it. It reports
// whether the session came up, and every error it emitted.
func runCodexAccountDispatchSession(t *testing.T, url string, job *ClaimedSession, scratchDir string) (bool, []string) {
	t.Helper()
	execDir := t.TempDir()
	var mu sync.Mutex
	var errs []string
	up := make(chan struct{})
	var once sync.Once
	emit := func(eventType string, payload map[string]interface{}) {
		switch {
		case eventType == evTextDelta && payload["text"] == codexAccountDispatchUp:
			once.Do(func() { close(up) })
		case eventType == evError:
			mu.Lock()
			errs = append(errs, asString(payload["message"]))
			mu.Unlock()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ended := make(chan string, 1)
	go func() {
		status, _, _ := runSessionProcess(ctx, context.Background(), NewTransport(url, "runner-token"), job, "", execDir, scratchDir,
			emit, func(string, string, map[string]interface{}) {}, func(string) {}, true, nil, nil,
			func(TurnCompleteRequest, ...context.Context) error { return nil }, func(context.Context) bool { return true }, func(error) {})
		ended <- status
	}()
	cameUp := false
	select {
	case <-up:
		cameUp = true
		cancel()
		select {
		case <-ended:
		case <-time.After(30 * time.Second):
			t.Fatal("the session did not end once cancelled")
		}
	case <-ended:
	case <-time.After(30 * time.Second):
		t.Fatal("the session neither came up nor ended")
	}
	mu.Lock()
	defer mu.Unlock()
	return cameUp, append([]string(nil), errs...)
}

// The session's whole engine runs in the slot its claim names, whichever door it came through —
// with Default signed out, which is the machine this matters on: an account signed in only as Work.
func TestCodexAccountDispatchRunsTheClaimedSessionInItsSlot(t *testing.T) {
	for _, door := range []string{"claim", "reclaim"} {
		t.Run(door, func(t *testing.T) {
			m := newCodexAccountDispatchMachine(t)
			m.signIn(t, m.work.Dir)
			const sessionID = "7c1e5a90-3b2d-4f6e-9a8c-1d2e3f4a5b6c"
			url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"CODEX_HOME": m.work.Dir, "RUST_LOG": "warn"})
			job := claimedThrough(t, door, url)
			if got := job.Agent.Env["CODEX_HOME"]; got != m.work.Dir {
				t.Fatalf("the %s decoded CODEX_HOME %q, want the slot's %q", door, got, m.work.Dir)
			}
			scratch := t.TempDir()
			if up, errs := runCodexAccountDispatchSession(t, url, job, scratch); !up {
				t.Fatalf("a session on a signed-in account did not come up: %v", errs)
			}

			// Signed in was asked of the slot, never of Default (whose answer is "signed out").
			if asked := m.askedToSignIn(t); len(asked) != 1 || asked[0] != m.work.Dir {
				t.Fatalf("`codex login status` ran in %v, want the slot %s", asked, m.work.Dir)
			}
			// Both app-servers — the state bootstrap and the session's own — ran in the slot, on the
			// slot's state partition.
			partition := codexAccountDispatchPartitionDir(t, m.work.Dir)
			spawns := m.appServers(t)
			if len(spawns) < 2 {
				t.Fatalf("want the state bootstrap and the session's app-server, got %d spawns: %+v", len(spawns), spawns)
			}
			for i, spawn := range spawns {
				if spawn.CodexHome != m.work.Dir {
					t.Fatalf("app-server %d ran with CODEX_HOME %q, want the slot %q", i, spawn.CodexHome, m.work.Dir)
				}
				if got := spawn.sqliteHome(t); got != partition {
					t.Fatalf("app-server %d opened state %s, want the slot's partition %s", i, got, partition)
				}
			}
			// The session remembers the slot as its account, so every later spawn of it stays there.
			meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
			if meta == nil || meta.CodexStateLayout != codexStateLayoutShared || meta.CodexStateHome != m.work.Dir ||
				meta.CodexStatePartition != codexStatePartition(m.work.Dir) {
				t.Fatalf("session meta %+v, want the slot's shared state", meta)
			}
			// Default's state was never opened, and never made: the two accounts share nothing.
			if codexStatePartition(m.defaultHome) == codexStatePartition(m.work.Dir) {
				t.Fatal("Default and the slot map to one partition")
			}
			if _, err := os.Stat(codexAccountDispatchPartitionDir(t, m.defaultHome)); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("Default's state partition exists (%v): a session on the slot opened it", err)
			}
		})
	}
}

// The same machine, a claim that names no account: everything runs where the runner's own
// environment points, which is Default. Without this the case above could pass on a runner that put
// every session in the same place.
func TestCodexAccountDispatchWithoutAnAccountRunsOnDefault(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.defaultHome)
	const sessionID = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
	url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"RUST_LOG": "warn"})
	if up, errs := runCodexAccountDispatchSession(t, url, claimedThrough(t, "claim", url), t.TempDir()); !up {
		t.Fatalf("a session on Default did not come up: %v", errs)
	}
	partition := codexAccountDispatchPartitionDir(t, m.defaultHome)
	for i, spawn := range m.appServers(t) {
		if spawn.CodexHome != m.defaultHome || spawn.sqliteHome(t) != partition {
			t.Fatalf("app-server %d ran in %q on %s, want Default %q on %s", i, spawn.CodexHome, spawn.sqliteHome(t), m.defaultHome, partition)
		}
	}
	if _, err := os.Stat(codexAccountDispatchPartitionDir(t, m.work.Dir)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the slot's state partition exists (%v): a session on Default opened it", err)
	}
}

// Signed out is judged on the account the session will run on. With Default signed in and the slot
// not, the session is refused before any engine is spawned — the answer Default would have given
// is not the slot's, and the app-server would only have met a 401 twenty seconds later.
func TestCodexAccountDispatchRefusesASessionWhoseSlotIsSignedOut(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.defaultHome)
	const sessionID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
	url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"CODEX_HOME": m.work.Dir})
	up, errs := runCodexAccountDispatchSession(t, url, claimedThrough(t, "claim", url), t.TempDir())
	if up || len(errs) == 0 || !strings.HasPrefix(errs[0], "Failed to authenticate") {
		t.Fatalf("a session on a signed-out slot came up=%v with errors %v, want the signed-out refusal", up, errs)
	}
	if asked := m.askedToSignIn(t); len(asked) != 1 || asked[0] != m.work.Dir {
		t.Fatalf("`codex login status` ran in %v, want the slot %s", asked, m.work.Dir)
	}
	if spawns := m.appServers(t); len(spawns) != 0 {
		t.Fatalf("a refused session spawned %d app-servers", len(spawns))
	}
}

// A session keeps the account its state was first opened under — its thread lives in that
// CODEX_HOME — unless it can follow a later claim naming another one: the account it is switched to
// is asked first, and when that one is not signed in yet the session runs where it was, and its
// sign-in is asked there — that is no reason to refuse a session that is not moving.
func TestCodexAccountDispatchKeepsASessionOnTheSlotItStartedIn(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.work.Dir)
	other, err := codexAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	const sessionID = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f"
	scratch := t.TempDir()
	// What its first spawn wrote before the engine came up: the slot, as its account.
	started := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex}
	writeSessionMetaWithCodexState(scratch, started, t.TempDir(), codexStateLayoutShared, codexStatePartition(m.work.Dir), m.work.Dir)

	url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"CODEX_HOME": other.Dir})
	if up, errs := runCodexAccountDispatchSession(t, url, claimedThrough(t, "claim", url), scratch); !up {
		t.Fatalf("the session was not resumed on the account it started in: %v", errs)
	}
	if asked := m.askedToSignIn(t); len(asked) != 2 || asked[0] != other.Dir || asked[1] != m.work.Dir {
		t.Fatalf("`codex login status` ran in %v, want the account it was switched to, %s, then the one it started in, %s",
			asked, other.Dir, m.work.Dir)
	}
	partition := codexAccountDispatchPartitionDir(t, m.work.Dir)
	for i, spawn := range m.appServers(t) {
		if spawn.CodexHome != m.work.Dir || spawn.sqliteHome(t) != partition {
			t.Fatalf("app-server %d ran in %q on %s, want %q on %s", i, spawn.CodexHome, spawn.sqliteHome(t), m.work.Dir, partition)
		}
	}
}

// A session the control plane moved off an account whose usage limit stopped it is claimed naming the
// account it moved to. When that account is signed in, the thread follows: its rollout and its
// sub-agents' are copied into the new CODEX_HOME at the same relative paths, the session's meta is
// pointed there, and the whole
// engine — the sign-in check, the state partition, the app-server that resumes the thread by id — runs
// in the new account. The old account keeps its copy.
func TestCodexAccountDispatchMovesASessionToTheSignedInAccountItsClaimNames(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.work.Dir)
	other, err := codexAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	m.signIn(t, other.Dir)
	const sessionID = "4d5e6f7a-8b9c-4dae-8f01-3b4c5d6e7f80"
	const thread = "01a0eae2-75e2-77d0-b2fa-014b49b2870a"
	scratch := t.TempDir()
	started := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex, RuntimeSessionID: thread}
	writeSessionMetaWithCodexState(scratch, started, t.TempDir(), codexStateLayoutShared, codexStatePartition(m.work.Dir), m.work.Dir)
	rel := filepath.Join("sessions", "2026", "09", "29", "rollout-2026-09-29T03-58-25-"+thread+".jsonl")
	rollout := []byte(`{"type":"session_meta","payload":{"id":"` + thread + `"}}` + "\n" + `{"type":"response_item","payload":{"type":"message","role":"user"}}` + "\n")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(m.work.Dir, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.work.Dir, rel), rollout, 0o600); err != nil {
		t.Fatal(err)
	}
	// A sub-agent it spawned the next day, and a thread of another session's, whose rollouts name only
	// their own ids: the first line says which thread each belongs to.
	subagent := filepath.Join("sessions", "2026", "09", "30", "rollout-2026-09-30T08-00-00-01a0ef00-0000-7000-8000-000000000001.jsonl")
	stranger := filepath.Join("sessions", "2026", "09", "30", "rollout-2026-09-30T08-00-01-01a0ef00-0000-7000-8000-000000000002.jsonl")
	for path, belongsTo := range map[string]string{subagent: thread, stranger: "01a0ef00-0000-7000-8000-00000000000f"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(m.work.Dir, path)), 0o755); err != nil {
			t.Fatal(err)
		}
		line := `{"type":"session_meta","payload":{"session_id":"` + belongsTo + `","thread_source":"subagent"}}` + "\n"
		if err := os.WriteFile(filepath.Join(m.work.Dir, path), []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"CODEX_HOME": other.Dir})
	job := claimedThrough(t, "claim", url)
	job.RuntimeSessionID = thread
	if up, errs := runCodexAccountDispatchSession(t, url, job, scratch); !up {
		t.Fatalf("the moved session was not resumed on the account its claim names: %v", errs)
	}
	if got, err := os.ReadFile(filepath.Join(other.Dir, rel)); err != nil || string(got) != string(rollout) {
		t.Fatalf("the thread's rollout in the new account: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(m.work.Dir, rel)); err != nil {
		t.Fatalf("the old account lost its copy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(other.Dir, subagent)); err != nil {
		t.Fatalf("the sub-agent's rollout did not follow its thread: %v", err)
	}
	if _, err := os.Stat(filepath.Join(other.Dir, stranger)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("another session's rollout was carried along: %v", err)
	}
	if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.CodexStateHome != other.Dir ||
		meta.CodexStatePartition != codexStatePartition(other.Dir) {
		t.Fatalf("the session's meta still points at %+v", meta)
	}
	for i, home := range m.askedToSignIn(t) {
		if home != other.Dir {
			t.Fatalf("`codex login status` %d ran in %s, want the account the session moved to, %s", i, home, other.Dir)
		}
	}
	partition := codexAccountDispatchPartitionDir(t, other.Dir)
	spawns := m.appServers(t)
	if len(spawns) == 0 {
		t.Fatal("no app-server was spawned")
	}
	for i, spawn := range spawns {
		if spawn.CodexHome != other.Dir || spawn.sqliteHome(t) != partition {
			t.Fatalf("app-server %d ran in %q on %s, want %q on %s", i, spawn.CodexHome, spawn.sqliteHome(t), other.Dir, partition)
		}
	}
}

// A thread that cannot be carried stays where it is, and so does a session whose claim names a
// CODEX_HOME that is no account of this runner: nothing is copied, and the meta is not touched.
func TestCodexThreadStaysWhereItCannotBeCarried(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.work.Dir)
	other, err := codexAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	m.signIn(t, other.Dir)
	const sessionID = "5e6f7a8b-9cad-4ebf-9012-4c5d6e7f8091"
	stray := t.TempDir()
	m.signIn(t, stray)
	for name, env := range map[string]map[string]string{
		"no rollout of the thread in its home": {"CODEX_HOME": other.Dir},
		"a CODEX_HOME no account is":           {"CODEX_HOME": stray},
		"a key of its own":                     {"CODEX_HOME": other.Dir, "OPENAI_API_KEY": "sk-test"},
	} {
		scratch := t.TempDir()
		started := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex, RuntimeSessionID: "thread-without-a-rollout"}
		writeSessionMetaWithCodexState(scratch, started, t.TempDir(), codexStateLayoutShared, codexStatePartition(m.work.Dir), m.work.Dir)
		job := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex, RuntimeSessionID: "thread-without-a-rollout",
			Agent: AgentExecConfig{Provider: providerCodex, Env: env}}
		moved, err := moveCodexThreadToClaimedAccount(job, scratch, t.TempDir())
		if err != nil || moved {
			t.Fatalf("%s: moved=%v err=%v", name, moved, err)
		}
		if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.CodexStateHome != m.work.Dir {
			t.Fatalf("%s: the meta moved to %+v", name, meta)
		}
	}
}

// The runner says it can carry a thread to another account, in the words the control plane asks for:
// a session is moved off a spent account only on a runner that declares codex-account-move/v1.
func TestTheRunnerDeclaresItCarriesCodexThreadsToAnotherAccount(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+codexAccountMoveCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", codexAccountMoveCapabilityV1, runnerCapabilitiesV1)
	}
	controller, err := os.ReadFile(filepath.Join("..", "apiserver", "src", "runner-api", "runner-api.controller.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "CODEX_ACCOUNT_MOVE_V1 = '" + codexAccountMoveCapabilityV1 + "'"; !strings.Contains(string(controller), want) {
		t.Fatalf("the control plane does not ask for %s in those words (%s)", codexAccountMoveCapabilityV1, want)
	}
}
