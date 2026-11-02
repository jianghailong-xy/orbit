package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
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

func TestLaunchdStateTellsARunningAgentFromOneThatExited(t *testing.T) {
	running := "{\n\t\"LimitLoadToSessionType\" = \"Aqua\";\n\t\"Label\" = \"com.orbit.runner\";\n\t\"LastExitStatus\" = 0;\n\t\"PID\" = 812;\n};\n"
	exited := "{\n\t\"Label\" = \"com.orbit.runner\";\n\t\"LastExitStatus\" = 256;\n};\n"
	for _, tc := range []struct {
		name, out string
		err       error
		down      bool
		summary   string
	}{
		{"running", running, nil, false, ""},
		{"exited", exited, nil, true, "com.orbit.runner exited (status 256)"},
		{"not loaded", "", errors.New("exit status 113"), true, "com.orbit.runner is not loaded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			answerServiceQueries(t, func(cmd string) (string, error) {
				if cmd != "launchctl list com.orbit.runner" {
					t.Fatalf("asked %q", cmd)
				}
				return tc.out, tc.err
			})
			st, ok := launchdState("com.orbit.runner")
			if !ok || st.down != tc.down || st.summary != tc.summary {
				t.Fatalf("launchdState = %+v, %v; want down %v, %q", st, ok, tc.down, tc.summary)
			}
		})
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

func TestRegisterShowsALaunchAgentsLogFromItsFile(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "runner.log")
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, fmt.Sprintf("line %d", i))
	}
	if err := os.WriteFile(logPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	svc := &runnerService{label: launchdLabel, logPath: logPath, how: "starts at login"}
	got := serviceLog(svc, time.Now(), 3)
	if strings.Join(got, "|") != "line 18|line 19|line 20" {
		t.Fatalf("serviceLog = %q, want the last 3 lines", got)
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
