package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

// The lifecycle half of the hostd protocol: the verbs a user's `orbit` CLI asks the
// root broker to perform on their own runner instance. Every one of them acts on
// unitForUid(peer.UID) and nothing else — the request body never names a target (see
// hostdIdentityField), so "whose runner" is decided here, once, from the kernel's
// answer, and the rest of this file only ever sees the unit that came out of it.

// hostdSystem is everything the verbs reach outside their own process: the systemctl
// binary, the passwd database, and the directory unit files live in. It travels as one
// injected value so a test can drive the real verb logic against a recording fake and a
// temporary directory instead of the machine's actual init system.
type hostdSystem struct {
	// run executes a command for its effect and returns its combined output — what a
	// failed systemctl has to say for itself, which is the only useful thing to put in
	// the error the caller ends up reading.
	run func(name string, args ...string) (string, error)
	// query executes a command for its standard output alone. `systemctl show` answers
	// are parsed verbatim, and stderr folded into the same string would corrupt them.
	query func(name string, args ...string) (string, error)
	// lookupUID resolves a uid to its account, or fails if there is none.
	lookupUID func(uid string) (*user.User, error)
	unitDir   string
}

// hostdSystemDefaults is the production wiring: the real systemctl, the real passwd
// database, the real /etc/systemd/system.
func hostdSystemDefaults() hostdSystem {
	return hostdSystem{
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).CombinedOutput()
			return string(out), err
		},
		query:     execStdout,
		lookupUID: user.LookupId,
		unitDir:   systemdUnitDir,
	}
}

// verbs is the table hostdServe dispatches through. Six verbs, one shape: resolve the
// caller to their instance, then act on that instance.
func (s hostdSystem) verbs() map[string]hostdVerb {
	return map[string]hostdVerb{
		"enable":  s.enable,
		"disable": s.disable,
		"start":   s.unitVerb("start"),
		"stop":    s.unitVerb("stop"),
		"restart": s.unitVerb("restart"),
		"status":  s.status,
	}
}

// hostdTarget is the answer to "whose runner is this request about", derived once per
// request and never from anything the caller wrote.
type hostdTarget struct {
	uid      uint32
	username string
	unit     string
}

// data is the response body every verb shares: the uid hostd decided on and the unit it
// acted on, so a caller can check what actually happened rather than assume it matched
// what they meant.
func (t hostdTarget) data(extra map[string]any) map[string]any {
	d := map[string]any{"uid": t.uid, "unit": t.unit}
	for k, v := range extra {
		d[k] = v
	}
	return d
}

// hostdBringsUnitUp names the verbs that can leave a unit running, and so the ones uid 0
// is refused. restart belongs on this list: against a stopped unit it *is* start, so
// guarding enable and start while leaving restart open would be a lock with the key
// hanging next to it. Tear-down and read-only verbs stay open to uid 0 on purpose — a
// root runner that predates this rule has to remain stoppable.
var hostdBringsUnitUp = map[string]bool{"enable": true, "start": true, "restart": true}

// target resolves the peer to the instance a verb may act on, or returns the refusal to
// send back instead. Two rules live here:
//
//   - A uid with no account is not somebody hostd will touch a unit for. The template's
//     User=%i could not resolve at activation anyway, and a uid arriving from a user
//     namespace hostd cannot see is exactly the case worth stopping at the door.
//   - uid 0 gets no runner brought up. A root runner owns every file its agents write
//     and reads root's own engine logins, which is why the control plane carries a
//     runsAsRoot risk flag at all (see runs_as_root_test.go) — hostd's job is to make
//     that flag unnecessary, not to hand out new reasons for it.
func (s hostdSystem) target(peer hostdPeer, verb string) (hostdTarget, hostdResponse, bool) {
	uid := strconv.FormatUint(uint64(peer.UID), 10)
	u, err := s.lookupUID(uid)
	if err != nil {
		return hostdTarget{}, hostdFail("uid %s has no account on this machine: %v", uid, err), false
	}
	if peer.UID == 0 && hostdBringsUnitUp[verb] {
		return hostdTarget{}, hostdFail("refusing to %s %s: the runner must not run as root — it would own every file its agents write and read root's own engine logins. Ask from the unprivileged account the runner should belong to instead.", verb, unitForUid(peer.UID)), false
	}
	return hostdTarget{uid: peer.UID, username: u.Username, unit: unitForUid(peer.UID)}, hostdResponse{}, true
}

// unitVerb builds the verbs that are one systemctl subcommand against the caller's own
// instance and nothing more: start, stop, restart.
func (s hostdSystem) unitVerb(verb string) hostdVerb {
	return func(peer hostdPeer, _ hostdRequest) hostdResponse {
		t, refusal, ok := s.target(peer, verb)
		if !ok {
			return refusal
		}
		if err := s.systemctl(verb, t.unit); err != nil {
			return hostdFail("%v", err)
		}
		return hostdOK(t.data(nil))
	}
}

// enable is what `orbit register` asks for: leave this user with exactly one live
// runner, the uid-keyed instance.
func (s hostdSystem) enable(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "enable")
	if !ok {
		return refusal
	}
	// Before the instance is enabled, not after: the pre-template units this account may
	// still carry run the very same `orbit run`, and two live runners for one account
	// fight over one lease.
	s.migrateLegacyUnits(t)
	if err := s.systemctl("enable", t.unit); err != nil {
		return hostdFail("%v", err)
	}
	// restart, not start: registering rotates the runner's credential, and start is a
	// no-op on a unit that is already running — the live runner would keep its stale
	// in-memory token and 401 until something restarted it. restart starts a stopped
	// unit and replaces a running one. Same reasoning as installSystemd's restart in
	// service.go.
	if err := s.systemctl("restart", t.unit); err != nil {
		return hostdFail("%v", err)
	}
	return hostdOK(t.data(nil))
}

// disable is what `orbit unregister` asks for: leave this user with no live runner at
// all. That is more than the uid-keyed instance. An account that registered the sudo way
// before `orbit host setup` existed, and never re-registered, still owns a pre-template
// unit — and unregistering only orbit-runner@<uid> (a unit that account never enabled,
// so systemctl reports success) leaves that one running against the credential the
// server just deleted, restarting into a 401 forever. enable migrates those units out of
// the way; disable has to take the same ones down, or the broker path is a tear-down
// that leaves the thing it was asked to remove behind.
//
// After the instance, not before: the instance is what the caller asked about and what
// the response reports on, so a systemctl that cannot even do that is the failure worth
// returning — the legacy sweep that follows is best-effort in the same way enable's is.
func (s hostdSystem) disable(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "disable")
	if !ok {
		return refusal
	}
	if err := s.systemctl("disable", "--now", t.unit); err != nil {
		return hostdFail("%v", err)
	}
	s.migrateLegacyUnits(t)
	return hostdOK(t.data(nil))
}

// status answers "is my runner up". `systemctl show` rather than is-active or status
// because it answers for a unit that was never enabled, and because it is the one
// subcommand with output meant to be parsed. Without --value the lines name themselves,
// so reading two properties does not depend on trusting their order.
func (s hostdSystem) status(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "status")
	if !ok {
		return refusal
	}
	out, err := s.query("systemctl", "show", t.unit, "-p", "ActiveState", "-p", "SubState")
	if err != nil {
		return hostdFail("systemctl show %s failed: %v", t.unit, err)
	}
	props := hostdShowProperties(out)
	return hostdOK(t.data(map[string]any{
		"activeState": props["ActiveState"],
		"subState":    props["SubState"],
	}))
}

// migrateLegacyUnits removes the units this account's runner had before instances were
// keyed by uid: the per-user orbit-runner-<username> and, older still, the bare
// orbit-runner. Both run the same `orbit run`, so leaving one enabled beside the new
// instance means two runners for one account — and the older one holds a credential the
// re-registration just rotated, so it 401s forever rather than failing loudly.
//
// Both halves of the lifecycle call it, for that same second reason: enable, so the new
// instance is the account's only runner, and disable, so unregister does not leave one
// behind holding a credential that no longer exists.
//
// Ownership is decided by the unit's own User=, never by its name. That is what keeps
// this safe on a shared machine (another account's orbit-runner is their runner, not
// debris), and it is the only thing that can tell "alice.b" and "alice_b" apart —
// systemdServiceFor maps both to orbit-runner-alice_b, which is precisely the collision
// the uid keying exists to end.
//
// Best-effort: a migration that cannot be finished must not stop the caller from getting
// the new instance, which is the thing that actually supersedes the old one. hostd runs
// as root, so unlike the sudo path in service.go there is nothing to elevate through.
func (s hostdSystem) migrateLegacyUnits(t hostdTarget) {
	removed := false
	for _, svc := range []string{systemdServiceFor(t.username), systemdService} {
		if !unitRunsAsUserIn(s.unitDir, s.query, svc, t.username) {
			continue
		}
		_ = s.systemctl("disable", "--now", svc+".service")
		if err := os.Remove(filepath.Join(s.unitDir, svc+".service")); err == nil {
			removed = true
		}
	}
	// Only when a unit file actually went away — daemon-reload exists to make systemd
	// re-read the directory, and there is nothing to re-read otherwise.
	if removed {
		_ = s.systemctl("daemon-reload")
	}
}

// systemctl runs one invocation and folds systemd's own complaint into the error, so a
// caller several hops away still learns why rather than just that.
func (s hostdSystem) systemctl(args ...string) error {
	out, err := s.run("systemctl", args...)
	if err == nil {
		return nil
	}
	if detail := strings.TrimSpace(out); detail != "" {
		return fmt.Errorf("systemctl %s failed: %v: %s", strings.Join(args, " "), err, detail)
	}
	return fmt.Errorf("systemctl %s failed: %v", strings.Join(args, " "), err)
}

// hostdShowProperties parses the Key=Value lines `systemctl show` emits. A value may
// itself contain '=', so only the first one separates.
func hostdShowProperties(out string) map[string]string {
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			props[k] = v
		}
	}
	return props
}
