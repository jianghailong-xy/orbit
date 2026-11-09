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
	// notAsItWas says a move that failed could not leave the uid instance as it was: it stays
	// down because the name instance could not be confirmed down, or it could not be put back.
	notAsItWas bool
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
// all. A move that fails part way leaves the account with at most one runner: the uid instance,
// put back as it was once the name instance is confirmed down and disabled, or, when the name
// instance cannot be confirmed down, the uid instance left down and both units named.
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
		restored, ok := env.restore(from, st)
		m.why, m.notAsItWas = "the move failed: "+err.Error()+restored, !ok
		return m, true
	}
	to := t.unit
	err = sys.systemctl("enable", to)
	if err == nil {
		err = sys.systemctl("start", to)
	}
	if err != nil {
		// systemd may have enabled or started the name instance even though systemctl reported
		// an error (its reply lost, say), so it is taken down and confirmed down before the uid
		// instance is put back. One that cannot be confirmed down may still be running: the uid
		// instance then stays down, and the account has at most one runner.
		if downErr := takeDownNameInstance(sys, to); downErr != nil {
			m.why = fmt.Sprintf("the move failed: %v; and %v. %s may still be running, so %s is not started again and %s has at most one runner. "+
				"To settle it, root runs `systemctl disable --now %s` and, once `systemctl is-active %s` says inactive, `systemctl enable --now %s`; "+
				"or %s runs the command below, which finishes the move",
				err, downErr, to, from, t.username, to, to, from, t.username)
			m.notAsItWas = true
			return m, true
		}
		restored, ok := env.restore(from, st)
		m.why, m.notAsItWas = "the move failed: "+err.Error()+restored, !ok
		return m, true
	}
	m.to = to
	return m, true
}

// takeDownNameInstance takes down a name instance whose enable or start reported an error, as
// takeDown does an older runner: stopped, confirmed down, disabled, and confirmed down and not
// enabled, each by asking systemd rather than trusting systemctl's exit status.
func takeDownNameInstance(sys hostdSystem, unit string) error {
	if err := sys.systemctl("stop", unit); err != nil {
		return fmt.Errorf("%s could not be stopped: %v", unit, err)
	}
	st, err := sys.unitState(unit)
	if err != nil {
		return fmt.Errorf("%s was stopped, but systemd could not be asked whether it is down: %v", unit, err)
	}
	if !st.down() {
		return fmt.Errorf("%s is still up after systemctl stop: systemd reports ActiveState=%s", unit, st["ActiveState"])
	}
	if err := sys.systemctl("disable", unit); err != nil {
		return fmt.Errorf("%s was stopped but could not be disabled: %v", unit, err)
	}
	if st, err = sys.unitState(unit); err != nil {
		return fmt.Errorf("%s was stopped and disabled, but systemd could not be asked whether it stayed down: %v", unit, err)
	}
	if !st.down() || st.enabled() {
		return fmt.Errorf("%s is not down after systemctl stop and disable: systemd reports ActiveState=%s, UnitFileState=%s", unit, st["ActiveState"], st["UnitFileState"])
	}
	return nil
}

// restore puts a uid instance whose move failed back as it was before — enabled if it was, and
// started if it was up — and says what could not be. Only what the move changed is put back: a
// uid instance that would not stop is still running, enabled, as it was. ok is false when it
// could not be put back.
func (env hostSetupEnv) restore(from string, was hostdUnitState) (said string, ok bool) {
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
		return "; and it could not be put back: " + strings.Join(failed, "; "), false
	}
	return "; it is put back as it was", true
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
	asItWas := 0
	for _, m := range left {
		if !m.notAsItWas {
			asItWas++
		}
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
	// What follows holds only for an instance left as it was; one a failed move could not leave
	// so has its own line above saying what became of it.
	if asItWas == 0 {
		return
	}
	who := "An instance left"
	if asItWas < len(left) {
		who = "An instance left as it was"
	}
	fmt.Fprintln(w, "  "+who+" keeps its current process. At its next restart it runs its account's own\n"+
		"  ~/.orbit/bin/orbit, so it needs that copy by then: the command above puts it in place and\n"+
		"  moves the runner to orbit-runner@<user name>.")
}
