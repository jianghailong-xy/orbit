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
		wantRan: append(moved(from, to), []string{"systemctl", "disable", "--now", to}, []string{"systemctl", "enable", from}, []string{"systemctl", "start", from}),
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
