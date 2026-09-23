package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCodexForLogin stands in for codex in the sign-in relay. Every invocation appends a line
// "<args>\t<the CODEX_HOME it runs in>\t<CODEX_HOME as it was set>" to $FAKE_CODEX_SEEN and, like
// the real CLI (which unpacks helper binaries under $CODEX_HOME/tmp/arg0 even to print its help),
// writes into the CODEX_HOME it runs in. `login --device-auth` prints the device flow, waits for
// the test to approve it by creating <home>/approve, then writes <home>/auth.json — the
// credentials a sign-in into the wrong account would overwrite. `login status` answers from that
// file.
const fakeCodexForLogin = `home=${CODEX_HOME:-$HOME/.codex}
printf '%s\t%s\t%s\n' "$*" "$home" "$CODEX_HOME" >> "$FAKE_CODEX_SEEN"
mkdir -p "$home/tmp/arg0" && : > "$home/tmp/arg0/fake-codex"
case "$*" in
"login --help") echo "      --device-auth  Sign in with a device code" ;;
"login --device-auth")
	printf '1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n'
	printf '2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGH\n\n'
	while [ ! -e "$home/approve" ]; do sleep 0.05; done
	printf '{"tokens":"%s"}' "$home" > "$home/auth.json"
	;;
"login status") [ -f "$home/auth.json" ] ;;
*) exit 2 ;;
esac`

const codexLoginDefaultCredentials = `{"tokens":"the machine's own account"}`

type codexLoginHarness struct {
	defaultHome string
	seen        string
	// The Default account's credentials, which no sign-in into another account may touch.
	sentinel    string
	sentinelMod time.Time
	// Everything under the Default CODEX_HOME before the sign-in ran.
	defaultTree []string
	relay       *loginRelay
	mu          sync.Mutex
	reports     []LoginResultRequest
}

// newCodexLoginHarness gives the runner a throwaway HOME whose ~/.codex is the Default account
// (signed in: a sentinel auth.json with a pinned mtime), a throwaway ORBIT_HOME for added slots,
// and the fake codex both on PATH (which the relay execs) and as the binary the relay probes.
func newCodexLoginHarness(t *testing.T) *codexLoginHarness {
	t.Helper()
	home, _ := codexAccountSlotTestHomes(t)
	bin := t.TempDir()
	writeFakeBin(t, bin, providerCodex, fakeCodexForLogin)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	lookup := lookLoginEngine
	lookLoginEngine = func(name string) (string, bool) { return filepath.Join(bin, name), name == providerCodex }
	t.Cleanup(func() { lookLoginEngine = lookup })
	h := &codexLoginHarness{
		defaultHome: filepath.Join(home, ".codex"),
		seen:        filepath.Join(t.TempDir(), "seen"),
		relay:       &loginRelay{},
	}
	t.Setenv("FAKE_CODEX_SEEN", h.seen)
	if def, err := codexAccountSlotHome(codexAccountDefaultSlot); err != nil || def != h.defaultHome {
		t.Fatalf("Default slot = %q (%v), want %q", def, err, h.defaultHome)
	}
	if err := os.MkdirAll(h.defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	h.sentinel = filepath.Join(h.defaultHome, "auth.json")
	if err := os.WriteFile(h.sentinel, []byte(codexLoginDefaultCredentials), 0o600); err != nil {
		t.Fatal(err)
	}
	// A time no write made during the test can reproduce, so a rewrite of the same bytes still shows.
	h.sentinelMod = time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(h.sentinel, h.sentinelMod, h.sentinelMod); err != nil {
		t.Fatal(err)
	}
	h.defaultTree = treeOf(t, h.defaultHome)
	t.Cleanup(h.relay.stop)
	return h
}

func (h *codexLoginHarness) start(lr LoginCommand) {
	lr.Action, lr.Engine = "start", providerCodex
	h.relay.start(lr, func(res LoginResultRequest) {
		h.mu.Lock()
		h.reports = append(h.reports, res)
		h.mu.Unlock()
	})
}

// waitReport waits for a report of `status` about `attempt`.
func (h *codexLoginHarness) waitReport(t *testing.T, attempt, status string) LoginResultRequest {
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

type fakeCodexCall struct{ args, home, env string }

func (h *codexLoginHarness) calls(t *testing.T) []fakeCodexCall {
	t.Helper()
	b, err := os.ReadFile(h.seen)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls []fakeCodexCall
	for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 {
			t.Fatalf("fake codex log line %q", line)
		}
		calls = append(calls, fakeCodexCall{f[0], f[1], f[2]})
	}
	return calls
}

// assertEveryCallIn holds that codex ran, and only ever in `home`.
func (h *codexLoginHarness) assertEveryCallIn(t *testing.T, home string) {
	t.Helper()
	calls := h.calls(t)
	signIns := 0
	for _, c := range calls {
		if c.home != home {
			t.Errorf("`codex %s` ran in CODEX_HOME %q, want the account's own %q", c.args, c.home, home)
		}
		if c.args == "login --device-auth" {
			signIns++
		}
	}
	if signIns != 1 {
		t.Errorf("codex was asked to sign in %d times, want once: %+v", signIns, calls)
	}
}

// assertDefaultUntouched holds the Default account exactly as it was: its credentials' bytes and
// mtime, and nothing added or removed anywhere under its CODEX_HOME.
func (h *codexLoginHarness) assertDefaultUntouched(t *testing.T) {
	t.Helper()
	b, err := os.ReadFile(h.sentinel)
	if err != nil {
		t.Fatalf("Default's credentials: %v", err)
	}
	if string(b) != codexLoginDefaultCredentials {
		t.Errorf("Default's credentials were rewritten: %s", b)
	}
	info, err := os.Stat(h.sentinel)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(h.sentinelMod) {
		t.Errorf("Default's credentials were written at %v (want mtime %v)", info.ModTime(), h.sentinelMod)
	}
	if got := treeOf(t, h.defaultHome); strings.Join(got, "\n") != strings.Join(h.defaultTree, "\n") {
		t.Errorf("Default's CODEX_HOME changed:\n  before %q\n  after  %q", h.defaultTree, got)
	}
}

func treeOf(t *testing.T, dir string) []string {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		paths = append(paths, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(paths)
	return paths
}

func approveFakeCodexSignIn(t *testing.T, home string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "approve"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertSignedInto(t *testing.T, home string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		t.Fatalf("the sign-in wrote no credentials into %s: %v", home, err)
	}
	if want := `{"tokens":"` + home + `"}`; string(b) != want {
		t.Fatalf("credentials in %s = %s, want %s", home, b, want)
	}
}

// Re-signing in an account the runner already has: codex runs in that slot's CODEX_HOME — the
// sign-in itself, the version probe before it and the "did it land" probe after it — the device
// flow reaches the page unchanged, every report names the account, and Default is not touched.
func TestCodexLoginAccountSlotSignsInTheNamedSlot(t *testing.T) {
	h := newCodexLoginHarness(t)
	slot, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}

	h.start(LoginCommand{Attempt: "attempt-1", Account: slot.ID})
	waiting := h.waitReport(t, "attempt-1", loginAwaitingApproval)
	if waiting.URL != "https://auth.openai.com/codex/device" || waiting.UserCode != "ABCD-EFGH" {
		t.Fatalf("device flow reached the page as url=%q code=%q", waiting.URL, waiting.UserCode)
	}
	if waiting.Account != slot.ID {
		t.Fatalf("the report names account %q, want %q", waiting.Account, slot.ID)
	}
	approveFakeCodexSignIn(t, slot.CodexHome)
	if done := h.waitReport(t, "attempt-1", loginDone); done.Account != slot.ID {
		t.Fatalf("the outcome names account %q, want %q", done.Account, slot.ID)
	}
	h.relay.stop()

	h.assertEveryCallIn(t, slot.CodexHome)
	assertSignedInto(t, slot.CodexHome)
	h.assertDefaultUntouched(t)
}

// "Sign in another account": the runner adds a slot under the name the user gave, signs into it,
// and reports its id — the only way the control plane learns it. The heartbeat redelivers the
// start until that first report lands, and a redelivery must neither add the account again nor
// start a second CLI.
func TestCodexLoginAccountSlotAddsTheNewAccountOnce(t *testing.T) {
	h := newCodexLoginHarness(t)

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "  Work  "})
	waiting := h.waitReport(t, "attempt-1", loginAwaitingApproval)
	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "  Work  "})

	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 || slots[1].Name != "Work" {
		t.Fatalf("slots = %+v, want Default and one account named Work", slots)
	}
	added := slots[1]
	if waiting.Account != added.ID {
		t.Fatalf("the report names account %q, want the added slot %q", waiting.Account, added.ID)
	}
	approveFakeCodexSignIn(t, added.CodexHome)
	if done := h.waitReport(t, "attempt-1", loginDone); done.Account != added.ID {
		t.Fatalf("the outcome names account %q, want %q", done.Account, added.ID)
	}
	h.relay.stop()

	h.assertEveryCallIn(t, added.CodexHome)
	assertSignedInto(t, added.CodexHome)
	h.assertDefaultUntouched(t)
	if slots, err := listCodexAccountSlots(); err != nil || len(slots) != 2 {
		t.Fatalf("after the redelivery slots = %+v (%v), want still two", slots, err)
	}
}

// An account the runner does not have is refused — never quietly signed in as Default, and never
// created on the spot.
func TestCodexLoginAccountSlotUnknownAccountNeverFallsBackToDefault(t *testing.T) {
	h := newCodexLoginHarness(t)
	for _, account := range []string{"0badf00d", "../../.codex"} {
		h.start(LoginCommand{Attempt: "attempt-" + account, Account: account})
		failed := h.waitReport(t, "attempt-"+account, loginFailed)
		if failed.Account != account || !strings.Contains(failed.Message, "no Codex account") {
			t.Errorf("account %q: failure %+v", account, failed)
		}
	}
	if calls := h.calls(t); len(calls) != 0 {
		t.Fatalf("codex ran for an account the runner does not have: %+v", calls)
	}
	if slots, err := listCodexAccountSlots(); err != nil || len(slots) != 1 {
		t.Fatalf("slots = %+v (%v), want only Default", slots, err)
	}
	h.assertDefaultUntouched(t)
}

// One sign-in at a time per account, not per runner: two accounts sign in side by side, and a new
// attempt at one of them replaces only that account's — whose last word names its own attempt,
// so the control plane can tell it from the sign-in that replaced it.
func TestCodexLoginAccountSlotOneSignInPerSlot(t *testing.T) {
	h := newCodexLoginHarness(t)
	a, err := createCodexAccountSlot("A")
	if err != nil {
		t.Fatal(err)
	}
	b, err := createCodexAccountSlot("B")
	if err != nil {
		t.Fatal(err)
	}

	h.start(LoginCommand{Attempt: "a-1", Account: a.ID})
	h.start(LoginCommand{Attempt: "b-1", Account: b.ID})
	h.waitReport(t, "a-1", loginAwaitingApproval)
	h.waitReport(t, "b-1", loginAwaitingApproval)
	h.relay.mu.Lock()
	runA, runB := h.relay.runs[loginAccountKey(providerCodex, a.ID)], h.relay.runs[loginAccountKey(providerCodex, b.ID)]
	h.relay.mu.Unlock()
	if runA == nil || runB == nil || runA.attempt != "a-1" || runB.attempt != "b-1" {
		t.Fatalf("both accounts should be signing in at once: A=%+v B=%+v", runA, runB)
	}

	h.start(LoginCommand{Attempt: "a-2", Account: a.ID})
	if superseded := h.waitReport(t, "a-1", loginFailed); superseded.Account != a.ID {
		t.Fatalf("the replaced sign-in's last report names account %q, want %q", superseded.Account, a.ID)
	}
	h.waitReport(t, "a-2", loginAwaitingApproval)
	h.relay.mu.Lock()
	nowA, nowB := h.relay.runs[loginAccountKey(providerCodex, a.ID)], h.relay.runs[loginAccountKey(providerCodex, b.ID)]
	h.relay.mu.Unlock()
	if nowA == nil || nowA.attempt != "a-2" || nowB != runB {
		t.Fatalf("a new attempt at A must replace A's sign-in and leave B's: A=%+v B=%+v", nowA, nowB)
	}

	approveFakeCodexSignIn(t, a.CodexHome)
	approveFakeCodexSignIn(t, b.CodexHome)
	h.waitReport(t, "a-2", loginDone)
	h.waitReport(t, "b-1", loginDone)
	h.relay.stop()

	assertSignedInto(t, a.CodexHome)
	assertSignedInto(t, b.CodexHome)
	for _, c := range h.calls(t) {
		if c.home != a.CodexHome && c.home != b.CodexHome {
			t.Errorf("`codex %s` ran in %q, outside both accounts", c.args, c.home)
		}
	}
	h.assertDefaultUntouched(t)
}

// A start that names no account — what every control plane older than accounts sends — signs in
// the runner's own CODEX_HOME exactly as before: the CLI inherits the runner's environment, and
// nothing is injected into it.
func TestCodexLoginAccountSlotNoAccountIsTheRunnersOwnLogin(t *testing.T) {
	h := newCodexLoginHarness(t)

	h.start(LoginCommand{Attempt: "attempt-1"})
	if waiting := h.waitReport(t, "attempt-1", loginAwaitingApproval); waiting.Account != "" {
		t.Fatalf("a start naming no account reported account %q", waiting.Account)
	}
	approveFakeCodexSignIn(t, h.defaultHome)
	h.waitReport(t, "attempt-1", loginDone)
	h.relay.stop()

	for _, c := range h.calls(t) {
		if c.home != h.defaultHome || c.env != "" {
			t.Errorf("`codex %s` ran with CODEX_HOME=%q (in %q); want the runner's own environment untouched", c.args, c.env, c.home)
		}
	}
	assertSignedInto(t, h.defaultHome)
}
