package main

// Cursor CLI accounts on a runner (cursor_account_slot.go), against the scripted Cursor CLI of
// cursor_install_test.go: adding one and relaying its sign-in link, each account's sign-in in the engine
// report, signing one in again, removing one (and not while a session uses it), a session borrowing its
// account's login while the commands it runs see the environment any other engine's session gives them,
// and Default's directory left exactly as it was. scripts/test-cursor-accounts-runner.mjs runs every one of
// these by name.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCursorLogin is `NO_OPEN_BROWSER=1 agent login` (contract §9): its three lines and a link of its own at
// once, then the wait for someone to sign in with that link, which the fake's login-outcome file decides —
// one sign-in each, as the fake takes the file away when it acts on it. approve saves login-token as the
// login where the pinned build would (fakeCursorSaveCredential: under XDG_CONFIG_HOME on Linux, under HOME
// on macOS, nowhere in memory, the Keychain for macOS's default store) and exits 0; expire is the CLI giving
// up on its link and exits 1; fail is a login error and exits 1. With none it waits until it is killed.
func fakeCursorLogin(dir string) int {
	n := time.Now().UnixNano()
	fmt.Println("Starting login process...")
	fmt.Println("Authenticating with Cursor...")
	fmt.Println("Waiting for browser authentication...")
	fmt.Printf("Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=fake%dx&uuid=%08x-0000-4000-8000-%012x&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true\n",
		n, os.Getpid(), n&0xffffffffffff)
	for {
		outcome, _ := os.ReadFile(filepath.Join(dir, "login-outcome"))
		if len(outcome) > 0 {
			_ = os.Remove(filepath.Join(dir, "login-outcome"))
		}
		switch strings.TrimSpace(string(outcome)) {
		case "approve":
			token, _ := os.ReadFile(filepath.Join(dir, "login-token"))
			login, _ := json.Marshal(map[string]string{"accessToken": string(token), "refreshToken": string(token)})
			fakeCursorSaveCredential(dir, login)
			fmt.Println("Authentication tokens stored securely.")
			return 0
		case "expire":
			fmt.Fprintln(os.Stderr, "Login failed or timed out. Please try again.")
			return 1
		case "fail":
			fmt.Fprintln(os.Stderr, "Login error: Request failed with status code 403")
			return 1
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cursorAccountsRunner is a runner user of the test's own with the scripted pinned build installed, on a
// platform that keeps Cursor CLI accounts.
func cursorAccountsRunner(t *testing.T) (string, *fakeCursorRelease) {
	t.Helper()
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	installFakeCursor(t)
	useCursorPlatform(t, "linux", "amd64")
	return home, r
}

// useCursorPlatform has the runner run Cursor CLI by goos/arch's rules for the test's duration (cursorOS,
// cursorArch): the pinned build it installs, the accounts it keeps, and where it finds a login.
func useCursorPlatform(t *testing.T, goos, arch string) {
	t.Helper()
	previousOS, previousArch := cursorOS, cursorArch
	cursorOS, cursorArch = goos, arch
	t.Cleanup(func() { cursorOS, cursorArch = previousOS, previousArch })
}

// signInCursorAccount saves token as the login of the account at dir, where `agent login` would.
func signInCursorAccount(t *testing.T, dir, token string) {
	t.Helper()
	path := cursorStoredLoginPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	login, _ := json.Marshal(map[string]string{"accessToken": token, "refreshToken": token})
	if err := os.WriteFile(path, login, 0o600); err != nil {
		t.Fatal(err)
	}
}

// cursorRelay drives the sign-in relay and keeps every report it makes.
type cursorRelay struct {
	relay   *loginRelay
	mu      sync.Mutex
	reports []LoginResultRequest
}

func newCursorRelay(t *testing.T) *cursorRelay {
	r := &cursorRelay{relay: &loginRelay{}}
	t.Cleanup(r.relay.stop)
	return r
}

func (r *cursorRelay) start(lr LoginCommand) {
	lr.Action, lr.Engine = "start", providerCursor
	r.relay.start(lr, func(res LoginResultRequest) {
		r.mu.Lock()
		r.reports = append(r.reports, res)
		r.mu.Unlock()
	})
}

// until waits for a report about attempt that done says ends the wait, and returns every report about
// attempt so far.
func (r *cursorRelay) until(t *testing.T, attempt string, done func(LoginResultRequest) bool) []LoginResultRequest {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		r.mu.Lock()
		var got []LoginResultRequest
		for _, res := range r.reports {
			if res.Attempt == attempt {
				got = append(got, res)
			}
		}
		r.mu.Unlock()
		if n := len(got); n > 0 && done(got[n-1]) {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("no such report for attempt %q; reported %+v", attempt, got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (r *cursorRelay) link(t *testing.T, attempt string) LoginResultRequest {
	t.Helper()
	got := r.until(t, attempt, func(res LoginResultRequest) bool { return res.Status != "" })
	if got[0].Status != loginAwaitingApproval {
		t.Fatalf("the first report of %s is %+v, want the sign-in link", attempt, got[0])
	}
	return got[0]
}

// signInWith starts lr, waits for its link, and then has someone finish with it as outcome says.
func (r *cursorRelay) signInWith(t *testing.T, cli *fakeCursorRelease, lr LoginCommand, outcome string) []LoginResultRequest {
	t.Helper()
	r.start(lr)
	r.link(t, lr.Attempt)
	cli.behave(t, "login-outcome", outcome)
	return r.outcome(t, lr.Attempt)
}

func (r *cursorRelay) outcome(t *testing.T, attempt string) []LoginResultRequest {
	t.Helper()
	return r.until(t, attempt, func(res LoginResultRequest) bool { return res.Status == loginDone || res.Status == loginFailed })
}

func addedCursorSlots(t *testing.T) []accountSlot {
	t.Helper()
	slots, err := cursorAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	return slots[1:]
}

// cursorLoginCalls are the fake's `agent login` starts.
func cursorLoginCalls(t *testing.T, r *fakeCursorRelease) []fakeCursorCall {
	t.Helper()
	return callsWith(r.calls(t), "login")
}

// assertCursorLoginRanIn fails unless call is `agent login` run in the account at dir: its HOME, config and
// XDG_CONFIG_HOME there, the login saved to a file there, no browser, nothing of the runner's own.
func assertCursorLoginRanIn(t *testing.T, call fakeCursorCall, dir string) {
	t.Helper()
	if strings.Join(call.Args, " ") != "login" || call.Dir != filepath.Join(dir, "home") {
		t.Fatalf("the sign-in ran %v in %s, want `login` in %s", call.Args, call.Dir, filepath.Join(dir, "home"))
	}
	for key, want := range map[string]string{"HOME": filepath.Join(dir, "home"), "CURSOR_CONFIG_DIR": filepath.Join(dir, "config"),
		"XDG_CONFIG_HOME": filepath.Join(dir, "xdg-config"), "AGENT_CLI_CREDENTIAL_STORE": "file", "NO_OPEN_BROWSER": "1"} {
		if got, _ := call.env(key); got != want {
			t.Errorf("the sign-in ran with %s=%q, want %q", key, got, want)
		}
	}
	for _, key := range []string{"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "ANTHROPIC_API_KEY", cursorAccountDirVar, "CURSOR_DATA_DIR"} {
		if value, ok := call.env(key); ok {
			t.Errorf("the sign-in ran with %s=%q", key, value)
		}
	}
}

func assertPrivateCursorDir(t *testing.T, dir string) {
	t.Helper()
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("%s is not a private directory: %v, %v", dir, info, err)
	}
}

// Add account: the runner adds a directory of its own under <orbit home>/cursor-accounts, signs it in with
// the pinned build's `agent login` run there, and relays the link the CLI prints as it prints it, with when
// it stops working; the sign-in lands in the new account, never in Default.
func TestCursorAddAccountRelaysTheSignInLink(t *testing.T) {
	home, r := cursorAccountsRunner(t)
	for key, value := range map[string]string{"CURSOR_API_KEY": "runner-cursor-key", "ANTHROPIC_API_KEY": "runner-anthropic"} {
		t.Setenv(key, value)
	}
	defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
	signInCursorDefault(t, defaultToken)
	before := cursorTreeDigest(t, cursorDefaultAccountDir())
	workToken := cursorTestToken(t, time.Now().Add(48*time.Hour))
	r.behave(t, "login-token", workToken)

	relay := newCursorRelay(t)
	const attempt = "2026-10-17T04:00:00.000Z"
	started := time.Now()
	relay.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	link := relay.link(t, attempt)

	added := addedCursorSlots(t)
	if len(added) != 1 || added[0].Name != "Work" || !accountSlotIDPattern.MatchString(added[0].ID) {
		t.Fatalf("added accounts = %#v, want the one named Work", added)
	}
	work := added[0]
	if want := filepath.Join(home, ".orbit", "cursor-accounts", work.ID); work.Dir != want {
		t.Fatalf("Work lives at %s, want %s", work.Dir, want)
	}
	for _, dir := range []string{work.Dir, filepath.Join(work.Dir, "home"), filepath.Join(work.Dir, "config"), filepath.Join(work.Dir, "xdg-config")} {
		assertPrivateCursorDir(t, dir)
	}
	// The link is relayed exactly as the CLI printed it, while the CLI is still waiting on it.
	calls := cursorLoginCalls(t, r)
	if len(calls) != 1 {
		t.Fatalf("`agent login` ran %d times, want once", len(calls))
	}
	assertCursorLoginRanIn(t, calls[0], work.Dir)
	if !cursorLoginURLRe.MatchString(link.URL) || !strings.HasPrefix(link.URL, "https://cursor.com/loginDeepControl?challenge=fake") ||
		!strings.HasSuffix(link.URL, "&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true") {
		t.Fatalf("relayed %q, want the CLI's loginDeepControl link", link.URL)
	}
	if link.Account != work.ID || link.UserCode != "" {
		t.Fatalf("the link report = %+v, want account %s and nothing to type", link, work.ID)
	}
	expires, err := time.Parse(time.RFC3339, link.ExpiresAt)
	if err != nil || expires.Before(started.Add(cursorLoginLinkLifetime-time.Minute)) || expires.After(time.Now().Add(cursorLoginLinkLifetime+time.Minute)) {
		t.Fatalf("the link expires at %q (%v), want %v from when it was printed", link.ExpiresAt, err, cursorLoginLinkLifetime)
	}
	if _, err := os.Stat(cursorStoredLoginPath(work.Dir)); !os.IsNotExist(err) {
		t.Fatalf("a login was saved before anyone signed in (%v)", err)
	}
	// Redelivered while it waits: the same sign-in, not a second account or a second CLI.
	relay.start(LoginCommand{AccountName: "Work", Attempt: attempt})
	time.Sleep(400 * time.Millisecond)
	if n := len(addedCursorSlots(t)); n != 1 {
		t.Fatalf("a redelivered start added %d accounts", n)
	}
	if n := len(cursorLoginCalls(t, r)); n != 1 {
		t.Fatalf("a redelivered start ran `agent login` %d times", n)
	}

	// Someone signs in with the link — on any device: the CLI polls Cursor for it.
	r.behave(t, "login-outcome", "approve")
	got := relay.outcome(t, attempt)
	if last := got[len(got)-1]; last.Status != loginDone || last.Account != work.ID || last.Reason != "" {
		t.Fatalf("reports = %+v, want the link and then done for %s", got, work.ID)
	}
	if token, err := cursorStoredLogin(work.Dir); err != nil || token != workToken {
		t.Fatalf("Work's login = %q, %v: the sign-in did not land in its own directory", token, err)
	}
	if after := cursorTreeDigest(t, cursorDefaultAccountDir()); after != before {
		t.Fatal("adding an account changed Default's directory")
	}
	if token, _ := cursorStoredLogin(cursorDefaultAccountDir()); token != defaultToken {
		t.Fatal("adding an account replaced Default's login")
	}
	assertNoCursorStateIn(t, home)
	if timeout := cursorLoginRelayTimeout; timeout <= 1636*time.Second || timeout >= 30*time.Minute {
		t.Fatalf("the relay waits %v on `agent login`: past the CLI's own wait (1,636 s at most, measured) and within the control plane's 30-minute sweep", timeout)
	}
	if cursorLoginLinkLifetime > 1418*time.Second {
		t.Fatalf("the link is promised for %v, longer than the CLI is sure to wait on it (1,418 s)", cursorLoginLinkLifetime)
	}
}

// Default signs in the same way, into Orbit's own directory for it, and a runner's sign-in of Cursor CLI
// never starts any other engine's CLI — an older one ran `claude auth login` for an engine it did not know.
func TestCursorDefaultSignInUsesOrbitsDirectory(t *testing.T) {
	home, r := cursorAccountsRunner(t)
	token := cursorTestToken(t, time.Now().Add(24*time.Hour))
	r.behave(t, "login-token", token)
	if flow := loginFlowFor(providerCursor); flow.engine != providerCursor {
		t.Fatalf("a Cursor CLI sign-in runs the %s flow", flow.engine)
	}
	relay := newCursorRelay(t)
	const attempt = "2026-10-17T04:05:00.000Z"
	got := relay.signInWith(t, r, LoginCommand{Attempt: attempt}, "approve")
	if len(got) != 2 || got[0].Status != loginAwaitingApproval || got[1].Status != loginDone || got[1].Account != "" {
		t.Fatalf("reports = %+v, want Default's link and then done", got)
	}
	def := cursorDefaultAccountDir()
	assertCursorLoginRanIn(t, cursorLoginCalls(t, r)[0], def)
	assertPrivateCursorDir(t, def)
	if saved, _ := cursorStoredLogin(def); saved != token {
		t.Fatal("Default's sign-in did not land in Orbit's directory for it")
	}
	if added := addedCursorSlots(t); len(added) != 0 {
		t.Fatalf("Default's sign-in added %v", added)
	}
	for _, call := range r.calls(t) {
		if call.Args[0] != "login" && call.Args[0] != "--version" {
			t.Fatalf("a sign-in ran %v", call.Args)
		}
	}
	assertNoCursorStateIn(t, home)
}

// The link running out before anyone signed in with it is reported as such (reason "expired"), apart from
// every other failure: the CLI giving up after its full wait, and the relay's own deadline. The account the
// attempt added goes again, and the same name gets a new link from a new attempt. The CLI giving up early —
// its polls failing, not the link expiring — is a failure in other words.
func TestCursorExpiredSignInLinkIsReportedAsExpired(t *testing.T) {
	_, r := cursorAccountsRunner(t)
	relay := newCursorRelay(t)

	t.Run("cli-gives-up-after-its-wait", func(t *testing.T) {
		previous := cursorLoginLinkLifetime
		cursorLoginLinkLifetime = 0
		t.Cleanup(func() { cursorLoginLinkLifetime = previous })
		const attempt = "2026-10-17T04:10:00.000Z"
		got := relay.signInWith(t, r, LoginCommand{AccountName: "Work", Attempt: attempt}, "expire")
		last := got[len(got)-1]
		if last.Status != loginFailed || last.Reason != loginReasonExpired || last.Message != cursorLoginExpiredMessage {
			t.Fatalf("reports = %+v, want failed for an expired link", got)
		}
		relay.relay.wg.Wait()
		if added := addedCursorSlots(t); len(added) != 0 {
			t.Fatalf("the expired attempt left %v behind", added)
		}
		// A new link for the same name: a new attempt, which adds the account afresh and signs it in.
		r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(24*time.Hour)))
		const again = "2026-10-17T04:11:00.000Z"
		if got := relay.signInWith(t, r, LoginCommand{AccountName: "Work", Attempt: again}, "approve"); got[len(got)-1].Status != loginDone {
			t.Fatalf("a new link after the expired one = %+v", got)
		}
		if added := addedCursorSlots(t); len(added) != 1 || added[0].Name != "Work" {
			t.Fatalf("after a new link the accounts are %v", added)
		}
	})
	t.Run("cli-gives-up-early", func(t *testing.T) {
		const attempt = "2026-10-17T04:12:00.000Z"
		got := relay.signInWith(t, r, LoginCommand{AccountName: "Team", Attempt: attempt}, "expire")
		last := got[len(got)-1]
		if last.Status != loginFailed || last.Reason != "" || !strings.Contains(last.Message, "before its link expired") {
			t.Fatalf("reports = %+v, want a failure that is not an expired link", got)
		}
	})
	t.Run("login-error", func(t *testing.T) {
		const attempt = "2026-10-17T04:13:00.000Z"
		got := relay.signInWith(t, r, LoginCommand{Attempt: attempt}, "fail")
		last := got[len(got)-1]
		if last.Status != loginFailed || last.Reason != "" || last.Message != "Cursor CLI could not sign in: Login error: Request failed with status code 403" {
			t.Fatalf("reports = %+v, want the CLI's own error", got)
		}
	})
	t.Run("relay-deadline", func(t *testing.T) {
		quick := newCursorRelay(t)
		quick.relay.timeout = 2 * time.Second
		const attempt = "2026-10-17T04:14:00.000Z"
		quick.start(LoginCommand{AccountName: "Later", Attempt: attempt})
		got := quick.outcome(t, attempt)
		last := got[len(got)-1]
		if got[0].Status != loginAwaitingApproval || last.Status != loginFailed || last.Reason != loginReasonExpired {
			t.Fatalf("reports = %+v, want the link and then its expiry", got)
		}
		quick.relay.wg.Wait()
		calls := cursorLoginCalls(t, r)
		pid := calls[len(calls)-1].PID
		if err := waitForProcessGone(pid, 5*time.Second); err != nil {
			t.Fatalf("the `agent login` the relay gave up on is still running: %v", err)
		}
		for _, slot := range addedCursorSlots(t) {
			if slot.Name == "Later" {
				t.Fatal("the account whose link expired was left behind")
			}
		}
	})
}

// waitForProcessGone waits for pid to be gone or a zombie.
func waitForProcessGone(pid int, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil || strings.Contains(string(stat), ") Z ") {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("process %d still runs", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The engine report lists every account with its own sign-in: Default first, then each added one by its id,
// name and directory. An account is signed in only when its saved login is unexpired and Cursor accepts it;
// one whose token has expired is signed out — it needs signing in again — and is not asked about at all, and
// no probe writes, refreshes or trades any account's login.
func TestCursorEngineReportsEveryAccountsSignIn(t *testing.T) {
	_, r := cursorAccountsRunner(t)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	slots := map[string]accountSlot{}
	tokens := map[string]string{}
	for _, name := range []string{"Work", "Expired", "Refused", "Empty"} {
		slot, err := cursorAccountKind.create(name)
		if err != nil {
			t.Fatal(err)
		}
		slots[name] = slot
		switch name {
		case "Work":
			tokens[name] = cursorTestToken(t, time.Now().Add(48*time.Hour))
		case "Expired":
			tokens[name] = cursorTestToken(t, time.Now().Add(-time.Hour))
		case "Refused":
			tokens[name] = cursorTestToken(t, time.Now().Add(72*time.Hour))
		}
		if tokens[name] != "" {
			signInCursorAccount(t, slot.Dir, tokens[name])
		}
	}
	// Within the five minutes the CLI already counts as expired (§9): over too.
	soon, err := cursorAccountKind.create("Soon")
	if err != nil {
		t.Fatal(err)
	}
	slots["Soon"], tokens["Soon"] = soon, cursorTestToken(t, time.Now().Add(2*time.Minute))
	signInCursorAccount(t, soon.Dir, tokens["Soon"])
	r.behave(t, "refused-tokens", tokens["Refused"])
	digests := map[string]string{}
	for name, slot := range slots {
		digests[name] = cursorTreeDigest(t, slot.Dir)
	}
	defaultDigest := cursorTreeDigest(t, cursorDefaultAccountDir())

	_, report := cursorHealth(t)
	if report.Auth != "yes" {
		t.Fatalf("the engine's own answer = %q, want Default's yes", report.Auth)
	}
	want := map[string]string{"Work": "yes", "Expired": "no", "Refused": "no", "Empty": "no", "Soon": "no"}
	if len(report.Accounts) != 1+len(want) || report.Accounts[0].ID != accountSlotDefaultID || report.Accounts[0].Auth != "yes" ||
		report.Accounts[0].Dir != cursorDefaultAccountDir() {
		t.Fatalf("accounts = %+v, want Default first and signed in, then the five added", report.Accounts)
	}
	for _, account := range report.Accounts[1:] {
		slot := slots[account.Name]
		if account.ID != slot.ID || account.Dir != slot.Dir || account.Auth != want[account.Name] || account.CodexHome != "" {
			t.Errorf("account %+v, want %s (%s) at %s, auth %s", account, account.Name, slot.ID, slot.Dir, want[account.Name])
		}
	}
	// The heartbeat carries it as engines[].accounts[] {id, name, home, auth}.
	encoded, err := json.Marshal(report.Accounts[1])
	if err != nil {
		t.Fatal(err)
	}
	var shape map[string]interface{}
	if err := json.Unmarshal(encoded, &shape); err != nil {
		t.Fatal(err)
	}
	if shape["id"] != report.Accounts[1].ID || shape["name"] != report.Accounts[1].Name || shape["home"] != report.Accounts[1].Dir ||
		shape["auth"] != report.Accounts[1].Auth {
		t.Fatalf("an account reads %s on the wire", encoded)
	}
	// Only Default, Work and Refused were asked; each with its own token, held in memory.
	asked := map[string]bool{}
	for _, call := range callsWith(r.calls(t), "models") {
		token, _ := call.env("CURSOR_AUTH_TOKEN")
		asked[token] = true
		if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
			t.Errorf("an account was asked with its login kept in %q", store)
		}
	}
	for name, token := range tokens {
		if asked[token] != (name == "Work" || name == "Refused") {
			t.Errorf("%s asked about = %v", name, asked[token])
		}
	}
	for name, slot := range slots {
		if cursorTreeDigest(t, slot.Dir) != digests[name] {
			t.Errorf("reporting %s changed its directory", name)
		}
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Error("reporting changed Default's directory")
	}
	for _, call := range r.calls(t) {
		if call.Args[0] == "login" {
			t.Fatalf("reporting signed something in: %v", call.Args)
		}
	}
}

// Re-sign in: the account's own directory is signed in again — its id, name and record stay, a new login
// replaces the old one in place, no account is added — and the report says signed in again. A Re-sign in
// that does not complete leaves the account where it was: only an account an attempt added goes again.
func TestCursorReSignInReplacesTheAccountsLogin(t *testing.T) {
	_, r := cursorAccountsRunner(t)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	defaultDigest := cursorTreeDigest(t, cursorDefaultAccountDir())
	work, err := cursorAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInCursorAccount(t, work.Dir, cursorTestToken(t, time.Now().Add(-time.Hour)))
	if _, report := cursorHealth(t); report.Accounts[1].Auth != "no" {
		t.Fatalf("an expired login reports %q", report.Accounts[1].Auth)
	}

	relay := newCursorRelay(t)
	const unfinished = "2026-10-17T04:20:00.000Z"
	if got := relay.signInWith(t, r, LoginCommand{Account: work.ID, Attempt: unfinished}, "fail"); got[len(got)-1].Status != loginFailed {
		t.Fatalf("reports = %+v", got)
	}
	relay.relay.wg.Wait()
	if added := addedCursorSlots(t); len(added) != 1 || added[0].ID != work.ID {
		t.Fatalf("a Re-sign in that did not complete left the accounts %v, want Work as it was", added)
	}

	fresh := cursorTestToken(t, time.Now().Add(72*time.Hour))
	r.behave(t, "login-token", fresh)
	const attempt = "2026-10-17T04:21:00.000Z"
	relay.start(LoginCommand{Account: work.ID, Attempt: attempt})
	link := relay.link(t, attempt)
	if link.Account != work.ID || link.URL == "" {
		t.Fatalf("the Re-sign in link = %+v", link)
	}
	calls := cursorLoginCalls(t, r)
	assertCursorLoginRanIn(t, calls[len(calls)-1], work.Dir)
	r.behave(t, "login-outcome", "approve")
	if got := relay.outcome(t, attempt); got[len(got)-1].Status != loginDone || got[len(got)-1].Account != work.ID {
		t.Fatalf("reports = %+v", got)
	}
	if saved, _ := cursorStoredLogin(work.Dir); saved != fresh {
		t.Fatal("the new login did not replace the old one in Work's directory")
	}
	added := addedCursorSlots(t)
	if len(added) != 1 || added[0].ID != work.ID || added[0].Name != "Work" || !added[0].CreatedAt.Equal(work.CreatedAt) {
		t.Fatalf("after a Re-sign in the accounts are %+v, want Work as it was", added)
	}
	if _, report := cursorHealth(t); report.Accounts[1].Auth != "yes" {
		t.Fatalf("after a Re-sign in Work reports %q", report.Accounts[1].Auth)
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Fatal("signing Work in again changed Default's directory")
	}
	// An account the runner does not have is not signed in, and Default is never signed in in its place.
	const missing = "2026-10-17T04:22:00.000Z"
	relay.start(LoginCommand{Account: "0badc0de", Attempt: missing})
	if got := relay.outcome(t, missing); got[len(got)-1].Status != loginFailed || !strings.Contains(got[len(got)-1].Message, "no Cursor CLI account 0badc0de") {
		t.Fatalf("signing in an account the runner does not have = %+v", got)
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Fatal("a sign-in of an account the runner does not have changed Default's directory")
	}
}

// Remove takes one account — its directory and its record — and nothing else; an account a running
// session borrows its login from is refused, and is removable once that session is over. Default is never
// removable, and a removal redelivered after it was carried out is done again.
func TestCursorAccountRemovalRefusedWhileASessionUsesIt(t *testing.T) {
	home, _ := cursorAccountsRunner(t)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	defaultDigest := cursorTreeDigest(t, cursorDefaultAccountDir())
	work, err := cursorAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	team, err := cursorAccountKind.create("Team")
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range []accountSlot{work, team} {
		signInCursorAccount(t, slot.Dir, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	}
	teamDigest := cursorTreeDigest(t, team.Dir)

	// Three running sessions, recorded the way a session's run records itself before its CLI starts: on
	// Work, on Default, and on a key while Work is named.
	const onWork, onDefault, onKey = "7a0c3c0e-1d0f-4c6e-9a7b-2f3e4d5c6b7a", "8b1d4d1f-2e10-4d7f-8b8c-3f4e5d6c7b8a", "9c2e5e2a-3f21-4e80-9c9d-4a5f6e7d8c9b"
	for id, env := range map[string]map[string]string{onWork: {cursorAccountDirVar: work.Dir}, onDefault: nil,
		onKey: {cursorAccountDirVar: work.Dir, cursorAPIKeyVar: cursorTestKey}} {
		if err := os.MkdirAll(runDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
		writeSessionMeta(runDir(id), &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: env}}, t.TempDir())
	}
	for id, want := range map[string]string{onWork: work.Dir, onDefault: "", onKey: ""} {
		if meta := readSessionMeta(filepath.Join(runDir(id), "meta.json")); meta == nil || meta.CursorAccountDir != want {
			t.Fatalf("session %s records %#v, want account %q", id, meta, want)
		}
	}
	live := cursorAccountKind.liveDirs([]string{onWork, onDefault, onKey})
	if !reflect.DeepEqual(live, map[string]bool{work.Dir: true}) {
		t.Fatalf("accounts in use = %v, want only Work", live)
	}

	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, live); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("removing Work under a running session = %v, want it refused", err)
	}
	if _, err := cursorStoredLogin(work.Dir); err != nil {
		t.Fatalf("the refused removal touched Work: %v", err)
	}
	if token, _ := cursorStoredLogin(work.Dir); token == "" {
		t.Fatal("the refused removal took Work's login")
	}

	// That session over, Work goes: its directory and its record, nothing else.
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, cursorAccountKind.liveDirs([]string{onDefault, onKey})); err != nil {
		t.Fatalf("removing Work: %v", err)
	}
	for _, path := range []string{work.Dir, filepath.Join(home, ".orbit", "cursor-accounts", work.ID+".json")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s outlived the removal (%v)", path, err)
		}
	}
	if added := addedCursorSlots(t); len(added) != 1 || added[0].ID != team.ID || cursorTreeDigest(t, team.Dir) != teamDigest {
		t.Fatalf("removing Work changed the other accounts: %v", added)
	}
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, nil); err != nil {
		t.Fatalf("a redelivered removal: %v", err)
	}
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, accountSlotDefaultID, nil); err == nil {
		t.Fatal("Default was removable")
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Fatal("removing an account changed Default's directory")
	}
	// Removed is signed out, and a session dispatched onto it now is refused rather than run on Default.
	if got := cursorSlotLoginStatus(context.Background(), "/no/cli", work.Dir); got != authNo {
		t.Fatalf("a removed account reads %v", got)
	}
	if _, err := os.Lstat(work.Dir); !os.IsNotExist(err) {
		t.Fatal("asking about the removed account brought its directory back")
	}
	if msg := engineAuthPreflight(providerCursor, map[string]string{cursorAccountDirVar: work.Dir}); !isAuthError(msg) ||
		!strings.Contains(msg, "no Cursor CLI account at "+work.Dir) {
		t.Fatalf("a session on the removed account = %q", msg)
	}
}

// commandEnvironment runs script the way Cursor CLI runs an agent's command (§8.3): through the session's
// $SHELL, with the CLI's environment and what the CLI's launcher and the CLI add to every command.
func commandEnvironment(t *testing.T, spec CursorLaunchSpec, login bool, script string) (map[string]string, string) {
	t.Helper()
	env := envMap(spec.Env)
	cliEnv := append(append([]string(nil), spec.Env...),
		"NODE_COMPILE_CACHE="+filepath.Join(spec.Home, ".cache", "cursor-compile-cache"), "CURSOR_AGENT=1",
		"CURSOR_INVOKED_AS=cursor-agent", "TERM=dumb", "NO_COLOR=1")
	flags := "-c"
	if login {
		flags = "-ilc"
	}
	cmd := exec.Command(env["SHELL"], "-O", "extglob", flags, script+"\nprintf '\\0--env--\\0'; env -0")
	cmd.Env = cliEnv
	cmd.Dir = spec.Cwd
	var stdout strings.Builder
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("a command through %s: %v", env["SHELL"], err)
	}
	head, rest, _ := strings.Cut(stdout.String(), "\x00--env--\x00")
	out := map[string]string{}
	for _, entry := range strings.Split(rest, "\x00") {
		if key, value, ok := strings.Cut(entry, "="); ok {
			out[key] = value
		}
	}
	return out, head
}

// A session dispatched onto an added account borrows that account's login — handed to the CLI as a token,
// in memory — while the CLI keeps its state in the session's own directories, and nothing is written into
// the account. The commands the agent runs see what a session of any other engine shows them: the real HOME
// and its login profile, the runner's and the workspace's XDG directories (so git and gh find the user's own
// configuration), the variables Orbit set only for the CLI as they were, and none of the CLI's credentials
// or directories — on an added account exactly as on Default.
func TestCursorSessionBorrowsItsAccountAndCommandsKeepTheirEnvironment(t *testing.T) {
	home, r := cursorAccountsRunner(t)
	exe := filepath.Join(cursorVersionDir(), cursorEntryPoint)
	// The runner user's own environment: XDG directories, and git's and gh's configuration under them.
	runnerConfig := filepath.Join(home, ".config-of-the-runner")
	t.Setenv("XDG_CONFIG_HOME", runnerConfig)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache-of-the-runner"))
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/4242")
	for _, key := range []string{"NODE_COMPILE_CACHE", "DIRENV_DISABLE", "NO_OPEN_BROWSER", "AGENT_CLI_CREDENTIAL_STORE", "XDG_DATA_HOME"} {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
	for path, content := range map[string]string{
		filepath.Join(home, ".gitconfig"):              "[user]\n\tname = Runner User\n",
		filepath.Join(runnerConfig, "git", "config"):   "[core]\n\teditor = runner-editor\n",
		filepath.Join(runnerConfig, "gh", "hosts.yml"): "github.com:\n    user: runner\n",
		filepath.Join(home, ".bash_profile"):           "export PROFILE_OF=real-home\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
	signInCursorDefault(t, defaultToken)
	work, err := cursorAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	workToken := cursorTestToken(t, time.Now().Add(48*time.Hour))
	signInCursorAccount(t, work.Dir, workToken)
	before := map[string]string{"default": cursorTreeDigest(t, cursorDefaultAccountDir()), "work": cursorTreeDigest(t, work.Dir)}

	workspace := map[string]string{"WORKSPACE_VALUE": "workspace", "XDG_DATA_HOME": "/workspace/xdg-data", "GIT_AUTHOR_NAME": "Workspace Author"}
	onWork := &ClaimedSession{SessionID: "a1111111-2222-4333-8444-555555555555", SessionUUID: "a1111111-2222-4333-8444-555555555555",
		AgentID: "a", Provider: providerCursor, Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAccountDirVar: work.Dir}}}
	onDefault := &ClaimedSession{SessionID: "b1111111-2222-4333-8444-555555555555", SessionUUID: "b1111111-2222-4333-8444-555555555555",
		AgentID: "a", Provider: providerCursor, Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{}}}
	for key, value := range workspace {
		onWork.Agent.Env[key], onDefault.Agent.Env[key] = value, value
	}
	execDir := t.TempDir()
	views := map[string]map[string]string{}
	for name, job := range map[string]*ClaimedSession{"work": onWork, "default": onDefault} {
		if msg := engineAuthPreflight(providerCursor, job.Agent.Env); msg != "" {
			t.Fatalf("the %s session's sign-in preflight: %s", name, msg)
		}
		dir, err := cursorSessionDir(job.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		spec, err := prepareCursorLaunch(job, execDir, exe, dir)
		if err != nil {
			t.Fatal(err)
		}
		env := envMap(spec.Env)
		wantToken := map[string]string{"work": workToken, "default": defaultToken}[name]
		if env["CURSOR_AUTH_TOKEN"] != wantToken || env["AGENT_CLI_CREDENTIAL_STORE"] != "memory" {
			t.Fatalf("the %s session's CLI runs on CURSOR_AUTH_TOKEN %q in %q: want its account's login, in memory", name, env["CURSOR_AUTH_TOKEN"], env["AGENT_CLI_CREDENTIAL_STORE"])
		}
		if _, ok := env[cursorAccountDirVar]; ok {
			t.Fatalf("%s reached the %s session's CLI", cursorAccountDirVar, name)
		}
		if env["HOME"] != filepath.Join(dir, "home") || env["CURSOR_CONFIG_DIR"] != filepath.Join(dir, "config") || strings.HasPrefix(env["HOME"], work.Dir) {
			t.Fatalf("the %s session's CLI runs with HOME %q and config %q, want the session's own", name, env["HOME"], env["CURSOR_CONFIG_DIR"])
		}
		writeSessionMeta(runDir(job.SessionID), job, execDir)
		wantRecord := map[string]string{"work": work.Dir, "default": ""}[name]
		if meta := readSessionMeta(filepath.Join(runDir(job.SessionID), "meta.json")); meta == nil || meta.CursorAccountDir != wantRecord {
			t.Fatalf("the %s session records %#v, want account %q", name, meta, wantRecord)
		}
		// The session's CLI runs, and keeps its conversation in the session's own directory.
		ask, stop := startCursorSession(t, spec, "ORBIT_TEST_SESSION="+name)
		if line := ask(1, "session/new"); !strings.Contains(line, "fake-session") {
			t.Fatalf("session/new on %s = %q", name, line)
		}
		stop()
		if _, err := os.Stat(filepath.Join(spec.ConfigDir, "acp-sessions", "fake-session", "store.db")); err != nil {
			t.Fatalf("the %s session's conversation is not in its own directory: %v", name, err)
		}

		// A command the agent runs, and the login-shell snapshot the CLI takes before it.
		shell := env["SHELL"]
		if !strings.HasPrefix(shell, filepath.Join(dir, "bin")+string(os.PathSeparator)) || !cursorShellPathUsable(shell) {
			t.Fatalf("SHELL = %q: the session's own orbit-bash, on a path naming bash and not zsh", shell)
		}
		got, head := commandEnvironment(t, spec, false, `printf '%s|%s|%s' "$(git config user.name)" "$(git config core.editor)" "$(cd && pwd)"`)
		if want := "Runner User|runner-editor|" + home; head != want {
			t.Fatalf("on %s, git and the shell saw %q, want the runner user's own configuration %q", name, head, want)
		}
		_, profile := commandEnvironment(t, spec, true, `printf '%s' "$PROFILE_OF"`)
		if profile != "real-home" {
			t.Fatalf("on %s, the login-shell snapshot read the profile of %q, want the real HOME's", name, profile)
		}
		normal := envMap(envWithAgent(job.Agent.Env))
		keys := []string{"HOME", "WORKSPACE_VALUE", "GIT_AUTHOR_NAME", "DIRENV_DISABLE", "NODE_COMPILE_CACHE", "AGENT_CLI_CREDENTIAL_STORE",
			"NO_OPEN_BROWSER", "CURSOR_AGENT_DISABLE_DEBUG_LOG"}
		for key := range normal {
			if strings.HasPrefix(key, "XDG_") {
				keys = append(keys, key)
			}
		}
		for key := range got {
			if strings.HasPrefix(key, "XDG_") {
				keys = append(keys, key)
			}
		}
		for _, key := range keys {
			value, ok := got[key]
			wantValue, wantOK := normal[key]
			if ok != wantOK || value != wantValue {
				t.Errorf("on %s, a command sees %s=%q (set %v); a session of any other engine gives it %q (set %v)", name, key, value, ok, wantValue, wantOK)
			}
		}
		if got["XDG_CONFIG_HOME"] != runnerConfig || got["XDG_DATA_HOME"] != "/workspace/xdg-data" {
			t.Errorf("on %s, XDG_CONFIG_HOME = %q and XDG_DATA_HOME = %q, want the runner's and the workspace's", name, got["XDG_CONFIG_HOME"], got["XDG_DATA_HOME"])
		}
		for _, key := range []string{"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", cursorAccountDirVar, cursorAPIKeyVar} {
			if value, ok := got[key]; ok {
				t.Errorf("on %s, a command sees %s=%q", name, key, value)
			}
		}
		for _, value := range got {
			if strings.Contains(value, wantToken) || strings.HasPrefix(value, work.Dir) {
				t.Errorf("on %s, a command sees %q", name, value)
			}
		}
		view := map[string]string{}
		for _, key := range keys {
			view[key] = got[key]
		}
		views[name] = view
	}
	if !reflect.DeepEqual(views["work"], views["default"]) {
		t.Fatalf("the account changed what commands see:\non Work    %v\non Default %v", views["work"], views["default"])
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != before["default"] || cursorTreeDigest(t, work.Dir) != before["work"] {
		t.Fatal("a session wrote into the account it borrows its login from")
	}
	for _, call := range callsWith(r.calls(t), "acp") {
		if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
			t.Fatalf("a session kept its login in %q", store)
		}
	}
	assertNoCursorStateIn(t, home)
}

// A session dispatched onto an added account runs on that account's login or not at all: one that is not
// signed in, whose sign-in has expired, or that this runner does not have is refused before anything starts,
// as a sign-in to make — never run on Default's login or the workspace's key in its place.
func TestCursorSessionOnAnAccountWithoutALoginIsRefused(t *testing.T) {
	_, _ = cursorAccountsRunner(t)
	exe := filepath.Join(cursorVersionDir(), cursorEntryPoint)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	expired, err := cursorAccountKind.create("Expired")
	if err != nil {
		t.Fatal(err)
	}
	signInCursorAccount(t, expired.Dir, cursorTestToken(t, time.Now().Add(-time.Minute)))
	empty, err := cursorAccountKind.create("Empty")
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		env  map[string]string
		want string
	}{
		"expired":          {map[string]string{cursorAccountDirVar: expired.Dir}, "has a sign-in that expired"},
		"not-signed-in":    {map[string]string{cursorAccountDirVar: empty.Dir}, "is not signed in"},
		"workspace-key":    {map[string]string{cursorAccountDirVar: expired.Dir, "CURSOR_API_KEY": "key_from-the-workspace"}, "has a sign-in that expired"},
		"not-this-runners": {map[string]string{cursorAccountDirVar: filepath.Join(t.TempDir(), "elsewhere")}, "no Cursor CLI account at"},
	} {
		t.Run(name, func(t *testing.T) {
			job := &ClaimedSession{SessionID: "c1111111-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
				Agent: AgentExecConfig{Provider: providerCursor, Env: c.env}}
			msg := engineAuthPreflight(providerCursor, c.env)
			if !isAuthError(msg) || !strings.Contains(msg, c.want) {
				t.Fatalf("the preflight = %q, want a sign-in refusal saying %q", msg, c.want)
			}
			_, err := prepareCursorLaunch(job, t.TempDir(), exe, filepath.Join(runDir(job.SessionID), "cursor"))
			if err == nil || err.Error() != msg {
				t.Fatalf("the launch = %v, want the preflight's refusal %q", err, msg)
			}
		})
	}
	// A dispatched key is the session's credential whatever account is named, and spends none.
	job := &ClaimedSession{SessionID: "d1111111-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
		Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAccountDirVar: expired.Dir, cursorAPIKeyVar: cursorTestKey}}}
	spec, err := prepareCursorLaunch(job, t.TempDir(), exe, filepath.Join(runDir(job.SessionID), "cursor"))
	if err != nil || envMap(spec.Env)["CURSOR_API_KEY"] != cursorTestKey {
		t.Fatalf("a session with a dispatched key: %v", err)
	}
	if cursorSessionAccountDirToRecord(job) != "" {
		t.Fatal("a session on a key records an account")
	}
}

// orbit-bash has to be on a path the CLI takes as bash — one naming bash and not zsh, which the CLI looks
// for first (§8.3) — or the CLI runs commands in a shell of its own choosing, on its own HOME and with its
// credentials. A runner whose Orbit home names zsh is refused rather than run that way.
func TestCursorShellWrapperPathNamesBashNotZsh(t *testing.T) {
	for path, usable := range map[string]bool{"/home/u/.orbit/runs/s/cursor/bin/orbit-bash": true, "/usr/bin/bash": true,
		"/home/zsh-fan/.orbit/runs/s/cursor/bin/orbit-bash": false, "/bin/zsh": false, "/home/u/.orbit/bin/orbit-sh": false} {
		if cursorShellPathUsable(path) != usable {
			t.Errorf("cursorShellPathUsable(%q) = %v, want %v", path, !usable, usable)
		}
	}
	useCursorRealHome(t)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	job := &ClaimedSession{SessionID: "e1111111-2222-4333-8444-555555555555", AgentID: "a"}
	spec, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", filepath.Join(runDir(job.SessionID), "cursor"))
	if err != nil || !cursorShellPathUsable(envMap(spec.Env)["SHELL"]) || !strings.HasSuffix(envMap(spec.Env)["SHELL"], "/orbit-bash") {
		t.Fatalf("SHELL = %q, %v", envMap(spec.Env)["SHELL"], err)
	}
	zsh := filepath.Join(t.TempDir(), "zsh-user", ".orbit")
	if err := os.MkdirAll(zsh, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", zsh)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	if _, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", filepath.Join(runDir(job.SessionID), "cursor")); err == nil ||
		!strings.HasPrefix(err.Error(), "CURSOR_CONFIG_CONFLICT:") || !strings.Contains(err.Error(), "names bash and not zsh") {
		t.Fatalf("a launch whose orbit-bash path names zsh = %v, want it refused", err)
	}
}

// Default's directory is the same, byte for byte, after another account is added and signed in, reported,
// signed in again, run a session on and removed.
func TestCursorDefaultAccountDirectoryIsUnchanged(t *testing.T) {
	home, r := cursorAccountsRunner(t)
	exe := filepath.Join(cursorVersionDir(), cursorEntryPoint)
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(24*time.Hour)))
	// Default as a sign-in leaves it: its own home and settings beside the login.
	for _, rel := range []string{"home/.cursor/agent-cli-state.json", "config/cli-config.json"} {
		path := filepath.Join(cursorDefaultAccountDir(), rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{\"default\":true}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	before := cursorTreeDigest(t, cursorDefaultAccountDir())

	relay := newCursorRelay(t)
	r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(48*time.Hour)))
	const add, again = "2026-10-17T04:30:00.000Z", "2026-10-17T04:31:00.000Z"
	if got := relay.signInWith(t, r, LoginCommand{AccountName: "Work", Attempt: add}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("adding Work = %+v", got)
	}
	work := addedCursorSlots(t)[0]
	cursorHealth(t)
	if got := relay.signInWith(t, r, LoginCommand{Account: work.ID, Attempt: again}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("signing Work in again = %+v", got)
	}
	job := &ClaimedSession{SessionID: "f1111111-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
		Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAccountDirVar: work.Dir}}}
	spec, err := prepareCursorLaunch(job, t.TempDir(), exe, filepath.Join(runDir(job.SessionID), "cursor"))
	if err != nil {
		t.Fatal(err)
	}
	ask, stop := startCursorSession(t, spec, "ORBIT_TEST_SESSION=work")
	ask(1, "initialize")
	ask(2, "session/new")
	stop()
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	if after := cursorTreeDigest(t, cursorDefaultAccountDir()); after != before {
		t.Fatalf("Default's directory changed: %s, then %s", before, after)
	}
	assertNoCursorStateIn(t, home)
}

// Accounts beside Default are kept on Linux and macOS, where approach A of D4 was measured (§8.4, §18.7): a
// runner on either declares both account capabilities. Anywhere else the runner keeps Default alone (approach
// D): it declares neither, adds no account and signs none in, and runs no session on one — while Default
// still signs in.
func TestCursorAccountsAreKeptOnLinuxAndMacOS(t *testing.T) {
	_, r := cursorAccountsRunner(t)
	declared := "," + runnerCapabilitiesV1 + ","
	for _, capability := range []string{"cursor-account-login/v1", "cursor-account-remove/v1"} {
		if want := runtime.GOOS == "linux" || runtime.GOOS == "darwin"; strings.Contains(declared, ","+capability+",") != want {
			t.Fatalf("this %s runner declares %s: %v, want %v (%q)", runtime.GOOS, capability, !want, want, runnerCapabilitiesV1)
		}
	}
	for _, platform := range [][2]string{{"darwin", "arm64"}, {"linux", "amd64"}} {
		useCursorPlatform(t, platform[0], platform[1])
		if got := cursorAccountCapabilities(); !reflect.DeepEqual(got, []string{cursorAccountLoginCapabilityV1, cursorAccountRemoveCapabilityV1}) {
			t.Fatalf("a %s/%s runner declares %v", platform[0], platform[1], got)
		}
	}
	work, err := cursorAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInCursorAccount(t, work.Dir, cursorTestToken(t, time.Now().Add(24*time.Hour)))

	// A platform with a pinned build but no measurement of D4: Default alone.
	cursorArtifacts["freebsd/amd64"] = cursorArtifacts[runtime.GOOS+"/"+runtime.GOARCH]
	useCursorPlatform(t, "freebsd", "amd64")
	if got := cursorAccountCapabilities(); len(got) != 0 {
		t.Fatalf("a FreeBSD runner declares %v", got)
	}
	relay := newCursorRelay(t)
	for attempt, lr := range map[string]LoginCommand{
		"2026-10-17T04:40:00.000Z": {AccountName: "Team"},
		"2026-10-17T04:41:00.000Z": {Account: work.ID},
	} {
		lr.Attempt = attempt
		relay.start(lr)
		got := relay.outcome(t, attempt)
		if len(got) != 1 || got[0].Status != loginFailed || got[0].Message != cursorAccountsUnsupportedMessage() {
			t.Fatalf("on FreeBSD, %+v = %+v, want it refused", lr, got)
		}
	}
	if added := addedCursorSlots(t); len(added) != 1 || added[0].ID != work.ID {
		t.Fatalf("on FreeBSD the accounts are %v", added)
	}
	if n := len(cursorLoginCalls(t, r)); n != 0 {
		t.Fatalf("on FreeBSD `agent login` ran %d times for another account", n)
	}
	msg := engineAuthPreflight(providerCursor, map[string]string{cursorAccountDirVar: work.Dir})
	if !isAuthError(msg) || !strings.Contains(msg, cursorAccountsUnsupportedMessage()) {
		t.Fatalf("on FreeBSD a session on another account = %q", msg)
	}
	r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(24*time.Hour)))
	const def = "2026-10-17T04:42:00.000Z"
	if got := relay.signInWith(t, r, LoginCommand{Attempt: def}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("on FreeBSD Default's sign-in = %+v", got)
	}
}

// D5 (owner, 2026-10-17): whether Cursor continues a conversation under another account or key is not known
// yet (§13.2), so this runner does not declare cursor-account-move/v1, and the control plane refuses a Cursor
// CLI session that has talked another account or key here. A session's conversation stays in its own
// directory whichever it runs on (cursor_launch.go), so once two real identities show it continues, the
// declaration is all a move needs.
func TestCursorRunnerDoesNotDeclareAccountMove(t *testing.T) {
	declared := map[string]bool{}
	for _, capability := range strings.Split(runnerCapabilitiesV1, ",") {
		declared[capability] = true
	}
	for _, other := range []string{"codex-account-move/v1", "claude-account-move/v1", "kimi-account-move/v1"} {
		if !declared[other] {
			t.Fatalf("this runner no longer declares %s (%q)", other, runnerCapabilitiesV1)
		}
	}
	if declared["cursor-account-move/v1"] {
		t.Fatalf("this runner declares cursor-account-move/v1 before two real identities showed a Cursor conversation continues (D5): %q", runnerCapabilitiesV1)
	}
}
