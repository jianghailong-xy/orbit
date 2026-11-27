package main

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Re-running `orbit host setup` on a host set up before instances were named after accounts:
// setup, with its files under a temporary root, and systemd and the passwd database a fake that
// carries out stop, disable, enable and start on the units it knows, as systemd would.

// moveAccount is one account of the fake host.
type moveAccount struct {
	uid  int
	name string
	home string
	// copy says the account can execute ~/.orbit/bin/orbit.
	copy bool
}

type moveHost struct {
	t     *testing.T
	f     *fakeSystem
	env   hostSetupEnv
	root  string
	users map[string]moveAccount // by uid
	// owner is the account each unit the test planted belongs to, for the invariant below.
	owner map[string]string
	// violations is every moment an account had two live runners, or a name instance was
	// started before its uid instance was confirmed down and disabled.
	violations []string
	// onStop, when set, runs in place of the fake's stop for that unit: what a draining
	// runner does while systemctl stop waits for it.
	onStop map[string]func() error
}

const listUidInstances = "systemctl list-units --all --type=service --no-legend --plain --no-pager orbit-runner@*"

func newMoveHost(t *testing.T, accounts ...moveAccount) *moveHost {
	t.Helper()
	env, _, root := testHostEnv(t, 0)
	placeBinary(t, root, machineBinaryPath)
	h := &moveHost{
		t:     t,
		f:     &fakeSystem{stdout: map[string]string{}, fail: map[string]error{}, units: map[string]*fakeUnit{}},
		root:  root,
		users: map[string]moveAccount{},
		owner: map[string]string{},
	}
	for _, a := range accounts {
		h.users[strconv.Itoa(a.uid)] = a
	}
	// No broker running: setup has none to stop (TestHostSetupStopsARunningBrokerBeforeItMovesAnything).
	setInstance(h.f, hostdServiceUnit, "", "static", "inactive")
	env.sys = hostdSystem{
		run:   h.run,
		query: h.f.query,
		lookupUID: func(uid string) (*user.User, error) {
			a, ok := h.users[uid]
			if !ok {
				return nil, fmt.Errorf("user: unknown userid %s", uid)
			}
			return &user.User{Uid: uid, Gid: uid, Username: a.name, HomeDir: a.home}, nil
		},
		unitDir: filepath.Join(root, systemdUnitDir),
		canExecute: func(u *user.User, path string) (bool, error) {
			h.f.checked = append(h.f.checked, u.Username+" "+path)
			return h.users[u.Uid].copy && path == userBinPath(u.HomeDir), nil
		},
	}
	// (a) The host as it stands before setup is run again: this binary at /usr/local/bin/orbit,
	// put there by hostd's update or by a root runner, and the uid template still on disk.
	if err := os.MkdirAll(env.sys.unitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.sys.unitDir, "orbit-runner@.service"), []byte(uidHostRunnerTemplate(machineBinaryPath)), 0o644); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	env.out = &out
	h.env = env
	return h
}

// instance plants an account's uid instance as systemd reports it, and the name instance it
// would move to, never enabled or started.
func (h *moveHost) instance(uid int, unitFileState, activeState string, listed bool) {
	from := unitForUid(uint32(uid))
	setInstance(h.f, from, strconv.Itoa(uid), unitFileState, activeState)
	who := "uid " + strconv.Itoa(uid)
	if a, ok := h.users[strconv.Itoa(uid)]; ok {
		who = a.name
		to := unitForAccount(a.name)
		setInstance(h.f, to, a.name, "disabled", "inactive")
		h.owner[to] = who
	}
	h.owner[from] = who
	if listed {
		h.f.stdout[listUidInstances] += from + " loaded " + activeState + " running Orbit runner (uid " + strconv.Itoa(uid) + ")\n"
	} else {
		// Enabled and not running: systemd need not have it loaded, but its link is there.
		wants := filepath.Join(h.env.sys.unitDir, "multi-user.target.wants")
		if err := os.MkdirAll(wants, 0o755); err != nil {
			h.t.Fatal(err)
		}
		if err := os.Symlink("../orbit-runner@.service", filepath.Join(wants, from)); err != nil {
			h.t.Fatal(err)
		}
	}
}

// run is the fake's run, plus what systemd does on enable, start and disable --now, and the
// invariant checked after every command.
func (h *moveHost) run(name string, args ...string) (string, error) {
	argv := append([]string{name}, args...)
	unit := argv[len(argv)-1]
	if len(argv) == 3 && argv[1] == "start" {
		if from, ok := strings.CutPrefix(unit, "orbit-runner@"); ok && strings.Trim(strings.TrimSuffix(from, ".service"), "0123456789") != "" {
			// A name instance: its account's uid instance must be confirmed down by now.
			for u, owner := range h.owner {
				if owner == h.owner[unit] && u != unit {
					if st := h.f.units[u]; st.activeState != "inactive" && st.activeState != "failed" || st.unitFileState == "enabled" {
						h.violations = append(h.violations, fmt.Sprintf("started %s while %s was %s/%s", unit, u, st.activeState, st.unitFileState))
					}
				}
			}
		}
	}
	var out string
	var err error
	if stop := h.onStop[unit]; stop != nil && len(argv) == 3 && argv[1] == "stop" {
		h.f.ran = append(h.f.ran, argv)
		err = stop()
	} else {
		out, err = h.f.run(name, args...)
	}
	if u := h.f.units[unit]; u != nil && err == nil && !u.stuck {
		switch {
		case len(argv) == 3 && argv[1] == "start":
			u.activeState = "active"
		case len(argv) == 3 && argv[1] == "enable":
			u.unitFileState = "enabled"
		case len(argv) == 4 && argv[1] == "disable" && argv[2] == "--now":
			u.activeState, u.unitFileState = "inactive", "disabled"
		}
	}
	live := map[string][]string{}
	for u, owner := range h.owner {
		if st := h.f.units[u]; st != nil && (hostdUnitState{"ActiveState": st.activeState}).up() {
			live[owner] = append(live[owner], u)
		}
	}
	for owner, units := range live {
		if len(units) > 1 {
			h.violations = append(h.violations, fmt.Sprintf("after %v, %s had two live runners: %v", argv, owner, units))
		}
	}
	return out, err
}

func (h *moveHost) setup() string {
	h.t.Helper()
	if err := hostSetup(h.env, "https://orbit.example.com"); err != nil {
		h.t.Fatalf("setup: %v", err)
	}
	if len(h.violations) > 0 {
		h.t.Errorf("the one-runner rule broke:\n  %s", strings.Join(h.violations, "\n  "))
	}
	return h.env.out.(*strings.Builder).String()
}

// moved is how one uid instance moves: stopped (drained) and disabled, each confirmed, then the
// name instance enabled and started.
func moved(from, to string) [][]string {
	return [][]string{{"systemctl", "stop", from}, {"systemctl", "disable", from}, {"systemctl", "enable", to}, {"systemctl", "start", to}}
}

func TestHostSetupMovesEachUidInstanceWithACopyToItsNameInstance(t *testing.T) {
	h := newMoveHost(t,
		moveAccount{1000, "alice", "/home/alice", true},
		moveAccount{1001, "bob", "/home/bob", false},
		moveAccount{1002, "carol", "/nonexistent", true},
		moveAccount{1005, "test-user", "/home/test-user", true},
		moveAccount{1006, "frank", "/home/frank", true},
		moveAccount{1007, "erin", "/home/erin", true},
	)
	h.instance(1000, "enabled", "active", true)
	h.instance(1001, "enabled", "active", true)
	h.instance(1002, "enabled", "active", true)
	h.instance(1004, "enabled", "active", true) // a uid with no account
	h.instance(1005, "enabled", "active", true)
	h.instance(1006, "disabled", "inactive", true) // loaded, but no runner: left out
	h.instance(1007, "enabled", "inactive", false) // enabled, not running, not loaded

	out := h.setup()
	t.Logf("setup printed:\n%s", out)

	// One account at a time, in uid order: each uid instance is down and disabled before its name
	// instance is enabled and started, and nothing at all is done to an account that is left.
	var want [][]string
	want = append(want, moved("orbit-runner@1000.service", "orbit-runner@alice.service")...)
	want = append(want, moved("orbit-runner@1005.service", `orbit-runner@test\x2duser.service`)...)
	want = append(want, moved("orbit-runner@1007.service", "orbit-runner@erin.service")...)
	assertArgv(t, h.f.ran, want...)
	// Each step of a move is confirmed by asking systemd, as hostd's enable does.
	shows := 0
	for _, argv := range h.f.asked {
		if strings.Join(argv, " ") == instanceQuery("orbit-runner@1000.service") {
			shows++
		}
	}
	if shows != 3 {
		t.Errorf("asked systemd about orbit-runner@1000.service %d times, want 3: before, after the stop, after the disable", shows)
	}
	for _, unit := range []string{"orbit-runner@alice.service", `orbit-runner@test\x2duser.service`, "orbit-runner@erin.service"} {
		if u := h.f.units[unit]; u.activeState != "active" || u.unitFileState != "enabled" {
			t.Errorf("%s is %s/%s, want active/enabled", unit, u.activeState, u.unitFileState)
		}
	}
	for _, unit := range []string{"orbit-runner@1001.service", "orbit-runner@1002.service", "orbit-runner@1004.service"} {
		if u := h.f.units[unit]; u.activeState != "active" || u.unitFileState != "enabled" {
			t.Errorf("%s, left, is %s/%s, want it as it was: active/enabled", unit, u.activeState, u.unitFileState)
		}
	}

	for _, line := range []string{
		"  Moved to instances named after their accounts:",
		"    orbit-runner@1000.service → orbit-runner@alice.service (alice)",
		`    orbit-runner@1005.service → orbit-runner@test\x2duser.service (test-user)`,
		"    orbit-runner@1007.service → orbit-runner@erin.service (erin)",
		"  Left on their orbit-runner@<uid> instance (3):",
		"    bob (orbit-runner@1001.service): /home/bob/.orbit/bin/orbit is missing or bob cannot execute it.",
		"      bob runs:  /usr/local/bin/orbit register",
		`    carol (orbit-runner@1002.service): carol has no home directory to keep its own copy in (the passwd database gives "/nonexistent"); once it has one.`,
		"      carol runs:  /usr/local/bin/orbit register",
		"    uid 1004 (orbit-runner@1004.service): uid 1004 has no account on this machine: user: unknown userid 1004.",
		"  An instance left keeps its current process. At its next restart it runs its account's own",
		"  ~/.orbit/bin/orbit, so it needs that copy by then: the command above puts it in place and",
		"  moves the runner to orbit-runner@<user name>.",
	} {
		if !strings.Contains(out, line+"\n") {
			t.Errorf("setup output lacks the line %q", line)
		}
	}
	if strings.Contains(out, "1006") || strings.Contains(out, "frank") {
		t.Errorf("setup reported an instance that is no runner:\n%s", out)
	}
}

// A host with no uid instance — set up by this release, or never before — says nothing about moves.
func TestHostSetupWithNoUidInstanceMovesNothing(t *testing.T) {
	h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
	h.f.stdout[listUidInstances] = "orbit-runner@alice.service loaded active running Orbit runner (alice)\n"
	out := h.setup()
	assertArgv(t, h.f.ran)
	if strings.Contains(out, "Moved") || strings.Contains(out, "Left") {
		t.Errorf("setup reported moves on a host with no uid instance:\n%s", out)
	}
}

// A move that fails names the account and leaves it with exactly one runner: the uid instance,
// put back as it was, or never taken down.
func TestHostSetupLeavesAnAccountWhoseMoveFailsWithExactlyOneRunner(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	for _, tc := range []struct {
		name    string
		arrange func(h *moveHost)
		wantRan [][]string
		why     string
	}{{
		name: "the uid instance will not stop",
		arrange: func(h *moveHost) {
			h.f.fail["systemctl stop "+from] = errors.New("exit status 4")
			h.f.stdout["systemctl stop "+from] = "Failed to stop " + from + ": Operation refused\n"
		},
		wantRan: [][]string{{"systemctl", "stop", from}},
		why:     "alice (" + from + "): the move failed: alice's older runner " + from + " could not be stopped: systemctl stop " + from + " failed: exit status 4: Failed to stop " + from + ": Operation refused; it is put back as it was.",
	}, {
		name:    "the uid instance stops, then will not disable",
		arrange: func(h *moveHost) { h.f.fail["systemctl disable "+from] = errors.New("exit status 1") },
		wantRan: [][]string{{"systemctl", "stop", from}, {"systemctl", "disable", from}, {"systemctl", "start", from}},
		why:     "the move failed: alice's older runner " + from + " was stopped but could not be disabled: systemctl disable " + from + " failed: exit status 1; it is put back as it was.",
	}, {
		name:    "the name instance will not start",
		arrange: func(h *moveHost) { h.f.fail["systemctl start "+to] = errors.New("exit status 1") },
		wantRan: append(moved(from, to), []string{"systemctl", "stop", to}, []string{"systemctl", "disable", to}, []string{"systemctl", "enable", from}, []string{"systemctl", "start", from}),
		why:     "the move failed: systemctl start " + to + " failed: exit status 1; it is put back as it was.",
	}, {
		// systemd started the name instance and only its reply was lost: the cleanup takes it
		// down and confirms it down, and only then is the uid instance put back.
		name: "the name instance's start reports an error while systemd started it, and the cleanup confirms it down",
		arrange: func(h *moveHost) {
			h.f.fail["systemctl start "+to] = errors.New("exit status 1")
			h.f.onRun = func(argv []string) {
				if strings.Join(argv, " ") == "systemctl start "+to {
					h.f.units[to].activeState = "active"
				}
			}
		},
		wantRan: append(moved(from, to), []string{"systemctl", "stop", to}, []string{"systemctl", "disable", to}, []string{"systemctl", "enable", from}, []string{"systemctl", "start", from}),
		why:     "the move failed: systemctl start " + to + " failed: exit status 1; it is put back as it was.",
	}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
			h.instance(1000, "enabled", "active", true)
			tc.arrange(h)

			out := h.setup()

			assertArgv(t, h.f.ran, tc.wantRan...)
			if u := h.f.units[from]; u.activeState != "active" || u.unitFileState != "enabled" {
				t.Errorf("%s is %s/%s, want alice's one runner, as it was: active/enabled", from, u.activeState, u.unitFileState)
			}
			if u := h.f.units[to]; u.activeState != "inactive" || u.unitFileState == "enabled" {
				t.Errorf("%s is %s/%s, want down and not enabled", to, u.activeState, u.unitFileState)
			}
			for _, want := range []string{tc.why, "      alice runs:  /usr/local/bin/orbit register\n", "Left on their orbit-runner@<uid> instance (1):"} {
				if !strings.Contains(out, want) {
					t.Errorf("setup output lacks %q:\n%s", want, out)
				}
			}
		})
	}
}

// (c) Setup re-run while an account's uid instance is mid-turn: systemctl stop waits for the
// runner to drain (KillMode=mixed sends it alone SIGTERM, and TimeoutStopSec=180 is its room), and
// the name instance starts only once that stop has returned and systemd reports the unit down. A
// drain that ran out of room ends with systemd killing the runner, the unit failed: down, and
// moved. A stop that gave up while the runner was still deactivating leaves the account on its
// uid instance, with nothing started beside it.
func TestHostSetupWaitsForAMidTurnRunnerToDrainBeforeItMoves(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	for _, tc := range []struct {
		name string
		// end is how the drain ends: the unit's state once systemctl stop returns, and its error.
		end     string
		err     error
		wantRan [][]string
		moved   bool
	}{
		{"the turn finishes", "inactive", nil, moved(from, to), true},
		{"the drain runs out of TimeoutStopSec", "failed", nil, moved(from, to), true},
		{"systemctl stop gives up while it drains", "deactivating", errors.New("exit status 1"), [][]string{{"systemctl", "stop", from}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
			h.instance(1000, "enabled", "active", true)
			draining := false
			h.onStop = map[string]func() error{from: func() error {
				// SIGTERM reached the runner, which is finishing its turn: the unit is
				// deactivating, and still alice's one live runner, until the stop returns.
				h.f.units[from].activeState, draining = "deactivating", true
				if _, err := h.run("systemctl", "is-active", from); err != nil {
					t.Fatal(err)
				}
				draining = false
				h.f.units[from].activeState = tc.end
				return tc.err
			}}
			prevRun := h.env.sys.run
			h.env.sys.run = func(name string, args ...string) (string, error) {
				if draining && !(len(args) == 2 && args[0] == "is-active") {
					t.Errorf("ran %s %v while %s was still draining", name, args, from)
				}
				return prevRun(name, args...)
			}

			out := h.setup()

			var ran [][]string
			for _, argv := range h.f.ran {
				if argv[1] != "is-active" {
					ran = append(ran, argv)
				}
			}
			assertArgv(t, ran, tc.wantRan...)
			if got := h.f.units[to].activeState == "active"; got != tc.moved {
				t.Errorf("%s active = %v, want %v", to, got, tc.moved)
			}
			if !tc.moved && !strings.Contains(out, "alice ("+from+"): the move failed: alice's older runner "+from+" could not be stopped") {
				t.Errorf("setup did not name alice as left:\n%s", out)
			}
		})
	}
}

// V2's case: the name instance's enable or start reports an error while systemd did enable or
// start it, and the cleanup after it fails. The name instance may still be running, so the uid
// instance is not started again: the account has at most one runner, and setup names the unit
// that may still run and what settles it, rather than saying it is put back as it was.
func TestHostSetupKeepsTheUidInstanceDownWhenTheNameInstanceCannotBeConfirmedDown(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	startedAnyway := func(h *moveHost, verb string) {
		h.f.fail["systemctl "+verb+" "+to] = errors.New("exit status 1")
		h.f.onRun = func(argv []string) {
			if strings.Join(argv, " ") == "systemctl "+verb+" "+to {
				if verb == "start" {
					h.f.units[to].activeState = "active"
				} else {
					h.f.units[to].unitFileState = "enabled"
				}
			}
		}
	}
	for _, tc := range []struct {
		name    string
		arrange func(h *moveHost)
		wantRan [][]string
		// toActive and toEnabled are the name instance's state at the end.
		toActive, toEnabled string
		downErr             string
	}{{
		name: "start reports an error while systemd started it, and its stop fails",
		arrange: func(h *moveHost) {
			startedAnyway(h, "start")
			h.f.fail["systemctl stop "+to] = errors.New("exit status 1")
		},
		wantRan:   append(moved(from, to), []string{"systemctl", "stop", to}),
		toActive:  "active",
		toEnabled: "enabled",
		downErr:   to + " could not be stopped: systemctl stop " + to + " failed: exit status 1",
	}, {
		name: "start reports an error while systemd started it, and its stop leaves it up",
		arrange: func(h *moveHost) {
			startedAnyway(h, "start")
			started := h.f.onRun
			h.f.onRun = func(argv []string) {
				started(argv)
				if strings.Join(argv, " ") == "systemctl start "+to {
					h.f.units[to].stuck = true // from here on, systemctl stop leaves it up
				}
			}
		},
		wantRan:   append(moved(from, to), []string{"systemctl", "stop", to}),
		toActive:  "active",
		toEnabled: "enabled",
		downErr:   to + " is still up after systemctl stop: systemd reports ActiveState=active",
	}, {
		name: "enable reports an error while systemd enabled it, and its disable fails",
		arrange: func(h *moveHost) {
			startedAnyway(h, "enable")
			h.f.fail["systemctl disable "+to] = errors.New("exit status 1")
		},
		wantRan:   [][]string{{"systemctl", "stop", from}, {"systemctl", "disable", from}, {"systemctl", "enable", to}, {"systemctl", "stop", to}, {"systemctl", "disable", to}},
		toActive:  "inactive",
		toEnabled: "enabled",
		downErr:   to + " was stopped but could not be disabled: systemctl disable " + to + " failed: exit status 1",
	}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
			h.instance(1000, "enabled", "active", true)
			tc.arrange(h)

			out := h.setup()
			t.Logf("setup printed:\n%s", out)

			assertArgv(t, h.f.ran, tc.wantRan...)
			for _, argv := range h.f.ran {
				if argv[len(argv)-1] == from && (argv[1] == "start" || argv[1] == "enable") {
					t.Errorf("ran %v while %s could not be confirmed down", argv, to)
				}
			}
			if u := h.f.units[from]; u.activeState != "inactive" || u.unitFileState != "disabled" {
				t.Errorf("%s is %s/%s, want it left down: inactive/disabled", from, u.activeState, u.unitFileState)
			}
			if u := h.f.units[to]; u.activeState != tc.toActive || u.unitFileState != tc.toEnabled {
				t.Errorf("%s is %s/%s, want %s/%s", to, u.activeState, u.unitFileState, tc.toActive, tc.toEnabled)
			}
			live := 0
			for _, unit := range []string{from, to} {
				if (hostdUnitState{"ActiveState": h.f.units[unit].activeState}).up() {
					live++
				}
			}
			if live > 1 {
				t.Errorf("alice has %d live runners, want at most one", live)
			}
			fail := "systemctl start " + to + " failed: exit status 1"
			if strings.HasPrefix(tc.name, "enable") {
				fail = "systemctl enable " + to + " failed: exit status 1"
			}
			why := "    alice (" + from + "): the move failed: " + fail + "; and " + tc.downErr + ". " +
				to + " may still be running, so " + from + " is not started again and alice has at most one runner. " +
				"To settle it, root runs `systemctl disable --now " + to + "` and, once `systemctl is-active " + to + "` says inactive, `systemctl enable --now " + from + "`; " +
				"or alice runs the command below, which finishes the move.\n"
			// The output ends with alice's lines: no footer saying her uid instance keeps its
			// process, which it does not.
			tail := "\n  Left on their orbit-runner@<uid> instance (1):\n" + why + "      alice runs:  /usr/local/bin/orbit register\n"
			if !strings.HasSuffix(out, "without root.\n"+tail) {
				t.Errorf("setup output does not end with %q:\n%s", tail, out)
			}
			if strings.Contains(out, "put back as it was") {
				t.Errorf("setup says the uid instance is put back as it was, while it is left down:\n%s", out)
			}
		})
	}
}

// A uid instance that could not be put back after a failed move is not as it was, so setup prints
// no footer saying it keeps its process.
func TestHostSetupPrintsNoKeptProcessFooterForAUidInstanceItCouldNotPutBack(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
	h.instance(1000, "enabled", "active", true)
	h.f.fail["systemctl start "+to] = errors.New("exit status 1")
	h.f.fail["systemctl start "+from] = errors.New("exit status 1")

	out := h.setup()

	tail := "\n  Left on their orbit-runner@<uid> instance (1):\n" +
		"    alice (" + from + "): the move failed: systemctl start " + to + " failed: exit status 1; and it could not be put back: systemctl start " + from + " failed: exit status 1.\n" +
		"      alice runs:  /usr/local/bin/orbit register\n"
	if !strings.HasSuffix(out, "without root.\n"+tail) {
		t.Errorf("setup output does not end with %q:\n%s", tail, out)
	}
}

// The footer under the accounts left covers only the instances left as they were, and says so
// when some were not.
func TestPrintMovesFooterCoversOnlyInstancesLeftAsTheyWere(t *testing.T) {
	kept := hostInstanceMove{from: "orbit-runner@1001.service", uid: 1001, account: "bob", why: "/home/bob/.orbit/bin/orbit is missing or bob cannot execute it", command: hostLeftCommand}
	down := hostInstanceMove{from: "orbit-runner@1000.service", uid: 1000, account: "alice", why: "the move failed: …", command: hostLeftCommand, notAsItWas: true}
	const rest = " keeps its current process. At its next restart it runs its account's own\n" +
		"  ~/.orbit/bin/orbit, so it needs that copy by then: the command above puts it in place and\n" +
		"  moves the runner to orbit-runner@<user name>.\n"
	for _, tc := range []struct {
		name   string
		moves  []hostInstanceMove
		footer string
	}{
		{"every instance left as it was", []hostInstanceMove{kept}, "  An instance left" + rest},
		{"some left as they were, some not", []hostInstanceMove{down, kept}, "  An instance left as it was" + rest},
		{"none left as it was", []hostInstanceMove{down}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var b strings.Builder
			printMoves(&b, tc.moves, nil)
			out := b.String()
			last := tc.moves[len(tc.moves)-1]
			want := "      " + last.account + " runs:  " + hostLeftCommand + "\n" + tc.footer
			if !strings.HasSuffix(out, want) {
				t.Errorf("printMoves output does not end with %q:\n%s", want, out)
			}
			if tc.footer == "" && strings.Contains(out, "keeps its current process") {
				t.Errorf("printMoves says an instance keeps its process while none was left as it was:\n%s", out)
			}
		})
	}
}

// brokerLog records, in one sequence, every command setup runs for itself and every command
// and question it puts to systemd for the moves, so their order can be asserted across both.
func (h *moveHost) brokerLog() *[]string {
	var log []string
	h.env.run = func(name string, args ...string) error {
		log = append(log, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	run, query := h.env.sys.run, h.env.sys.query
	h.env.sys.run = func(name string, args ...string) (string, error) {
		log = append(log, strings.Join(append([]string{name}, args...), " "))
		return run(name, args...)
	}
	h.env.sys.query = func(name string, args ...string) (string, error) {
		log = append(log, "? "+strings.Join(append([]string{name}, args...), " "))
		return query(name, args...)
	}
	return &log
}

// A broker still running when setup is run again may be the earlier release's, which would enable
// an account's uid instance or restart every runner on the layout setup is changing. Setup stops
// it, and confirms it down, after writing the units, reloading systemd and enabling the socket,
// and before it moves anything.
func TestHostSetupStopsARunningBrokerBeforeItMovesAnything(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
	h.instance(1000, "enabled", "active", true)
	setInstance(h.f, hostdServiceUnit, "", "static", "active")
	log := h.brokerLog()

	out := h.setup()

	want := []string{
		"systemd-tmpfiles --create " + filepath.Join(h.root, hostdTmpfilesPath),
		"systemctl daemon-reload",
		"systemctl enable --now orbit-hostd.socket",
		"? " + instanceQuery(hostdServiceUnit),
		"systemctl stop orbit-hostd.service",
		"? " + instanceQuery(hostdServiceUnit),
		"? " + listUidInstances,
		"? " + instanceQuery(from),
		"systemctl stop " + from,
		"? " + instanceQuery(from),
		"systemctl disable " + from,
		"? " + instanceQuery(from),
		"systemctl enable " + to,
		"systemctl start " + to,
	}
	if got := strings.Join(*log, "\n"); got != strings.Join(want, "\n") {
		t.Errorf("setup's commands, in order:\ngot:\n  %s\nwant:\n  %s", strings.ReplaceAll(got, "\n", "\n  "), strings.Join(want, "\n  "))
	}
	if u := h.f.units[hostdServiceUnit]; u.activeState != "inactive" {
		t.Errorf("%s is %s after setup, want inactive", hostdServiceUnit, u.activeState)
	}
	for _, argv := range h.f.ran {
		if strings.Contains(strings.Join(argv, " "), "orbit-hostd.socket") {
			t.Errorf("setup touched the socket through the broker's system: %v", argv)
		}
	}
	if !strings.Contains(out, "    "+from+" → "+to+" (alice)\n") {
		t.Errorf("setup did not report the move:\n%s", out)
	}
}

// A broker that cannot be stopped, or confirmed down, could still be the earlier release's acting
// on the old layout, so setup moves nothing: it says why and what to run, and exits non-zero. The
// units are written already, so running setup again finishes the job.
func TestHostSetupMovesNothingWhenTheBrokerCannotBeConfirmedDown(t *testing.T) {
	const from = "orbit-runner@1000.service"
	const stop = "systemctl stop orbit-hostd.service"
	for _, tc := range []struct {
		name    string
		arrange func(h *moveHost)
		why     string
	}{{
		name:    "the stop fails",
		arrange: func(h *moveHost) { h.f.fail[stop] = errors.New("exit status 1") },
		why:     "systemctl stop orbit-hostd.service failed: exit status 1",
	}, {
		name:    "it stays up after the stop",
		arrange: func(h *moveHost) { h.f.units[hostdServiceUnit].stuck = true },
		why:     "orbit-hostd.service is still up after systemctl stop: systemd reports ActiveState=active",
	}, {
		name: "it is deactivating after the stop",
		arrange: func(h *moveHost) {
			h.f.units[hostdServiceUnit].activeState = "deactivating"
			h.f.units[hostdServiceUnit].stuck = true
		},
		why: "orbit-hostd.service is still up after systemctl stop: systemd reports ActiveState=deactivating",
	}, {
		name:    "systemd cannot be asked",
		arrange: func(h *moveHost) { h.f.fail[instanceQuery(hostdServiceUnit)] = errors.New("exit status 1") },
		why:     "orbit-hostd.service was stopped, but systemd could not be asked whether it is down: systemctl show orbit-hostd.service failed: exit status 1",
	}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
			h.instance(1000, "enabled", "active", true)
			setInstance(h.f, hostdServiceUnit, "", "static", "active")
			tc.arrange(h)
			log := h.brokerLog()

			err := hostSetup(h.env, "https://orbit.example.com")
			if err == nil {
				t.Fatal("setup succeeded with a broker it could not confirm down")
			}
			for _, part := range []string{
				"setup wrote the units but moved no runner: the host broker that was running could not be confirmed down: " + tc.why + ".\n",
				"It may be an earlier release's, which would act on the old layout while setup moves runners.",
				"once `systemctl is-active orbit-hostd.service` says inactive, set the host up again; that run finishes the job:\n" +
					"  sudo systemctl stop orbit-hostd.service\n" +
					"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
			} {
				if !strings.Contains(err.Error(), part) {
					t.Errorf("error lacks %q:\n%v", part, err)
				}
			}
			// The units are written, systemd reloaded and the socket enabled: a second run finishes.
			if _, err := os.Stat(filepath.Join(h.root, hostRunnerTemplatePath)); err != nil {
				t.Errorf("the runner template was not written: %v", err)
			}
			for _, entry := range *log {
				if strings.Contains(entry, "orbit-runner@") {
					t.Errorf("setup reached a runner instance with the broker not confirmed down: %s", entry)
				}
			}
			assertArgv(t, h.f.ran, []string{"systemctl", "stop", hostdServiceUnit})
			if u := h.f.units[from]; u.activeState != "active" || u.unitFileState != "enabled" {
				t.Errorf("%s is %s/%s, want it as it was: active/enabled", from, u.activeState, u.unitFileState)
			}
			if out := h.env.out.(*strings.Builder).String(); strings.Contains(out, "set up for Orbit runners") || strings.Contains(out, "Moved") {
				t.Errorf("setup reported success or a move:\n%s", out)
			}
		})
	}
}

// A host with no broker running — inactive, or failed — has none to stop: setup asks systemd once
// and goes on to the moves exactly as before.
func TestHostSetupWithNoBrokerRunningStopsNothing(t *testing.T) {
	const from, to = "orbit-runner@1000.service", "orbit-runner@alice.service"
	for _, state := range []string{"inactive", "failed"} {
		t.Run(state, func(t *testing.T) {
			h := newMoveHost(t, moveAccount{1000, "alice", "/home/alice", true})
			h.instance(1000, "enabled", "active", true)
			setInstance(h.f, hostdServiceUnit, "", "static", state)
			log := h.brokerLog()

			h.setup()

			assertArgv(t, h.f.ran, moved(from, to)...)
			asked := 0
			for _, entry := range *log {
				if strings.Contains(entry, hostdServiceUnit) {
					asked++
				}
			}
			if asked != 1 {
				t.Errorf("setup reached %s %d times, want once, to ask about it:\n  %s", hostdServiceUnit, asked, strings.Join(*log, "\n  "))
			}
		})
	}
}
