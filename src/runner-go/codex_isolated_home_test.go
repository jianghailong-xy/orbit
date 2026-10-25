package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// A session whose claim injects credentials of its own — a custom provider, the Codex pool — runs on
// none of the runner's accounts, and these cases run it the way a claim does (the dispatch machine of
// codex_account_dispatch_test.go) to show where its engine ends up.

var codexInjectedCredentials = map[string]string{"OPENAI_BASE_URL": "https://gateway.test/v1", "OPENAI_API_KEY": "sk-pool"}

func codexIsolatedHome(t *testing.T, scratch string) string {
	t.Helper()
	home, err := filepath.Abs(filepath.Join(scratch, "codex-home"))
	if err != nil {
		t.Fatal(err)
	}
	return home
}

// The app-server runs in a CODEX_HOME of the session's own, with its SQLite state beside it, and no
// shared partition is bootstrapped. Nothing of the runner's home comes with it: not the account's
// configuration — the session's is the one Orbit builds for it — not its history, which a fresh
// state database would make Codex read in full before answering initialize (on a busy runner, for
// longer than the handshake was allowed), and not its login.
func TestCodexCredentialIsolatedSessionRunsInAHomeOfItsOwn(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.defaultHome)
	history := filepath.Join(m.defaultHome, "sessions", "2026", "09", "30", "rollout-2026-09-30T08-00-00-01a0ef00-0000-7000-8000-000000000003.jsonl")
	if err := os.MkdirAll(filepath.Dir(history), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(history, []byte(`{"type":"session_meta","payload":{"id":"01a0ef00-0000-7000-8000-000000000003"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.defaultHome, "config.toml"), []byte("model = \"gpt-5.5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	const sessionID = "6f7a8b9c-adbe-4fc0-9123-5d6e7f8091a2"
	url := codexAccountDispatchControlPlane(t, sessionID, codexInjectedCredentials)
	scratch := t.TempDir()
	if up, errs := runCodexAccountDispatchSession(t, url, claimedThrough(t, "claim", url), scratch); !up {
		t.Fatalf("a session on injected credentials did not come up: %v", errs)
	}

	home := codexIsolatedHome(t, scratch)
	spawns := m.appServers(t)
	if len(spawns) != 1 {
		t.Fatalf("want the session's own app-server and no shared bootstrap, got %d spawns: %+v", len(spawns), spawns)
	}
	if spawns[0].CodexHome != home || spawns[0].sqliteHome(t) != home {
		t.Fatalf("the app-server ran in %q on %s, want both %s", spawns[0].CodexHome, spawns[0].sqliteHome(t), home)
	}
	if _, err := os.Lstat(filepath.Join(home, "config.toml")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the session's home carries the runner's configuration (config.toml: %v)", err)
	}
	if info, err := os.Lstat(filepath.Join(home, "sessions")); err == nil && info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("the session's home links the runner's history")
	}
	if _, err := os.Lstat(filepath.Join(home, "auth.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the session's home has the runner's login (%v)", err)
	}
	if asked := m.askedToSignIn(t); len(asked) != 0 {
		t.Fatalf("a session on injected credentials asked after the runner's login in %v", asked)
	}
	if _, err := os.Stat(codexAccountDispatchPartitionDir(t, m.defaultHome)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Default's state partition exists (%v): the isolated session opened it", err)
	}
	if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil ||
		meta.CodexStateLayout != codexStateLayoutIsolated || meta.CodexStateHome != home {
		t.Fatalf("session meta %+v, want the home of its own", meta)
	}
}

// A session the legacy layout left stuck — its marker written before the spawn, its first start timed
// out in the cold backfill, no thread to show for it — is placed afresh when it is sent again: in a
// home of its own while it still injects credentials, and on Default's shared state once its provider
// is switched to the built-in one.
func TestCodexPreThreadLegacySessionIsPlacedAfresh(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"still on injected credentials":     codexInjectedCredentials,
		"switched to the built-in provider": {"RUST_LOG": "warn"},
	} {
		t.Run(name, func(t *testing.T) {
			m := newCodexAccountDispatchMachine(t)
			m.signIn(t, m.defaultHome)
			const sessionID = "7a8b9cad-becf-4d01-a234-6e7f8091a2b3"
			scratch := t.TempDir()
			started := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex}
			writeSessionMetaWithCodexState(scratch, started, t.TempDir(), codexStateLayoutLegacy, "", "")
			if err := os.MkdirAll(filepath.Join(scratch, "codex-state"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(scratch, "codex-state", "state_5.sqlite"), []byte("a backfill never finished"), 0o600); err != nil {
				t.Fatal(err)
			}

			url := codexAccountDispatchControlPlane(t, sessionID, env)
			if up, errs := runCodexAccountDispatchSession(t, url, claimedThrough(t, "claim", url), scratch); !up {
				t.Fatalf("the stuck session did not come up when sent again: %v", errs)
			}
			wantLayout, wantHome, wantState := codexStateLayoutIsolated, codexIsolatedHome(t, scratch), codexIsolatedHome(t, scratch)
			if env["OPENAI_API_KEY"] == "" {
				wantLayout, wantHome, wantState = codexStateLayoutShared, m.defaultHome, codexAccountDispatchPartitionDir(t, m.defaultHome)
			}
			spawns := m.appServers(t)
			if len(spawns) == 0 {
				t.Fatal("no app-server was spawned")
			}
			for i, spawn := range spawns {
				if spawn.CodexHome != wantHome || spawn.sqliteHome(t) != wantState {
					t.Fatalf("app-server %d ran in %q on %s, want %q on %s", i, spawn.CodexHome, spawn.sqliteHome(t), wantHome, wantState)
				}
			}
			if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.CodexStateLayout != wantLayout {
				t.Fatalf("session meta %+v, want %s", meta, wantLayout)
			}
		})
	}
}

// An isolated session with a thread, revived on the runner's own login — its provider switched to the
// built-in one — carries that thread onto Default, as a move between two accounts does: the home of
// its own holds no login to resume it with.
func TestCodexIsolatedSessionRevivedOnTheRunnersLoginCarriesItsThread(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.defaultHome)
	const sessionID = "8b9cadbe-cfd0-4e12-b345-7f8091a2b3c4"
	const thread = "01a0f856-f5ad-7000-8000-00000000000a"
	scratch := t.TempDir()
	home := codexIsolatedHome(t, scratch)
	started := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex, RuntimeSessionID: thread}
	writeSessionMetaWithCodexState(scratch, started, t.TempDir(), codexStateLayoutIsolated, "", home)
	rel := filepath.Join("sessions", "2026", "10", "01", "rollout-2026-10-01T16-40-29-"+thread+".jsonl")
	rollout := []byte(`{"type":"session_meta","payload":{"id":"` + thread + `"}}` + "\n")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(home, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, rel), rollout, 0o600); err != nil {
		t.Fatal(err)
	}

	url := codexAccountDispatchControlPlane(t, sessionID, map[string]string{"RUST_LOG": "warn"})
	job := claimedThrough(t, "claim", url)
	job.RuntimeSessionID = thread
	if up, errs := runCodexAccountDispatchSession(t, url, job, scratch); !up {
		t.Fatalf("the revived session was not resumed on Default: %v", errs)
	}
	if got, err := os.ReadFile(filepath.Join(m.defaultHome, rel)); err != nil || string(got) != string(rollout) {
		t.Fatalf("the thread's rollout on Default: %q, %v", got, err)
	}
	if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.CodexStateLayout != codexStateLayoutShared ||
		meta.CodexStateHome != m.defaultHome || meta.CodexStatePartition != codexStatePartition(m.defaultHome) {
		t.Fatalf("session meta %+v, want Default's shared state", meta)
	}
	partition := codexAccountDispatchPartitionDir(t, m.defaultHome)
	spawns := m.appServers(t)
	if len(spawns) == 0 {
		t.Fatal("no app-server was spawned")
	}
	for i, spawn := range spawns {
		if spawn.CodexHome != m.defaultHome || spawn.sqliteHome(t) != partition {
			t.Fatalf("app-server %d ran in %q on %s, want Default %q on %s", i, spawn.CodexHome, spawn.sqliteHome(t), m.defaultHome, partition)
		}
	}
}
