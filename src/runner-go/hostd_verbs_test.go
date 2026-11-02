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

// testUnit is the instance every request from testPeer must land on, and the only one, on
// a host set up by this release: named after the account.
var testUnit = unitForAccount(testUser)

// testUidUnit is that account's instance on a host set up before instances were named
// after accounts — and, on a host set up since, the older unit enable and disable take
// down.
var testUidUnit = unitForUid(testUID)

// testCopy is where testUser's own binary lives, the file a name instance runs.
var testCopy = userBinPath("/home/" + testUser)

// fakeSystem records every command the verbs issue and answers the ones they read from,
// so a test can assert the exact argv systemd would have been handed. Commands run for
// effect and commands run for their output are kept apart: `ran` is what hostd *did* to
// the machine, which is what the argv assertions are about. checked is every account
// copy canExecute was asked about, as "<user> <path>"; executable and checkErr are its
// answer.
type fakeSystem struct {
	ran        [][]string
	asked      [][]string
	stdout     map[string]string
	fail       map[string]error
	checked    []string
	executable bool
	checkErr   error
	exes       map[string]string // /proc/<pid>/exe, by pid
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

func (f *fakeSystem) canExecute(account *user.User, path string) (bool, error) {
	f.checked = append(f.checked, account.Username+" "+path)
	return f.executable, f.checkErr
}

func (f *fakeSystem) readExe(pid string) (string, error) {
	if exe, ok := f.exes[pid]; ok {
		return exe, nil
	}
	return "", os.ErrNotExist
}

// newFakeSystem wires the verbs to the recorder, a temporary unit directory holding the
// runner template this release's `orbit host setup` writes, and a passwd database
// containing root plus testUser — who has an executable copy of their own.
func newFakeSystem(t *testing.T) (*fakeSystem, hostdSystem) {
	t.Helper()
	return newFakeSystemWithTemplate(t, hostRunnerTemplate())
}

// newUidLayoutSystem is newFakeSystem on a host set up before instances were named after
// accounts, its template still the one that setup wrote.
func newUidLayoutSystem(t *testing.T) (*fakeSystem, hostdSystem) {
	t.Helper()
	return newFakeSystemWithTemplate(t, uidHostRunnerTemplate(machineBinaryPath))
}

func newFakeSystemWithTemplate(t *testing.T, template string) (*fakeSystem, hostdSystem) {
	t.Helper()
	f := &fakeSystem{stdout: map[string]string{}, fail: map[string]error{}, executable: true, exes: map[string]string{}}
	sys := hostdSystem{
		run:        f.run,
		query:      f.query,
		lookupUID:  fakeLookupUID(map[string]string{"0": "root", strconv.Itoa(testUID): testUser}),
		unitDir:    t.TempDir(),
		canExecute: f.canExecute,
		readExe:    f.readExe,
	}
	if err := os.WriteFile(filepath.Join(sys.unitDir, "orbit-runner@.service"), []byte(template), 0o644); err != nil {
		t.Fatal(err)
	}
	return f, sys
}

// uidHostRunnerTemplate is the runner template `orbit host setup` wrote before instances
// were named after accounts, byte for byte as it rendered for exe: what a host set up then
// keeps on disk until setup is run again.
func uidHostRunnerTemplate(exe string) string {
	return `[Unit]
Description=Orbit runner (uid %i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
ExecStart=` + exe + ` run
Restart=always
RestartSec=5
# Send SIGTERM to the runner only (not the claude children), so on stop/restart the
# runner can drain — finish in-flight turns and detach — before claude is torn down.
# The runner's complete shutdown envelope stays below this legacy-compatible value:
# provider drain + lease release + event flush + a racing finalization + margin.
KillMode=mixed
TimeoutStopSec=180
# No Environment= lines here, deliberately. One template serves every instance, and the
# home, the runner state dir and the login PATH each belong to the instance's own
# account — while the specifiers that would fill them in (%h, %s) expand in a *system*
# unit against the service manager, root, rather than against User=. Baking them in
# would therefore point every user's runner at /root. The runner works out its own
# environment at startup instead, where it knows which account it is.

[Install]
WantedBy=multi-user.target
`
}

// fakeLookupUID is a passwd database of uid -> user name, each account with the home
// useradd gives it.
func fakeLookupUID(users map[string]string) func(string) (*user.User, error) {
	return func(uid string) (*user.User, error) {
		name, ok := users[uid]
		if !ok {
			return nil, fmt.Errorf("user: unknown userid %s", uid)
		}
		home := "/home/" + name
		if name == "root" {
			home = "/root"
		}
		return &user.User{Uid: uid, Gid: uid, Username: name, HomeDir: home}, nil
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

// instanceQuery is how hostd asks systemd about the caller's orbit-runner@<uid> instance,
// which has no unit file of its own; setInstance teaches the fake systemctl the answer.
func instanceQuery(unit string) string {
	return "systemctl show " + unit + " -p User -p UnitFileState -p ActiveState"
}

func setInstance(f *fakeSystem, unit, runAs, unitFileState, activeState string) {
	f.stdout[instanceQuery(unit)] = "User=" + runAs + "\nUnitFileState=" + unitFileState + "\nActiveState=" + activeState + "\n"
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

// The layout is the template's to say: User=%I names instances after accounts, and
// anything else — the uid template a host set up before keeps, or no template at all — is
// today's uid instances.
func TestHostdLayoutComesFromTheRunnerTemplate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		template string // "" leaves the template out
		byName   bool
	}{
		{"this release's template", hostRunnerTemplate(), true},
		{"the template a host set up before still has", uidHostRunnerTemplate(machineBinaryPath), false},
		{"no template at all", "", false},
		// systemd applies the last assignment, and so does hostd.
		{"a later User= that undoes %I", hostRunnerTemplate() + "[Service]\nUser=%i\n", false},
		{"a later User= that sets %I", uidHostRunnerTemplate(machineBinaryPath) + "[Service]\nUser=%I\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sys := hostdSystem{unitDir: t.TempDir()}
			if tc.template != "" {
				if err := os.WriteFile(filepath.Join(sys.unitDir, "orbit-runner@.service"), []byte(tc.template), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := sys.namesInstances(); got != tc.byName {
				t.Errorf("namesInstances() = %v, want %v", got, tc.byName)
			}
		})
	}
}

// Criterion 1 and 2 together: enable's complete argv sequence is migration (only when
// there is something of this account's to take down), then enable, then restart — every
// older unit stopped before the instance starts. Which units are the account's is decided
// by their User=: its name, or its uid in digits.
func TestHostdEnableMigratesThenEnablesAndRestarts(t *testing.T) {
	perUser := systemdServiceFor(testUser) // orbit-runner-alice

	type instance struct{ runAs, unitFileState, activeState string }
	cases := []struct {
		name string
		// legacy unit files to plant, as svc name -> the unit's User=.
		legacy map[string]string
		// what systemd says about the caller's orbit-runner@<uid> instance, if anything.
		uidInstance *instance
		wantRan     [][]string // before enable and restart
		wantRemoved []string
		wantKept    []string
	}{
		{
			name: "no other unit at all",
		},
		{
			name:   "the caller's own per-user unit",
			legacy: map[string]string{perUser: testUser},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser},
		},
		{
			name:   "the caller's own bare pre-naming unit",
			legacy: map[string]string{systemdService: testUser},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{systemdService},
		},
		{
			// Both generations present: each is disabled and removed, and systemd is
			// asked to re-read the directory once, at the end.
			name:   "both generations of the caller's unit",
			legacy: map[string]string{perUser: testUser, systemdService: testUser},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser, systemdService},
		},
		{
			// systemd reads a numeric User= as that uid: the caller's own unit.
			name:   "a per-user unit whose User= is the caller's uid",
			legacy: map[string]string{perUser: strconv.Itoa(testUID)},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser},
		},
		{
			name:   "a bare unit whose User= is the caller's uid",
			legacy: map[string]string{systemdService: strconv.Itoa(testUID)},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{systemdService},
		},
		{
			// The name says alice; User= says bob. Zero migration calls, file untouched.
			name:     "a per-user unit whose User= is somebody else",
			legacy:   map[string]string{perUser: "bob"},
			wantKept: []string{perUser},
		},
		{
			name:     "a per-user unit whose User= is another uid",
			legacy:   map[string]string{perUser: strconv.Itoa(testUID + 1)},
			wantKept: []string{perUser},
		},
		{
			name:     "a bare unit belonging to another account's runner",
			legacy:   map[string]string{systemdService: "bob"},
			wantKept: []string{systemdService},
		},
		{
			// The account's runner from a host set up before instances were named after
			// accounts: stopped first, and nothing to remove, since an instance has no file.
			name:        "the caller's orbit-runner@<uid>, running",
			uidInstance: &instance{strconv.Itoa(testUID), "enabled", "active"},
			wantRan:     [][]string{{"systemctl", "disable", "--now", testUidUnit}},
		},
		{
			name:        "the caller's orbit-runner@<uid>, enabled but stopped",
			uidInstance: &instance{strconv.Itoa(testUID), "enabled", "inactive"},
			wantRan:     [][]string{{"systemctl", "disable", "--now", testUidUnit}},
		},
		{
			// Waiting out RestartSec= is not stopped: it comes back on its own.
			name:        "the caller's orbit-runner@<uid>, disabled but restarting",
			uidInstance: &instance{strconv.Itoa(testUID), "disabled", "activating"},
			wantRan:     [][]string{{"systemctl", "disable", "--now", testUidUnit}},
		},
		{
			name:        "the caller's orbit-runner@<uid>, neither enabled nor running",
			uidInstance: &instance{strconv.Itoa(testUID), "disabled", "inactive"},
		},
		{
			name:        "the caller's orbit-runner@<uid>, failed and disabled",
			uidInstance: &instance{strconv.Itoa(testUID), "disabled", "failed"},
		},
		{
			// By User=, never by name: an @<uid> that does not run as the caller is not theirs.
			name:        "an orbit-runner@<uid> whose User= is another account",
			uidInstance: &instance{"bob", "enabled", "active"},
		},
		{
			name:        "every older unit at once",
			legacy:      map[string]string{perUser: testUser, systemdService: strconv.Itoa(testUID)},
			uidInstance: &instance{strconv.Itoa(testUID), "enabled", "active"},
			wantRan: [][]string{
				{"systemctl", "disable", "--now", testUidUnit},
				{"systemctl", "disable", "--now", perUser + ".service"},
				{"systemctl", "disable", "--now", systemdService + ".service"},
				{"systemctl", "daemon-reload"},
			},
			wantRemoved: []string{perUser, systemdService},
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
			if i := c.uidInstance; i != nil {
				setInstance(f, testUidUnit, i.runAs, i.unitFileState, i.activeState)
			}

			resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
			if !resp.OK {
				t.Fatalf("enable failed: %s", resp.Error)
			}
			// The older units go first: no account has two live runners at any moment.
			assertArgv(t, f.ran, append(c.wantRan,
				[]string{"systemctl", "enable", testUnit},
				[]string{"systemctl", "restart", testUnit})...)
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

// A host set up before instances were named after accounts keeps today's enable: the uid
// instance is the caller's instance, nothing is asked about a copy of the account's own,
// and the sudo-era units are migrated as before — by the name in their User= alone.
func TestHostdEnableOnTheUidTemplateIsTodaysEnable(t *testing.T) {
	perUser := systemdServiceFor(testUser)
	f, sys := newUidLayoutSystem(t)
	writeLegacyUnit(t, f, sys, perUser, testUser)
	bare := writeLegacyUnit(t, f, sys, systemdService, strconv.Itoa(testUID))
	f.executable = false // no copy of alice's own, which this layout never needs

	resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
	if !resp.OK {
		t.Fatalf("enable failed: %s", resp.Error)
	}
	assertArgv(t, f.ran,
		[]string{"systemctl", "disable", "--now", perUser + ".service"},
		[]string{"systemctl", "daemon-reload"},
		[]string{"systemctl", "enable", testUidUnit},
		[]string{"systemctl", "restart", testUidUnit},
	)
	assertArgv(t, f.asked,
		[]string{"systemctl", "show", perUser + ".service", "-p", "User", "--value"},
		[]string{"systemctl", "show", systemdService + ".service", "-p", "User", "--value"},
	)
	if got := resp.Data["unit"]; got != testUidUnit {
		t.Errorf("response unit = %v, want %v", got, testUidUnit)
	}
	if len(f.checked) != 0 {
		t.Errorf("asked about a copy of the account's own on the uid template: %v", f.checked)
	}
	if _, err := os.Stat(bare); err != nil {
		t.Errorf("a unit with a numeric User= was taken down on the uid template, which never did: %v", err)
	}
}

// The collision unit-name escaping cannot resolve, and the reason ownership is decided
// by User= rather than by the file's name: "alice.b" and "alice_b" are two real accounts
// that systemdServiceFor maps onto one unit name — and two instances systemd's own
// escaping keeps apart.
func TestHostdEnableLeavesACollidingUnitOfAnotherAccountAlone(t *testing.T) {
	const caller, other = "alice_b", "alice.b"
	svc := systemdServiceFor(caller)
	if svc != systemdServiceFor(other) {
		t.Fatalf("fixture is stale: %q and %q no longer collide", caller, other)
	}
	if unitForAccount(caller) == unitForAccount(other) {
		t.Fatalf("%q and %q share the instance %s", caller, other, unitForAccount(caller))
	}

	f, sys := newFakeSystem(t)
	sys.lookupUID = fakeLookupUID(map[string]string{strconv.Itoa(testUID): caller})
	path := writeLegacyUnit(t, f, sys, svc, other)

	if resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"}); !resp.OK {
		t.Fatalf("enable failed: %s", resp.Error)
	}
	assertArgv(t, f.ran,
		[]string{"systemctl", "enable", "orbit-runner@alice_b.service"},
		[]string{"systemctl", "restart", "orbit-runner@alice_b.service"},
	)
	if _, err := os.Stat(path); err != nil {
		t.Errorf("%s runs as %q, not the caller — it must survive: %v", path, other, err)
	}
}

// disable's own criteria 1-3: unregister has to leave the account with no runner at all,
// so the instance is taken down and the same older units enable migrates are swept with
// it — but only the ones whose User= says they are this caller's. Without the sweep, an
// account that registered the sudo way and never re-registered keeps a legacy unit alive
// against the credential unregister just deleted: a 401 restart loop forever.
func TestHostdDisableAlsoRemovesTheCallersLegacyUnits(t *testing.T) {
	perUser := systemdServiceFor(testUser) // orbit-runner-alice

	for _, layout := range []struct {
		name   string
		system func(*testing.T) (*fakeSystem, hostdSystem)
		unit   string
	}{
		{"name template", newFakeSystem, testUnit},
		{"uid template", newUidLayoutSystem, testUidUnit},
	} {
		disableInstance := []string{"systemctl", "disable", "--now", layout.unit}
		cases := []struct {
			name string
			// legacy unit files to plant, as svc name -> the unit's User=.
			legacy      map[string]string
			wantRan     [][]string
			wantRemoved []string
			wantKept    []string
			// A numeric User= is the caller's on the name template only: the uid template
			// keeps today's rule, which this case does not apply to.
			nameTemplateOnly bool
		}{
			{
				name:    "no legacy unit: the instance, and nothing else",
				wantRan: [][]string{disableInstance},
			},
			{
				// The bug this verb was missing: the instance was never enabled by this
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
				name:   "a per-user unit whose User= is the caller's uid",
				legacy: map[string]string{perUser: strconv.Itoa(testUID)},
				wantRan: [][]string{
					disableInstance,
					{"systemctl", "disable", "--now", perUser + ".service"},
					{"systemctl", "daemon-reload"},
				},
				wantRemoved:      []string{perUser},
				nameTemplateOnly: true,
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
			if c.nameTemplateOnly && layout.unit != testUnit {
				continue
			}
			t.Run(layout.name+"/"+c.name, func(t *testing.T) {
				f, sys := layout.system(t)
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
				if got := resp.Data["unit"]; got != layout.unit {
					t.Errorf("response unit = %v, want %v", got, layout.unit)
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
}

// On a host whose instances are named after accounts, unregister also takes down the
// account's orbit-runner@<uid> from before, after its own instance.
func TestHostdDisableAlsoTakesDownTheCallersUidInstance(t *testing.T) {
	f, sys := newFakeSystem(t)
	setInstance(f, testUidUnit, strconv.Itoa(testUID), "enabled", "active")

	if resp := sys.verbs()["disable"](testPeer, hostdRequest{V: 1, Verb: "disable"}); !resp.OK {
		t.Fatalf("disable failed: %s", resp.Error)
	}
	assertArgv(t, f.ran,
		[]string{"systemctl", "disable", "--now", testUnit},
		[]string{"systemctl", "disable", "--now", testUidUnit},
	)

	// On the uid template that instance *is* the caller's, and it is disabled once.
	f, sys = newUidLayoutSystem(t)
	setInstance(f, testUidUnit, strconv.Itoa(testUID), "enabled", "active")
	if resp := sys.verbs()["disable"](testPeer, hostdRequest{V: 1, Verb: "disable"}); !resp.OK {
		t.Fatalf("disable failed: %s", resp.Error)
	}
	assertArgv(t, f.ran, []string{"systemctl", "disable", "--now", testUidUnit})
}

// Criterion 3: every verb targets the caller's own instance, spelled exactly — the name
// instance, or the uid instance on a host still on the uid template.
func TestHostdVerbsTargetTheCallersOwnInstance(t *testing.T) {
	for _, layout := range []struct {
		name   string
		system func(*testing.T) (*fakeSystem, hostdSystem)
		unit   string
		// instanceAsked is what the name layout's enable and disable ask about the
		// caller's older uid instance; the uid layout asks nothing.
		instanceAsked [][]string
		// checked is the copy of the account's own enable looks for first.
		checked []string
	}{
		{
			name: "name template", system: newFakeSystem, unit: testUnit,
			instanceAsked: [][]string{{"systemctl", "show", testUidUnit, "-p", "User", "-p", "UnitFileState", "-p", "ActiveState"}},
			checked:       []string{testUser + " " + testCopy},
		},
		{name: "uid template", system: newUidLayoutSystem, unit: testUidUnit},
	} {
		unit := layout.unit
		cases := []struct {
			verb        string
			wantRan     [][]string
			wantAsked   [][]string
			wantChecked []string
		}{
			{
				verb:        "enable",
				wantRan:     [][]string{{"systemctl", "enable", unit}, {"systemctl", "restart", unit}},
				wantAsked:   layout.instanceAsked,
				wantChecked: layout.checked,
			},
			{verb: "disable", wantRan: [][]string{{"systemctl", "disable", "--now", unit}}, wantAsked: layout.instanceAsked},
			{verb: "start", wantRan: [][]string{{"systemctl", "start", unit}}},
			{verb: "stop", wantRan: [][]string{{"systemctl", "stop", unit}}},
			{verb: "restart", wantRan: [][]string{{"systemctl", "restart", unit}}},
			{verb: "status", wantAsked: [][]string{{"systemctl", "show", unit, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID"}}},
		}
		for _, c := range cases {
			t.Run(layout.name+"/"+c.verb, func(t *testing.T) {
				f, sys := layout.system(t)
				resp := sys.verbs()[c.verb](testPeer, hostdRequest{V: 1, Verb: c.verb})
				if !resp.OK {
					t.Fatalf("%s failed: %s", c.verb, resp.Error)
				}
				assertArgv(t, f.ran, c.wantRan...)
				assertArgv(t, f.asked, c.wantAsked...)
				if strings.Join(f.checked, "\n") != strings.Join(c.wantChecked, "\n") {
					t.Errorf("copies checked = %q, want %q", f.checked, c.wantChecked)
				}
				if got := resp.Data["uid"]; got != uint32(testUID) {
					t.Errorf("response uid = %v, want %d", got, testUID)
				}
				if got := resp.Data["unit"]; got != unit {
					t.Errorf("response unit = %v, want %v", got, unit)
				}
			})
		}
	}

	// The table above is the whole lifecycle surface plus enable, and update is the one
	// verb that is not about a single instance (hostd_update.go); nothing else is served.
	sys := hostdSystemDefaults()
	got := make([]string, 0, len(sys.verbs()))
	for verb := range sys.verbs() {
		got = append(got, verb)
	}
	want := map[string]bool{"enable": true, "disable": true, "start": true, "stop": true, "restart": true, "status": true, "update": true}
	if len(got) != len(want) {
		t.Fatalf("verbs = %v, want exactly %v", got, want)
	}
	for _, verb := range got {
		if !want[verb] {
			t.Errorf("unexpected verb %q", verb)
		}
	}
}

// The instance a verb lands on is the caller's user name as systemd escapes it, so a name
// with a '-' or a leading '.' lands on the instance whose %I is that very name.
func TestHostdVerbsEscapeTheCallersName(t *testing.T) {
	for name, unit := range map[string]string{
		"test-user": `orbit-runner@test\x2duser.service`,
		".hidden":   `orbit-runner@\x2ehidden.service`,
		"test.user": "orbit-runner@test.user.service",
	} {
		t.Run(name, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			sys.lookupUID = fakeLookupUID(map[string]string{strconv.Itoa(testUID): name})
			if resp := sys.verbs()["start"](testPeer, hostdRequest{V: 1, Verb: "start"}); !resp.OK || resp.Data["unit"] != unit {
				t.Fatalf("start = %+v, want it on %s", resp, unit)
			}
			assertArgv(t, f.ran, []string{"systemctl", "start", unit})
		})
	}
}

// systemd reads a numeric User= as a uid, so an instance named after a user whose name is
// all digits would run as whoever has that uid — root, for a user called "0". hostd names
// no such instance; on the uid template the instance key is the uid and there is nothing
// to refuse.
func TestHostdRefusesToNameAnInstanceAfterAnAllDigitUserName(t *testing.T) {
	const uid = 1005
	peer := hostdPeer{UID: uid, PID: 7}
	for _, name := range []string{"0", "1000"} {
		for _, verb := range []string{"enable", "disable", "start", "stop", "restart", "status"} {
			t.Run(name+"/"+verb, func(t *testing.T) {
				f, sys := newFakeSystem(t)
				sys.lookupUID = fakeLookupUID(map[string]string{strconv.Itoa(uid): name})
				resp := sys.verbs()[verb](peer, hostdRequest{V: 1, Verb: verb})
				if resp.OK {
					t.Fatalf("%s acted on orbit-runner@%s.service for uid %d", verb, name, uid)
				}
				if !strings.Contains(resp.Error, "all digits") || !strings.Contains(resp.Error, "uid "+name) {
					t.Errorf("error %q does not say why", resp.Error)
				}
				assertArgv(t, f.ran)
				assertArgv(t, f.asked)
			})
		}
	}

	_, sys := newUidLayoutSystem(t)
	sys.lookupUID = fakeLookupUID(map[string]string{strconv.Itoa(uid): "1000"})
	if resp := sys.verbs()["start"](peer, hostdRequest{V: 1, Verb: "start"}); !resp.OK || resp.Data["unit"] != unitForUid(uid) {
		t.Errorf("start on the uid template = %+v, want it on %s", resp, unitForUid(uid))
	}
}

// Criterion 5: status reports what systemd said about the unit, and the binary its main
// process runs — on a name instance the account's own copy, which ExecStart's /bin/sh
// hides from systemctl.
func TestHostdStatusReportsActiveStateAndTheBinary(t *testing.T) {
	show := "systemctl show " + testUnit + " -p ActiveState -p SubState -p MainPID"
	f, sys := newFakeSystem(t)
	f.stdout[show] = "ActiveState=active\nSubState=running\nMainPID=4321\n"
	f.exes["4321"] = testCopy

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
	if got := resp.Data["binary"]; got != testCopy {
		t.Errorf("binary = %v, want %s, what /proc/4321/exe names", got, testCopy)
	}

	// A unit that was never enabled is still a question systemd answers, and status must
	// pass that answer through rather than treat it as a failure. No process, no binary.
	f, sys = newFakeSystem(t)
	f.stdout[show] = "ActiveState=inactive\nSubState=dead\nMainPID=0\n"
	resp = sys.verbs()["status"](testPeer, hostdRequest{V: 1, Verb: "status"})
	if !resp.OK || resp.Data["activeState"] != "inactive" || resp.Data["subState"] != "dead" {
		t.Errorf("status of a unit that was never started = %+v (error %q)", resp.Data, resp.Error)
	}
	if _, ok := resp.Data["binary"]; ok {
		t.Errorf("status of a unit with no process reports a binary: %+v", resp.Data)
	}

	// The uid template's instances report theirs the same way: the machine's binary.
	f, sys = newUidLayoutSystem(t)
	f.stdout["systemctl show "+testUidUnit+" -p ActiveState -p SubState -p MainPID"] = "ActiveState=active\nSubState=running\nMainPID=99\n"
	f.exes["99"] = machineBinaryPath
	resp = sys.verbs()["status"](testPeer, hostdRequest{V: 1, Verb: "status"})
	if !resp.OK || resp.Data["unit"] != testUidUnit || resp.Data["binary"] != machineBinaryPath {
		t.Errorf("status on the uid template = %+v (error %q)", resp.Data, resp.Error)
	}
}

// Criterion 4a: hostd will not bring a root runner up — and stays able to take one down.
func TestHostdRefusesToBringUpARootRunner(t *testing.T) {
	root := hostdPeer{UID: 0, PID: 7}

	for _, layout := range []struct {
		name   string
		system func(*testing.T) (*fakeSystem, hostdSystem)
		unit   string
	}{
		{"name template", newFakeSystem, "orbit-runner@root.service"},
		{"uid template", newUidLayoutSystem, "orbit-runner@0.service"},
	} {
		for _, verb := range []string{"enable", "start", "restart"} {
			t.Run(layout.name+"/refuses "+verb, func(t *testing.T) {
				f, sys := layout.system(t)
				resp := sys.verbs()[verb](root, hostdRequest{V: 1, Verb: verb})
				if resp.OK {
					t.Fatalf("%s brought up a root runner", verb)
				}
				if want := "refusing to " + verb + " " + layout.unit + ": the runner must not run as root"; !strings.Contains(resp.Error, want) {
					t.Errorf("error %q does not say %q", resp.Error, want)
				}
				// Before the copy check, too: root's refusal is the one the sudo path takes.
				if resp.Code != "" {
					t.Errorf("root's refusal carries code %q; the client must fall back as it always has", resp.Code)
				}
				assertArgv(t, f.ran)
				assertArgv(t, f.asked)
				if len(f.checked) != 0 {
					t.Errorf("checked %v for root", f.checked)
				}
			})
		}

		// A root runner from before this rule must remain stoppable and observable, or the
		// guard would strand exactly the installs it exists to clean up.
		for _, verb := range []string{"disable", "stop", "status"} {
			t.Run(layout.name+"/allows "+verb, func(t *testing.T) {
				_, sys := layout.system(t)
				if resp := sys.verbs()[verb](root, hostdRequest{V: 1, Verb: verb}); !resp.OK {
					t.Fatalf("%s on a root runner was refused: %s", verb, resp.Error)
				}
			})
		}
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

// A name instance runs "$HOME/.orbit/bin/orbit", so enable refuses — before it touches a
// single unit, the account's older runner included — an account with no home to keep
// that file in, or none it can execute there, saying what is missing and the one command
// that puts it right. Every such refusal carries the code that stops `orbit register`
// short of the sudo path.
func TestHostdEnableRefusesAnAccountWithoutItsOwnCopy(t *testing.T) {
	for _, tc := range []struct {
		name     string
		home     string
		arrange  func(f *fakeSystem)
		want     []string
		checks   bool // whether the account is asked about its copy at all
		noFixFor bool // the refusal names no command, only what to do
	}{{
		name: "a home of /nonexistent",
		home: "/nonexistent",
		want: []string{
			`refusing to enable orbit-runner@alice.service: it runs alice's own ~/.orbit/bin/orbit, and alice has no home directory to keep it in (the passwd database gives "/nonexistent").`,
			"Register from an account that has a home directory.",
		},
		noFixFor: true,
	}, {
		name:     "no home at all",
		home:     "",
		want:     []string{`alice has no home directory to keep it in (the passwd database gives "").`, "Register from an account that has a home directory."},
		noFixFor: true,
	}, {
		// systemd sets no $HOME from one, and hostd will not resolve it against its own
		// working directory.
		name:     "a relative home",
		home:     "home/alice",
		want:     []string{`alice has no home directory to keep it in (the passwd database gives "home/alice").`},
		noFixFor: true,
	}, {
		name:    "a copy that is missing or not executable",
		home:    "/home/alice",
		arrange: func(f *fakeSystem) { f.executable = false },
		want: []string{
			"refusing to enable orbit-runner@alice.service: it runs alice's own ~/.orbit/bin/orbit, and /home/alice/.orbit/bin/orbit is missing or alice cannot execute it. Put a copy there, then run `orbit register` again:\n" +
				"  mkdir -p -m 0700 ~/.orbit && install -D -m 0755 /usr/local/bin/orbit ~/.orbit/bin/orbit",
		},
		checks: true,
	}, {
		// A check that cannot answer — a home on a mount that hangs — is never a yes.
		name:    "a copy that could not be checked",
		home:    "/home/alice",
		arrange: func(f *fakeSystem) { f.executable, f.checkErr = true, errors.New("no answer within 3s") },
		want: []string{
			"it runs alice's own ~/.orbit/bin/orbit, and hostd could not check /home/alice/.orbit/bin/orbit as alice: no answer within 3s. Run `orbit register` again once it can be reached.",
		},
		checks:   true,
		noFixFor: true,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			lookup := sys.lookupUID
			sys.lookupUID = func(uid string) (*user.User, error) {
				u, err := lookup(uid)
				if err == nil {
					u.HomeDir = tc.home
				}
				return u, err
			}
			// An older runner the refusal must leave running: nothing is migrated for an
			// instance that cannot start.
			legacy := writeLegacyUnit(t, f, sys, systemdServiceFor(testUser), testUser)
			setInstance(f, testUidUnit, strconv.Itoa(testUID), "enabled", "active")
			if tc.arrange != nil {
				tc.arrange(f)
			}

			resp := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
			if resp.OK {
				t.Fatalf("enable started %s with no copy of the account's own to run", testUnit)
			}
			if resp.Code != hostdRefusedOwnCopy {
				t.Errorf("code = %q, want %q", resp.Code, hostdRefusedOwnCopy)
			}
			for _, want := range tc.want {
				if !strings.Contains(resp.Error, want) {
					t.Errorf("error must say %q, got:\n%s", want, resp.Error)
				}
			}
			if hasFix := strings.Contains(resp.Error, hostdOwnCopyCommand); hasFix == tc.noFixFor {
				t.Errorf("error names %s: %v, want %v:\n%s", hostdOwnCopyCommand, hasFix, !tc.noFixFor, resp.Error)
			}
			// Not one unit touched or asked about.
			assertArgv(t, f.ran)
			assertArgv(t, f.asked)
			if _, err := os.Stat(legacy); err != nil {
				t.Errorf("the account's older unit went for an instance that cannot start: %v", err)
			}
			wantChecked := []string{}
			if tc.checks {
				wantChecked = []string{testUser + " " + testCopy}
			}
			if strings.Join(f.checked, "\n") != strings.Join(wantChecked, "\n") {
				t.Errorf("copies checked = %q, want %q", f.checked, wantChecked)
			}
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
// ownership the same way. Its rule: the file exists AND its User= is one of the names
// given — the account's, and from hostd also its uid.
func TestUnitRunsAsUserIn(t *testing.T) {
	f, sys := newFakeSystem(t)
	writeLegacyUnit(t, f, sys, "orbit-runner-alice", testUser)
	writeLegacyUnit(t, f, sys, "orbit-runner-byuid", "1000")

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
	if !unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-byuid", testUser, "1000") {
		t.Error("a numeric User= is that uid: the account whose uid it is owns the unit")
	}
	if unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-byuid", testUser) {
		t.Error("the legacy path names the account alone, and a numeric User= is not its name")
	}
	if unitRunsAsUserIn(sys.unitDir, sys.query, "orbit-runner-byuid", testUser, "1001") {
		t.Error("another uid must not match")
	}
}
