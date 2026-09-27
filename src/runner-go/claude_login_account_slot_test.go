package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClaudeForLogin stands in for claude in the sign-in relay. Every invocation appends a line
// "<args>\t<the CLAUDE_CONFIG_DIR it runs in>" to $FAKE_CLAUDE_SEEN, and `auth login` prints the
// authorize URL the real CLI prints, then waits for a code on stdin: the right one writes the
// credentials into the directory it runs in — the file a sign-in into the wrong account would
// overwrite — and anything else is rejected the way the real CLI rejects it. `auth status` answers
// from that file.
const fakeClaudeForLogin = `dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
printf '%s\t%s\n' "$*" "$dir" >> "$FAKE_CLAUDE_SEEN"
case "$*" in
"auth login")
	printf 'Browser didn\x27t open? Use the url below to sign in:\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=fake\n\nPaste code here if prompted > '
	read -r code
	if [ "$code" = "GOOD-CODE" ]; then
		mkdir -p "$dir"
		printf '{"claudeAiOauth":{"accessToken":"%s"}}' "$dir" > "$dir/.credentials.json"
	else
		printf 'Invalid code. Please make sure the full code was copied.\n'
	fi
	;;
"auth status") [ -f "$dir/.credentials.json" ] && echo '{"loggedIn":true}' || echo '{"loggedIn":false}' ;;
*) exit 2 ;;
esac`

const claudeSignInDefaultCredentials = `{"claudeAiOauth":{"accessToken":"the machine's own login"}}`

type claudeLoginHarness struct {
	defaultDir string
	seen       string
	// The Default login's credentials, which no sign-in into another account may touch.
	sentinel    string
	sentinelMod time.Time
	relay       *loginRelay
	mu          sync.Mutex
	reports     []LoginResultRequest
}

// newClaudeLoginHarness gives the runner a throwaway HOME whose ~/.claude is the machine's own
// login (signed in: a sentinel credentials file with a pinned mtime), a throwaway ORBIT_HOME for
// added slots, and the fake claude both on PATH (which the relay execs) and as the binary the relay
// probes.
func newClaudeLoginHarness(t *testing.T) *claudeLoginHarness {
	t.Helper()
	home, _ := claudeAccountSlotTestHomes(t)
	bin := t.TempDir()
	writeFakeBin(t, bin, providerClaude, fakeClaudeForLogin)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	lookup := lookLoginEngine
	lookLoginEngine = func(name string) (string, bool) { return filepath.Join(bin, name), name == providerClaude }
	t.Cleanup(func() { lookLoginEngine = lookup })

	h := &claudeLoginHarness{
		defaultDir: filepath.Join(home, ".claude"),
		seen:       filepath.Join(t.TempDir(), "seen"),
		relay:      &loginRelay{},
	}
	t.Setenv("FAKE_CLAUDE_SEEN", h.seen)
	if def, err := claudeAccountKind.home(accountSlotDefaultID); err != nil || def != h.defaultDir {
		t.Fatalf("Default slot = %q (%v), want %q", def, err, h.defaultDir)
	}
	if err := os.MkdirAll(h.defaultDir, 0o700); err != nil {
		t.Fatal(err)
	}
	h.sentinel = filepath.Join(h.defaultDir, ".credentials.json")
	if err := os.WriteFile(h.sentinel, []byte(claudeSignInDefaultCredentials), 0o600); err != nil {
		t.Fatal(err)
	}
	// A time no write made during the test can reproduce, so a rewrite of the same bytes still shows.
	h.sentinelMod = time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(h.sentinel, h.sentinelMod, h.sentinelMod); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.relay.stop)
	return h
}

func (h *claudeLoginHarness) start(lr LoginCommand) {
	lr.Action, lr.Engine = "start", providerClaude
	h.relay.start(lr, func(res LoginResultRequest) {
		h.mu.Lock()
		h.reports = append(h.reports, res)
		h.mu.Unlock()
	})
}

func (h *claudeLoginHarness) code(lr LoginCommand) {
	lr.Action, lr.Engine = "code", providerClaude
	h.relay.submitCode(lr, func(res LoginResultRequest) {
		h.mu.Lock()
		h.reports = append(h.reports, res)
		h.mu.Unlock()
	})
}

// waitReport waits for a report of `status` about `attempt`, returning the last one it saw.
func (h *claudeLoginHarness) waitReport(t *testing.T, attempt, status string) LoginResultRequest {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		h.mu.Lock()
		reports := append([]LoginResultRequest(nil), h.reports...)
		h.mu.Unlock()
		for _, res := range reports {
			if res.Attempt == attempt && res.Status == status {
				return res
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %q report for attempt %q; got %+v", status, attempt, reports)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

/** Every call the fake claude saw, as "<args>\t<dir>". */
func (h *claudeLoginHarness) calls(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(h.seen)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

/** The one slot the attempt added, by looking at what is on disk now. */
func (h *claudeLoginHarness) addedSlot(t *testing.T) accountSlot {
	t.Helper()
	slots, err := claudeAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range slots {
		if slot.ID != accountSlotDefaultID {
			return slot
		}
	}
	t.Fatal("the attempt added no slot")
	return accountSlot{}
}

// assertDefaultUntouched: the machine's own login is bytes-for-bytes and mtime-for-mtime what it
// was. A sign-in that ran in the runner's own environment would rewrite it — which is exactly what
// an account sign-in must never do.
func (h *claudeLoginHarness) assertDefaultUntouched(t *testing.T) {
	t.Helper()
	b, err := os.ReadFile(h.sentinel)
	if err != nil {
		t.Fatalf("the machine's own login is gone: %v", err)
	}
	if string(b) != claudeSignInDefaultCredentials {
		t.Fatalf("the machine's own login was rewritten: %q", b)
	}
	info, err := os.Stat(h.sentinel)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(h.sentinelMod) {
		t.Fatalf("the machine's own login was rewritten (mtime %s, want %s)", info.ModTime(), h.sentinelMod)
	}
}

func TestClaudeLoginAccountSlotSignsInTheNamedSlot(t *testing.T) {
	h := newClaudeLoginHarness(t)
	const attempt = "2026-09-26T10:00:00.000Z"
	h.start(LoginCommand{AccountName: "Work", Attempt: attempt})

	// The URL the CLI printed reaches the page, with the account this attempt added named on it.
	awaiting := h.waitReport(t, attempt, loginAwaitingCode)
	if awaiting.URL == "" {
		t.Fatalf("no sign-in URL reported: %+v", awaiting)
	}
	slot := h.addedSlot(t)
	if awaiting.Account != slot.ID {
		t.Fatalf("report names account %q, want the slot it added (%q)", awaiting.Account, slot.ID)
	}

	// The paste goes to the account that is waiting for it.
	h.code(LoginCommand{Account: slot.ID, Code: "GOOD-CODE", Attempt: attempt})
	h.waitReport(t, attempt, loginDone)

	// Every call the CLI made ran in that slot's directory — including the login itself.
	for _, call := range h.calls(t) {
		if !strings.HasSuffix(call, "\t"+slot.Dir) {
			t.Fatalf("a claude call ran outside the slot: %q", call)
		}
	}
	if _, err := os.Stat(filepath.Join(slot.Dir, ".credentials.json")); err != nil {
		t.Fatalf("the slot was not signed in: %v", err)
	}
	h.assertDefaultUntouched(t)
}

func TestClaudeLoginAccountSlotRedeliveryAddsNoSecondSlot(t *testing.T) {
	h := newClaudeLoginHarness(t)
	const attempt = "2026-09-26T10:00:00.000Z"
	h.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	h.waitReport(t, attempt, loginAwaitingCode)
	slot := h.addedSlot(t)

	// The heartbeat redelivers the same start until the server sees a status change.
	h.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	h.code(LoginCommand{Account: slot.ID, Code: "GOOD-CODE", Attempt: attempt})
	h.waitReport(t, attempt, loginDone)

	slots, err := claudeAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 {
		t.Fatalf("slots = %#v, want Default and the one account this attempt added", slots)
	}
	h.assertDefaultUntouched(t)
}

func TestClaudeLoginAccountSlotSignsInASlotTheRunnerAlreadyHas(t *testing.T) {
	h := newClaudeLoginHarness(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	const attempt = "2026-09-26T11:00:00.000Z"
	h.start(LoginCommand{Account: work.ID, Attempt: attempt})
	h.waitReport(t, attempt, loginAwaitingCode)

	// A slot that already exists is signed into, not added again.
	slots, err := claudeAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 || slots[1].ID != work.ID || slots[1].Name != "Work" {
		t.Fatalf("slots = %#v, want Default and Work", slots)
	}
	h.code(LoginCommand{Account: work.ID, Code: "GOOD-CODE", Attempt: attempt})
	h.waitReport(t, attempt, loginDone)
	if _, err := os.Stat(filepath.Join(work.Dir, ".credentials.json")); err != nil {
		t.Fatalf("the named slot was not signed in: %v", err)
	}
	h.assertDefaultUntouched(t)
}

func TestClaudeLoginAccountSlotTakesBackTheSlotAFailedAttemptAdded(t *testing.T) {
	h := newClaudeLoginHarness(t)
	const attempt = "2026-09-26T12:00:00.000Z"
	h.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	h.waitReport(t, attempt, loginAwaitingCode)
	slot := h.addedSlot(t)

	// The relay's window closes with nobody pasting a code: the attempt is over, and an account
	// nobody signed into and nobody can sign into again is not one to leave on the machine.
	h.relay.reclaimAddedSlot(&loginRun{key: "claude/" + slot.ID, attempt: attempt, slot: slot.ID, kind: claudeAccountKind})

	if _, err := os.Lstat(slot.Dir); !os.IsNotExist(err) {
		t.Fatalf("the empty slot outlived the failed attempt (err %v)", err)
	}
	// A redelivery of that same start is told so rather than adding the account back.
	h.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	h.waitReport(t, attempt, loginFailed)
	slots, err := claudeAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 1 {
		t.Fatalf("slots = %#v, want just Default", slots)
	}
	h.assertDefaultUntouched(t)
}
