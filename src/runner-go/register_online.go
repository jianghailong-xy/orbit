package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Before `orbit register` says a machine is online, the service it started has to have been heard
// from: the control plane reports a heartbeat later than the one it reported before the service
// started. Nothing short of that says the runner works. systemd and launchd start a runner that exits
// a moment later as readily as one that stays up, and the control plane's own "online" can come from
// a beat older than this registration. A runner beats as soon as it has started (runloop.go), so a
// healthy one is heard from within seconds.

// runnerService is the background service a registration started: what to ask whether it is still
// running, and where its log is.
type runnerService struct {
	unit    string // the systemd unit, e.g. orbit-runner-alice.service or orbit-runner@alice.service
	label   string // the launchd agent's label
	logPath string // the file the launchd agent writes its output to
	how     string // how it comes back: "runs at boot" or "starts at login"
}

// What register waits for. onlineWait bounds it: past it, a runner still not heard from is reported,
// whatever it is doing. Vars so a test need not sit through them.
var (
	onlineWait = 60 * time.Second
	onlinePoll = time.Second
)

// serviceQuery runs a command for its standard output: systemctl, journalctl and launchctl, asked
// about the service. A var so a test can answer in their place.
var serviceQuery = execStdout

// serviceState is what the service manager says about the service.
type serviceState struct {
	down    bool   // it is not running and is not about to be, or it keeps exiting
	summary string // what happened to it, when down
}

// onlineWatch waits for the control plane to hear from a runner its service just started.
type onlineWatch struct {
	server string
	me     func() (*MeResponse, error)
	// state reads the service manager; ok is false when it could not be read.
	state func() (serviceState, bool)
	sleep func(time.Duration)
	now   func() time.Time
	wait  time.Duration
	poll  time.Duration
}

// notOnline is why a started service was not heard from.
type notOnline struct{ reason string }

func (e *notOnline) Error() string { return e.reason }

// until waits until the control plane reports a heartbeat later than before's: a runner it had never
// heard from (before.LastHeartbeatAt nil) is online at its first beat. before is nil when it could not
// be read; then the first answer to arrive stands in for it, and only a beat after that one counts.
// It returns nil once the runner is heard from, and the reason it was not otherwise: the service went
// down, the control plane refused the credential, or the wait ran out.
func (w onlineWatch) until(before *MeResponse) error {
	known := before != nil
	var last *string
	if known {
		last = before.LastHeartbeatAt
	}
	var askErr error
	deadline := w.now().Add(w.wait)
	for {
		w.sleep(w.poll)
		me, err := w.me()
		switch {
		case err == nil && !known:
			known, last = true, me.LastHeartbeatAt
		case err == nil && beatAfter(me.LastHeartbeatAt, last):
			return nil
		case isTransportHTTPStatus(err, 401):
			return &notOnline{fmt.Sprintf("%s no longer accepts its credential", w.server)}
		case err != nil:
			askErr = err
		}
		if st, ok := w.state(); ok && st.down {
			return &notOnline{fmt.Sprintf("%s, and %s has not heard from it", st.summary, w.server)}
		}
		if w.now().After(deadline) {
			if askErr != nil && !known {
				return &notOnline{fmt.Sprintf("%s could not be asked whether it has heard from it (%s)", w.server, firstLine(askErr.Error()))}
			}
			return &notOnline{fmt.Sprintf("%s has not heard from it in %s", w.server, w.wait.Round(time.Second))}
		}
	}
}

// beatAfter reports whether the control plane's last-heartbeat reading moved past before: from never
// to a beat, or to a later one.
func beatAfter(after, before *string) bool {
	if after == nil {
		return false
	}
	if before == nil {
		return true
	}
	a, errA := time.Parse(time.RFC3339Nano, *after)
	b, errB := time.Parse(time.RFC3339Nano, *before)
	if errA != nil || errB != nil {
		return *after != *before
	}
	return a.After(b)
}

// systemdState reads unit from systemd. restartsBefore is its restart count when it was started, so
// that only the restarts since count. A unit that is gone, failed or stopped is down, and so is one
// restarted twice since: the runner exits within moments when it cannot start, and its unit restarts
// it every 5 s.
func systemdState(unit string, restartsBefore int) (serviceState, bool) {
	props, ok := systemdProps(unit)
	if !ok {
		return serviceState{}, false
	}
	restarts := atoiOr(props["NRestarts"], 0) - restartsBefore
	var how string
	switch props["ExecMainCode"] {
	case "1": // CLD_EXITED
		how = "exited with status " + props["ExecMainStatus"]
	case "2", "3": // CLD_KILLED, CLD_DUMPED
		how = "was killed by signal " + props["ExecMainStatus"]
	}
	switch {
	case props["LoadState"] == "not-found":
		return serviceState{down: true, summary: unit + " is no longer installed"}, true
	case props["ActiveState"] == "failed", props["ActiveState"] == "inactive":
		summary := unit + " is " + props["ActiveState"]
		if how != "" {
			summary = unit + " " + how + " and is " + props["ActiveState"]
		}
		return serviceState{down: true, summary: summary}, true
	case restarts >= 2:
		if how == "" {
			how = "keeps exiting"
		}
		return serviceState{down: true, summary: fmt.Sprintf("%s %s and was restarted %d times", unit, how, restarts)}, true
	}
	return serviceState{}, true
}

// systemdRestarts is unit's restart count now, for systemdState to count from.
func systemdRestarts(unit string) int {
	props, _ := systemdProps(unit)
	return atoiOr(props["NRestarts"], 0)
}

func systemdProps(unit string) (map[string]string, bool) {
	out, err := serviceQuery("systemctl", "show", unit, "--property=LoadState,ActiveState,SubState,NRestarts,ExecMainCode,ExecMainStatus")
	if err != nil {
		return nil, false
	}
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			props[k] = v
		}
	}
	return props, props["ActiveState"] != ""
}

// launchdState reads the agent from launchd: not loaded, or not running after exiting with a failure,
// is down. KeepAlive starts it again, at most every 10 s, so between two tries it has no PID.
func launchdState(label string) (serviceState, bool) {
	out, err := serviceQuery("launchctl", "list", label)
	if err != nil {
		return serviceState{down: true, summary: label + " is not loaded"}, true
	}
	pid, exit := plistValue(out, "PID"), plistValue(out, "LastExitStatus")
	if pid == "" && exit != "" && exit != "0" {
		return serviceState{down: true, summary: fmt.Sprintf("%s exited (status %s)", label, exit)}, true
	}
	return serviceState{}, true
}

// plistValue is key's value in `launchctl list <label>` output, whose lines read `"PID" = 501;`.
func plistValue(out, key string) string {
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && strings.Trim(strings.TrimSpace(k), `"`) == key {
			return strings.Trim(strings.TrimSuffix(strings.TrimSpace(v), ";"), `"`)
		}
	}
	return ""
}

// serviceLog is the end of the service's log, at most n lines, or nothing when it cannot be read:
// for a unit, what it logged since started, which journalctl shows an account for its own runner only
// when the journal is persistent; for a LaunchAgent, the end of the file its output goes to.
func serviceLog(svc *runnerService, started time.Time, n int) []string {
	var text string
	switch {
	case svc.unit != "":
		out, err := serviceQuery("journalctl", "-u", svc.unit, "--since", "@"+strconv.FormatInt(started.Unix(), 10),
			"--no-pager", "--output=cat", "-n", strconv.Itoa(n))
		if err != nil {
			return nil
		}
		text = out
	case svc.logPath != "":
		b, err := os.ReadFile(svc.logPath)
		if err != nil {
			return nil
		}
		text = string(b)
	}
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimRight(line, " \r"); line != "" && !strings.HasPrefix(line, "-- ") {
			lines = append(lines, line)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// whereToLook is the commands that show the service's state and its whole log.
func (svc *runnerService) whereToLook() []string {
	if svc.unit != "" {
		return []string{"systemctl status " + svc.unit, "journalctl -u " + svc.unit + " -e"}
	}
	return []string{"launchctl list " + svc.label, "tail -n 100 " + svc.logPath}
}

// printNotOnline says that the service started for name was not heard from, why, what it logged and
// where to look further.
func printNotOnline(w io.Writer, name string, svc *runnerService, err error, logLines []string) {
	var why *notOnline
	reason := err.Error()
	if errors.As(err, &why) {
		reason = why.reason
	}
	fmt.Fprintf(w, "\n✗ %s did not come online: %s.\n", name, reason)
	if len(logLines) > 0 {
		fmt.Fprintln(w, "  Its log ends:")
		for _, line := range logLines {
			fmt.Fprintf(w, "    %s\n", line)
		}
	}
	fmt.Fprintln(w, "  Look further with:")
	for _, cmd := range svc.whereToLook() {
		fmt.Fprintf(w, "    %s\n", cmd)
	}
}

func atoiOr(s string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return fallback
}
