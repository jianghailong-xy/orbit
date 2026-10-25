package main

// A runner on macOS (docs/cursor-runtime-contract.md §18, P0b and its follow-up): the pinned build's own
// tarball for darwin/arm64, Cursor CLI accounts beside Default, every login read where the macOS build saves
// it — <account>/home/.cursor/auth.json, whatever XDG_CONFIG_HOME says (§18.3) — and every Cursor CLI process
// with its credential store named, so none falls back to the Keychain (§18.4). The scripted CLI of
// cursor_install_test.go runs as the macOS build (fakeCursorRelease.onMac) on a runner whose platform the test
// stands in (useCursorPlatform): the rules are the runner's own, only the platform is the test's. Linux is held
// to what it was beside each. scripts/test-cursor-macos-runner.mjs runs every one of these by name.

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// cursorMacRunner is a runner user of the test's own on a darwin/arm64 runner, with the scripted CLI as the
// macOS build, installed by the runner from the darwin/arm64 tarball.
func cursorMacRunner(t *testing.T) (string, *fakeCursorRelease) {
	t.Helper()
	home := useCursorRealHome(t)
	useCursorPlatform(t, "darwin", "arm64")
	r := newFakeCursorRelease(t)
	r.onMac(t)
	installFakeCursor(t)
	return home, r
}

// cursorLoginsUnder is every auth.json under dir, the Cursor CLI logins it holds.
func cursorLoginsUnder(t *testing.T, dir string) []string {
	t.Helper()
	var logins []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && entry.Name() == "auth.json" {
			logins = append(logins, path)
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	sort.Strings(logins)
	return logins
}

// assertCursorLoginUnderHome fails unless the account at dir has token as its login where the macOS build
// saves one — home/.cursor/auth.json, 0600 in a 0700 directory — and holds no other login.
func assertCursorLoginUnderHome(t *testing.T, dir, token string) {
	t.Helper()
	path := filepath.Join(dir, "home", ".cursor", "auth.json")
	if got := cursorStoredLoginPath(dir); got != path {
		t.Fatalf("on macOS the login of %s is read from %s, want %s", dir, got, path)
	}
	if saved, err := cursorStoredLogin(dir); err != nil || saved != token {
		t.Fatalf("the login of %s reads %q, %v; want the one it signed in with", dir, saved, err)
	}
	file, err := os.Stat(path)
	if err != nil || file.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v, %v; want a private file", path, file, err)
	}
	if parent, err := os.Stat(filepath.Dir(path)); err != nil || parent.Mode().Perm() != 0o700 {
		t.Fatalf("%s: %v, %v; want a private directory", filepath.Dir(path), parent, err)
	}
	if logins := cursorLoginsUnder(t, dir); !reflect.DeepEqual(logins, []string{path}) {
		t.Fatalf("%s holds the logins %v, want only %s — none under xdg-config/, which macOS ignores for its login", dir, logins, path)
	}
}

// saveCursorLoginAt writes token as a login at rel inside dir, where some platform's `agent login` would.
func saveCursorLoginAt(t *testing.T, dir, rel, token string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"accessToken":"`+token+`","refreshToken":"`+token+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

const (
	cursorLinuxLogin = "xdg-config/cursor/auth.json"
	cursorMacLogin   = "home/.cursor/auth.json"
)

// The pinned build has a tarball for darwin/arm64 — the one P0b measured, from its own download path — beside
// Linux x64's. A platform nobody measured, an Intel Mac among them, is refused with CURSOR_PLATFORM_UNSUPPORTED,
// naming the two that were, and so is a runner standing on one.
func TestCursorPinnedBuildPerPlatform(t *testing.T) {
	if cursorSupportedVersion != "2026.10.14-941492e" {
		t.Fatalf("the pinned version is %s", cursorSupportedVersion)
	}
	for _, c := range []struct {
		goos, arch, path, sha256 string
		size                     int64
	}{
		{"darwin", "arm64", "darwin/arm64", "c6d9e2eaa1b1e24221517e0b4206b1f1593792e6f0d8a52e9b507bbe7ab0cc77", 178006204},
		{"linux", "amd64", "linux/x64", "6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d", 183861376},
	} {
		artifact, err := cursorArtifactFor(c.goos, c.arch)
		if err != nil || artifact.path != c.path || artifact.sha256 != c.sha256 || artifact.size != c.size {
			t.Fatalf("%s/%s: %+v, %v; want %s, %d bytes, SHA-256 %s", c.goos, c.arch, artifact, err, c.path, c.size, c.sha256)
		}
		want := "https://downloads.cursor.com/lab/2026.10.14-941492e/" + c.path + "/agent-cli-package.tar.gz"
		if got := cursorTarballURL(artifact); got != want {
			t.Fatalf("%s/%s downloads from %s, want %s", c.goos, c.arch, got, want)
		}
		useCursorPlatform(t, c.goos, c.arch)
		if err := cursorPlatformError(); err != nil {
			t.Fatalf("a %s/%s runner: %v", c.goos, c.arch, err)
		}
	}
	if len(cursorArtifacts) != 2 {
		t.Fatalf("the pinned build has tarballs for %d platforms, want darwin/arm64 and linux/amd64 alone", len(cursorArtifacts))
	}
	for _, platform := range []string{"darwin/amd64", "linux/arm64", "windows/amd64", "freebsd/amd64"} {
		goos, arch, _ := strings.Cut(platform, "/")
		_, err := cursorArtifactFor(goos, arch)
		if err == nil || !strings.HasPrefix(err.Error(), "CURSOR_PLATFORM_UNSUPPORTED:") ||
			!strings.Contains(err.Error(), "only on darwin/arm64, linux/amd64 runners") || !strings.HasSuffix(err.Error(), "this runner is "+platform) {
			t.Fatalf("%s: %v, want CURSOR_PLATFORM_UNSUPPORTED naming the two measured platforms", platform, err)
		}
		useCursorPlatform(t, goos, arch)
		if err := cursorPlatformError(); err == nil || !strings.HasPrefix(err.Error(), "CURSOR_PLATFORM_UNSUPPORTED:") {
			t.Fatalf("a %s runner: %v", platform, err)
		}
	}
}

// A darwin/arm64 runner installs the pinned build from macOS's download path, finds it ready, and declares
// provider:cursor on every request beside both account capabilities. An Intel Mac reports its platform
// unsupported, declares no provider:cursor, and downloads and starts nothing. Linux's declaration is as it was.
func TestCursorMacRunnerDeclaresCursor(t *testing.T) {
	without, with := runnerSupportedProviders, runnerSupportedProviders+","+providerCursor
	both := []string{cursorAccountLoginCapabilityV1, cursorAccountRemoveCapabilityV1}
	t.Run("darwin-arm64", func(t *testing.T) {
		home, r := cursorMacRunner(t)
		registerCursorDriverForTest(t, true)
		if paths := r.requestPaths(); len(paths) != 1 || paths[0] != "/"+cursorSupportedVersion+"/darwin/arm64/agent-cli-package.tar.gz" {
			t.Fatalf("the install downloaded %q, want the darwin/arm64 tarball once", paths)
		}
		h, report := cursorHealth(t)
		if !h.installed || h.installError != "" || h.version != cursorSupportedVersion || !report.Installed || report.InstallationError != "" {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		if got := supportedProvidersHeader(); got != with {
			t.Fatalf("declared providers = %q, want %q", got, with)
		}
		if got := sentSupportedProviders(t); got != with {
			t.Fatalf("a request declared %q, want %q", got, with)
		}
		if got := cursorAccountCapabilities(); !reflect.DeepEqual(got, both) {
			t.Fatalf("a macOS runner declares %v, want %v", got, both)
		}
		if saves := r.keychainSaves(t); len(saves) != 0 {
			t.Fatalf("the install and the probes saved into the Keychain: %v", saves)
		}
		assertNoCursorStateIn(t, home)
	})
	t.Run("darwin-amd64", func(t *testing.T) {
		home := useCursorRealHome(t)
		useCursorPlatform(t, "darwin", "amd64")
		r := newFakeCursorRelease(t)
		r.onMac(t)
		delete(cursorArtifacts, "darwin/amd64") // the fake is pinned for this machine's own platform too
		registerCursorDriverForTest(t, true)
		allowCursorInstall(t, true)
		if msg := ensureEngine(context.Background(), providerCursor, func(string) { t.Error("announced an install on an Intel Mac") }); !strings.HasPrefix(msg, "CURSOR_PLATFORM_UNSUPPORTED:") {
			t.Fatalf("a session's install on an Intel Mac = %q", msg)
		}
		h, report := cursorHealth(t)
		if h.installed || !strings.HasPrefix(h.installError, "CURSOR_PLATFORM_UNSUPPORTED:") || report.Installed ||
			!strings.HasPrefix(report.InstallationError, "CURSOR_PLATFORM_UNSUPPORTED:") {
			t.Fatalf("health = %+v, report = %+v", h, report)
		}
		if got := supportedProvidersHeader(); got != without {
			t.Fatalf("an Intel Mac declares providers %q, want %q", got, without)
		}
		if len(r.requestPaths()) != 0 || len(r.calls(t)) != 0 {
			t.Fatalf("an Intel Mac downloaded %v and started %v", r.requestPaths(), r.calls(t))
		}
		assertNoCursorStateIn(t, home)
	})
	t.Run("linux-amd64", func(t *testing.T) {
		home := useCursorRealHome(t)
		useCursorPlatform(t, "linux", "amd64")
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		registerCursorDriverForTest(t, true)
		if paths := r.requestPaths(); len(paths) != 1 || paths[0] != "/"+cursorSupportedVersion+"/linux/x64/agent-cli-package.tar.gz" {
			t.Fatalf("the install downloaded %q, want the linux/x64 tarball once", paths)
		}
		if _, report := cursorHealth(t); !report.Installed || report.InstallationError != "" {
			t.Fatalf("report = %+v", report)
		}
		if got := sentSupportedProviders(t); got != with {
			t.Fatalf("a Linux runner declared %q, want %q", got, with)
		}
		if got := cursorAccountCapabilities(); !reflect.DeepEqual(got, both) {
			t.Fatalf("a Linux runner declares %v, want %v", got, both)
		}
		assertNoCursorStateIn(t, home)
	})
}

// On macOS a sign-in lands in the account's own HOME: `agent login` runs with the account's home/ as HOME and
// its credentials in a file, and the login is <account>/home/.cursor/auth.json — private, the only one in the
// account, nothing under xdg-config/ (§18.3), nothing in the Keychain. Default signs in the same way into its
// own directory, and Re-sign in replaces an account's login in place. The hint for signing in by hand names
// the file store too.
func TestCursorMacSignInSavesUnderHome(t *testing.T) {
	home, r := cursorMacRunner(t)
	relay := newCursorRelay(t)
	defaultDigest := ""

	workToken := cursorTestToken(t, time.Now().Add(48*time.Hour))
	r.behave(t, "login-token", workToken)
	if got := relay.signInWith(t, r, LoginCommand{AccountName: "Work", Attempt: "2026-10-25T02:00:00.000Z"}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("adding Work = %+v", got)
	}
	added := addedCursorSlots(t)
	if len(added) != 1 || added[0].Name != "Work" {
		t.Fatalf("added accounts = %+v", added)
	}
	work := added[0]
	calls := cursorLoginCalls(t, r)
	assertCursorLoginRanIn(t, calls[len(calls)-1], work.Dir)
	assertCursorLoginUnderHome(t, work.Dir, workToken)

	defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
	r.behave(t, "login-token", defaultToken)
	if got := relay.signInWith(t, r, LoginCommand{Attempt: "2026-10-25T02:01:00.000Z"}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("Default's sign-in = %+v", got)
	}
	calls = cursorLoginCalls(t, r)
	assertCursorLoginRanIn(t, calls[len(calls)-1], cursorDefaultAccountDir())
	assertCursorLoginUnderHome(t, cursorDefaultAccountDir(), defaultToken)
	defaultDigest = cursorTreeDigest(t, cursorDefaultAccountDir())

	fresh := cursorTestToken(t, time.Now().Add(72*time.Hour))
	r.behave(t, "login-token", fresh)
	if got := relay.signInWith(t, r, LoginCommand{Account: work.ID, Attempt: "2026-10-25T02:02:00.000Z"}, "approve"); got[len(got)-1].Status != loginDone {
		t.Fatalf("signing Work in again = %+v", got)
	}
	assertCursorLoginUnderHome(t, work.Dir, fresh)
	if again := addedCursorSlots(t); len(again) != 1 || again[0].ID != work.ID {
		t.Fatalf("after a Re-sign in the accounts are %+v", again)
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Fatal("signing Work in again changed Default's directory")
	}
	for _, call := range cursorLoginCalls(t, r) {
		if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "file" {
			t.Fatalf("a sign-in ran with its credentials in %q", store)
		}
	}
	if saves := r.keychainSaves(t); len(saves) != 0 {
		t.Fatalf("a sign-in saved into the Keychain: %v", saves)
	}
	hint := cursorLoginHintFor(work.Dir)
	if !strings.Contains(hint, "AGENT_CLI_CREDENTIAL_STORE=file") || !strings.Contains(hint, "HOME="+shellQuote(filepath.Join(work.Dir, "home"))) {
		t.Fatalf("the hint for signing Work in by hand = %q, want its own HOME and a file store", hint)
	}
	assertNoCursorStateIn(t, home)
}

// Each account's sign-in is read where its platform's build saves it. On macOS an unexpired login under
// home/.cursor is asked about with its own token, held in memory; one that has expired, or is within the CLI's
// five minutes of it, is signed out without asking; and a login at Linux's place, xdg-config/cursor/auth.json,
// is no login at all — as one under home/.cursor is none on Linux, whose report is as it was.
func TestCursorMacLoginStatusFollowsTheLayout(t *testing.T) {
	type account struct {
		rel   string
		exp   time.Duration
		state string
	}
	run := func(t *testing.T, r *fakeCursorRelease, own string, accounts map[string]account) {
		t.Helper()
		defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
		saveCursorLoginAt(t, cursorDefaultAccountDir(), own, defaultToken)
		tokens := map[string]string{"": defaultToken}
		slots := map[string]accountSlot{}
		for name, a := range accounts {
			slot, err := cursorAccountKind.create(name)
			if err != nil {
				t.Fatal(err)
			}
			slots[name] = slot
			tokens[name] = cursorTestToken(t, time.Now().Add(a.exp))
			saveCursorLoginAt(t, slot.Dir, a.rel, tokens[name])
		}
		_, report := cursorHealth(t)
		if report.Auth != "yes" || report.Accounts[0].ID != accountSlotDefaultID || report.Accounts[0].Auth != "yes" {
			t.Fatalf("Default reports %q (%+v), want signed in", report.Auth, report.Accounts)
		}
		if len(report.Accounts) != 1+len(accounts) {
			t.Fatalf("accounts = %+v", report.Accounts)
		}
		for _, got := range report.Accounts[1:] {
			if want := accounts[got.Name].state; got.Auth != want || got.ID != slots[got.Name].ID {
				t.Errorf("%s reports %q, want %q", got.Name, got.Auth, want)
			}
		}
		asked := map[string]bool{}
		for _, call := range callsWith(r.calls(t), "models") {
			token, _ := call.env("CURSOR_AUTH_TOKEN")
			asked[token] = true
			if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
				t.Errorf("a sign-in was asked about with its token kept in %q", store)
			}
		}
		for name, token := range tokens {
			if want := name == "" || accounts[name].state == "yes"; asked[token] != want {
				t.Errorf("account %q asked about: %v, want %v", name, asked[token], want)
			}
		}
	}
	t.Run("darwin", func(t *testing.T) {
		home, r := cursorMacRunner(t)
		run(t, r, cursorMacLogin, map[string]account{
			"Work":        {cursorMacLogin, 48 * time.Hour, "yes"},
			"Expired":     {cursorMacLogin, -time.Hour, "no"},
			"Soon":        {cursorMacLogin, 2 * time.Minute, "no"},
			"LinuxLayout": {cursorLinuxLogin, 50 * time.Hour, "no"},
		})
		if saves := r.keychainSaves(t); len(saves) != 0 {
			t.Fatalf("a status probe saved into the Keychain: %v", saves)
		}
		assertNoCursorStateIn(t, home)
	})
	t.Run("linux", func(t *testing.T) {
		home, r := cursorAccountsRunner(t)
		run(t, r, cursorLinuxLogin, map[string]account{
			"Work":      {cursorLinuxLogin, 48 * time.Hour, "yes"},
			"Expired":   {cursorLinuxLogin, -time.Hour, "no"},
			"MacLayout": {cursorMacLogin, 50 * time.Hour, "no"},
		})
		assertNoCursorStateIn(t, home)
	})
}

// A session on macOS borrows its account's login from home/.cursor/auth.json — handed to the CLI as a token,
// in memory — and Default's the same way; its CLI starts and opens its conversation on it. An account whose
// login there has expired, is within five minutes of it, or is saved only at Linux's place is refused before
// anything starts, never run on Default's login. Nothing a session does is written into the account it
// borrows from, and its own directories hold no login.
func TestCursorMacSessionBorrowsItsAccountsLogin(t *testing.T) {
	home, r := cursorMacRunner(t)
	exe := filepath.Join(cursorVersionDir(), cursorEntryPoint)
	defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
	signInCursorDefault(t, defaultToken)
	assertCursorLoginUnderHome(t, cursorDefaultAccountDir(), defaultToken)
	slots := map[string]accountSlot{}
	tokens := map[string]string{}
	for name, login := range map[string]struct {
		rel string
		exp time.Duration
	}{"Work": {cursorMacLogin, 48 * time.Hour}, "Expired": {cursorMacLogin, -time.Minute}, "Soon": {cursorMacLogin, 2 * time.Minute},
		"LinuxLayout": {cursorLinuxLogin, 50 * time.Hour}} {
		slot, err := cursorAccountKind.create(name)
		if err != nil {
			t.Fatal(err)
		}
		slots[name], tokens[name] = slot, cursorTestToken(t, time.Now().Add(login.exp))
		saveCursorLoginAt(t, slot.Dir, login.rel, tokens[name])
	}
	before := map[string]string{"default": cursorTreeDigest(t, cursorDefaultAccountDir()), "work": cursorTreeDigest(t, slots["Work"].Dir)}

	for name, c := range map[string]struct {
		id, dir, token string
	}{
		"work":    {"a2222222-2222-4333-8444-555555555555", slots["Work"].Dir, tokens["Work"]},
		"default": {"b2222222-2222-4333-8444-555555555555", "", defaultToken},
	} {
		env := map[string]string{}
		if c.dir != "" {
			env[cursorAccountDirVar] = c.dir
		}
		job := &ClaimedSession{SessionID: c.id, SessionUUID: c.id, AgentID: "a", Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: env}}
		if msg := engineAuthPreflight(providerCursor, env); msg != "" {
			t.Fatalf("the %s session's sign-in preflight: %s", name, msg)
		}
		dir, err := cursorSessionDir(job.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		spec, err := prepareCursorLaunch(job, t.TempDir(), exe, dir)
		if err != nil {
			t.Fatal(err)
		}
		got := envMap(spec.Env)
		if got["CURSOR_AUTH_TOKEN"] != c.token || got["AGENT_CLI_CREDENTIAL_STORE"] != "memory" || got["HOME"] != filepath.Join(dir, "home") {
			t.Fatalf("the %s session's CLI runs on token %q in %q with HOME %q: want its account's login, in memory, in its own home",
				name, got["CURSOR_AUTH_TOKEN"], got["AGENT_CLI_CREDENTIAL_STORE"], got["HOME"])
		}
		writeSessionMeta(runDir(job.SessionID), job, t.TempDir())
		if meta := readSessionMeta(filepath.Join(runDir(job.SessionID), "meta.json")); meta == nil || meta.CursorAccountDir != c.dir {
			t.Fatalf("the %s session records %#v, want account %q", name, meta, c.dir)
		}
		ask, stop := startCursorSession(t, spec, "ORBIT_TEST_SESSION="+name)
		if line := ask(1, "session/new"); !strings.Contains(line, "fake-session") {
			t.Fatalf("session/new on %s = %q", name, line)
		}
		stop()
		if logins := cursorLoginsUnder(t, dir); len(logins) != 0 {
			t.Fatalf("the %s session's own directories hold the logins %v", name, logins)
		}
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != before["default"] || cursorTreeDigest(t, slots["Work"].Dir) != before["work"] {
		t.Fatal("a session wrote into the account it borrows its login from")
	}
	for name, want := range map[string]string{"Expired": "has a sign-in that expired", "Soon": "has a sign-in that expired", "LinuxLayout": "is not signed in"} {
		env := map[string]string{cursorAccountDirVar: slots[name].Dir}
		msg := engineAuthPreflight(providerCursor, env)
		if !isAuthError(msg) || !strings.Contains(msg, want) {
			t.Fatalf("a session on %s: preflight %q, want a sign-in refusal saying %q", name, msg, want)
		}
		job := &ClaimedSession{SessionID: "c2222222-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: env}}
		if _, err := prepareCursorLaunch(job, t.TempDir(), exe, filepath.Join(runDir(job.SessionID), "cursor")); err == nil || err.Error() != msg {
			t.Fatalf("a session on %s launches: %v, want the preflight's refusal %q", name, err, msg)
		}
	}
	for _, call := range callsWith(r.calls(t), "acp") {
		if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
			t.Fatalf("a session kept its login in %q", store)
		}
	}
	if saves := r.keychainSaves(t); len(saves) != 0 {
		t.Fatalf("a session saved into the Keychain: %v", saves)
	}
	assertNoCursorStateIn(t, home)
}

// Remove on macOS takes the account's directory — its login under home/.cursor with it — and its record, and
// is refused while a session borrows that login. The removed account is signed out, a session on it refused,
// and the other account and Default untouched.
func TestCursorMacAccountRemoval(t *testing.T) {
	home, _ := cursorMacRunner(t)
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
	for i, slot := range []accountSlot{work, team} {
		token := cursorTestToken(t, time.Now().Add(time.Duration(48+i)*time.Hour))
		signInCursorAccount(t, slot.Dir, token)
		assertCursorLoginUnderHome(t, slot.Dir, token)
	}
	teamDigest := cursorTreeDigest(t, team.Dir)
	const onWork = "d2222222-2222-4333-8444-555555555555"
	if err := os.MkdirAll(runDir(onWork), 0o700); err != nil {
		t.Fatal(err)
	}
	writeSessionMeta(runDir(onWork), &ClaimedSession{SessionID: onWork, SessionUUID: onWork, Provider: providerCursor,
		Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAccountDirVar: work.Dir}}}, t.TempDir())
	live := cursorAccountKind.liveDirs([]string{onWork})
	if !reflect.DeepEqual(live, map[string]bool{work.Dir: true}) {
		t.Fatalf("accounts in use = %v, want Work", live)
	}
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, live); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("removing Work under a running session = %v, want it refused", err)
	}
	if token, err := cursorStoredLogin(work.Dir); err != nil || token == "" {
		t.Fatalf("the refused removal took Work's login: %q, %v", token, err)
	}
	if err := removeAccount(cursorAccountKind, nil, nil, nil, nil, work.ID, nil); err != nil {
		t.Fatalf("removing Work: %v", err)
	}
	root, err := accountSlotsDir(cursorAccountKind)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(work.Dir, cursorMacLogin), work.Dir, accountSlotMetaPath(root, work.ID)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s outlived the removal (%v)", path, err)
		}
	}
	if got := cursorSlotLoginStatus(context.Background(), filepath.Join(cursorVersionDir(), cursorEntryPoint), work.Dir); got != authNo {
		t.Fatalf("the removed account reads %v", got)
	}
	if msg := engineAuthPreflight(providerCursor, map[string]string{cursorAccountDirVar: work.Dir}); !isAuthError(msg) ||
		!strings.Contains(msg, "no Cursor CLI account at "+work.Dir) {
		t.Fatalf("a session on the removed account = %q", msg)
	}
	if added := addedCursorSlots(t); len(added) != 1 || added[0].ID != team.ID || cursorTreeDigest(t, team.Dir) != teamDigest {
		t.Fatalf("removing Work changed the other accounts: %v", added)
	}
	if cursorTreeDigest(t, cursorDefaultAccountDir()) != defaultDigest {
		t.Fatal("removing an account changed Default's directory")
	}
	assertNoCursorStateIn(t, home)
}

// What else reads a login reads macOS's: each account's plan usage is asked of Cursor's dashboard with the
// token under its home/, and the model catalogue with Default's, its `agent acp` holding that token in memory.
func TestCursorMacUsageAndCatalogueReadTheHomeLogin(t *testing.T) {
	home, r := cursorMacRunner(t)
	defaultToken := cursorTestToken(t, time.Now().Add(24*time.Hour))
	signInCursorDefault(t, defaultToken)
	team, err := cursorAccountKind.create("Team")
	if err != nil {
		t.Fatal(err)
	}
	teamToken := cursorTestToken(t, time.Now().Add(48*time.Hour))
	signInCursorAccount(t, team.Dir, teamToken)
	free, premium := recordedCursorDashboard(t)
	dashboard := newFakeCursorDashboard(t)
	dashboard.account(defaultToken, free["GetCurrentPeriodUsage"], free["GetPlanInfo"])
	dashboard.account(teamToken, premium["GetCurrentPeriodUsage"], premium["GetPlanInfo"])
	for dir, plan := range map[string]string{cursorDefaultAccountDir(): "Free", team.Dir: "Premium"} {
		usage, err := (&cursorUsageRead{}).fetch(context.Background(), &http.Client{}, dir)
		if err != nil || usage.PlanName != plan {
			t.Fatalf("the usage of %s = %+v, %v; want its own %s plan", dir, usage, err, plan)
		}
	}
	for _, request := range dashboard.requests() {
		if !strings.HasSuffix(request, " "+defaultToken) && !strings.HasSuffix(request, " "+teamToken) {
			t.Fatalf("the dashboard was asked %q", request)
		}
	}
	models, err := fetchCursorModelCatalog(context.Background())
	if err != nil || len(models) == 0 {
		t.Fatalf("the catalogue = %d models, %v", len(models), err)
	}
	catalogue := callsWith(r.calls(t), "acp")
	if len(catalogue) != 1 {
		t.Fatalf("the catalogue started %d CLIs", len(catalogue))
	}
	if token, _ := catalogue[0].env("CURSOR_AUTH_TOKEN"); token != defaultToken {
		t.Fatal("the catalogue was read without Default's login")
	}
	assertProbeHome(t, catalogue[0], home)
	if saves := r.keychainSaves(t); len(saves) != 0 {
		t.Fatalf("the catalogue saved into the Keychain: %v", saves)
	}
	assertNoCursorStateIn(t, home)
}

// cursorCLIStarts are the places in the runner's own source that start a Cursor CLI process, by file and the
// function they are in: the version probe, `agent models` (an account's sign-in, a key's check), the model
// catalogue's `agent acp`, a session's `agent acp`, and `agent login`. Each sets AGENT_CLI_CREDENTIAL_STORE in
// the environment it starts with. The session scope's keeper (session_scope_linux.go) starts what the runner
// handed it, with the environment it was handed.
var cursorCLIStarts = []string{
	"cursor_acp.go startCursorACP",
	"cursor_health.go cursorModels",
	"cursor_install.go cursorProbeVersion",
	"cursor_models.go fetchCursorModelCatalogWith",
	"login.go start",
}

// cursorCLIStartSites is every exec.Command or exec.CommandContext in the runner's non-test source that starts
// Cursor CLI: each in a cursor_*.go file, and each elsewhere whose arguments name Cursor.
func cursorCLIStartSites(t *testing.T) []string {
	t.Helper()
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var sites []string
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		file, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		enclosing := func(pos token.Pos) string {
			for _, decl := range file.Decls {
				if fn, ok := decl.(*ast.FuncDecl); ok && fn.Pos() <= pos && pos < fn.End() {
					return fn.Name.Name
				}
			}
			return "(package level)"
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "Command" && sel.Sel.Name != "CommandContext") {
				return true
			}
			if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "exec" {
				return true
			}
			args := string(src[fset.Position(call.Lparen).Offset:fset.Position(call.Rparen).Offset])
			if strings.HasPrefix(name, "cursor_") || strings.Contains(strings.ToLower(args), "cursor") {
				sites = append(sites, name+" "+enclosing(call.Pos()))
			}
			return true
		})
	}
	sort.Strings(sites)
	return sites
}

// cursorCLIStartOf is which of cursorCLIStarts started call, by the arguments and the HOME each gives it: a
// probe's throwaway home is named for it (newCursorProbeRoot), a session's is its own directory's, a sign-in's
// its account's.
func cursorCLIStartOf(call fakeCursorCall, sessionHomes, accountHomes map[string]bool) string {
	home, _ := call.env("HOME")
	root := filepath.Base(filepath.Dir(home))
	switch {
	case call.Args[0] == "--version" && strings.HasPrefix(root, "orbit-cursor-version-"):
		return "cursor_install.go cursorProbeVersion"
	case call.Args[0] == "models" && strings.HasPrefix(root, "orbit-cursor-models-"):
		return "cursor_health.go cursorModels"
	case call.Args[0] == "acp" && strings.HasPrefix(root, "orbit-cursor-catalog-"):
		return "cursor_models.go fetchCursorModelCatalogWith"
	case call.Args[0] == "acp" && sessionHomes[home]:
		return "cursor_acp.go startCursorACP"
	case call.Args[0] == "login" && accountHomes[home]:
		return "login.go start"
	}
	return ""
}

// startAndStopCursorSession starts job's Cursor CLI the way the session driver does (startCursorACP), on the
// launch the runner prepares for it, has it initialize, and ends it.
func startAndStopCursorSession(t *testing.T, job *ClaimedSession, report cursorKeyReporter) CursorLaunchSpec {
	t.Helper()
	spec, err := PrepareCursorSessionLaunch(context.Background(), job, t.TempDir(), report)
	if err != nil {
		t.Fatal(err)
	}
	app, err := startCursorACP(context.Background(), spec, newCursorEventMapper(func(string, string, map[string]interface{}) {}), nil,
		func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatal(err)
	}
	defer app.dispose()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := app.initialize(ctx); err != nil {
		t.Fatalf("the session's CLI did not initialize: %v", err)
	}
	return spec
}

// Every Cursor CLI process the runner starts names its credential store: a file for `agent login`, memory for
// everything else — the version probe, `agent models` for a sign-in and for a key, the model catalogue and a
// session, on a key or on an account. So on macOS no process falls back to the default store, the Keychain
// (§18.4), and the scripted macOS build, which records every Keychain save, records none. The census holds the
// list of places that start Cursor CLI to the runner's source, so a new one cannot go unexamined; each of them
// is seen starting a process here.
func TestCursorEveryCLIStartNamesItsCredentialStore(t *testing.T) {
	exercise := func(t *testing.T, home string, r *fakeCursorRelease, loginRel string) {
		t.Helper()
		allowCursorInstall(t, false)
		relay := newCursorRelay(t)
		r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(24*time.Hour)))
		if got := relay.signInWith(t, r, LoginCommand{Attempt: "2026-10-25T02:10:00.000Z"}, "approve"); got[len(got)-1].Status != loginDone {
			t.Fatalf("Default's sign-in = %+v", got)
		}
		r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(48*time.Hour)))
		if got := relay.signInWith(t, r, LoginCommand{AccountName: "Work", Attempt: "2026-10-25T02:11:00.000Z"}, "approve"); got[len(got)-1].Status != loginDone {
			t.Fatalf("adding Work = %+v", got)
		}
		work := addedCursorSlots(t)[0]
		if _, report := cursorHealth(t); report.Auth != "yes" || len(report.Accounts) != 2 || report.Accounts[1].Auth != "yes" {
			t.Fatalf("the engine report = %+v", report)
		}
		var checked []CursorKeyCheckResult
		answerCursorKeyCheck(context.Background(), CursorKeyCheckCommand{CheckID: "check-1", APIKey: cursorTestKey}, func(result CursorKeyCheckResult) error {
			checked = append(checked, result)
			return nil
		})
		if len(checked) != 1 || checked[0].State != cursorKeyValid {
			t.Fatalf("a key's check = %+v", checked)
		}
		if models, err := fetchCursorModelCatalog(context.Background()); err != nil || len(models) == 0 {
			t.Fatalf("the catalogue: %v", err)
		}
		var keyReports []CursorKeyCheckReport
		onKey := startAndStopCursorSession(t, &ClaimedSession{SessionID: "e2222222-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAPIKeyVar: cursorTestKey}}},
			func(_ string, report CursorKeyCheckReport) error { keyReports = append(keyReports, report); return nil })
		if len(keyReports) != 1 || keyReports[0].State != cursorKeyValid {
			t.Fatalf("the session's key check = %+v", keyReports)
		}
		onWork := startAndStopCursorSession(t, &ClaimedSession{SessionID: "f2222222-2222-4333-8444-555555555555", AgentID: "a", Provider: providerCursor,
			Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{cursorAccountDirVar: work.Dir}}}, nil)

		sessionHomes := map[string]bool{onKey.Home: true, onWork.Home: true}
		accountHomes := map[string]bool{filepath.Join(cursorDefaultAccountDir(), "home"): true, filepath.Join(work.Dir, "home"): true}
		seen := map[string]int{}
		for _, call := range r.calls(t) {
			site := cursorCLIStartOf(call, sessionHomes, accountHomes)
			if site == "" {
				t.Errorf("a Cursor CLI process no start in the census accounts for: %v", call.Args)
				continue
			}
			seen[site]++
			want := "memory"
			if call.Args[0] == "login" {
				want = "file"
			}
			if store, ok := call.env("AGENT_CLI_CREDENTIAL_STORE"); !ok || store != want {
				t.Errorf("%s ran %v with AGENT_CLI_CREDENTIAL_STORE=%q (set: %v), want %q", site, call.Args, store, ok, want)
			}
		}
		for _, site := range cursorCLIStarts {
			if seen[site] == 0 {
				t.Errorf("%s started no Cursor CLI here", site)
			}
		}
		if seen["cursor_acp.go startCursorACP"] != 2 || seen["login.go start"] != 2 {
			t.Errorf("started sessions %d times and sign-ins %d times, want 2 each", seen["cursor_acp.go startCursorACP"], seen["login.go start"])
		}
		if saves := r.keychainSaves(t); len(saves) != 0 {
			t.Errorf("Cursor CLI saved into the Keychain: %v", saves)
		}
		// The only logins anywhere in Orbit's home are the two sign-ins', at the platform's place.
		want := []string{filepath.Join(cursorDefaultAccountDir(), loginRel), filepath.Join(work.Dir, loginRel)}
		sort.Strings(want)
		if logins := cursorLoginsUnder(t, machineHome()); !reflect.DeepEqual(logins, want) {
			t.Errorf("Orbit's home holds the logins %v, want %v", logins, want)
		}
		assertNoCursorStateIn(t, home)
	}
	t.Run("darwin", func(t *testing.T) {
		home, r := cursorMacRunner(t)
		exercise(t, home, r, cursorMacLogin)
		// The scripted macOS build does record a credential whose store was left to its default: a sign-in by
		// hand that drops AGENT_CLI_CREDENTIAL_STORE lands in the Keychain, not in its HOME.
		bare := t.TempDir()
		r.behave(t, "login-token", cursorTestToken(t, time.Now().Add(time.Hour)))
		r.behave(t, "login-outcome", "approve")
		cmd := exec.Command(filepath.Join(cursorVersionDir(), cursorEntryPoint), "login")
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + bare, "NO_OPEN_BROWSER=1", "CURSOR_AGENT_DISABLE_DEBUG_LOG=1"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("a sign-in by hand: %v %s", err, out)
		}
		if saves := r.keychainSaves(t); len(saves) != 1 || len(cursorLoginsUnder(t, bare)) != 0 {
			t.Fatalf("a sign-in with the default store saved %v into the Keychain and %v into its HOME, want one Keychain save", saves, cursorLoginsUnder(t, bare))
		}
	})
	t.Run("linux", func(t *testing.T) {
		home := useCursorRealHome(t)
		useCursorPlatform(t, "linux", "amd64")
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		exercise(t, home, r, cursorLinuxLogin)
	})
	t.Run("census", func(t *testing.T) {
		if got := cursorCLIStartSites(t); !reflect.DeepEqual(got, cursorCLIStarts) {
			t.Fatalf("the runner starts Cursor CLI at %q, and the census knows %q: a start it does not know must name its "+
				"credential store (AGENT_CLI_CREDENTIAL_STORE) before it joins cursorCLIStarts", got, cursorCLIStarts)
		}
	})
}
