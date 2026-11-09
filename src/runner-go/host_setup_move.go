package main

import (
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Running `orbit host setup` again on a host set up before instances were named after accounts
// moves the runners it finds there: each orbit-runner@<uid> whose account has its own
// ~/.orbit/bin/orbit becomes orbit-runner@<escaped user name>, one account at a time. The uid
// instance is stopped — drained, since the template's KillMode=mixed and TimeoutStopSec=180 give
// the runner room to finish its turns — and disabled, each confirmed by systemd as hostd's enable
// confirms an older runner down (takeDown), and only then is the name instance enabled and
// started. No account has two live runners at any moment. Every account left behind is listed,
// with the one command that account runs.

// hostInstanceMove is one orbit-runner@<uid> setup found, and what became of it.
type hostInstanceMove struct {
	from    string // orbit-runner@<uid>.service
	uid     uint32
	account string // the user name, "" when the uid has none
	to      string // orbit-runner@<escaped user name>.service, once moved
	// why says why it was left; "" for a move.
	why string
	// command is the one command its account runs; "" when there is no account to run it.
	command string
}

// hostLeftCommand is what an account left on its uid instance runs: register, as the account,
// puts its own copy in place, and the broker's enable then moves its runner the same way.
const hostLeftCommand = machineBinaryPath + " register"

// moveUidInstances moves every live or enabled orbit-runner@<uid> this host has, one at a time,
// in uid order, and returns what became of each. An instance systemd reports neither up nor
// enabled is no runner and is left out. A host whose instances cannot be listed moves none.
func (env hostSetupEnv) moveUidInstances() ([]hostInstanceMove, error) {
	units, err := env.uidInstances()
	if err != nil {
		return nil, err
	}
	var moves []hostInstanceMove
	for _, unit := range units {
		if m, ok := env.moveUidInstance(unit); ok {
			moves = append(moves, m)
		}
	}
	return moves, nil
}

// uidInstances is every orbit-runner@<uid> systemd has loaded, plus every one enabled in the
// unit directory (an enabled instance that is not running may not be loaded), in uid order.
func (env hostSetupEnv) uidInstances() ([]string, error) {
	out, err := env.sys.query("systemctl", "list-units", "--all", "--type=service", "--no-legend", "--plain", "--no-pager", hostdRunnerUnitPattern)
	if err != nil {
		return nil, fmt.Errorf("systemctl list-units %s failed: %v", hostdRunnerUnitPattern, err)
	}
	names := strings.Fields(out)
	links, _ := filepath.Glob(filepath.Join(env.sys.unitDir, "*.wants", "orbit-runner@*.service"))
	for _, link := range links {
		names = append(names, filepath.Base(link))
	}
	seen := map[uint32]bool{}
	var uids []uint32
	for _, name := range names {
		inst, ok := strings.CutPrefix(name, "orbit-runner@")
		if !ok {
			continue
		}
		inst, ok = strings.CutSuffix(inst, ".service")
		if !ok || inst == "" || strings.Trim(inst, "0123456789") != "" {
			continue
		}
		uid, err := strconv.ParseUint(inst, 10, 32)
		if err != nil || seen[uint32(uid)] {
			continue
		}
		seen[uint32(uid)] = true
		uids = append(uids, uint32(uid))
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	units := make([]string, len(uids))
	for i, uid := range uids {
		units[i] = unitForUid(uid)
	}
	return units, nil
}

// moveUidInstance moves one uid instance, or says why it is left; false when it is no runner at
// all. A move that fails part way leaves the account with exactly one runner: the uid instance,
// put back as it was, and the name instance down and disabled.
func (env hostSetupEnv) moveUidInstance(from string) (hostInstanceMove, bool) {
	sys := env.sys
	uid64, _ := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(from, "orbit-runner@"), ".service"), 10, 32)
	m := hostInstanceMove{from: from, uid: uint32(uid64)}

	st, err := sys.unitState(from)
	if err != nil {
		m.why = fmt.Sprintf("setup could not ask systemd about it: %v", err)
		return m, true
	}
	if !st.up() && !st.enabled() {
		return m, false
	}
	t, refusal, ok := sys.target(hostdPeer{UID: m.uid}, "enable")
	if !ok {
		m.why = refusal.Error
		return m, true
	}
	m.account = t.username
	if !t.byName {
		m.why = "the runner template does not name instances after accounts"
		return m, true
	}
	m.command = hostLeftCommand
	home := t.account.HomeDir
	if home == "" || home == "/nonexistent" || !filepath.IsAbs(home) {
		m.why = fmt.Sprintf("%s has no home directory to keep its own copy in (the passwd database gives %q); once it has one", t.username, home)
		return m, true
	}
	bin := userBinPath(home)
	switch ok, err := sys.canExecute(t.account, bin); {
	case err != nil:
		m.why = fmt.Sprintf("setup could not check %s as %s: %v", bin, t.username, err)
		return m, true
	case !ok:
		m.why = fmt.Sprintf("%s is missing or %s cannot execute it", bin, t.username)
		return m, true
	}

	// The uid instance down first, confirmed down and disabled. One that will not go down keeps
	// running as it was; one that went down and then failed a later step is put back.
	if err := sys.takeDown(from, t); err != nil {
		m.why = "the move failed: " + err.Error() + env.restore(from, st)
		return m, true
	}
	to := t.unit
	err = sys.systemctl("enable", to)
	if err == nil {
		err = sys.systemctl("start", to)
	}
	if err != nil {
		_ = sys.systemctl("disable", "--now", to)
		m.why = "the move failed: " + err.Error() + env.restore(from, st)
		return m, true
	}
	m.to = to
	return m, true
}

// restore puts a uid instance whose move failed back as it was before — enabled if it was, and
// started if it was up — and says what could not be. Only what the move changed is put back: a
// uid instance that would not stop is still running, enabled, as it was.
func (env hostSetupEnv) restore(from string, was hostdUnitState) string {
	now, err := env.sys.unitState(from)
	if err != nil {
		now = hostdUnitState{}
	}
	var failed []string
	if was.enabled() && !now.enabled() {
		if err := env.sys.systemctl("enable", from); err != nil {
			failed = append(failed, err.Error())
		}
	}
	if was.up() && !now.up() {
		if err := env.sys.systemctl("start", from); err != nil {
			failed = append(failed, err.Error())
		}
	}
	if len(failed) > 0 {
		return "; and it could not be put back: " + strings.Join(failed, "; ")
	}
	return "; it is put back as it was"
}

// printMoves reports what setup did with the uid instances it found: each one moved, then every
// account left, with the one command that account runs, and what happens to a left instance.
func printMoves(w io.Writer, moves []hostInstanceMove, listErr error) {
	if listErr != nil {
		fmt.Fprintf(w, "\n  ✗ No orbit-runner@<uid> instance was moved: %v\n", listErr)
		return
	}
	var left []hostInstanceMove
	for _, m := range moves {
		if m.to == "" {
			left = append(left, m)
		}
	}
	if len(moves) > len(left) {
		fmt.Fprintln(w, "\n  Moved to instances named after their accounts:")
		for _, m := range moves {
			if m.to != "" {
				fmt.Fprintf(w, "    %s → %s (%s)\n", m.from, m.to, m.account)
			}
		}
	}
	if len(left) == 0 {
		return
	}
	fmt.Fprintf(w, "\n  Left on their orbit-runner@<uid> instance (%d):\n", len(left))
	for _, m := range left {
		who := fmt.Sprintf("uid %d", m.uid)
		if m.account != "" {
			who = m.account
		}
		fmt.Fprintf(w, "    %s (%s): %s.\n", who, m.from, m.why)
		if m.command != "" {
			fmt.Fprintf(w, "      %s runs:  %s\n", m.account, m.command)
		}
	}
	fmt.Fprintln(w, "  An instance left keeps its current process. At its next restart it runs its account's own\n"+
		"  ~/.orbit/bin/orbit, so it needs that copy by then: the command above puts it in place and\n"+
		"  moves the runner to orbit-runner@<user name>.")
}
