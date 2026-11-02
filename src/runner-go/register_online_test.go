package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// beats is a control plane's answers to GET /runner/me, one per poll: a time is the beat it reports,
// "" none yet, and an error is an answer that did not come.
type beats []any

func (b *beats) me() (*MeResponse, error) {
	if len(*b) == 0 {
		return nil, errors.New("asked more often than the test expected")
	}
	next := (*b)[0]
	if len(*b) > 1 {
		*b = (*b)[1:]
	}
	switch v := next.(type) {
	case error:
		return nil, v
	case string:
		if v == "" {
			return &MeResponse{}, nil
		}
		return &MeResponse{LastHeartbeatAt: &v}, nil
	}
	panic(fmt.Sprintf("beats: %v", next))
}

// testWatch is an onlineWatch over answers, with a clock that moves only by its polls and a service
// manager that says the service is running unless down says otherwise.
func testWatch(answers *beats, down *serviceState) (onlineWatch, *int) {
	polls := 0
	clock := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	return onlineWatch{
		server: "https://orbit.example",
		me:     answers.me,
		state: func() (serviceState, bool) {
			if down != nil {
				return *down, true
			}
			return serviceState{}, true
		},
		sleep: func(d time.Duration) { polls++; clock = clock.Add(d) },
		now:   func() time.Time { return clock },
		wait:  time.Minute,
		poll:  time.Second,
	}, &polls
}

func strPtr(s string) *string { return &s }

// A runner registered again keeps the beats of the process its old credential belonged to: the control
// plane may call it online on one of those before the new service has started. Only a beat after the
// one reported before the service started says the service works.
func TestRegisterWaitsForABeatLaterThanTheOneBeforeTheServiceStarted(t *testing.T) {
	old := "2026-11-02T00:00:00.000Z"
	answers := beats{old, old, "2026-11-02T00:00:03.120Z"}
	watch, polls := testWatch(&answers, nil)
	if err := watch.until(&MeResponse{LastHeartbeatAt: strPtr(old)}); err != nil {
		t.Fatalf("until = %v, want online at the later beat", err)
	}
	if *polls != 3 {
		t.Fatalf("online after %d polls, want 3: the old beat is not this service's", *polls)
	}

	// A control plane that keeps reporting the old beat never makes it online.
	answers = beats{old}
	watch, _ = testWatch(&answers, nil)
	err := watch.until(&MeResponse{LastHeartbeatAt: strPtr(old)})
	if err == nil || !strings.Contains(err.Error(), "https://orbit.example has not heard from it in 1m0s") {
		t.Fatalf("until = %v, want the wait to run out", err)
	}
}

func TestRegisterCountsTheFirstBeatOfARunnerNeverHeardFrom(t *testing.T) {
	answers := beats{"", "2026-11-02T00:00:01Z"}
	watch, polls := testWatch(&answers, nil)
	if err := watch.until(&MeResponse{}); err != nil || *polls != 2 {
		t.Fatalf("until = %v after %d polls, want online at the second", err, *polls)
	}
}

// When the control plane could not be asked before the service started, a beat it reports may be that
// service's or the old process's: the first answer stands in for the reading before, and the next beat
// after it is the service's.
func TestRegisterWithoutAReadingBeforeWaitsForTheNextBeat(t *testing.T) {
	first := "2026-11-02T00:00:01Z"
	answers := beats{errors.New("connection refused"), first, first, "2026-11-02T00:00:31Z"}
	watch, polls := testWatch(&answers, nil)
	if err := watch.until(nil); err != nil || *polls != 4 {
		t.Fatalf("until = %v after %d polls, want online at the fourth", err, *polls)
	}

	answers = beats{errors.New("connection refused")}
	watch, _ = testWatch(&answers, nil)
	if err := watch.until(nil); err == nil || !strings.Contains(err.Error(), "could not be asked whether it has heard from it (connection refused)") {
		t.Fatalf("until = %v, want the unanswered question", err)
	}
}

// The incident's runner exited at every start: the service manager says so long before the wait runs
// out, and register says what it said.
func TestRegisterStopsWaitingForAServiceThatKeepsExiting(t *testing.T) {
	answers := beats{""}
	down := serviceState{down: true, summary: "orbit-runner-c2b.service exited with status 1 and was restarted 2 times"}
	watch, polls := testWatch(&answers, &down)
	err := watch.until(&MeResponse{})
	want := "orbit-runner-c2b.service exited with status 1 and was restarted 2 times, and https://orbit.example has not heard from it"
	if err == nil || err.Error() != want {
		t.Fatalf("until = %v, want %q", err, want)
	}
	if *polls != 1 {
		t.Fatalf("gave up after %d polls, want 1", *polls)
	}
}

func TestRegisterStopsWaitingWhenTheCredentialIsRefused(t *testing.T) {
	answers := beats{&transportHTTPError{statusCode: 401}}
	watch, _ := testWatch(&answers, nil)
	if err := watch.until(&MeResponse{}); err == nil || !strings.Contains(err.Error(), "no longer accepts its credential") {
		t.Fatalf("until = %v, want the refused credential", err)
	}
}

// answerServiceQueries swaps serviceQuery for answers keyed by the command line.
func answerServiceQueries(t *testing.T, answer func(cmd string) (string, error)) {
	t.Helper()
	prev := serviceQuery
	t.Cleanup(func() { serviceQuery = prev })
	serviceQuery = func(name string, args ...string) (string, error) {
		return answer(strings.Join(append([]string{name}, args...), " "))
	}
}

func TestSystemdStateTellsARunningUnitFromOneThatKeepsExiting(t *testing.T) {
	cases := []struct {
		name, show string
		before     int
		down       bool
		summary    string
	}{
		{"running", "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=4\nExecMainCode=0\nExecMainStatus=0\n", 4, false, ""},
		{"restarted once", "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=1\nExecMainCode=0\nExecMainStatus=0\n", 0, false, ""},
		{"crash loop", "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nNRestarts=3\nExecMainCode=1\nExecMainStatus=1\n", 1, true,
			"orbit-runner-c2b.service exited with status 1 and was restarted 2 times"},
		{"failed", "LoadState=loaded\nActiveState=failed\nSubState=failed\nNRestarts=0\nExecMainCode=2\nExecMainStatus=9\n", 0, true,
			"orbit-runner-c2b.service was killed by signal 9 and is failed"},
		{"stopped", "LoadState=loaded\nActiveState=inactive\nSubState=dead\nNRestarts=0\nExecMainCode=0\nExecMainStatus=0\n", 0, true,
			"orbit-runner-c2b.service is inactive"},
		{"gone", "LoadState=not-found\nActiveState=inactive\nSubState=dead\n", 0, true, "orbit-runner-c2b.service is no longer installed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			answerServiceQueries(t, func(cmd string) (string, error) {
				if !strings.HasPrefix(cmd, "systemctl show orbit-runner-c2b.service ") {
					t.Fatalf("asked %q", cmd)
				}
				return tc.show, nil
			})
			st, ok := systemdState("orbit-runner-c2b.service", tc.before)
			if !ok || st.down != tc.down || st.summary != tc.summary {
				t.Fatalf("systemdState = %+v, %v; want down %v, %q", st, ok, tc.down, tc.summary)
			}
		})
	}

	answerServiceQueries(t, func(string) (string, error) { return "", errors.New("no systemctl") })
	if _, ok := systemdState("orbit-runner-c2b.service", 0); ok {
		t.Fatal("systemdState read a unit with no systemctl to ask")
	}
}

func TestLaunchdStateTellsARunningAgentFromOneThatKeepsExiting(t *testing.T) {
	running := "{\n\t\"LimitLoadToSessionType\" = \"Aqua\";\n\t\"Label\" = \"com.orbit.runner\";\n\t\"LastExitStatus\" = 0;\n\t\"PID\" = 812;\n};\n"
	exited := "{\n\t\"Label\" = \"com.orbit.runner\";\n\t\"LastExitStatus\" = 256;\n};\n"
	restarted := "{\n\t\"Label\" = \"com.orbit.runner\";\n\t\"LastExitStatus\" = 256;\n\t\"PID\" = 813;\n};\n"
	answer, answerErr := running, error(nil)
	answerServiceQueries(t, func(cmd string) (string, error) {
		if cmd != "launchctl list com.orbit.runner" {
			t.Fatalf("asked %q", cmd)
		}
		return answer, answerErr
	})
	gaps := 0
	read := func() serviceState {
		t.Helper()
		st, ok := launchdState("com.orbit.runner", &gaps)
		if !ok {
			t.Fatal("launchdState could not read the agent")
		}
		return st
	}
	if st := read(); st.down {
		t.Fatalf("a running agent is down: %+v", st)
	}
	// One exit is no verdict: KeepAlive starts it again within 10 s, and then it is running.
	answer = exited
	for i := 0; i < launchdExitGaps; i++ {
		if st := read(); st.down {
			t.Fatalf("down after %d polls of one exit's gap: %+v", i+1, st)
		}
	}
	answer = restarted
	if st := read(); st.down {
		t.Fatalf("an agent started again is down: %+v", st)
	}
	// More gaps than one exit leaves: it exited again.
	answer = exited
	st := read()
	if want := "com.orbit.runner exited with status 1 and keeps being started again"; !st.down || st.summary != want {
		t.Fatalf("launchdState = %+v, want down with %q", st, want)
	}

	answer, answerErr = "", errors.New("exit status 113")
	if st := read(); !st.down || st.summary != "com.orbit.runner is not loaded" {
		t.Fatalf("launchdState not loaded = %+v", st)
	}
}

func TestWaitStatusTextSaysWhatLaunchdsStatusMeans(t *testing.T) {
	for status, want := range map[string]string{
		"256":  "exited with status 1",
		"768":  "exited with status 3",
		"9":    "was killed by signal 9",
		"oops": "exited (status oops)",
	} {
		if got := waitStatusText(status); got != want {
			t.Errorf("waitStatusText(%s) = %q, want %q", status, got, want)
		}
	}
}

// What register prints when the control plane did not hear from the service: why, the end of what the
// runner logged since it started, and where to look further — for the incident's unit, its journal.
func TestRegisterSaysWhyTheRunnerIsNotOnlineAndWhereToLook(t *testing.T) {
	started := time.Unix(1793577600, 0)
	answerServiceQueries(t, func(cmd string) (string, error) {
		want := "journalctl -u orbit-runner-c2b.service --since @1793577600 --no-pager --output=cat -n 15"
		if cmd != want {
			t.Fatalf("asked %q, want %q", cmd, want)
		}
		return "cannot secure runner config storage: chmod /root/.orbit: permission denied\n" +
			"cannot secure runner config storage: chmod /root/.orbit: permission denied\n", nil
	})
	svc := &runnerService{unit: "orbit-runner-c2b.service", how: "runs at boot"}
	var out bytes.Buffer
	reason := &notOnline{"orbit-runner-c2b.service exited with status 1 and was restarted 2 times, and https://orbitd.io has not heard from it"}
	printNotOnline(&out, "c2b-load-2", svc, reason, serviceLog(svc, started, 15))
	want := "\n✗ c2b-load-2 did not come online: orbit-runner-c2b.service exited with status 1 and was restarted 2 times, and https://orbitd.io has not heard from it.\n" +
		"  Its log ends:\n" +
		"    cannot secure runner config storage: chmod /root/.orbit: permission denied\n" +
		"    cannot secure runner config storage: chmod /root/.orbit: permission denied\n" +
		"  Look further with:\n" +
		"    systemctl status orbit-runner-c2b.service\n" +
		"    journalctl -u orbit-runner-c2b.service -e\n"
	if out.String() != want {
		t.Fatalf("printed:\n%s\nwant:\n%s", out.String(), want)
	}

	// A journal the account may not read leaves only where to look.
	answerServiceQueries(t, func(string) (string, error) { return "-- No entries --\n", nil })
	out.Reset()
	printNotOnline(&out, "c2b-load-2", svc, reason, serviceLog(svc, started, 15))
	if strings.Contains(out.String(), "Its log") || !strings.Contains(out.String(), "journalctl -u orbit-runner-c2b.service -e") {
		t.Fatalf("printed:\n%s", out.String())
	}
}

// A LaunchAgent's log is a file every runner registered on the account has written to: what register
// shows of it is what this start wrote, from where the file ended when the agent was loaded.
func TestRegisterShowsALaunchAgentsLogFromItsFile(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "runner.log")
	earlier := "runner \"before\" online\nrunner stopping; draining session supervisors...\n"
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, fmt.Sprintf("line %d", i))
	}
	if err := os.WriteFile(logPath, []byte(earlier+strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := &runnerService{label: launchdLabel, logPath: logPath, logFrom: int64(len(earlier)), how: "starts at login"}
	got := serviceLog(svc, time.Now(), 3)
	if strings.Join(got, "|") != "line 18|line 19|line 20" {
		t.Fatalf("serviceLog = %q, want the last 3 lines", got)
	}
	if got := serviceLog(svc, time.Now(), 30); len(got) != 20 || got[0] != "line 1" {
		t.Fatalf("serviceLog = %q, want this start's 20 lines and none from before", got)
	}
	// A file started anew since, shorter than where it ended: all of it is this start's.
	if err := os.WriteFile(logPath, []byte("fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := serviceLog(svc, time.Now(), 30); strings.Join(got, "|") != "fresh" {
		t.Fatalf("serviceLog = %q, want the new file's line", got)
	}
	if got := svc.whereToLook(); strings.Join(got, "|") != "launchctl list com.orbit.runner|tail -n 100 "+logPath {
		t.Fatalf("whereToLook = %q", got)
	}
}

func TestRegisterReceiptWhenTheServiceDidNotComeOnline(t *testing.T) {
	cfg := &RunnerConfig{Name: "c2b-load-2", ServerURL: "https://orbitd.io", RunnerID: registerTestRunnerID}
	var out bytes.Buffer
	printRegisterReceipt(&out, cfg, serviceNotOnline, false)
	got := out.String()
	for _, want := range []string{
		"✗ Setup incomplete — c2b-load-2 is registered, but not online.",
		"Next     get its service running (see above), then Start a session",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("receipt lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "is online") || strings.Contains(got, "Setup complete") {
		t.Errorf("receipt claims what did not happen:\n%s", got)
	}
}

// A runner registered under sudo is the account's, and root's own `orbit status` knows nothing of it.
func TestRegisterReceiptUnderSudoSaysWhoseCommandsTheyAre(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", HomeDir: t.TempDir()}
	prevEUID, prevCurrent := processEUID, currentUser
	t.Cleanup(func() { processEUID, currentUser = prevEUID, prevCurrent })
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	cfg := &RunnerConfig{Name: "c2b-load-2", ServerURL: "https://orbitd.io", RunnerID: registerTestRunnerID}
	t.Setenv(sudoHandOffMark, "1")
	for sudoUser, want := range map[string]string{
		"root": "orbit status · orbit doctor · orbit unregister (as c2b)\n",
		"":     "orbit status · orbit doctor · orbit unregister\n",
	} {
		t.Setenv("SUDO_USER", sudoUser)
		var out bytes.Buffer
		printRegisterReceipt(&out, cfg, serviceOnline, false)
		if !strings.Contains(out.String(), want) {
			t.Errorf("SUDO_USER=%q: receipt lacks %q:\n%s", sudoUser, want, out.String())
		}
	}
}

// Registering saves only what the control plane has already issued, so a home that cannot hold it is found
// before anyone is asked anything. Root may write anywhere, so these are ones nobody can.
func TestCheckConfigStorageFindsAHomeThatCannotHoldTheConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(dir, "new", ".orbit"))
	if err := checkConfigStorage(); err != nil {
		t.Fatalf("a home it can create: %v", err)
	}
	assertPrivateMode(t, machineHome(), machineHomePerm)
	if entries, err := os.ReadDir(machineHome()); err != nil || len(entries) != 0 {
		t.Fatalf("the check left %v (%v) in the home", entries, err)
	}

	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", filepath.Join(file, ".orbit"))
	if err := checkConfigStorage(); err == nil {
		t.Fatal("a home under a regular file passed")
	}

	t.Setenv("ORBIT_HOME", filepath.Join(dir, "blocked"))
	if err := os.MkdirAll(filepath.Join(machineHome(), "config.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := checkConfigStorage(); err == nil {
		t.Fatal("a config path that cannot be written passed")
	}
}

// An account a release build cannot look up, as with LDAP, keeps its group by number, which systemd takes:
// its name alone would be a group that does not exist.
func TestPrimaryGroupFallsBackToItsNumber(t *testing.T) {
	if got := primaryGroup(&user.User{Gid: "4242424", Username: "ldap-user"}); got != "4242424" {
		t.Errorf("primaryGroup = %q, want the number", got)
	}
	if got := primaryGroup(&user.User{Username: "ldap-user"}); got != "ldap-user" {
		t.Errorf("primaryGroup with no gid = %q, want the name", got)
	}
}

func TestBeatAfterComparesTheReadings(t *testing.T) {
	for _, tc := range []struct {
		after, before *string
		want          bool
	}{
		{nil, nil, false},
		{strPtr("2026-11-02T00:00:01Z"), nil, true},
		{strPtr("2026-11-02T00:00:01Z"), strPtr("2026-11-02T00:00:01Z"), false},
		{strPtr("2026-11-02T00:00:01.5Z"), strPtr("2026-11-02T00:00:01Z"), true},
		{strPtr("2026-11-02T00:00:00Z"), strPtr("2026-11-02T00:00:01Z"), false},
		{strPtr("later"), strPtr("earlier"), true},
	} {
		if got := beatAfter(tc.after, tc.before); got != tc.want {
			t.Errorf("beatAfter(%v, %v) = %v, want %v", deref(tc.after), deref(tc.before), got, tc.want)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
