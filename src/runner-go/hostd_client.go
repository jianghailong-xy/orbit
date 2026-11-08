package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"time"
)

// The client half of the hostd protocol: how a user's `orbit` asks the machine broker
// to act on their own runner. A call is a verb and nothing else — whose runner it lands
// on is the connection's peer credentials, which the caller cannot write and cannot
// forge (see hostdIdentityField). That is what makes register and unregister possible
// without root on a host where `orbit host setup` has been run.

// hostdCallTimeout bounds reaching the broker: connecting and handing it the request, and
// how long its answer may take before the client says it is waiting. A broker that is not
// there must not wedge `orbit register` along with it: the legacy sudo path is still
// there, and reaching it a few seconds late beats not reaching it at all. A var rather
// than a const only so a test can drive the give-up path without sitting out five real
// seconds.
var hostdCallTimeout = 5 * time.Second

// hostdAnswerWait bounds the answer of a broker that took the request. Taking the
// account's older runners down drains each of them, for up to the TimeoutStopSec=180 of
// its unit, and enable then restarts the instance, which drains it too if it runs: up to
// four drains one after another (orbit-runner@<uid>, orbit-runner-<user>, the bare
// orbit-runner, the instance), so a quarter of an hour covers the worst case with room to
// spare. A broker that is still working is never gone around: the sudo path would install
// a unit of its own beside the instance hostd is about to start. A var only so a test can
// drive the give-up path in milliseconds.
var hostdAnswerWait = 15 * time.Minute

// hostdNoAnswer is the client's own code for a broker that took the request and gave no
// answer within hostdAnswerWait. It may still be carrying the request out, so the caller
// stops there, as at the broker's refusals that stop register (hostdStopsRegister).
const hostdNoAnswer = "no-answer"

// hostdCall performs one exchange against the broker listening at socketPath: connect,
// send {"v":1,"verb":...}, read the one response, close. socketPath is a parameter
// rather than the constant so a test can point it at a socket in a temp dir.
//
// An error means we never got an answer — no broker, or one that hung up mid-exchange.
// A request the broker understood and refused comes back as a response with OK false
// and its own reason instead. Callers have to read both, and both mean the same thing
// to them: this did not happen, fall back. Except for a broker that took the request
// and is still working on it: that one is waited for, saying so after hostdCallTimeout,
// and one that has not answered after hostdAnswerWait comes back as a response with
// OK false and the code hostdNoAnswer, never as an error to fall back on.
func hostdCall(socketPath, verb string) (hostdResponse, error) {
	conn, err := net.DialTimeout("unix", socketPath, hostdCallTimeout)
	if err != nil {
		return hostdResponse{}, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(hostdCallTimeout))

	if err := json.NewEncoder(conn).Encode(hostdRequest{V: hostdProtocolVersion, Verb: verb}); err != nil {
		return hostdResponse{}, fmt.Errorf("cannot send %q: %w", verb, err)
	}
	// The first byte of the answer is waited for apart from the rest, so that a deadline
	// that passes while the broker is busy leaves nothing half-read behind it.
	answer := bufio.NewReader(conn)
	if _, err := answer.Peek(1); err != nil {
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			return hostdResponse{}, fmt.Errorf("no answer to %q: %w", verb, err)
		}
		fmt.Printf("    Waiting for the machine broker to finish %q — it may be draining an older runner, which takes up to 3 minutes (giving up after %s)…\n", verb, hostdAnswerWait)
		_ = conn.SetDeadline(time.Now().Add(hostdAnswerWait))
		if _, err := answer.Peek(1); err != nil {
			if !errors.As(err, &timeout) || !timeout.Timeout() {
				return hostdResponse{}, fmt.Errorf("no answer to %q: %w", verb, err)
			}
			resp := hostdFail("the machine broker at %s took %q and has not answered within %s. It may still be carrying it out, so this stops here rather than go around it. See `systemctl status orbit-hostd.service`, then run this again.", socketPath, verb, hostdAnswerWait)
			resp.Code = hostdNoAnswer
			return resp, nil
		}
	}
	var resp hostdResponse
	if err := json.NewDecoder(answer).Decode(&resp); err != nil {
		return hostdResponse{}, fmt.Errorf("no answer to %q: %w", verb, err)
	}
	return resp, nil
}

// hostdStopsRegister names the codes a register or unregister stops at, with the broker's
// reason printed and no sudo fallback: enable's refusal of an account with no copy of its
// own (hostdRefusedOwnCopy), enable's and disable's of an older runner unit that could not
// be taken down (hostdRefusedOlderRunner), and a broker still working on the request
// (hostdNoAnswer). The sudo path is no way around any of them: on a host set up for
// instances it installs a unit of its own beside the template, and the account would have
// two runners.
var hostdStopsRegister = map[string]bool{hostdRefusedOwnCopy: true, hostdRefusedOlderRunner: true, hostdNoAnswer: true}

// hostdDo asks the broker for one verb and reports whether it actually carried it out,
// printing why when it did not. Not getting it done is never fatal here: every caller
// has the legacy sudo path left to try, and registration must not dead-end on a broker
// that is missing or unwell. The answers that are not a cue to fall back are the ones in
// hostdStopsRegister: no note is printed for them, and the caller hands the broker's
// reason on instead.
func hostdDo(socketPath, verb string) (hostdResponse, bool) {
	// No socket at all is the ordinary state of a machine nobody ran `orbit host setup`
	// on, which is most of them. That is not news, so it is not printed — the legacy
	// path is simply what this machine does. A socket that exists and still cannot be
	// talked to *is* news, and says so below.
	if _, err := os.Stat(socketPath); err != nil {
		return hostdResponse{}, false
	}
	resp, err := hostdCall(socketPath, verb)
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "note: the machine broker at %s did not answer %q (%v) — falling back to the sudo path.\n", socketPath, verb, err)
		return resp, false
	case !resp.OK && hostdStopsRegister[resp.Code]:
		return resp, false
	case !resp.OK:
		fmt.Fprintf(os.Stderr, "note: the machine broker refused %q (%s) — falling back to the sudo path.\n", verb, resp.Error)
		return resp, false
	}
	return resp, true
}

// hostdRegisterRefusal is the broker's answer that registration stops at
// (hostdStopsRegister), in the broker's words: what is in the way, and what puts it right.
type hostdRegisterRefusal struct{ code, reason string }

func (e *hostdRegisterRefusal) Error() string { return e.reason }

// registerViaHostd asks the broker to enable and start this user's runner instance, and
// returns the unit it started, or "" when it did not, with the answer registration has to
// stop at (hostdRegisterRefusal), if that was the reason. The credential the instance will read was already
// written by `orbit register` itself, as this user, before we got here — so there is
// nothing left that needs root, and nothing here shells out at all.
func registerViaHostd(socketPath string, proxyVars []envVar) (string, error) {
	resp, ok := hostdDo(socketPath, "enable")
	if !ok {
		if hostdStopsRegister[resp.Code] {
			return "", &hostdRegisterRefusal{code: resp.Code, reason: resp.Error}
		}
		return "", nil
	}
	unit := hostdUnit(resp)
	if len(proxyVars) > 0 {
		// The legacy path bakes the proxy into a unit it writes for this one user. The
		// broker's template is shared by every uid on the host and carries no per-user
		// Environment=, so say so rather than let the runner come up unproxied and
		// leave the user to work out why nothing reaches the control plane.
		fmt.Fprintf(os.Stderr, "note: --proxy is not carried into %s — the machine's shared runner template has no per-user proxy environment.\n", unit)
	}
	return unit, nil
}

// unregisterViaHostd asks the broker to stop and disable this user's runner instance. An
// answer in hostdStopsRegister — an older runner unit of the account that could not be
// taken down, or a broker still working — is printed and taken as handled: the sudo
// removal would remove the unit file of a unit that is still running.
func unregisterViaHostd(socketPath string) bool {
	resp, ok := hostdDo(socketPath, "disable")
	if !ok && hostdStopsRegister[resp.Code] {
		fmt.Fprintf(os.Stderr, "✗ %s\n", resp.Error)
		return true
	}
	if !ok {
		return false
	}
	fmt.Printf("✓ removed the %s runner service\n", hostdUnit(resp))
	return true
}

// hostdUnit is the unit the broker says it acted on. Its answer, not a guess of ours:
// hostd derives the instance from the caller's kernel-attested uid, so what it reports
// back is the name the user should actually point systemctl at. The guess is only for a
// response that left the field out, and reads the machine's template as hostd does.
func hostdUnit(resp hostdResponse) string {
	if unit, _ := resp.Data["unit"].(string); unit != "" {
		return unit
	}
	if u, err := user.Current(); err == nil && (hostdSystem{unitDir: systemdUnitDir}).namesInstances() {
		return unitForAccount(u.Username)
	}
	return unitForUid(uint32(os.Getuid()))
}
