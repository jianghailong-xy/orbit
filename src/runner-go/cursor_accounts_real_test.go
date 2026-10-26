//go:build cursor_real

package main

// Two Cursor CLI accounts on one runner, on the real pinned CLI, Linux and macOS alike (docs/cursor-runtime-
// contract.md §16.2, §18.7; the project's criterion 4). The runner's own code does all of it, in an Orbit home
// of the test's own: it installs the pinned build for this platform (installCursor, from downloads.cursor.com,
// checked against its pinned SHA-256), adds two accounts with its account slots and signs each in with `agent
// login` through its sign-in relay — printing each link for a person to sign in with — and then runs a session
// on each account at the same time through runCursorSession, the runner's launch and ACP driver against a stub
// control plane, one Auto prompt each, charged to a ledger before it is sent. It checks that:
//
//   - each account's login is in its own directory, where this platform saves one (cursorStoredLoginPath), and
//     nowhere else in Orbit's home; no session's directories hold one;
//   - each session's CLI ran on its own account's token, held in memory, and Cursor's dashboard (GetMe, the
//     identity call of the usage API) names a different Cursor user for each — the user of that account's login;
//   - both sessions' CLIs ran at once;
//   - the runner user's real ~/.cursor, ~/.config/cursor, Cursor's install tree and compile caches — and on
//     macOS the login Keychain's Cursor items (§18.4) — are as they were;
//   - what it keeps names no token, key or identity: the summary is redacted, and checked for it.
//
// It needs a person at a browser and spends two real prompts, so it is opt-in twice over: the build tag, and the
// variables it refuses to run without. Run on the machine under test, from src/runner-go:
//
//	ORBIT_CURSOR_REAL_LEDGER=<dir>/accounts-prompts.jsonl \
//	ORBIT_CURSOR_REAL_OUT=<dir> \
//	go test -tags cursor_real -count=1 -timeout 75m -run '^TestCursorRealAccounts$' -v .
//
// Both links are printed as they come, and kept in <out>/accounts/sign-in-links.txt until both sign-ins end:
// sign each in with a different Cursor account (a private window for the second keeps the two apart). The
// ledger refuses past realAccountsPromptCap prompts. <out>/accounts/summary.json keeps what was checked.

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
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// realAccountsPromptCap is how many real prompts the ledger allows: two a run, so a few runs.
const realAccountsPromptCap = 10

// realAccountsPrompt is the one prompt each session sends, on Auto.
const realAccountsPrompt = "Reply with only the word ready."

// realAccountsLedger charges real prompts to a JSONL file before they are sent, and refuses past its cap.
type realAccountsLedger struct {
	mu   sync.Mutex
	path string
}

func (l *realAccountsLedger) charge(account string) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	data, err := os.ReadFile(l.path)
	if err != nil && !os.IsNotExist(err) {
		return 0, err
	}
	spent := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			spent++
		}
	}
	if spent >= realAccountsPromptCap {
		return 0, fmt.Errorf("the prompt ledger %s holds %d prompts, its cap", l.path, spent)
	}
	entry, _ := json.Marshal(map[string]interface{}{"n": spent + 1, "at": time.Now().UTC().Format(time.RFC3339Nano),
		"scenario": "cursor-real-accounts", "account": account, "prompt": realAccountsPrompt, "version": cursorSupportedVersion,
		"model": "Auto (default)", "platform": runtime.GOOS + "/" + runtime.GOARCH})
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if _, err := f.Write(append(entry, '\n')); err != nil {
		return 0, err
	}
	return spent + 1, nil
}

// realAccountsCheck is one finding, kept in the summary.
type realAccountsCheck struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
}

type realAccountsReport struct {
	mu     sync.Mutex
	t      *testing.T
	checks []realAccountsCheck
	facts  map[string]interface{}
}

func (r *realAccountsReport) check(name string, pass bool, detail string, args ...interface{}) {
	r.t.Helper()
	text := fmt.Sprintf(detail, args...)
	r.mu.Lock()
	r.checks = append(r.checks, realAccountsCheck{Name: name, Pass: pass, Detail: text})
	r.mu.Unlock()
	if !pass {
		r.t.Errorf("%s: %s", name, text)
	} else {
		r.t.Logf("PASS %s: %s", name, text)
	}
}

func (r *realAccountsReport) fact(name string, value interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.facts[name] = value
}

// realAccountsRedactor replaces the run's tokens and identities, and its own paths, with placeholders.
type realAccountsRedactor struct {
	secrets []string
	paths   [][2]string
}

var (
	realAccountsJWT   = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
	realAccountsKey   = regexp.MustCompile(`(?:crsr|key)_[0-9A-Za-z_-]{16,}`)
	realAccountsEmail = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	realAccountsLink  = regexp.MustCompile(`https://cursor\.com/loginDeepControl\?\S+`)
)

func (red *realAccountsRedactor) text(s string) string {
	for _, secret := range red.secrets {
		if len(secret) >= 8 {
			s = strings.ReplaceAll(s, secret, "<REDACTED>")
		}
	}
	s = realAccountsJWT.ReplaceAllString(s, "<JWT>")
	s = realAccountsKey.ReplaceAllString(s, "<CURSOR_API_KEY>")
	s = realAccountsLink.ReplaceAllString(s, "<SIGN_IN_LINK>")
	s = realAccountsEmail.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasSuffix(m, "@cursor.com") || strings.HasSuffix(m, "@anysphere.co") {
			return m
		}
		return "<EMAIL>"
	})
	for _, path := range red.paths {
		if path[0] != "" && path[0] != "/" {
			s = strings.ReplaceAll(s, path[0], path[1])
		}
	}
	return s
}

// realAccountsDigest fingerprints dir by every entry's name, kind, mode, size and modification time — enough to
// see anything written — or says it is absent.
func realAccountsDigest(dir string) string {
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		return "absent"
	}
	digest := sha256.New()
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			fmt.Fprintf(digest, "%s error %v\n", path, err)
			return nil
		}
		info, err := os.Lstat(path)
		if err != nil {
			return nil
		}
		fmt.Fprintf(digest, "%s %v %d %d\n", path, info.Mode(), info.Size(), info.ModTime().UnixNano())
		return nil
	})
	if err != nil {
		return "unreadable: " + err.Error()
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// realAccountsUserPaths are what a Cursor CLI, or its installer, writes in the runner user's own home.
func realAccountsUserPaths(home string) []string {
	var paths []string
	for _, rel := range []string{".cursor", ".config/cursor", ".local/share/cursor-agent", ".cache/cursor-compile-cache",
		"Library/Caches/cursor-compile-cache"} {
		paths = append(paths, filepath.Join(home, rel))
	}
	return paths
}

// realAccountsKeychain is what the runner user's login Keychain holds of Cursor CLI's items (§18.4): for each
// service, whether it is there and, when it is, a hash of its attributes — never its secret, which nothing here
// reads. Only on macOS; the Keychain is found by HOME, so it is asked with the runner user's own.
func realAccountsKeychain(t *testing.T, home string) map[string]string {
	t.Helper()
	if runtime.GOOS != "darwin" {
		return nil
	}
	out := map[string]string{}
	for _, service := range []string{"cursor-access-token", "cursor-refresh-token", "cursor-api-key"} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-a", "cursor-user", "-s", service)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		attributes, err := cmd.Output()
		cancel()
		var exit *exec.ExitError
		switch {
		case err == nil:
			sum := sha256.Sum256(attributes)
			out[service] = "present " + hex.EncodeToString(sum[:8])
		case errors.As(err, &exit) && exit.ExitCode() == 44:
			out[service] = "absent"
		default:
			out[service] = "unknown (" + firstLine(err.Error()) + ")"
		}
	}
	return out
}

// realAccountsIdentity is the Cursor user a token belongs to, as Cursor's dashboard names it (GetMe, §11): its
// userId, else its authId or email — and the names of the fields it answered with.
func realAccountsIdentity(token string) (string, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cursorDashboardURL+"GetMe", strings.NewReader("{}"))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("X-Cursor-Client-Type", "cli")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "orbit-runner/"+version)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("GetMe: %s", firstLine(err.Error()))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("GetMe -> %d", resp.StatusCode)
	}
	var me map[string]interface{}
	if err := json.Unmarshal(body, &me); err != nil {
		return "", nil, fmt.Errorf("GetMe: the answer is not JSON")
	}
	fields := make([]string, 0, len(me))
	for field := range me {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	for _, field := range []string{"userId", "authId", "publicUserId", "email"} {
		if value := strings.TrimSpace(fmt.Sprint(me[field])); me[field] != nil && value != "" {
			return field + ":" + value, fields, nil
		}
	}
	return "", fields, fmt.Errorf("GetMe named no user (fields %v)", fields)
}

func realAccountsFingerprint(identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:6])
}

// realAccount is one of the two accounts the test signs in and runs a session on.
type realAccount struct {
	label, attempt, sessionID string
	slot                      accountSlot
	token, identity           string
	link                      string
}

// realAccountsSignIn waits for the sign-in of attempt to end, as long as the relay itself may wait on it.
func realAccountsSignIn(t *testing.T, relay *cursorRelay, attempt string) LoginResultRequest {
	t.Helper()
	deadline := time.Now().Add(cursorLoginRelayTimeout + time.Minute)
	for {
		relay.mu.Lock()
		var last LoginResultRequest
		for _, res := range relay.reports {
			if res.Attempt == attempt {
				last = res
			}
		}
		relay.mu.Unlock()
		if last.Status == loginDone || last.Status == loginFailed {
			return last
		}
		if time.Now().After(deadline) {
			t.Fatalf("the sign-in %s did not end within %v", attempt, cursorLoginRelayTimeout)
		}
		time.Sleep(time.Second)
	}
}

func TestCursorRealAccounts(t *testing.T) {
	ledger := &realAccountsLedger{path: os.Getenv("ORBIT_CURSOR_REAL_LEDGER")}
	out := os.Getenv("ORBIT_CURSOR_REAL_OUT")
	if !filepath.IsAbs(ledger.path) || !filepath.IsAbs(out) {
		t.Fatal("ORBIT_CURSOR_REAL_LEDGER and ORBIT_CURSOR_REAL_OUT must be absolute paths: this test signs two real accounts in and spends two real prompts")
	}
	outDir := filepath.Join(out, "accounts")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		t.Fatal(err)
	}
	report := &realAccountsReport{t: t, facts: map[string]interface{}{}}
	report.fact("platform", runtime.GOOS+"/"+runtime.GOARCH)
	report.fact("version", cursorSupportedVersion)
	red := &realAccountsRedactor{}
	// Kept however the test ends, a failure most of all.
	defer realAccountsWriteSummary(t, filepath.Join(outDir, "summary.json"), report, red)

	// The runner user's own Cursor state, before anything runs: the test then moves HOME and Orbit's home away.
	realHome := userHome()
	if realHome == "" {
		t.Fatal("the runner user's home is unknown")
	}
	userPaths := realAccountsUserPaths(realHome)
	userBefore := map[string]string{}
	for _, path := range userPaths {
		userBefore[path] = realAccountsDigest(path)
	}
	keychainBefore := realAccountsKeychain(t, realHome)
	report.fact("realHome", userBefore)
	if keychainBefore != nil {
		report.fact("keychain", keychainBefore)
	}
	useCursorRealHome(t)
	red.paths = [][2]string{{machineHome(), "<ORBIT_HOME>"}, {userHome(), "<TEST_HOME>"}, {realHome, "<HOME>"}, {os.TempDir(), "<TMP>"}}
	sort.Slice(red.paths, func(i, j int) bool { return len(red.paths[i][0]) > len(red.paths[j][0]) })

	// The pinned build, as the runner installs it on this platform.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	engineInstall.mu.Lock()
	err := installCursor(ctx, nil)
	engineInstall.mu.Unlock()
	cancel()
	report.check("install", err == nil, "installCursor from %s: %v", realAccountsTarballURL(), err)
	if err != nil {
		t.FailNow()
	}
	exe, err := cursorExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		// The runner's own download and unpack carry no quarantine (§18.2).
		attrs, err := exec.Command("/usr/bin/xattr", "-r", cursorVersionDir()).CombinedOutput()
		names := map[string]bool{}
		for _, line := range strings.Split(string(attrs), "\n") {
			if _, name, ok := strings.Cut(line, ": "); ok {
				names[strings.TrimSpace(name)] = true
			}
		}
		report.fact("installed extended attributes", sortedKeys(names))
		report.check("install-no-quarantine", err == nil && !names["com.apple.quarantine"], "xattr -r on the version directory: %v, attributes %v", err, sortedKeys(names))
	}

	// Two accounts, added and signed in by the runner's own relay, at once.
	accounts := []*realAccount{
		{label: "Orbit test A", attempt: "2026-10-25T00:00:01.000Z", sessionID: "a7777777-2222-4333-8444-555555555555"},
		{label: "Orbit test B", attempt: "2026-10-25T00:00:02.000Z", sessionID: "b7777777-2222-4333-8444-555555555555"},
	}
	relay := newCursorRelay(t)
	var links strings.Builder
	for _, a := range accounts {
		relay.start(LoginCommand{AccountName: a.label, Attempt: a.attempt})
		a.link = relay.link(t, a.attempt).URL
		fmt.Fprintf(&links, "%s: %s\n", a.label, a.link)
		fmt.Fprintf(os.Stderr, "\n>>> Sign Cursor CLI account %q in (a Cursor account of its own), within %v:\n>>> %s\n\n", a.label, cursorLoginLinkLifetime, a.link)
	}
	linksFile := filepath.Join(outDir, "sign-in-links.txt")
	if err := os.WriteFile(linksFile, []byte(links.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, a := range accounts {
		res := realAccountsSignIn(t, relay, a.attempt)
		report.check("sign-in "+a.label, res.Status == loginDone, "the relay reported %s %s", res.Status, red.text(res.Message))
	}
	_ = os.Remove(linksFile)
	if t.Failed() {
		t.FailNow()
	}
	slots := addedCursorSlots(t)
	byName := map[string]accountSlot{}
	for _, slot := range slots {
		byName[slot.Name] = slot
	}
	for _, a := range accounts {
		a.slot = byName[a.label]
		if a.slot.ID == "" {
			t.Fatalf("no account named %s among %v", a.label, slots)
		}
	}

	// Each login in its own account's directory, at this platform's place, and nowhere else in Orbit's home.
	var wantLogins []string
	for _, a := range accounts {
		path := cursorStoredLoginPath(a.slot.Dir)
		wantLogins = append(wantLogins, path)
		file, ferr := os.Stat(path)
		parent, perr := os.Stat(filepath.Dir(path))
		report.check("login-in-its-own-directory "+a.label, ferr == nil && perr == nil && file.Mode().Perm() == 0o600 && parent.Mode().Perm() == 0o700,
			"%s: file %v (%v), directory %v (%v)", red.text(path), realAccountsMode(file), ferr, realAccountsMode(parent), perr)
		a.token, err = cursorAccountLogin(a.slot.Dir)
		report.check("login-usable "+a.label, err == nil && a.token != "", "the saved login: %v", err)
		red.secrets = append(red.secrets, a.token)
	}
	sort.Strings(wantLogins)
	logins := cursorLoginsUnder(t, machineHome())
	report.check("logins-only-in-their-accounts", reflect.DeepEqual(logins, wantLogins), "Orbit's home holds %d logins: %s", len(logins), red.text(strings.Join(logins, ", ")))
	report.check("two-different-logins", accounts[0].token != "" && accounts[0].token != accounts[1].token, "the two accounts saved different tokens")
	for _, a := range accounts {
		identity, fields, err := realAccountsIdentity(a.token)
		a.identity = identity
		_, user, _ := strings.Cut(identity, ":")
		red.secrets = append(red.secrets, user)
		report.check("account-identity "+a.label, err == nil, "GetMe with the account's login: user %s (fields %v), %v", realAccountsFingerprint(identity), fields, err)
	}
	report.check("two-different-users", accounts[0].identity != "" && accounts[0].identity != accounts[1].identity,
		"the two accounts are Cursor users %s and %s: each link must be signed in with another Cursor account",
		realAccountsFingerprint(accounts[0].identity), realAccountsFingerprint(accounts[1].identity))
	var described []map[string]string
	for _, a := range accounts {
		rel, _ := filepath.Rel(a.slot.Dir, cursorStoredLoginPath(a.slot.Dir))
		described = append(described, map[string]string{"id": a.slot.ID, "label": a.label, "login": rel, "user": realAccountsFingerprint(a.identity)})
	}
	report.fact("accounts", described)
	if t.Failed() {
		t.FailNow()
	}
	accountDigests := map[string]string{}
	for _, a := range accounts {
		accountDigests[a.label] = realAccountsDigest(a.slot.Dir)
	}

	// `orbit mcp` for each session: this binary, against a runner config of its own. Nothing here calls Orbit's
	// tools, so the address it is given answers nothing.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	mcpShim := filepath.Join(t.TempDir(), "orbit-mcp")
	if err := os.WriteFile(mcpShim, []byte("#!/bin/sh\nexport "+testOrbitMCPEnv+"=1\nexec "+shellQuote(self)+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	previousMCP := cursorOrbitMCPCommand
	cursorOrbitMCPCommand = func() (string, []string) { return mcpShim, []string{"mcp"} }
	t.Cleanup(func() { cursorOrbitMCPCommand = previousMCP })
	config, _ := json.Marshal(RunnerConfig{ServerURL: "http://127.0.0.1:1", RunnerID: "cursor-real-accounts", RunnerToken: "cursor-real-accounts-token", Name: "cursor-real-accounts"})
	if err := os.WriteFile(configPath(), config, 0o600); err != nil {
		t.Fatal(err)
	}
	useCursorSlashRegistry(t)

	// A session on each account, at once: each prompt goes once both CLIs have opened their conversations.
	var mu sync.Mutex
	opened := map[string]time.Time{}
	settled := map[string]time.Time{}
	runs := map[string]cursorRun{}
	prompts := map[string]int{}
	ready := make(chan struct{})
	var allOpened sync.Once
	end := []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
	t.Run("sessions", func(t *testing.T) {
		for _, a := range accounts {
			a := a
			t.Run(a.slot.ID, func(t *testing.T) {
				t.Parallel()
				work := t.TempDir()
				if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("# Cursor CLI accounts probe\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				run := runCursorSession(t, cursorRunOptions{
					executable: exe, sameHome: true, keepSlashRegistry: true, sessionID: a.sessionID, execDir: work, timeout: 8 * time.Minute,
					env: map[string]string{cursorAccountDirVar: a.slot.Dir},
					onEvent: func(event cursorEvent) []RunInboxResponse {
						if event.typ != evSystem || event.payload["subtype"] != "init" {
							return nil
						}
						mu.Lock()
						if _, again := opened[a.label]; again {
							mu.Unlock()
							return nil
						}
						opened[a.label] = time.Now()
						if len(opened) == len(accounts) {
							allOpened.Do(func() { close(ready) })
						}
						mu.Unlock()
						select {
						case <-ready:
						case <-time.After(3 * time.Minute):
							t.Errorf("%s: the other session never opened its conversation", a.label)
							return end
						}
						n, err := ledger.charge(a.label)
						if err != nil {
							t.Errorf("%s: %v", a.label, err)
							return end
						}
						mu.Lock()
						prompts[a.label] = n
						mu.Unlock()
						return []RunInboxResponse{cursorMessage("turn-1", realAccountsPrompt)}
					},
					then: func(int, TurnCompleteRequest) []RunInboxResponse {
						mu.Lock()
						settled[a.label] = time.Now()
						mu.Unlock()
						return end
					},
				})
				mu.Lock()
				runs[a.label] = run
				mu.Unlock()
			})
		}
	})

	var sessions []map[string]interface{}
	for i, a := range accounts {
		run, ok := runs[a.label]
		if !ok {
			report.check("session "+a.label, false, "the session did not run")
			continue
		}
		other := accounts[1-i]
		env := envMap(run.spec.Env)
		turn := TurnCompleteRequest{}
		if len(run.completions) > 0 {
			turn = run.completions[0]
		}
		report.check("session-turn "+a.label, len(run.completions) == 1 && turn.Status == stSucceeded,
			"%d turn(s); the first %s %s", len(run.completions), turn.Status, red.text(turn.Error))
		report.check("session-runs-on-its-account "+a.label, env["CURSOR_AUTH_TOKEN"] == a.token && env["CURSOR_AUTH_TOKEN"] != other.token &&
			env["AGENT_CLI_CREDENTIAL_STORE"] == "memory" && env["HOME"] == run.spec.Home && env[cursorAccountDirVar] == "",
			"the CLI's token is its account's (%v), held in %s, HOME its own (%v)", env["CURSOR_AUTH_TOKEN"] == a.token,
			env["AGENT_CLI_CREDENTIAL_STORE"], env["HOME"] == run.spec.Home)
		identity, _, err := realAccountsIdentity(env["CURSOR_AUTH_TOKEN"])
		report.check("session-identity "+a.label, err == nil && identity == a.identity && identity != other.identity,
			"GetMe with the session's token: user %s, its account's %s, the other's %s (%v)",
			realAccountsFingerprint(identity), realAccountsFingerprint(a.identity), realAccountsFingerprint(other.identity), err)
		sessionLogins := cursorLoginsUnder(t, runDir(a.sessionID))
		report.check("session-holds-no-login "+a.label, len(sessionLogins) == 0, "the session's directories hold %d logins", len(sessionLogins))
		sessions = append(sessions, map[string]interface{}{"account": a.slot.ID, "label": a.label, "status": run.status, "args": run.spec.Args,
			"turnStatus": turn.Status, "turnError": red.text(turn.Error), "result": red.text(clip(turn.Result, 200)), "prompt": prompts[a.label]})
	}
	mu.Lock()
	var latestOpen, firstSettle time.Time
	for _, at := range opened {
		if at.After(latestOpen) {
			latestOpen = at
		}
	}
	for _, at := range settled {
		if firstSettle.IsZero() || at.Before(firstSettle) {
			firstSettle = at
		}
	}
	report.check("sessions-ran-at-once", len(opened) == 2 && len(settled) == 2 && latestOpen.Before(firstSettle),
		"both conversations opened before either turn settled (%d opened, %d settled)", len(opened), len(settled))
	mu.Unlock()
	for _, a := range accounts {
		report.check("account-untouched-by-its-session "+a.label, realAccountsDigest(a.slot.Dir) == accountDigests[a.label], "the account's directory after its session")
	}

	// The runner user's own Cursor state, as it was.
	for _, path := range userPaths {
		after := realAccountsDigest(path)
		report.check("real-home-unchanged "+red.text(path), after == userBefore[path], "before %s, after %s", realAccountsShort(userBefore[path]), realAccountsShort(after))
	}
	if keychainBefore != nil {
		keychainAfter := realAccountsKeychain(t, realHome)
		unknown := false
		for _, state := range keychainAfter {
			unknown = unknown || strings.HasPrefix(state, "unknown")
		}
		report.check("keychain-unchanged", !unknown && reflect.DeepEqual(keychainBefore, keychainAfter), "before %v, after %v", keychainBefore, keychainAfter)
	}

	report.fact("sessions", sessions)
}

// realAccountsWriteSummary keeps what the test checked and found at path, redacted — and refuses to keep it
// when the redaction left a token, a key or an identity in it.
func realAccountsWriteSummary(t *testing.T, path string, report *realAccountsReport, red *realAccountsRedactor) {
	t.Helper()
	report.mu.Lock()
	summary, err := json.MarshalIndent(map[string]interface{}{"test": "TestCursorRealAccounts", "passed": !t.Failed(),
		"checks": report.checks, "facts": report.facts}, "", "  ")
	report.mu.Unlock()
	if err != nil {
		t.Errorf("the summary: %v", err)
		return
	}
	text := red.text(string(summary)) + "\n"
	leaked := realAccountsJWT.MatchString(text) || realAccountsKey.MatchString(text)
	for _, secret := range red.secrets {
		leaked = leaked || (len(secret) >= 8 && strings.Contains(text, secret))
	}
	for _, m := range realAccountsEmail.FindAllString(text, -1) {
		leaked = leaked || !(strings.HasSuffix(m, "@cursor.com") || strings.HasSuffix(m, "@anysphere.co"))
	}
	if leaked {
		t.Error("the summary still names a token or an identity after redaction; it was not written")
		return
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Errorf("the summary: %v", err)
		return
	}
	t.Logf("summary: %s", path)
}

// realAccountsTarballURL is where this platform's pinned build is downloaded from, or why there is none.
func realAccountsTarballURL() string {
	artifact, err := cursorArtifactFor(cursorOS, cursorArch)
	if err != nil {
		return firstLine(err.Error())
	}
	return cursorTarballURL(artifact)
}

func realAccountsMode(info os.FileInfo) string {
	if info == nil {
		return "missing"
	}
	return info.Mode().Perm().String()
}

func realAccountsShort(digest string) string {
	if len(digest) > 12 {
		return digest[:12]
	}
	return digest
}
