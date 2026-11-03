package main

import (
	"encoding/xml"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSystemdServiceFor(t *testing.T) {
	cases := []struct{ user, want string }{
		{"husong", "orbit-runner-husong"},
		{"alice_2", "orbit-runner-alice_2"},
		{"web-svc", "orbit-runner-web-svc"},
		// Characters not allowed in a systemd unit name are mapped to '_'.
		{"foo.bar", "orbit-runner-foo_bar"},
		{"a/b c", "orbit-runner-a_b_c"},
	}
	for _, c := range cases {
		if got := systemdServiceFor(c.user); got != c.want {
			t.Errorf("systemdServiceFor(%q) = %q, want %q", c.user, got, c.want)
		}
	}
	// Distinct users must yield distinct unit names — the whole point of per-user units.
	if systemdServiceFor("alice") == systemdServiceFor("bob") {
		t.Fatal("different users produced the same unit name")
	}
}

// launchdPlistInteger reads an integer off the top level of a plist, as launchd would: by parsing it.
func launchdPlistInteger(t *testing.T, plist, key string) (int, bool) {
	t.Helper()
	var doc struct {
		Dict struct {
			Items []struct {
				XMLName xml.Name
				Value   string `xml:",chardata"`
			} `xml:",any"`
		} `xml:"dict"`
	}
	if err := xml.Unmarshal([]byte(plist), &doc); err != nil {
		t.Fatalf("the plist does not parse: %v\n%s", err, plist)
	}
	items := doc.Dict.Items
	for i := 0; i+1 < len(items); i++ {
		if items[i].XMLName.Local == "key" && items[i].Value == key {
			if items[i+1].XMLName.Local != "integer" {
				t.Fatalf("%s is a <%s>, want an <integer>", key, items[i+1].XMLName.Local)
			}
			n, err := strconv.Atoi(items[i+1].Value)
			if err != nil {
				t.Fatalf("%s is not an integer: %v", key, err)
			}
			return n, true
		}
	}
	return 0, false
}

// launchd kills a runner when its window ends, whatever the runner still has to do. launchd reads what the plist
// says only up to a limit, measured at 60 s on macOS 26 and 27.2 (launchdExitTimeOutSeconds), so a larger number
// here would be a promise nobody keeps: the plist asks for what launchd gives, and all of a Mac's stop fits in it
// with room to spare. TestLaunchdGivesTheRunnerItsWholeStop has launchd itself answer, on a Mac.
func TestLaunchdPlistAllowsCompleteGracefulShutdown(t *testing.T) {
	for _, background := range []bool{false, true} {
		plist := renderLaunchdPlist(
			"/usr/local/bin/orbit",
			"/Users/test/.orbit",
			launchdLabel,
			"/Users/test",
			"/usr/local/bin:/usr/bin:/bin",
			"/Users/test/.orbit/runner.log",
			background,
			nil,
		)
		seconds, ok := launchdPlistInteger(t, plist, "ExitTimeOut")
		if !ok {
			t.Fatalf("the plist has no ExitTimeOut, which launchd reads as 5 s:\n%s", plist)
		}
		if seconds > 60 {
			t.Fatalf("ExitTimeOut = %d: macOS 26 and later read anything above 60 as 60", seconds)
		}
		mac := stopBudgetFor("darwin")
		if latest := mac.envelope + shutdownLastBeatWait + linkCloseWait; latest > time.Duration(seconds)*time.Second-5*time.Second {
			t.Fatalf("a Mac's stop can take %v, within 5 s of the %d s launchd gives it", latest, seconds)
		}
	}
}

const austinPlist = "/Users/austin/Library/LaunchAgents/com.orbit.runner.plist"

// launchdRefused is what launchd says, in these words, about a job it will not load: one already
// there, one still exiting, one disabled, and one in the wrong session.
const launchdRefused = "Bootstrap failed: 5: Input/output error"

// fakeLaunchctl stands in for every way the launchd paths reach launchctl: each command is recorded in
// order, and answer says what launchd makes of it.
func fakeLaunchctl(t *testing.T, answer func(cmd string) (string, error)) *[]string {
	t.Helper()
	var seen []string
	ask := func(name string, args []string) (string, error) {
		cmd := strings.TrimSpace(name + " " + strings.Join(args, " "))
		seen = append(seen, cmd)
		return answer(cmd)
	}
	prevQuiet, prevCapture, prevQuery := runQuiet, runCapture, serviceQuery
	runQuiet = func(name string, args ...string) { _, _ = ask(name, args) }
	runCapture = func(name string, args ...string) (string, error) { return ask(name, args) }
	serviceQuery = func(name string, args ...string) (string, error) { return ask(name, args) }
	t.Cleanup(func() { runQuiet, runCapture, serviceQuery = prevQuiet, prevCapture, prevQuery })
	return &seen
}

// launchdWith is launchd on an account that has a desktop session or does not, holding the runner's
// agent in loaded, or in no domain at all when that is empty.
func launchdWith(desktop bool, loaded string) func(cmd string) (string, error) {
	return func(cmd string) (string, error) {
		switch {
		case strings.HasPrefix(cmd, "launchctl print gui/") && !desktop:
			return "", errors.New("exit status 125")
		case strings.HasPrefix(cmd, "launchctl bootout ") && cmd != "launchctl bootout "+loaded+"/"+launchdLabel:
			return "Boot-out failed: 3: No such process", errors.New("exit status 3")
		}
		return "", nil
	}
}

func TestLaunchdDomainIsWhatThePlistRecords(t *testing.T) {
	render := func(background bool) string {
		return renderLaunchdPlist("/Users/austin/.orbit/bin/orbit", "/Users/austin/.orbit", launchdLabel, "/Users/austin",
			"/usr/bin:/bin", "/Users/austin/.orbit/runner.log", background, nil)
	}
	cases := []struct {
		name, plist, uid, want string
	}{
		{"an Aqua agent, as every older install wrote", render(false), "502", "gui/502"},
		{"a Background agent", render(true), "502", "user/502"},
		{"a Background agent as plutil spells it", "<dict>\n\t<key>LimitLoadToSessionType</key>\n\t<string>Background</string>\n</dict>", "502", "user/502"},
		{"limited to Aqua by name", "<key>LimitLoadToSessionType</key><string>Aqua</string>", "502", "gui/502"},
		{"no plist to read", "", "502", "gui/502"},
		{"root's, which loads into the system domain", render(false), "0", "system"},
	}
	for _, c := range cases {
		if got := launchdDomain(c.plist, c.uid); got != c.want {
			t.Errorf("%s: launchdDomain = %q, want %q", c.name, got, c.want)
		}
	}
}

// An account with a desktop session gets the plist it always got, to the byte: only what SSH-only
// accounts could not start before is new.
func TestLaunchdPlistNamesASessionOnlyForBackground(t *testing.T) {
	render := func(background bool) string {
		return renderLaunchdPlist("/o/bin/orbit", "/o", launchdLabel, "/h", "/usr/bin", "/o/runner.log", background, nil)
	}
	aqua, background := render(false), render(true)
	if strings.Contains(aqua, "LimitLoadToSessionType") {
		t.Fatalf("an Aqua plist names a session:\n%s", aqua)
	}
	key := "  <key>LimitLoadToSessionType</key><string>Background</string>\n"
	if strings.Replace(background, key, "", 1) != aqua {
		t.Fatalf("a Background plist differs from an Aqua one by more than the key:\n%s", background)
	}
}

// A shell reached over SSH says Background to `launchctl managername` even on an account that is at
// its desktop, where the agent has to stay Aqua to read the login Keychain, so what is asked is
// whether the account has a desktop domain.
func TestLaunchdNeedsBackgroundAsksAboutTheAccountNotTheShell(t *testing.T) {
	seen := fakeLaunchctl(t, func(cmd string) (string, error) {
		if cmd == "launchctl print gui/501" {
			return "gui/501 = {\n", nil
		}
		return "", errors.New("exit status 125")
	})
	if launchdNeedsBackground("501") {
		t.Error("an account at its desktop was given a Background agent")
	}
	if !launchdNeedsBackground("502") {
		t.Error("an account with no desktop session was given an Aqua agent")
	}
	if launchdNeedsBackground("0") {
		t.Error("root's agent, in the system domain, was given a session")
	}
	assertCommands(t, *seen, "launchctl print gui/501", "launchctl print gui/502")
}

// The agent moves: it leaves the domain the old plist put it in and loads into the new plist's, with
// the disabled mark `load -w` used to clear cleared first.
func TestStartLaunchdMovesTheAgentBetweenDomains(t *testing.T) {
	seen := fakeLaunchctl(t, launchdWith(true, "gui/502"))
	if err := startLaunchd("gui/502", "user/502", austinPlist, launchdLabel, func() {}); err != nil {
		t.Fatal(err)
	}
	assertCommands(t, *seen,
		"launchctl bootout gui/502/"+launchdLabel,
		"launchctl enable user/502/"+launchdLabel,
		"launchctl bootstrap user/502 "+austinPlist,
	)
}

// launchctl's refusal is the only thing that says why the LaunchAgent would not load; the installer
// must carry it into the error instead of replacing it with "load failed", and not wait on it.
func TestStartLaunchdReportsLaunchctlsOwnRefusal(t *testing.T) {
	const detail = "Bootstrap failed: 125: Domain does not support specified action"
	seen := fakeLaunchctl(t, func(cmd string) (string, error) {
		if strings.Contains(cmd, "bootstrap") {
			return detail, errors.New("exit status 125")
		}
		return "", nil
	})
	err := startLaunchd("gui/502", "gui/502", austinPlist, launchdLabel, func() {})
	if err == nil || !strings.Contains(err.Error(), detail) {
		t.Fatalf("startLaunchd error = %v, want launchctl's %q", err, detail)
	}
	bootstraps := 0
	for _, cmd := range *seen {
		if strings.Contains(cmd, "bootstrap") {
			bootstraps++
		}
	}
	if bootstraps != 1 {
		t.Fatalf("bootstrap calls = %d, want 1 for a refusal waiting cannot change", bootstraps)
	}
}

// bootout returns at once and bootstrap refuses until the old runner has exited, which launchd lets
// take a minute or more: that wait is sat through when bootout removed a job. With no job removed
// launchd is refusing for a reason time will not change, in the same words, and register says so soon.
func TestStartLaunchdWaitsOutADrainOnlyWhenItRemovedAJob(t *testing.T) {
	prevTries, prevDrain, prevPause := launchdBootstrapTries, launchdDrainTries, launchdBootstrapPause
	launchdBootstrapTries, launchdDrainTries, launchdBootstrapPause = 2, 5, 0
	t.Cleanup(func() {
		launchdBootstrapTries, launchdDrainTries, launchdBootstrapPause = prevTries, prevDrain, prevPause
	})

	cases := []struct {
		name         string
		removed      bool
		refusals     int
		wantAttempts int
		wantErr      bool
	}{
		{"a drain that ends", true, 4, 5, false},
		{"a drain that outlasts the wait", true, 99, 5, true},
		{"nothing to wait for", false, 99, 2, true},
		{"nothing to wait for, loads first go", false, 0, 1, false},
	}
	for _, c := range cases {
		attempts := 0
		fakeLaunchctl(t, func(cmd string) (string, error) {
			switch {
			case strings.HasPrefix(cmd, "launchctl bootout") && !c.removed:
				return "Boot-out failed: 3: No such process", errors.New("exit status 3")
			case strings.HasPrefix(cmd, "launchctl bootstrap"):
				if attempts++; attempts <= c.refusals {
					return launchdRefused, errors.New("exit status 5")
				}
			}
			return "", nil
		})
		err := startLaunchd("user/502", "user/502", austinPlist, launchdLabel, func() {})
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v", c.name, err)
		}
		if err != nil && !strings.Contains(err.Error(), launchdRefused) {
			t.Errorf("%s: err = %v, want launchd's own words", c.name, err)
		}
		if attempts != c.wantAttempts {
			t.Errorf("%s: bootstrap attempts = %d, want %d", c.name, attempts, c.wantAttempts)
		}
	}
}

// installLaunchdFor runs a registration for austin, uid 502, over launchd as answer has it, with
// installed already on disk when it is not empty.
func installLaunchdFor(t *testing.T, installed string, answer func(cmd string) (string, error)) (svc *runnerService, plist string, seen *[]string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	orbitHome := filepath.Join(home, ".orbit")
	if err := os.MkdirAll(filepath.Join(orbitHome, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(orbitHome, "bin", "orbit")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	plist = launchAgentPath(home)
	if installed != "" {
		if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(plist, []byte(installed), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	prevUser, prevRoot, prevRun := currentUser, rootOwnedDir, run
	currentUser = func() (*user.User, error) {
		return &user.User{Username: "austin", Uid: "502", Gid: "20", HomeDir: home}, nil
	}
	rootOwnedDir = func(string) bool { return false }
	// `launchctl load` lands wherever it runs, and over SSH it aborts having loaded nothing.
	run = func(name string, args ...string) error {
		t.Fatalf("installLaunchd used the legacy launchctl path: %s %s", name, strings.Join(args, " "))
		return nil
	}
	t.Cleanup(func() { currentUser, rootOwnedDir, run = prevUser, prevRoot, prevRun })

	seen = fakeLaunchctl(t, answer)
	svc, err := installLaunchd(exe, orbitHome, launchdLabel, nil)
	if err != nil {
		t.Fatal(err)
	}
	return svc, plist, seen
}

func TestInstallLaunchdAtTheDesktopStaysAnAquaAgent(t *testing.T) {
	svc, plist, seen := installLaunchdFor(t, "", launchdWith(true, ""))
	assertCommands(t, *seen,
		"launchctl print gui/502",
		"launchctl bootout gui/502/"+launchdLabel,
		"launchctl enable gui/502/"+launchdLabel,
		"launchctl bootstrap gui/502 "+plist,
	)
	written, _ := os.ReadFile(plist)
	if strings.Contains(string(written), "LimitLoadToSessionType") {
		t.Fatalf("plist names a session:\n%s", written)
	}
	if svc.how != "starts at login" || len(svc.notes) != 0 {
		t.Fatalf("service = %+v", svc)
	}
}

// The account the proposal for this came from: nothing short of this ever started on it.
func TestInstallLaunchdWithNoDesktopIsABackgroundAgent(t *testing.T) {
	svc, plist, seen := installLaunchdFor(t, "", launchdWith(false, ""))
	assertCommands(t, *seen,
		"launchctl print gui/502",
		"launchctl bootout gui/502/"+launchdLabel,
		"launchctl enable user/502/"+launchdLabel,
		"launchctl bootstrap user/502 "+plist,
	)
	written, _ := os.ReadFile(plist)
	if got := launchdDomain(string(written), "502"); got != "user/502" {
		t.Fatalf("the plist written says domain %q:\n%s", got, written)
	}
	// Nothing brings it back after a restart, and this is the one moment register has to say so.
	said := strings.Join(svc.notes, "\n")
	if svc.how != launchdBackgroundHow || !strings.Contains(said, "launchctl bootstrap user/502 "+plist) || !strings.Contains(said, "Keychain") {
		t.Fatalf("service = %+v", svc)
	}
}

// Registering again from the other kind of session leaves one runner: the old agent goes from where
// its plist put it, which is not where the new one loads.
func TestInstallLaunchdLeavesNoAgentInTheOtherDomain(t *testing.T) {
	render := func(background bool) string {
		return renderLaunchdPlist("/o/orbit", "/o", launchdLabel, "/h", "/usr/bin", "/o/runner.log", background, nil)
	}
	t.Run("logged in at the desktop since", func(t *testing.T) {
		_, plist, seen := installLaunchdFor(t, render(true), launchdWith(true, "user/502"))
		assertCommands(t, *seen,
			"launchctl print gui/502",
			"launchctl bootout user/502/"+launchdLabel,
			"launchctl enable gui/502/"+launchdLabel,
			"launchctl bootstrap gui/502 "+plist,
		)
	})
	t.Run("no desktop session any more", func(t *testing.T) {
		_, plist, seen := installLaunchdFor(t, render(false), launchdWith(false, ""))
		assertCommands(t, *seen,
			"launchctl print gui/502",
			"launchctl bootout gui/502/"+launchdLabel,
			"launchctl enable user/502/"+launchdLabel,
			"launchctl bootstrap user/502 "+plist,
		)
	})
}

// A runner that does not come online shows its log from this start only (serviceLog), and the runner it
// replaces goes on logging its drain after bootout has returned: none of that is why this start failed.
func TestInstallLaunchdCountsTheLogFromWhenTheOldRunnerHasStopped(t *testing.T) {
	prevPause := launchdBootstrapPause
	launchdBootstrapPause = 0
	t.Cleanup(func() { launchdBootstrapPause = prevPause })

	refusals := 2
	svc, _, _ := installLaunchdFor(t, "", func(cmd string) (string, error) {
		if !strings.HasPrefix(cmd, "launchctl bootstrap") || refusals == 0 {
			return "", nil
		}
		refusals--
		f, err := os.OpenFile(filepath.Join(os.Getenv("HOME"), ".orbit", "runner.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteString("runner stopping; draining session supervisors...\n"); err != nil {
			t.Fatal(err)
		}
		return launchdRefused, errors.New("exit status 5")
	})
	written, err := os.ReadFile(svc.logPath)
	if err != nil {
		t.Fatal(err)
	}
	if svc.logFrom != int64(len(written)) {
		t.Fatalf("logFrom = %d, want %d, past everything the old runner wrote:\n%s", svc.logFrom, len(written), written)
	}
}

func TestUninstallLaunchdRemovesTheAgentFromWhereItIs(t *testing.T) {
	for _, c := range []struct {
		name       string
		background bool
		domain     string
	}{
		{"an Aqua agent", false, "gui/502"},
		{"a Background agent", true, "user/502"},
	} {
		home := t.TempDir()
		plist := launchAgentPath(home)
		if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
			t.Fatal(err)
		}
		content := renderLaunchdPlist("/o/orbit", "/o", launchdLabel, home, "/usr/bin", "/o/runner.log", c.background, nil)
		if err := os.WriteFile(plist, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		prevUser := currentUser
		currentUser = func() (*user.User, error) { return &user.User{Username: "austin", Uid: "502"}, nil }
		t.Cleanup(func() { currentUser = prevUser })
		seen := fakeLaunchctl(t, launchdWith(true, c.domain))
		uninstallLaunchd(home, launchdLabel)
		assertCommands(t, *seen, "launchctl bootout "+c.domain+"/"+launchdLabel)
		if fileExists(plist) {
			t.Errorf("%s: the plist is still there", c.name)
		}
	}
}
