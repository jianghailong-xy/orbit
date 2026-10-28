package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// The relay drills (scripts/runner-link/staging-check-relay.sh): what a person's request leaves in one apiserver
// process's memory reaches this runner over the link whichever process its calls are forwarded to
// (src/apiserver/src/runners/relay-peers.ts). The stack runs two apiservers; the web's requests reach the first, and the
// script points the gateway at the second alone, so every heartbeat and report of this runner lands on a process that
// does not hold the code or the key. Pointed at both, the same drill runs with its calls going round robin.
//
//	relay         an Antigravity sign-in started and its code pasted through the web API, then handed over by a heartbeat,
//	              once, for its attempt; a Cursor key checked through the web API, handed over by a heartbeat once, and the
//	              runner's answer settling the check the owner waits on: sent over HTTPS, as a runner sends it, or with
//	              -relay-handshake handed to the script (PATH.answer), which posts it to the second apiserver itself.
//	relay-begin   an Antigravity sign-in started and its Google link reported, for the script to paste a code into.
//	relay-finish  the code the script pasted, collected by this runner's heartbeats, once; with -relay-slow-holder the
//	              first heartbeat is answered at once without it, while the process holding it is paused, and the code
//	              comes after the nudge the asking process sends once the late answer reaches it. It calls nothing on the
//	              web's apiserver once connected, so the script can pause that one (-relay-handshake).
//
// The code and the key come from -relay-secrets, a file the script also greps the stack's logs and database for
// afterwards. Nothing here writes either into the report or the log: a step says how long they were and whether they
// matched.

// relayCapabilities are what a runner that relays Antigravity's Google sign-in and checks Cursor keys declares
// (src/apiserver/src/common/antigravity-readiness.ts, src/apiserver/src/providers/cursor-key-check-relay.ts).
var relayCapabilities = []string{"antigravity-google-login/v1", "cursor-key-check/v1"}

// relaySecrets is -relay-secrets: the Antigravity code the owner pastes and the Cursor key the owner checks.
type relaySecrets struct {
	Code string `json:"code"`
	Key  string `json:"key"`
}

func readRelaySecrets(file string) (relaySecrets, error) {
	var s relaySecrets
	if file == "" {
		return s, errors.New("-relay-secrets is required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil || s.Code == "" {
		return s, errors.New("-relay-secrets names no code")
	}
	return s, nil
}

// beatAnswer is what the relay drills read of the heartbeat route's answer (HeartbeatAck.reconcile_json).
type beatAnswer struct {
	LoginRequest *struct {
		Action  string `json:"action"`
		Engine  string `json:"engine"`
		Code    string `json:"code"`
		Attempt string `json:"attempt"`
	} `json:"loginRequest"`
	CursorKeyChecks []struct {
		CheckID string `json:"checkId"`
		APIKey  string `json:"apiKey"`
	} `json:"cursorKeyChecks"`
}

// relayEngines is the engines fact of a runner with the pinned Cursor CLI installed, which a key check is asked of
// (cursorKeyCheckers).
func relayEngines() *linkpb.Fact {
	return drillFact("engines", []map[string]any{
		{"engine": "claude", "installed": true, "version": "2.3.0 (link drill)", "auth": "yes"},
		{"engine": "cursor", "installed": true, "version": "2026.10.14-941492e", "auth": "unknown"},
	})
}

// relayBeat sends one heartbeat with every fact whole and reads its answer; a beat the gateway could not forward reads as
// one with nothing in it.
func (d *driver) relayBeat() (beatAnswer, *linkpb.HeartbeatAck, error) {
	var a beatAnswer
	ack, err := d.heartbeat(d.beat(true))
	if err != nil {
		return a, nil, err
	}
	if len(ack.GetReconcileJson()) > 0 {
		if err := json.Unmarshal(ack.GetReconcileJson(), &a); err != nil {
			return a, ack, fmt.Errorf("reconcile_json: %w", err)
		}
	}
	return a, ack, nil
}

// relayBeatUntil heartbeats until an answer satisfies want, or within: at once after a commands hint (a wake, or the nudge of
// a process that came to hold something late), else every second.
func (d *driver) relayBeatUntil(within time.Duration, want func(beatAnswer) bool) (beatAnswer, int, error) {
	end := time.Now().Add(within)
	for beats := 1; ; beats++ {
		a, _, err := d.relayBeat()
		if err == nil && want(a) {
			return a, beats, nil
		}
		if time.Now().After(end) {
			return a, beats, fmt.Errorf("not within %s (%d heartbeats, the last: %v)", within, beats, errOr(err, "nothing for this runner"))
		}
		_, _ = d.waitHint(time.Second, func(h *linkpb.Hint) bool { return h.GetCommands() != nil })
	}
}

// relayStart connects the drill's facts, signs the owner in and starts an Antigravity sign-in on this runner up to its
// Google link: the attempt, or "" when a step failed.
func (d *driver) relayStart(o drillOptions) (*owner, string) {
	if !d.step("welcome: MODE_LINK", func() (string, error) {
		if mode := d.cc.welcome.GetMode(); mode != linkpb.Mode_MODE_LINK {
			return mode.String(), errors.New("the gateway is not in MODE_LINK: start the stack with ORBIT_LINK_STAGING_MODE=link")
		}
		return "declaring " + strings.Join(relayCapabilities, ", "), nil
	}) {
		return nil, ""
	}
	d.beat(true)
	d.facts["engines"] = relayEngines()
	if !d.step("heartbeat: every fact whole, Cursor CLI installed, reconciled by the heartbeat route", func() (string, error) {
		ack, err := d.heartbeat(d.beat(true))
		if err != nil {
			return "", err
		}
		return checkReconciled(ack)
	}) {
		return nil, ""
	}
	own, err := newOwner(d.cl, o.ownerEmail, o.ownerPasswordFile)
	if !d.record("the owner signs in", err == nil, time.Now(), errString(err)) {
		return nil, ""
	}
	if !d.step("the owner starts an Antigravity sign-in on this runner, through the web API", func() (string, error) {
		var state struct {
			Status string `json:"status"`
		}
		status, body, err := own.call("POST", "/api/runners/"+d.runnerID+"/login", map[string]any{"engine": "antigravity"}, &state)
		if err != nil || status/100 != 2 || state.Status != "pending" {
			return fmt.Sprintf("POST /api/runners/:id/login %d %s", status, clip(string(body), 300)), errOr(err, "want 2xx, pending")
		}
		return "pending", nil
	}) {
		return nil, ""
	}
	var attempt string
	if !d.step("a heartbeat hands the start over", func() (string, error) {
		a, beats, err := d.relayBeatUntil(15*time.Second, func(a beatAnswer) bool {
			return a.LoginRequest != nil && a.LoginRequest.Action == "start" && a.LoginRequest.Engine == "antigravity"
		})
		if err != nil {
			return "", err
		}
		attempt = a.LoginRequest.Attempt
		d.report.Facts["attempt"] = attempt
		return fmt.Sprintf("loginRequest{start, antigravity, attempt %s} after %d heartbeat(s)", attempt, beats), nil
	}) {
		return nil, ""
	}
	if !d.step("the runner reports the Google link, awaiting its code", func() (string, error) {
		return d.loginResult(map[string]any{"status": "awaiting_code", "url": "https://accounts.google.com/o/oauth2/auth?client_id=link-relay-drill", "attempt": attempt})
	}) {
		return nil, ""
	}
	return own, attempt
}

// loginResult is POST /runner/login-result, as the runner sends it: applied, or why not.
func (d *driver) loginResult(body map[string]any) (string, error) {
	b, _ := json.Marshal(body)
	r, err := d.rpc(d.nextID("login"), "POST", "/runner/login-result", b, "", 0)
	if err != nil {
		return "", err
	}
	var out struct {
		Applied bool `json:"applied"`
	}
	if r.GetTunnel().GetStatus() != http.StatusOK || json.Unmarshal(r.GetTunnel().GetJsonBody(), &out) != nil || !out.Applied {
		return tunnelStatus(r), errors.New("want 200, applied")
	}
	return fmt.Sprintf("%s: applied", body["status"]), nil
}

// codeHandedOver is the step that collects the pasted code: once, for the attempt.
func (d *driver) codeHandedOver(secrets relaySecrets, attempt string, within time.Duration) bool {
	return d.step("a heartbeat, forwarded to a process that does not hold the code, hands it over for its attempt", func() (string, error) {
		started := time.Now()
		a, beats, err := d.relayBeatUntil(within, func(a beatAnswer) bool { return a.LoginRequest != nil && a.LoginRequest.Action == "code" })
		if err != nil {
			return "", err
		}
		l := a.LoginRequest
		detail := fmt.Sprintf("loginRequest{code, %s, attempt %s, a code of %d bytes} after %d heartbeat(s), %d ms", l.Engine, l.Attempt, len(l.Code),
			beats, time.Since(started).Milliseconds())
		if l.Code != secrets.Code || l.Attempt != attempt || l.Engine != "antigravity" {
			return detail, errors.New("not the code pasted, or not for this attempt")
		}
		return detail + ": the code pasted", nil
	}) && d.step("never twice: the next heartbeat hands nothing over", func() (string, error) {
		a, _, err := d.relayBeat()
		if err != nil {
			return "", err
		}
		if a.LoginRequest != nil {
			return "loginRequest{" + a.LoginRequest.Action + "}", errors.New("handed over again")
		}
		return "no loginRequest", nil
	}) && d.step("the runner reports the sign-in done", func() (string, error) {
		return d.loginResult(map[string]any{"status": "done", "attempt": attempt})
	})
}

func (d *driver) relayDrill(ctx context.Context, o drillOptions) {
	secrets, err := readRelaySecrets(o.relaySecrets)
	if !d.record("the code and the key to hand over", err == nil && secrets.Key != "", time.Now(), errString(errOr(err, "-relay-secrets names no key"))) {
		return
	}
	own, attempt := d.relayStart(o)
	if own == nil {
		return
	}
	if !d.step("the owner pastes the code through the web API, to the process the web reaches", func() (string, error) {
		status, body, err := own.call("POST", "/api/runners/"+d.runnerID+"/login/code", map[string]any{"code": secrets.Code}, nil)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST /api/runners/:id/login/code %d", status), errOr(err, "refused")
		}
		if strings.Contains(string(body), secrets.Code) {
			return "", errors.New("the answer carries the code")
		}
		return fmt.Sprintf("%d, the code not in the answer", status), nil
	}) {
		return
	}
	if !d.codeHandedOver(secrets, attempt, 20*time.Second) {
		return
	}

	// A Cursor key checked through the web API, which waits for this runner's answer.
	type checked struct {
		status int
		body   []byte
		err    error
	}
	done := make(chan checked, 1)
	go func() {
		var c checked
		c.status, c.body, c.err = own.call("POST", "/api/providers/test", map[string]any{"baseUrl": "https://api2.cursor.sh", "apiKey": secrets.Key, "runtime": "cursor"}, nil)
		done <- c
	}()
	var checkID string
	if !d.step("the owner checks a Cursor key through the web API; a heartbeat, forwarded to a process that does not hold it, hands it over", func() (string, error) {
		started := time.Now()
		a, beats, err := d.relayBeatUntil(20*time.Second, func(a beatAnswer) bool { return len(a.CursorKeyChecks) > 0 })
		if err != nil {
			return "", err
		}
		c := a.CursorKeyChecks[0]
		checkID = c.CheckID
		d.report.Facts["checkId"] = checkID
		detail := fmt.Sprintf("cursorKeyChecks[%d]{check %s, a key of %d bytes} after %d heartbeat(s), %d ms", len(a.CursorKeyChecks), c.CheckID,
			len(c.APIKey), beats, time.Since(started).Milliseconds())
		if len(a.CursorKeyChecks) != 1 || c.APIKey != secrets.Key {
			return detail, errors.New("not the key checked, or more than one")
		}
		return detail + ": the key checked", nil
	}) {
		return
	}
	if !d.step("never twice: the next heartbeat hands no key over", func() (string, error) {
		a, _, err := d.relayBeat()
		if err != nil {
			return "", err
		}
		if len(a.CursorKeyChecks) > 0 {
			return fmt.Sprintf("cursorKeyChecks[%d]", len(a.CursorKeyChecks)), errors.New("handed over again")
		}
		return "no cursorKeyChecks", nil
	}) {
		return
	}
	// The answer is not a daemon route (it is served beside the agent tool API, D14), so a runner sends it over HTTPS, which
	// reaches the web's apiserver. With -relay-handshake the script posts it to the second apiserver's own listener
	// instead, as HTTPS spread over every process would: the process that takes it does not wait on the check.
	sum := sha256.Sum256([]byte(strings.TrimSpace(secrets.Key)))
	answer := map[string]string{"checkId": checkID, "state": "INVALID", "keyFingerprint": hex.EncodeToString(sum[:])[:16]}
	if o.relayHandshake != "" {
		if !d.step("the runner's answer goes to the script, which posts it to the apiserver that does not wait on the check", func() (string, error) {
			b, _ := json.Marshal(answer)
			if err := os.WriteFile(o.relayHandshake+".answer", b, 0o600); err != nil {
				return "", err
			}
			return "check " + checkID + ": INVALID", nil
		}) {
			return
		}
	} else if !d.step("the runner's answer, over HTTPS as a runner sends it, settles the check", func() (string, error) {
		var out struct {
			Accepted bool `json:"accepted"`
		}
		status, body, err := d.daemonOverHTTPS("POST", "/api/runner/cursor-key-check-result", "", answer, &out)
		if err != nil || status != http.StatusOK || !out.Accepted {
			return fmt.Sprintf("POST /api/runner/cursor-key-check-result %d %s", status, clip(string(body), 300)), errOr(err, "want 200, accepted")
		}
		return "INVALID: accepted", nil
	}) {
		return
	}
	d.step("the owner's check answers what the runner said", func() (string, error) {
		var c checked
		select {
		case c = <-done:
		case <-time.After(40 * time.Second):
			return "", errors.New("the owner's check never answered")
		}
		var answer struct {
			OK       bool   `json:"ok"`
			KeyCheck string `json:"keyCheck"`
		}
		if c.err != nil || c.status/100 != 2 || json.Unmarshal(c.body, &answer) != nil {
			return fmt.Sprintf("POST /api/providers/test %d", c.status), errOr(c.err, "refused")
		}
		detail := fmt.Sprintf("ok %v, keyCheck %s", answer.OK, answer.KeyCheck)
		if strings.Contains(string(c.body), secrets.Key) {
			return "", errors.New("the answer carries the key")
		}
		if answer.KeyCheck != "INVALID" {
			return detail, errors.New("want keyCheck INVALID, as the runner answered")
		}
		return detail, nil
	})
}

func (d *driver) relayBeginDrill(ctx context.Context, o drillOptions) {
	d.relayStart(o)
}

func (d *driver) relayFinishDrill(ctx context.Context, o drillOptions) {
	secrets, err := readRelaySecrets(o.relaySecrets)
	if !d.record("the code to collect", err == nil && o.relayAttempt != "", time.Now(), errString(errOr(err, "-relay-attempt is required"))) {
		return
	}
	d.beat(true)
	d.facts["engines"] = relayEngines()
	// Connected, which takes the web's apiserver (the link token): the script may pause it from here on.
	if o.relayHandshake != "" && !d.step("connected; the script readies the apiservers", func() (string, error) {
		if err := os.WriteFile(o.relayHandshake+".ready", nil, 0o600); err != nil {
			return "", err
		}
		for end := time.Now().Add(60 * time.Second); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
			if _, err := os.Stat(o.relayHandshake + ".go"); err == nil {
				return "go", nil
			}
		}
		return "", errors.New("the script never said go")
	}) {
		return
	}
	within := 30 * time.Second
	if o.relaySlowHolder {
		if !d.step("the process holding the code is paused: a heartbeat is answered within its bound, without the code", func() (string, error) {
			started := time.Now()
			a, _, err := d.relayBeat()
			took := time.Since(started)
			if err != nil {
				return "", err
			}
			detail := fmt.Sprintf("answered in %d ms", took.Milliseconds())
			if a.LoginRequest != nil && a.LoginRequest.Action == "code" {
				return detail, errors.New("the code came while its holder was paused")
			}
			if took > 3*time.Second {
				return detail, errors.New("the heartbeat waited on the paused process")
			}
			return detail + ", no code", nil
		}) {
			return
		}
		if !d.step("once the holder answers late, the process that asked holds the code and nudges this runner", func() (string, error) {
			started := time.Now()
			_, err := d.waitHint(30*time.Second, func(h *linkpb.Hint) bool { return h.GetCommands() != nil })
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Hint{commands} %d ms after the first heartbeat", time.Since(started).Milliseconds()), nil
		}) {
			return
		}
		within = 5 * time.Second
	}
	d.codeHandedOver(secrets, o.relayAttempt, within)
}
