package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"
)

// The client half of the hostd protocol: how a user's `orbit` asks the machine broker
// to act on their own runner. A call is a verb and nothing else — whose runner it lands
// on is the connection's peer credentials, which the caller cannot write and cannot
// forge (see hostdIdentityField). That is what makes register and unregister possible
// without root on a host where `orbit host setup` has been run.

// hostdCallTimeout bounds one exchange. A broker that is wedged must not wedge
// `orbit register` along with it: the legacy sudo path is still there, and reaching it
// a few seconds late beats not reaching it at all.
const hostdCallTimeout = 5 * time.Second

// hostdCall performs one exchange against the broker listening at socketPath: connect,
// send {"v":1,"verb":...}, read the one response, close. socketPath is a parameter
// rather than the constant so a test can point it at a socket in a temp dir.
//
// An error means we never got an answer — no broker, or one that hung up mid-exchange.
// A request the broker understood and refused comes back as a response with OK false
// and its own reason instead. Callers have to read both, and both mean the same thing
// to them: this did not happen, fall back.
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
	var resp hostdResponse
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return hostdResponse{}, fmt.Errorf("no answer to %q: %w", verb, err)
	}
	return resp, nil
}

// hostdDo asks the broker for one verb and reports whether it actually carried it out,
// printing why when it did not. Not getting it done is never fatal here: every caller
// has the legacy sudo path left to try, and registration must not dead-end on a broker
// that is missing or unwell.
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
	case !resp.OK:
		fmt.Fprintf(os.Stderr, "note: the machine broker refused %q (%s) — falling back to the sudo path.\n", verb, resp.Error)
		return resp, false
	}
	return resp, true
}

// registerViaHostd asks the broker to enable and start this user's runner instance, and
// reports whether it did. The credential the instance will read was already written by
// `orbit register` itself, as this user, before we got here — so there is nothing left
// that needs root, and nothing here shells out at all.
func registerViaHostd(socketPath string, proxyVars []envVar) bool {
	resp, ok := hostdDo(socketPath, "enable")
	if !ok {
		return false
	}
	unit := hostdUnit(resp)
	fmt.Printf("\n✓ %s enabled and started — no root needed.\n"+
		"  Status:  systemctl status %s\n"+
		"  Logs:    journalctl -u %s -f\n", unit, unit, unit)
	if len(proxyVars) > 0 {
		// The legacy path bakes the proxy into a unit it writes for this one user. The
		// broker's template is shared by every uid on the host and carries no per-user
		// Environment=, so say so rather than let the runner come up unproxied and
		// leave the user to work out why nothing reaches the control plane.
		fmt.Fprintf(os.Stderr, "note: --proxy is not carried into %s — the machine's shared runner template has no per-user proxy environment.\n", unit)
	}
	return true
}

// unregisterViaHostd asks the broker to stop and disable this user's runner instance.
func unregisterViaHostd(socketPath string) bool {
	resp, ok := hostdDo(socketPath, "disable")
	if !ok {
		return false
	}
	fmt.Printf("✓ removed the %s runner service\n", hostdUnit(resp))
	return true
}

// hostdUnit is the unit the broker says it acted on. Its answer, not a guess of ours:
// hostd derives the instance from the caller's kernel-attested uid, so what it reports
// back is the name the user should actually point systemctl at. The guess is only for a
// response that left the field out.
func hostdUnit(resp hostdResponse) string {
	if unit, _ := resp.Data["unit"].(string); unit != "" {
		return unit
	}
	return unitForUid(uint32(os.Getuid()))
}
