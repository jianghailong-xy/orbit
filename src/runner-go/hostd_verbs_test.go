package main

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The uid every test below calls as. Deliberately not os.Getuid(): the suite runs as
// root in CI, and root is the one uid these verbs treat differently.
const (
	testUID  = 1000
	testUser = "alice"
)

var testPeer = hostdPeer{UID: testUID, PID: 4242}

// testUnit is the instance every request from testPeer must land on, and the only one.
var testUnit = unitForUid(testUID)

// fakeSystem records every command the verbs issue and answers the ones they read from,
// so a test can assert the exact argv systemd would have been handed. Commands run for
// effect and commands run for their output are kept apart: `ran` is what hostd *did* to
// the machine, which is what the argv assertions are about.
type fakeSystem struct {
	ran    [][]string
	asked  [][]string
	stdout map[string]string
	fail   map[string]error
}

func (f *fakeSystem) run(name string, args ...string) (string, error) {
	argv := append([]string{name}, args...)
	f.ran = append(f.ran, argv)
	return f.answer(argv)
}

func (f *fakeSystem) query(name string, args ...string) (string, error) {
	argv := append([]string{name}, args...)
	f.asked = append(f.asked, argv)
	return f.answer(argv)
}

func (f *fakeSystem) answer(argv []string) (string, error) {
	key := strings.Join(argv, " ")
	return f.stdout[key], f.fail[key]
}

// newFakeSystem wires the verbs to the recorder, a temporary unit directory, and a
// passwd database containing root plus testUser.
func newFakeSystem(t *testing.T) (*fakeSystem, hostdSystem) {
	t.Helper()
	f := &fakeSystem{stdout: map[string]string{}, fail: map[string]error{}}
	return f, hostdSystem{
		run:       f.run,
		query:     f.query,
		lookupUID: fakeLookupUID(map[string]string{"0": "root", strconv.Itoa(testUID): testUser}),
		unitDir:   t.TempDir(),
	}
}

func fakeLookupUID(users map[string]string) func(string) (*user.User, error) {
	return func(uid string) (*user.User, error) {
		name, ok := users[uid]
		if !ok {
			return nil, fmt.Errorf("user: unknown userid %s", uid)
		}
		return &user.User{Uid: uid, Username: name}, nil
	}
}

// writeLegacyUnit plants a pre-template unit file and teaches the fake systemctl what
// `show -p User` says about it — the two facts unitRunsAsUserIn consults.
func writeLegacyUnit(t *testing.T, f *fakeSystem, sys hostdSystem, svc, runAs string) string {
	t.Helper()
	path := filepath.Join(sys.unitDir, svc+".service")
	if err := os.WriteFile(path, []byte("[Service]\nUser="+runAs+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.stdout["systemctl show "+svc+".service -p User --value"] = runAs + "\n"
	return path
}

func assertArgv(t *testing.T, got [][]string, want ...[]string) {
	t.Helper()
	if want == nil {
		want = [][]string{}
	}
	if got == nil {
		got = [][]string{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("commands run:\n  got  %v\n  want %v", got, want)
	}
}

// Criterion 1 and 2 together: enable's complete argv sequence is migration (only when
// there is something of this user's to migrate), then enable, then restart.
func TestHostdEnableMigratesThenEnablesAndRestarts(t *testing.T) {
	perUser := systemdServiceFor(testUser) // orbit-runner-alice
	enableThenRestart := [][]string{
		{"systemctl", "enable", testUnit},
		{"systemctl", "restart", testUnit},
	}

	cases := []struct {
		name string
		// legacy unit files to plant, as svc name -> the unit's User=.
		legacy      map[string]string
		wantRan     [][]string
		wantRemoved []string
		wantKept    []string
	}{
		{
			name:        "no legacy units at all",
			wantRan:     enableThenRestart,
			wantRemoved: nil,
		},
		{
			name:   "the caller's own per-user unit",
			legacy: map[string]string{perUser: testUser},
			wantRan: append([][]string{
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "daemon-reload"},
			}, enableThenRestart...),
			wantRemoved: []string{perUser},
		},
		{
			name:   "the caller's own bare pre-naming unit",
			legacy: map[string]string{systemdService: testUser},
			wantRan: append([][]string{
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			}, enableThenRestart...),
			wantRemoved: []string{systemdService},
		},
		{
			// Both generations present: each is disabled and removed, and systemd is
			// asked to re-read the directory once, at the end.
			name:   "both generations of the caller's unit",
			legacy: map[string]string{perUser: testUser, systemdService: testUser},
			wantRan: append([][]string{
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			}, enableThenRestart...),
			wantRemoved: []string{perUser, systemdService},
		},
		{
			// The name says alice; User= says bob. Zero migration calls, file untouched.
			name:     "a per-user unit whose User= is somebody else",
			legacy:   map[string]string{perUser: "bob"},
			wantRan:  enableThenRestart,
			wantKept: []string{perUser},
		},
		{
			name:     "a bare unit belonging to another account's runner",
			legacy:   map[string]string{systemdService: "bob"},
			wantRan:  enableThenRestart,
			wantKept: []string{systemdService},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			for _, svc := range []string{perUser, systemdService} { // deterministic order
				if runAs, ok := c.legacy[svc]; ok {
					writeLegacyUnit(t, f, sys, svc, runAs)
				}
			}

			resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
			if !resp.OK {
				t.Fatalf("enable failed: %s", resp.Error)
			}
			assertArgv(t, f.ran, c.wantRan...)
			if got := resp.Data["unit"]; got != testUnit {
				t.Errorf("response unit = %v, want %v", got, testUnit)
			}

			for _, svc := range c.wantRemoved {
				if _, err := os.Stat(filepath.Join(sys.unitDir, svc+".service")); !os.IsNotExist(err) {
					t.Errorf("%s.service survived the migration", svc)
				}
			}
			for _, svc := range c.wantKept {
				if _, err := os.Stat(filepath.Join(sys.unitDir, svc+".service")); err != nil {
					t.Errorf("%s.service belongs to another account and must not be touched: %v", svc, err)
				}
			}
		})
	}
}

// The collision unit-name escaping cannot resolve, and the reason ownership is decided
// by User= rather than by the file's name: "alice.b" and "alice_b" are two real accounts
// that systemdServiceFor maps onto one unit name.
func TestHostdEnableLeavesACollidingUnitOfAnotherAccountAlone(t *testing.T) {
	const caller, other = "alice_b", "alice.b"
	svc := systemdServiceFor(caller)
	if svc != systemdServiceFor(other) {
		t.Fatalf("fixture is stale: %q and %q no longer collide", caller, other)
	}

	f, sys := newFakeSystem(t)
	sys.lookupUID = fakeLookupUID(map[string]string{strconv.Itoa(testUID): caller})
	path := writeLegacyUnit(t, f, sys, svc, other)

	if resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"}); !resp.OK {
		t.Fatalf("enable failed: %s", resp.Error)
	}
	assertArgv(t, f.ran,
		[]string{"systemctl", "enable", testUnit},
		[]string{"systemctl", "restart", testUnit},
	)
	if _, err := os.Stat(path); err != nil {
		t.Errorf("%s runs as %q, not the caller — it must survive: %v", path, other, err)
	}
}

// disable's own criteria 1-3: unregister has to leave the account with no runner at all,
// so the instance is taken down and the same pre-template units enable migrates are swept
// with it — but only the ones whose User= says they are this caller's. Without the sweep,
// an account that registered the sudo way and never re-registered keeps a legacy unit
// alive against the credential unregister just deleted: a 401 restart loop forever.
func TestHostdDisableAlsoRemovesTheCallersLegacyUnits(t *testing.T) {
	perUser := systemdServiceFor(testUser) // orbit-runner-alice
	disableInstance := []string{"systemctl", "disable", "--now", testUnit}

	cases := []struct {
		name string
		// legacy unit files to plant, as svc name -> the unit's User=.
		legacy      map[string]string
		wantRan     [][]string
		wantRemoved []string
		wantKept    []string
	}{
		{
			name:    "no legacy unit: the instance, and nothing else",
			wantRan: [][]string{disableInstance},
		},
		{
			// The bug this verb was missing: orbit-runner@<uid> was never enabled by this
			// account, so disabling it succeeds and says nothing about the unit that is
			// actually running.
			name:   "the caller's own per-user unit",
			legacy: map[string]string{perUser: testUser},
			wantRan: [][]string{
				disableInstance,
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser},
		},
		{
			name:   "the caller's own bare pre-naming unit",
			legacy: map[string]string{systemdService: testUser},
			wantRan: [][]string{
				disableInstance,
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{systemdService},
		},
		{
			name:   "both generations of the caller's unit",
			legacy: map[string]string{perUser: testUser, systemdService: testUser},
			wantRan: [][]string{
				disableInstance,
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser, systemdService},
		},
		{
			// The name says alice; User= says bob. That is bob's runner, and unregistering
			// alice must not touch it.
			name:     "a per-user unit whose User= is somebody else",
			legacy:   map[string]string{perUser: "bob"},
			wantRan:  [][]string{disableInstance},
			wantKept: []string{perUser},
		},
		{
			name:     "a bare unit belonging to another account's runner",
			legacy:   map[string]string{systemdService: "bob"},
			wantRan:  [][]string{disableInstance},
			wantKept: []string{systemdService},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			for _, svc := range []string{perUser, systemdService} { // deterministic order
				if runAs, ok := c.legacy[svc]; ok {
					writeLegacyUnit(t, f, sys, svc, runAs)
				}
			}

			resp := sys.verbs()["disable"](testPeer, hostdRequest{V: 1, Verb: "disable"})
			if !resp.OK {
				t.Fatalf("disable failed: %s", resp.Error)
			}
			assertArgv(t, f.ran, c.wantRan...)
			if got := resp.Data["unit"]; got != testUnit {
				t.Errorf("response unit = %v, want %v", got, testUnit)
			}

			for _, svc := range c.wantRemoved {
				if _, err := os.Stat(filepath.Join(sys.unitDir, svc+".service")); !os.IsNotExist(err) {
					t.Errorf("%s.service survived the unregister", svc)
				}
			}
			for _, svc := range c.wantKept {
				if _, err := os.Stat(filepath.Join(sys.unitDir, svc+".service")); err != nil {
					t.Errorf("%s.service belongs to another account and must not be touched: %v", svc, err)
				}
			}
		})
	}
}

// Criterion 3: every verb targets the caller's own instance, spelled exactly.
func TestHostdVerbsTargetTheCallersOwnInstance(t *testing.T) {
	cases := []struct {
		verb      string
		wantRan   [][]string
		wantAsked [][]string
	}{
		{verb: "disable", wantRan: [][]string{{"systemctl", "disable", "--now", testUnit}}},
		{verb: "start", wantRan: [][]string{{"systemctl", "start", testUnit}}},
		{verb: "stop", wantRan: [][]string{{"systemctl", "stop", testUnit}}},
		{verb: "restart", wantRan: [][]string{{"systemctl", "restart", testUnit}}},
		{verb: "status", wantAsked: [][]string{{"systemctl", "show", testUnit, "-p", "ActiveState", "-p", "SubState"}}},
	}
	for _, c := range cases {
		t.Run(c.verb, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			resp := sys.verbs()[c.verb](testPeer, hostdRequest{V: 1, Verb: c.verb})
			if !resp.OK {
				t.Fatalf("%s failed: %s", c.verb, resp.Error)
			}
			assertArgv(t, f.ran, c.wantRan...)
			assertArgv(t, f.asked, c.wantAsked...)
			if got := resp.Data["uid"]; got != uint32(testUID) {
				t.Errorf("response uid = %v, want %d", got, testUID)
			}
			if got := resp.Data["unit"]; got != testUnit {
				t.Errorf("response unit = %v, want %v", got, testUnit)
			}
		})
	}

	// The table above is the whole lifecycle surface plus enable; nothing else is served.
	sys := hostdSystemDefaults()
	got := make([]string, 0, len(sys.verbs()))
	for verb := range sys.verbs() {
		got = append(got, verb)
	}
	want := map[string]bool{"enable": true, "disable": true, "start": true, "stop": true, "restart": true, "status": true}
	if len(got) != len(want) {
		t.Fatalf("verbs = %v, want exactly %v", got, want)
	}
	for _, verb := range got {
		if !want[verb] {
			t.Errorf("unexpected verb %q", verb)
		}
	}
}

// Criterion 5: status reports what systemd said about the unit.
func TestHostdStatusReportsActiveState(t *testing.T) {
	f, sys := newFakeSystem(t)
	f.stdout["systemctl show "+testUnit+" -p ActiveState -p SubState"] = "ActiveState=active\nSubState=running\n"

	resp := sys.verbs()["status"](testPeer, hostdRequest{V: 1, Verb: "status"})
	if !resp.OK {
		t.Fatalf("status failed: %s", resp.Error)
	}
	if got := resp.Data["activeState"]; got != "active" {
		t.Errorf("activeState = %v, want active", got)
	}
	if got := resp.Data["subState"]; got != "running" {
		t.Errorf("subState = %v, want running", got)
	}

	// A unit that was never enabled is still a question systemd answers, and status must
	// pass that answer through rather than treat it as a failure.
	f, sys = newFakeSystem(t)
	f.stdout["systemctl show "+testUnit+" -p ActiveState -p SubState"] = "ActiveState=inactive\nSubState=dead\n"
	resp = sys.verbs()["status"](testPeer, hostdRequest{V: 1, Verb: "status"})
	if !resp.OK || resp.Data["activeState"] != "inactive" || resp.Data["subState"] != "dead" {
		t.Errorf("status of a unit that was never started = %+v (error %q)", resp.Data, resp.Error)
	}
}

// Criterion 4a: hostd will not bring a root runner up — and stays able to take one down.
func TestHostdRefusesToBringUpARootRunner(t *testing.T) {
	root := hostdPeer{UID: 0, PID: 7}

	for _, verb := range []string{"enable", "start", "restart"} {
		t.Run("refuses "+verb, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			resp := sys.verbs()[verb](root, hostdRequest{V: 1, Verb: verb})
			if resp.OK {
				t.Fatalf("%s brought up a root runner", verb)
			}
			if !strings.Contains(resp.Error, "must not run as root") {
				t.Errorf("error %q does not say why root is refused", resp.Error)
			}
			assertArgv(t, f.ran)
			assertArgv(t, f.asked)
		})
	}

	// A root runner from before this rule must remain stoppable and observable, or the
	// guard would strand exactly the installs it exists to clean up.
	for _, verb := range []string{"disable", "stop", "status"} {
		t.Run("allows "+verb, func(t *testing.T) {
			_, sys := newFakeSystem(t)
			if resp := sys.verbs()[verb](root, hostdRequest{V: 1, Verb: verb}); !resp.OK {
				t.Fatalf("%s on a root runner was refused: %s", verb, resp.Error)
			}
		})
	}
}

// Criterion 4b: a peer uid with no account is refused, before anything is run.
func TestHostdRefusesAUidWithNoAccount(t *testing.T) {
	stranger := hostdPeer{UID: 65534, PID: 9}
	for _, verb := range []string{"enable", "disable", "start", "stop", "restart", "status"} {
		t.Run(verb, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			resp := sys.verbs()[verb](stranger, hostdRequest{V: 1, Verb: verb})
			if resp.OK {
				t.Fatalf("%s acted for a uid with no account", verb)
			}
			if !strings.Contains(resp.Error, "65534") || !strings.Contains(resp.Error, "no account") {
				t.Errorf("error %q does not name the unresolvable uid", resp.Error)
			}
			assertArgv(t, f.ran)
			assertArgv(t, f.asked)
		})
	}
}

// A failing systemctl is a failed response carrying systemd's own words — and, for
// enable, one that stops before restarting rather than reporting success on half a job.
func TestHostdEnableSurfacesASystemctlFailure(t *testing.T) {
	f, sys := newFakeSystem(t)
	f.fail["systemctl enable "+testUnit] = errors.New("exit status 1")
	f.stdout["systemctl enable "+testUnit] = "Failed to enable unit: Unit orbit-runner@.service does not exist.\n"

	resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
	if resp.OK {
		t.Fatal("a failed systemctl enable was reported as success")
	}
	if !strings.Contains(resp.Error, "does not exist") {
		t.Errorf("error %q drops what systemd actually said", resp.Error)
	}
	assertArgv(t, f.ran, []string{"systemctl", "enable", testUnit})
}

// The migration is best-effort by design: it must not cost the caller the new instance,
// which is the thing that actually supersedes whatever it failed to clean up.
func TestHostdEnableStillProceedsWhenTheMigrationFails(t *testing.T) {
	svc := systemdServiceFor(testUser)
	f, sys := newFakeSystem(t)
	writeLegacyUnit(t, f, sys, svc, testUser)
	f.fail["systemctl disable --now "+svc+".service"] = errors.New("exit status 1")

	if resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"}); !resp.OK {
		t.Fatalf("a failed migration blocked the new instance: %s", resp.Error)
	}
	assertArgv(t, f.ran,
		[]string{"systemctl", "disable", "--now", svc + ".service"},
		[]string{"systemctl", "daemon-reload"},
		[]string{"systemctl", "enable", testUnit},
		[]string{"systemctl", "restart", testUnit},
	)
}

// The instance comes first and its failure is the answer: a systemctl that cannot take
// down the unit the caller asked about is not a tear-down to report success for, and the
// best-effort legacy sweep is not a consolation prize to run in its place.
func TestHostdDisableSurfacesASystemctlFailureBeforeSweepingLegacyUnits(t *testing.T) {
	svc := systemdServiceFor(testUser)
	f, sys := newFakeSystem(t)
	writeLegacyUnit(t, f, sys, svc, testUser)
	f.fail["systemctl disable --now "+testUnit] = errors.New("exit status 1")
	f.stdout["systemctl disable --now "+testUnit] = "Failed to disable unit: Connection timed out.\n"

	resp := sys.verbs()["disable"](testPeer, hostdRequest{V: 1, Verb: "disable"})
	if resp.OK {
		t.Fatal("a failed systemctl disable was reported as success")
	}
	if !strings.Contains(resp.Error, "Connection timed out") {
		t.Errorf("error %q drops what systemd actually said", resp.Error)
	}
	assertArgv(t, f.ran, []string{"systemctl", "disable", "--now", testUnit})
}

func TestHostdShowProperties(t *testing.T) {
	props := hostdShowProperties("ActiveState=active\nSubState=running\nExecStart=/usr/bin/orbit run --flag=1\n\n")
	if props["ActiveState"] != "active" || props["SubState"] != "running" {
		t.Errorf("props = %v", props)
	}
	// A value containing '=' is not a place to split twice.
	if got := props["ExecStart"]; got != "/usr/bin/orbit run --flag=1" {
		t.Errorf("ExecStart = %q", got)
	}
	if len(hostdShowProperties("")) != 0 {
		t.Error("empty output should yield no properties")
	}
}

// unitRunsAsUserIn is shared with service.go's legacy install path, so both decide unit
// ownership the same way. Its rule: the file exists AND its User= names this account.
func TestUnitRunsAsUserIn(t *testing.T) {
	f, sys := newFakeSystem(t)
	writeLegacyUnit(t, f, sys, "orbit-runner-alice", testUser)

	if !unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-alice", testUser) {
		t.Error("a present unit with a matching User= is this account's")
	}
	if unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-alice", "bob") {
		t.Error("User= decides ownership; a different account must not match")
	}
	if unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-ghost", testUser) {
		t.Error("a unit with no file on disk is not anybody's")
	}
	if unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-alice", "") {
		t.Error("an unresolved username must never match")
	}
}
