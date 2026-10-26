package main

// A Cursor CLI conversation stays on the identity it was opened on (cursor_identity_pin.go), run against the
// P0 recordings replayed by fake_cursor_acp_test.go. A session whose conversation was opened on its workspace's
// account, key or token is refused its next start in D5's words once the workspace has been moved to another,
// and nothing starts; one with nothing said yet follows the workspace; the same identity, or a runner that
// carries conversations, continues. scripts/test-cursor-identity-pin.mjs runs these by name.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The workspace's own keys and tokens a session may run on, each a different credential.
const (
	cursorPinKey      = "key_p6b-pin-first-7d1f0c2a9e4b4c06b5a1e8f3"
	cursorPinOtherKey = "key_p6b-pin-other-2b8e6f4d1c0a4f37a9d2c5e1"
)

// cursorPinRunner is a runner user of the test's own, on a platform that keeps Cursor CLI accounts: Default
// and two added accounts, Work and Other, each signed in.
type cursorPinRunner struct {
	scratch, execDir string
	work, other      accountSlot
}

func newCursorPinRunner(t *testing.T) cursorPinRunner {
	t.Helper()
	useCursorRealHome(t)
	useCursorPlatform(t, "linux", "amd64")
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	r := cursorPinRunner{scratch: runDir(cursorTestSessionID), execDir: t.TempDir()}
	for _, slot := range []struct {
		name string
		into *accountSlot
	}{{"Work", &r.work}, {"Other", &r.other}} {
		created, err := cursorAccountKind.create(slot.name)
		if err != nil {
			t.Fatal(err)
		}
		signInCursorAccount(t, created.Dir, cursorTestToken(t, time.Now().Add(48*time.Hour)))
		*slot.into = created
	}
	return r
}

// onAccount is the agent environment of a session the control plane dispatched onto one of the runner's
// accounts — the session's own pick, or its workspace's (ORBIT_CURSOR_ACCOUNT_DIR, §16.2).
func onAccount(slot accountSlot) map[string]string {
	return map[string]string{cursorAccountDirVar: slot.Dir}
}

// talk is the session's first process on env: it opens the conversation, says one turn in it, and ends.
func (r cursorPinRunner) talk(t *testing.T, env map[string]string) cursorRun {
	t.Helper()
	first, then := cursorTurns(cursorMessage("turn-1", "first message"))
	run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", sameHome: true, execDir: r.execDir,
		scratch: r.scratch, env: env, first: first, then: then})
	if run.status != stSucceeded || !run.ended || len(run.completions) != 1 || run.completions[0].Status != stSucceeded ||
		run.job.RuntimeSessionID != "<UUID_8>" {
		t.Fatalf("the first process: run (%s, ended=%v), completions %+v, conversation %q", run.status, run.ended, run.completions,
			run.job.RuntimeSessionID)
	}
	return run
}

// next is the session's next process on env, its claim carrying the conversation it has talked in, as the
// control plane hands it back (the session's runtimeSessionId): loaded, then ended.
func (r cursorPinRunner) next(t *testing.T, env map[string]string) cursorRun {
	t.Helper()
	return runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/load", sameHome: true, execDir: r.execDir,
		scratch: r.scratch, env: env, runtimeSessionID: "<UUID_8>", first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
}

// pin is the identity the session's record holds its conversation to.
func (r cursorPinRunner) pin(t *testing.T) string {
	t.Helper()
	meta := readSessionMeta(filepath.Join(r.scratch, "meta.json"))
	if meta == nil {
		t.Fatal("the session has no record")
	}
	return meta.CursorIdentity
}

// assertRefused: the start was refused in D5's words before Cursor CLI was started at all, nothing of the turn
// was said or settled, and the record still holds the conversation, to the identity it was opened on.
func (r cursorPinRunner) assertRefused(t *testing.T, run cursorRun, pin string) {
	t.Helper()
	errors := run.of("", evError)
	if run.status != stFailed || !run.ended || len(errors) != 1 || errors[0]["message"] != cursorConversationMoveRefusal {
		t.Fatalf("run = (%s, ended=%v), errors %v: want the start refused in D5's words", run.status, run.ended, errors)
	}
	if _, err := os.Stat(filepath.Join(run.fake.dir, "start.json")); !os.IsNotExist(err) {
		t.Fatalf("Cursor CLI was started to continue the conversation on another identity (start.json: %v)", err)
	}
	if len(run.completions) != 0 || len(run.events) != 1 {
		t.Fatalf("completions %+v, events %+v: want nothing but the refusal", run.completions, run.events)
	}
	meta := readSessionMeta(filepath.Join(r.scratch, "meta.json"))
	if meta == nil || meta.CursorIdentity != pin || meta.RuntimeSessionID != "<UUID_8>" || run.job.RuntimeSessionID != "<UUID_8>" {
		t.Fatalf("the record after a refusal = %+v (job's conversation %q), want conversation <UUID_8> held to %q", meta,
			run.job.RuntimeSessionID, pin)
	}
}

// assertContinued: the conversation was loaded, not opened afresh, and the session ended as asked.
func assertContinued(t *testing.T, run cursorRun) {
	t.Helper()
	if run.status != stSucceeded || !run.ended || len(run.of("", evError)) != 0 {
		t.Fatalf("run = (%s, ended=%v), errors %v", run.status, run.ended, run.of("", evError))
	}
	if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/load"}) {
		t.Fatalf("the runner asked %q, want the conversation loaded", methods)
	}
	if load := run.fake.requests(t, "session/load"); len(load) != 1 || mapValue(load[0].Message["params"])["sessionId"] != "<UUID_8>" {
		t.Fatalf("session/load = %+v", load)
	}
}

// p2Fingerprint is P2's name for a key, worked out here on its own: the first 16 hex digits of the SHA-256 of
// the trimmed key (providers/provider-engine-resolution.ts keyFingerprint).
func p2Fingerprint(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:])[:16]
}

// A session that follows its workspace's account — its claim names whichever account the workspace picked — and
// has talked there is refused its next start once the workspace has picked another account, Default included:
// Cursor CLI is never started on the other account to continue the conversation, and no new conversation is
// opened in its place.
func TestCursorIdentityPinRefusesAnotherAccount(t *testing.T) {
	t.Run("workspace-account-to-another-account", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, onAccount(r.work))
		if pin := r.pin(t); pin != "account:"+r.work.ID {
			t.Fatalf("the conversation opened on Work is held to %q", pin)
		}
		r.assertRefused(t, r.next(t, onAccount(r.other)), "account:"+r.work.ID)
	})
	t.Run("default-to-an-added-account", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{})
		if pin := r.pin(t); pin != "account:default" {
			t.Fatalf("the conversation opened on Default is held to %q", pin)
		}
		r.assertRefused(t, r.next(t, onAccount(r.work)), "account:default")
	})
	t.Run("added-account-to-default", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, onAccount(r.work))
		r.assertRefused(t, r.next(t, map[string]string{}), "account:"+r.work.ID)
	})
}

// The same for a key or token: one the workspace's env brings, replaced by another or taken away for the
// runner's sign-in, and one saved in Orbit that the session was dispatched with, replaced. The record holds a
// key or token by P2's fingerprint, never the key or token itself.
func TestCursorIdentityPinRefusesAnotherKey(t *testing.T) {
	t.Run("workspace-key-replaced", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{"CURSOR_API_KEY": cursorPinKey})
		pin := "key:" + p2Fingerprint(cursorPinKey)
		if r.pin(t) != pin {
			t.Fatalf("the conversation opened on the workspace's key is held to %q, want %q", r.pin(t), pin)
		}
		r.assertRefused(t, r.next(t, map[string]string{"CURSOR_API_KEY": cursorPinOtherKey}), pin)
	})
	t.Run("workspace-token-replaced", func(t *testing.T) {
		r := newCursorPinRunner(t)
		first, second := cursorTestToken(t, time.Now().Add(time.Hour)), cursorTestToken(t, time.Now().Add(2*time.Hour))
		r.talk(t, map[string]string{"CURSOR_AUTH_TOKEN": first})
		pin := "token:" + p2Fingerprint(first)
		if r.pin(t) != pin {
			t.Fatalf("the conversation opened on the workspace's token is held to %q, want %q", r.pin(t), pin)
		}
		r.assertRefused(t, r.next(t, map[string]string{"CURSOR_AUTH_TOKEN": second}), pin)
	})
	t.Run("workspace-key-to-the-runner-sign-in", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{"CURSOR_API_KEY": cursorPinKey})
		r.assertRefused(t, r.next(t, map[string]string{}), "key:"+p2Fingerprint(cursorPinKey))
	})
	t.Run("saved-key-replaced", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{cursorAPIKeyVar: cursorPinKey})
		r.assertRefused(t, r.next(t, map[string]string{cursorAPIKeyVar: cursorPinOtherKey}), "key:"+p2Fingerprint(cursorPinKey))
	})
	t.Run("record-holds-no-key", func(t *testing.T) {
		r := newCursorPinRunner(t)
		token := cursorTestToken(t, time.Now().Add(time.Hour))
		r.talk(t, map[string]string{"CURSOR_API_KEY": cursorPinKey, "CURSOR_AUTH_TOKEN": token})
		if pin, want := r.pin(t), "key:"+p2Fingerprint(cursorPinKey)+"+token:"+p2Fingerprint(token); pin != want {
			t.Fatalf("held to %q, want %q", pin, want)
		}
		record, err := os.ReadFile(filepath.Join(r.scratch, "meta.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{cursorPinKey, token} {
			if strings.Contains(string(record), secret) {
				t.Fatalf("the session's record holds a credential: %s", record)
			}
		}
	})
}

// A session that has not talked follows its workspace: one whose claims never opened a conversation, and one
// whose conversation was opened and never prompted — its turns so far were shell turns, and Cursor has nothing
// of it to load (§3.5) — open a conversation on the identity they run on now, which is the one they keep.
func TestCursorIdentityPinFollowsAnUnspokenSession(t *testing.T) {
	t.Run("no-conversation-yet", func(t *testing.T) {
		r := newCursorPinRunner(t)
		// An earlier claim on Work, before Cursor opened anything: the record names no conversation.
		writeSessionMeta(r.scratch, &ClaimedSession{SessionID: cursorTestSessionID, Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: onAccount(r.work)}}, r.execDir)
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "subagent-and-todos/subagent", sameHome: true, execDir: r.execDir,
			scratch: r.scratch, env: onAccount(r.other), first: first, then: then})
		if run.status != stSucceeded || len(run.completions) != 1 || run.completions[0].Status != stSucceeded || run.job.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("run = (%s, ended=%v), completions %+v", run.status, run.ended, run.completions)
		}
		if methods := run.methods(t); len(methods) < 2 || methods[1] != "session/new" {
			t.Fatalf("the runner asked %q, want a conversation opened", methods)
		}
		if pin := r.pin(t); pin != "account:"+r.other.ID {
			t.Fatalf("the conversation opened on Other is held to %q", pin)
		}
	})
	t.Run("opened-but-never-prompted", func(t *testing.T) {
		r := newCursorPinRunner(t)
		// Opened on Work, then only shell turns: Cursor keeps its meta.json and no store.db.
		writeCursorSessionMeta(r.scratch, &ClaimedSession{SessionID: cursorTestSessionID, Provider: providerCursor, RuntimeSessionID: "<UUID_0>",
			Agent: AgentExecConfig{Provider: providerCursor, Env: onAccount(r.work)}}, r.execDir, "account:"+r.work.ID)
		conversation := filepath.Join(runDir(cursorTestSessionID), "cursor", "config", "acp-sessions", "<UUID_0>")
		if err := os.MkdirAll(conversation, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(conversation, "meta.json"), []byte(`{"schemaVersion":1}`), 0o600); err != nil {
			t.Fatal(err)
		}
		run := runCursorSession(t, cursorRunOptions{recording: "subagent-and-todos/subagent", sameHome: true, execDir: r.execDir,
			scratch: r.scratch, env: onAccount(r.other), runtimeSessionID: "<UUID_0>", first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/new"}) || run.status != stSucceeded {
			t.Fatalf("the runner asked %q, run (%s, ended=%v), errors %v", methods, run.status, run.ended, run.of("", evError))
		}
		if run.job.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("conversation %q, want the one opened in its place", run.job.RuntimeSessionID)
		}
		if pin := r.pin(t); pin != "account:"+r.other.ID {
			t.Fatalf("the conversation opened on Other is held to %q", pin)
		}
	})
}

// The identity a conversation was opened on is what it continues on: the same account signed in again with a
// new token, the same key, or a runner that keeps Default and the session back on it.
func TestCursorIdentityPinContinuesOnTheSameIdentity(t *testing.T) {
	t.Run("same-account-signed-in-again", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, onAccount(r.work))
		signInCursorAccount(t, r.work.Dir, cursorTestToken(t, time.Now().Add(72*time.Hour)))
		assertContinued(t, r.next(t, onAccount(r.work)))
		if pin := r.pin(t); pin != "account:"+r.work.ID {
			t.Fatalf("held to %q after continuing on Work", pin)
		}
	})
	t.Run("same-key", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{"CURSOR_API_KEY": cursorPinKey, "WORKSPACE_NOTE": "first"})
		assertContinued(t, r.next(t, map[string]string{"CURSOR_API_KEY": cursorPinKey, "WORKSPACE_NOTE": "edited"}))
	})
	t.Run("default", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{})
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(72*time.Hour)))
		assertContinued(t, r.next(t, map[string]string{}))
	})
}

// declareCursorAccountMove has this runner declare cursor-account-move/v1 for the test: what a runner shown to
// carry a Cursor CLI conversation to another identity will declare.
func declareCursorAccountMove(t *testing.T) {
	t.Helper()
	previous := runnerCapabilitiesV1
	runnerCapabilitiesV1 += "," + cursorAccountMoveCapabilityV1
	t.Cleanup(func() { runnerCapabilitiesV1 = previous })
}

// A runner that declares cursor-account-move/v1 carries the conversation: the next start on the account or key
// the workspace was moved to continues it there, and the record then holds it to that one.
func TestCursorIdentityPinMovesOnARunnerThatCarriesIt(t *testing.T) {
	t.Run("another-account", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, onAccount(r.work))
		declareCursorAccountMove(t)
		assertContinued(t, r.next(t, onAccount(r.other)))
		if pin := r.pin(t); pin != "account:"+r.other.ID {
			t.Fatalf("the conversation continued on Other is held to %q", pin)
		}
	})
	t.Run("another-key", func(t *testing.T) {
		r := newCursorPinRunner(t)
		r.talk(t, map[string]string{"CURSOR_API_KEY": cursorPinKey})
		declareCursorAccountMove(t)
		assertContinued(t, r.next(t, map[string]string{"CURSOR_API_KEY": cursorPinOtherKey}))
		if pin, want := r.pin(t), "key:"+p2Fingerprint(cursorPinOtherKey); pin != want {
			t.Fatalf("held to %q, want %q", pin, want)
		}
	})
}

// Every other engine's session record is what it was: whichever writer records it, on whatever credential, it
// holds no Cursor CLI identity, and nothing of this is asked of its start.
func TestCursorIdentityPinLeavesOtherEnginesAlone(t *testing.T) {
	useCursorRealHome(t)
	execDir := t.TempDir()
	for _, engine := range []string{providerClaude, providerCodex, providerKimi, providerAntigravity, providerOpenCode, providerDsh} {
		t.Run(engine, func(t *testing.T) {
			scratch := t.TempDir()
			job := &ClaimedSession{SessionID: "other-engine-" + engine, SessionUUID: "other-engine-" + engine, Provider: engine,
				RuntimeSessionID: "conversation-" + engine,
				Agent:            AgentExecConfig{Provider: engine, Env: map[string]string{"CURSOR_API_KEY": cursorPinKey}}}
			for _, write := range []func(){
				func() { writeSessionMeta(scratch, job, execDir) },
				func() { writeClaudeSessionMeta(scratch, job, execDir) },
				func() { writeKimiSessionMeta(scratch, job, execDir) },
				func() { writeSessionMetaWithCodexState(scratch, job, execDir, "", "", "") },
			} {
				write()
				record, err := os.ReadFile(filepath.Join(scratch, "meta.json"))
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(record), "cursorIdentity") || strings.Contains(string(record), cursorPinKey) {
					t.Fatalf("a %s session's record holds a Cursor CLI identity: %s", engine, record)
				}
				job.Agent.Env = map[string]string{"CURSOR_API_KEY": cursorPinOtherKey}
			}
		})
	}
}
