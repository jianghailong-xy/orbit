package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The lifecycle half of the hostd protocol: the verbs a user's `orbit` CLI asks the
// root broker to perform on their own runner instance. Every one of them acts on the
// caller's own instance and nothing else — orbit-runner@<escaped user name>, or
// orbit-runner@<uid> on a host whose template predates names (namesInstances). The
// request body never names a target (see hostdIdentityField), so "whose runner" is
// decided here, once, from the kernel's answer plus the passwd database, and the rest of
// this file only ever sees the unit that came out of it.

// hostdSystem is everything the verbs reach outside their own process: the systemctl
// binary, the passwd database, the directory unit files live in, and the two questions
// about an account's processes and files that hostd never answers by touching them as
// root. It travels as one injected value so a test can drive the real verb logic against
// a recording fake and a temporary directory instead of the machine's actual init system.
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
	// canExecute reports whether the account can execute the file at path, asked as that
	// account (accountCanExecute). An error means it could not tell.
	canExecute func(account *user.User, path string) (bool, error)
	// readExe is the binary process pid runs, as the kernel's /proc/<pid>/exe link names it.
	readExe func(pid string) (string, error)
}

// hostdSystemDefaults is the production wiring: the real systemctl, the real passwd
// database, the real /etc/systemd/system.
func hostdSystemDefaults() hostdSystem {
	return hostdSystem{
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).CombinedOutput()
			return string(out), err
		},
		query:      execStdout,
		lookupUID:  user.LookupId,
		unitDir:    systemdUnitDir,
		canExecute: accountCanExecute,
		readExe:    func(pid string) (string, error) { return os.Readlink("/proc/" + pid + "/exe") },
	}
}

// namesInstances reports whether this host's runner template names instances after
// accounts — User=%I, as `orbit host setup` writes it from this release on. A host set up
// before keeps its template's User=%i, and with it today's uid instances, a binary shared
// by every instance and no copy of an account's own to check, until setup is run again; so
// does a host with no template at all. systemd applies the last User= it reads, and so
// does this.
func (s hostdSystem) namesInstances() bool {
	b, err := os.ReadFile(filepath.Join(s.unitDir, filepath.Base(hostRunnerTemplatePath)))
	if err != nil {
		return false
	}
	user := ""
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "User="); ok {
			user = strings.TrimSpace(v)
		}
	}
	return user == "%I"
}

// verbs is the table hostdServe dispatches through. Six of them share one shape: resolve
// the caller to their instance, then act on that instance. update is the exception — it
// acts on the machine's binary, so it is the caller's uid it needs (to drop to before
// running the download) rather than the caller's unit; see hostd_update.go.
func (s hostdSystem) verbs() map[string]hostdVerb {
	return map[string]hostdVerb{
		"enable":  s.enable,
		"disable": s.disable,
		"start":   s.unitVerb("start"),
		"stop":    s.unitVerb("stop"),
		"restart": s.unitVerb("restart"),
		"status":  s.status,
		"update":  hostdUpdate{sys: s}.withDefaults().verb,
	}
}

// hostdTarget is the answer to "whose runner is this request about", derived once per
// request and never from anything the caller wrote.
type hostdTarget struct {
	uid      uint32
	username string
	account  *user.User
	unit     string
	// byName says the instance is named after the account and runs the account's own
	// ~/.orbit/bin/orbit (namesInstances); false on a host still on the uid template.
	byName bool
}

// isAccount reports whether a unit's User= is this account: its name, or its uid in
// digits, which systemd reads as that same account.
func (t hostdTarget) isAccount(user string) bool {
	return user != "" && (user == t.username || user == strconv.FormatUint(uint64(t.uid), 10))
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
// send back instead. Three rules live here:
//
//   - A uid with no account is not somebody hostd will touch a unit for. The template's
//     User= could not resolve at activation anyway, and a uid arriving from a user
//     namespace hostd cannot see is exactly the case worth stopping at the door.
//   - A name made of digits alone names no instance: systemd reads User=%I of
//     orbit-runner@1000 as uid 1000 whoever is called "1000", and of orbit-runner@0 as
//     root.
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
	t := hostdTarget{uid: peer.UID, username: u.Username, account: u, unit: unitForUid(peer.UID)}
	if s.namesInstances() {
		t.byName, t.unit = true, unitForAccount(u.Username)
		if strings.Trim(u.Username, "0123456789") == "" {
			return hostdTarget{}, hostdFail("refusing to %s %s: the user name %q is all digits, which systemd reads as uid %s rather than as this account (uid %s)", verb, t.unit, u.Username, u.Username, uid), false
		}
	}
	if peer.UID == 0 && hostdBringsUnitUp[verb] {
		return hostdTarget{}, hostdFail("refusing to %s %s: the runner must not run as root — it would own every file its agents write and read root's own engine logins. Ask from the unprivileged account the runner should belong to instead.", verb, t.unit), false
	}
	return t, hostdResponse{}, true
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
// runner, its own instance.
func (s hostdSystem) enable(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "enable")
	if !ok {
		return refusal
	}
	// Before any unit is touched: an instance with no copy of the account's own to run
	// fails at every start, and the older runner taken down below would have gone for
	// nothing.
	if t.byName {
		if refusal, ok := s.ownCopy(t); !ok {
			return refusal
		}
	}
	// Before the instance is enabled, not after: the older units this account may still
	// carry run the very same `orbit run`, and two live runners for one account fight over
	// one lease. Each is confirmed down before the instance is enabled or started, and one
	// that is not is a refusal: the account keeps the runner it had, and only that one.
	if err := s.takeDownOlderUnits(t); err != nil {
		resp := hostdFail("refusing to enable %s: %v\nIt is still %s's runner, so %s was neither enabled nor started. Once it can be stopped, run `orbit register` again.", t.unit, err, t.username, t.unit)
		resp.Code = hostdRefusedOlderRunner
		return resp
	}
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

// hostdRefusedOwnCopy is the code on enable's refusal of an account with no copy of its
// own for its instance to run (ownCopy). `orbit register` stops at it rather than falling
// back to the sudo path, whose unit would run another binary beside the template.
const hostdRefusedOwnCopy = "own-copy"

// hostdRefusedOlderRunner is the code on enable's refusal, and disable's report, of an
// older runner unit of the account that could not be taken down (takeDownOlderUnits).
// `orbit register` stops at it too: the sudo path would install yet another unit beside it.
const hostdRefusedOlderRunner = "older-runner"

// hostdOwnCopyCommand is what an account with no copy of its own runs before registering
// again: the machine's binary copied into its own ~/.orbit/bin, under a ~/.orbit made
// 0700 like every one Orbit creates, since it holds the runner's credential.
const hostdOwnCopyCommand = "mkdir -p -m 0700 ~/.orbit && install -D -m 0755 " + machineBinaryPath + " ~/.orbit/bin/orbit"

// hostdCopyCheckTimeout bounds accountCanExecute: a home on a mount that hangs must not
// hold the handler past hostdConnTimeout.
var hostdCopyCheckTimeout = 3 * time.Second

// ownCopy refuses, with what is missing and what to run, an account whose instance would
// have nothing to start: ExecStart= runs "$HOME/.orbit/bin/orbit", where systemd sets
// $HOME from the passwd entry, so that file has to be one the account can execute.
// Nothing about it is looked at as root. An account with no home — none, a relative one,
// which systemd ignores, or /nonexistent — has nowhere to keep a copy; any other is asked
// of the account itself (canExecute), which follows a symlink there with its own
// permissions, as the exec will. A check that cannot answer is a refusal too.
func (s hostdSystem) ownCopy(t hostdTarget) (hostdResponse, bool) {
	refuse := func(format string, a ...any) (hostdResponse, bool) {
		resp := hostdFail("refusing to enable %s: it runs %s's own ~/.orbit/bin/orbit, and "+format,
			append([]any{t.unit, t.username}, a...)...)
		resp.Code = hostdRefusedOwnCopy
		return resp, false
	}
	home := t.account.HomeDir
	if home == "" || home == "/nonexistent" || !filepath.IsAbs(home) {
		return refuse("%s has no home directory to keep it in (the passwd database gives %q). Register from an account that has a home directory.", t.username, home)
	}
	bin := userBinPath(home)
	switch ok, err := s.canExecute(t.account, bin); {
	case err != nil:
		return refuse("hostd could not check %s as %s: %v. Run `orbit register` again once it can be reached.", bin, t.username, err)
	case !ok:
		return refuse("%s is missing or %s cannot execute it. Put a copy there, then run `orbit register` again:\n  %s", bin, t.username, hostdOwnCopyCommand)
	}
	return hostdResponse{}, true
}

// accountCanExecute is canExecute on a real machine: /bin/sh, run as the account, tests
// that path is a regular file the account may execute — the kernel's own answer for that
// account, its supplementary groups, ACLs and noexec mounts included. Root executes only
// the system's shell, opens nothing in the home and never execs the file; the shell
// follows a symlink there as the account, as systemd's exec through the template will. It
// gets no environment, no stdin and hostdCopyCheckTimeout to answer, and a hostd that is
// not root (a foreground one) has no other account to become, so it asks as itself.
func accountCanExecute(account *user.User, path string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hostdCopyCheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `test -f "$1" && test -x "$1"`, "orbit-hostd", path)
	cmd.Env, cmd.Dir = []string{}, "/"
	if os.Geteuid() == 0 {
		uid, err := strconv.ParseUint(account.Uid, 10, 32)
		if err != nil {
			return false, err
		}
		gid, err := strconv.ParseUint(account.Gid, 10, 32)
		if err != nil {
			return false, err
		}
		ids, err := account.GroupIds()
		if err != nil {
			return false, fmt.Errorf("cannot read the groups of %s: %w", account.Username, err)
		}
		var groups []uint32
		for _, id := range ids {
			if g, err := strconv.ParseUint(id, 10, 32); err == nil {
				groups = append(groups, uint32(g))
			}
		}
		if err := hostdDropTo(cmd, uint32(uid), uint32(gid), groups...); err != nil {
			return false, err
		}
	}
	// Waited for on a goroutine of its own, so that a shell the kill cannot reach yet — one
	// stuck in a hung mount — holds nothing but that goroutine.
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		return false, fmt.Errorf("no answer within %s", hostdCopyCheckTimeout)
	}
	var exit *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case ctx.Err() != nil:
		return false, fmt.Errorf("no answer within %s", hostdCopyCheckTimeout)
	case errors.As(err, &exit) && exit.ExitCode() == 1:
		return false, nil
	}
	return false, err
}

// disable is what `orbit unregister` asks for: leave this user with no live runner at
// all. That is more than its instance. An account that registered the sudo way before
// `orbit host setup` existed, and never re-registered, still owns a pre-template unit —
// and an account from a host set up before instances were named after accounts may still
// run orbit-runner@<uid>. Unregistering only the instance (a unit that account may never
// have enabled, so systemctl reports success) leaves that one running against the
// credential the server just deleted, restarting into a 401 forever. enable migrates
// those units out of the way; disable has to take the same ones down, or the broker path
// is a tear-down that leaves the thing it was asked to remove behind.
//
// After the instance, not before: the instance is what the caller asked about and what
// the response reports on, so a systemctl that cannot even do that is the failure worth
// returning first. An older unit that cannot be taken down after it is reported too, with
// the code enable's refusal carries, rather than answered as success: the account still
// has that runner.
func (s hostdSystem) disable(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "disable")
	if !ok {
		return refusal
	}
	if err := s.systemctl("disable", "--now", t.unit); err != nil {
		return hostdFail("%v", err)
	}
	if err := s.takeDownOlderUnits(t); err != nil {
		resp := hostdFail("disabled %s, but %v\nIt is still running as %s. Once it can be stopped, run `orbit unregister` again.", t.unit, err, t.username)
		resp.Code, resp.Data = hostdRefusedOlderRunner, t.data(nil)
		return resp
	}
	return hostdOK(t.data(nil))
}

// status answers "is my runner up", and with what. `systemctl show` rather than
// is-active or status because it answers for a unit that was never enabled, and because
// it is the one subcommand with output meant to be parsed. Without --value the lines name
// themselves, so reading several properties does not depend on trusting their order.
//
// The binary is the one the unit's main process runs, which systemctl cannot say: the
// template's ExecStart= names /bin/sh, which execs the account's own copy. It is read
// from the kernel's /proc/<pid>/exe link, which names the file without opening it, and
// left out while no process runs.
func (s hostdSystem) status(peer hostdPeer, _ hostdRequest) hostdResponse {
	t, refusal, ok := s.target(peer, "status")
	if !ok {
		return refusal
	}
	out, err := s.query("systemctl", "show", t.unit, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID")
	if err != nil {
		return hostdFail("systemctl show %s failed: %v", t.unit, err)
	}
	props := hostdShowProperties(out)
	extra := map[string]any{
		"activeState": props["ActiveState"],
		"subState":    props["SubState"],
	}
	if pid := props["MainPID"]; pid != "" && pid != "0" {
		if exe, err := s.readExe(pid); err == nil {
			extra["binary"] = exe
		}
	}
	return hostdOK(t.data(extra))
}

// takeDownOlderUnits takes down every other runner unit this account has: on a host
// whose instances are named after accounts, its orbit-runner@<uid> instance from before
// that; and on any host, the per-user orbit-runner-<username> and, older still, the bare
// orbit-runner, which the sudo path wrote. Each runs the same `orbit run`, so leaving one
// up beside the instance means two runners for one account — and the older one holds a
// credential the re-registration just rotated, so it 401s forever rather than failing
// loudly.
//
// Both halves of the lifecycle call it, for that same second reason: enable, before the
// instance is enabled or started, so it is the account's only runner at every moment, and
// disable, so unregister does not leave one behind holding a credential that no longer
// exists.
//
// Ownership is decided by the unit's own User=, never by its name: the account's name,
// or — on a host whose instances are named after accounts — its uid in digits, which
// systemd reads as the same account (isAccount). A host still on the uid template keeps
// today's rule, the name alone. That is what keeps this safe on a shared machine (another
// account's orbit-runner is their runner, not debris), and it is the only thing that can
// tell "alice.b" and "alice_b" apart — systemdServiceFor maps both to
// orbit-runner-alice_b.
//
// Not best-effort: every unit of the account is found first, then each is stopped and
// confirmed down (takeDown) before the next, and the first that cannot be — or a systemd
// that cannot be asked — is the error, naming the unit and systemd's answer. A legacy
// unit's file is removed only once its unit is confirmed down. hostd runs as root, so
// unlike the sudo path in service.go there is nothing to elevate through.
func (s hostdSystem) takeDownOlderUnits(t hostdTarget) error {
	type older struct {
		unit string
		file string // the legacy unit's file, removed once it is down; "" for an instance
	}
	var units []older
	owners := []string{t.username}
	if t.byName {
		inst := unitForUid(t.uid)
		st, err := s.unitState(inst)
		if err != nil {
			return fmt.Errorf("hostd could not ask systemd whether %s is an older runner of %s's: %v", inst, t.username, err)
		}
		// A template instance that is neither enabled nor on its way up is no runner, and
		// has no unit file of its own to remove.
		if t.isAccount(st["User"]) && (st.up() || st.enabled()) {
			units = append(units, older{unit: inst})
		}
		owners = append(owners, strconv.FormatUint(uint64(t.uid), 10))
	}
	for _, svc := range []string{systemdServiceFor(t.username), systemdService} {
		unit := svc + ".service"
		file := filepath.Join(s.unitDir, unit)
		if _, err := os.Stat(file); errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return fmt.Errorf("hostd could not tell whether %s is an older runner of %s's: %v", unit, t.username, err)
		}
		st, err := s.unitState(unit)
		if err != nil {
			return fmt.Errorf("hostd could not ask systemd whether %s is an older runner of %s's: %v", unit, t.username, err)
		}
		for _, owner := range owners {
			if st["User"] == owner {
				units = append(units, older{unit: unit, file: file})
				break
			}
		}
	}

	removed := false
	// Only when a unit file actually went away — daemon-reload exists to make systemd
	// re-read the directory, and there is nothing to re-read otherwise. Also after a later
	// unit failed: the files already removed are gone either way.
	defer func() {
		if removed {
			_ = s.systemctl("daemon-reload")
		}
	}()
	for _, o := range units {
		if err := s.takeDown(o.unit, t); err != nil {
			return err
		}
		if o.file != "" && os.Remove(o.file) == nil {
			removed = true
		}
	}
	return nil
}

// takeDown stops one older runner unit of t's account and disables it, in that order, so
// a unit that will not stop keeps running enabled, as it was. Each step is confirmed by
// asking systemd afterwards rather than trusted from systemctl's exit status alone: a stop
// that "succeeds" can leave a unit up, restarted or kept by something else.
func (s hostdSystem) takeDown(unit string, t hostdTarget) error {
	older := fmt.Sprintf("%s's older runner %s", t.username, unit)
	if err := s.systemctl("stop", unit); err != nil {
		return fmt.Errorf("%s could not be stopped: %v", older, err)
	}
	st, err := s.unitState(unit)
	if err != nil {
		return fmt.Errorf("%s was stopped, but systemd could not be asked whether it is down: %v", older, err)
	}
	if !st.down() {
		return fmt.Errorf("%s is still up after systemctl stop: systemd reports ActiveState=%s", older, st["ActiveState"])
	}
	if err := s.systemctl("disable", unit); err != nil {
		return fmt.Errorf("%s was stopped but could not be disabled: %v", older, err)
	}
	if st, err = s.unitState(unit); err != nil {
		return fmt.Errorf("%s was stopped and disabled, but systemd could not be asked whether it stayed down: %v", older, err)
	}
	if !st.down() || st.enabled() {
		return fmt.Errorf("%s is not down after systemctl stop and disable: systemd reports ActiveState=%s, UnitFileState=%s", older, st["ActiveState"], st["UnitFileState"])
	}
	return nil
}

// hostdUnitState is what `systemctl show` says about one unit: its User=, UnitFileState
// and ActiveState.
type hostdUnitState map[string]string

// unitState asks systemd about a unit. A unit with no file of its own, a template
// instance, is answered from its template, so systemd is the one asked.
func (s hostdSystem) unitState(unit string) (hostdUnitState, error) {
	out, err := s.query("systemctl", "show", unit, "-p", "User", "-p", "UnitFileState", "-p", "ActiveState")
	if err != nil {
		return nil, fmt.Errorf("systemctl show %s failed: %v", unit, err)
	}
	return hostdUnitState(hostdShowProperties(out)), nil
}

// up reports a unit not yet stopped for good: active, activating, reloading,
// deactivating, or waiting out RestartSec= — which comes back on its own.
func (st hostdUnitState) up() bool {
	switch st["ActiveState"] {
	case "", "inactive", "failed":
		return false
	}
	return true
}

// down reports a unit systemd says is stopped: inactive or failed, and nothing else — an
// answer without an ActiveState confirms nothing.
func (st hostdUnitState) down() bool {
	a := st["ActiveState"]
	return a == "inactive" || a == "failed"
}

// enabled reports a unit that would be started again at boot.
func (st hostdUnitState) enabled() bool {
	f := st["UnitFileState"]
	return f == "enabled" || f == "enabled-runtime"
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
