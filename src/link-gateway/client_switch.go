package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// The switch drill (scripts/runner-link/staging-check-switch.sh): the server's cut-over switch, RUNNER_LINK_REQUIRED,
// flipped by an administrator while a runner works (docs/runner-link-design.md §11.3, §11.4; mode.go). Switched on,
// the runner's HTTPS daemon calls are answered 426 UPGRADE_REQUIRED and the gateway tells it MODE_LINK, on the
// connection it has and on its next one, where it works. Switched off in the middle of a session's event stream, the
// gateway tells it MODE_HTTP and refuses its requests, and still stores the event batches it sends on that connection;
// the runner leaves the connection and sends the rest over HTTPS, resending the last batch whose acknowledgement it
// may have missed. The session's seqs end contiguous, each stored once. The switch is left off.

const (
	switchBatch  = 40 // events in a batch
	switchBefore = 3  // batches stored over the link before the switch goes off
	switchAfter  = 3  // batches sent on the same connection after it went off
	switchHTTPS  = 3  // batches sent over HTTPS once the runner left the connection
	// switchWithin bounds how long a change takes to reach the gateway (it reads the switch every second) and every
	// apiserver replica (each reads it at most a second after its last read).
	switchWithin = 15 * time.Second
)

func (d *driver) switchDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	own, err := newOwner(d.cl, o.ownerEmail, o.ownerPasswordFile)
	if !d.record("the owner signs in: the administrator who flips RUNNER_LINK_REQUIRED", err == nil, time.Now(), errString(err)) {
		return
	}
	flip := func(required bool) (string, error) {
		var view struct {
			Required  bool   `json:"required"`
			UpdatedAt string `json:"updatedAt"`
		}
		status, body, err := own.call("PUT", "/api/admin/runner-link-required", map[string]bool{"required": required}, &view)
		if err != nil || status != http.StatusOK || view.Required != required {
			return fmt.Sprintf("PUT /api/admin/runner-link-required %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		return fmt.Sprintf("PUT /api/admin/runner-link-required: required %v, switched at %s", view.Required, view.UpdatedAt), nil
	}

	// Off, whatever it was left in. Once the connection runDrill opened is told MODE_HTTP, the gateway has read it, and
	// the runner's next connection, its shadow's, opens in MODE_HTTP.
	if !d.step("off: the administrator switches it off", func() (string, error) { return flip(false) }) {
		return
	}
	if !d.step("off: the connection is told MODE_HTTP at its heartbeat", func() (string, error) {
		ack, err := d.beatUntil(linkpb.Mode_MODE_HTTP)
		if err != nil {
			return "", err
		}
		return summarizeAck(ack), nil
	}) {
		return
	}
	d.close()
	<-d.cc.done
	shadow, err := dialDriver(ctx, d.cl, d.report)
	if !d.record("off: the runner's shadow connects", err == nil, time.Now(), errString(err)) {
		return
	}
	if !shadow.step("off: welcomed in MODE_HTTP, and HTTPS serves the daemon", func() (string, error) {
		if m := shadow.cc.welcome.GetMode(); m != linkpb.Mode_MODE_HTTP {
			return m.String(), errors.New("want MODE_HTTP")
		}
		answer, _, err := d.httpsUntil(false)
		return "MODE_HTTP; GET /api/runner/me over HTTPS " + answer, err
	}) {
		return
	}

	// On.
	if !shadow.step("on: the administrator switches it on", func() (string, error) { return flip(true) }) {
		return
	}
	shadow.step("on: an HTTPS daemon call is answered 426 UPGRADE_REQUIRED, saying to run `orbit upgrade`", func() (string, error) {
		answer, waited, err := d.httpsUntil(true)
		if err != nil {
			return answer, err
		}
		return fmt.Sprintf("after %s: %s", waited.Round(time.Millisecond), answer), nil
	})
	shadow.step("on: the same call naming its caller (X-Orbit-Runner-Caller: cli) is served", func() (string, error) {
		status, body, err := d.daemonOverHTTPS("GET", "/api/runner/me", "cli", nil, nil)
		if err != nil || status != http.StatusOK {
			return fmt.Sprintf("%d %s", status, clip(string(body), 300)), errOr(err, "want 200")
		}
		return "GET /api/runner/me 200", nil
	})
	shadow.step("on: the shadow's connection, opened in MODE_HTTP, is told MODE_LINK at its heartbeat, and forwards nothing", func() (string, error) {
		ack, err := shadow.beatUntil(linkpb.Mode_MODE_LINK)
		if err != nil {
			return "", err
		}
		if len(ack.GetReconcileJson()) != 0 {
			return summarizeAck(ack), errors.New("the beat was reconciled: it was forwarded")
		}
		r, err := shadow.rpc(shadow.nextID("me"), "GET", "/runner/me", nil, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetFailure().GetCode() != "LINK_MODE_HTTP" {
			return tunnelStatus(r), errors.New("want LINK_MODE_HTTP: a connection opened in MODE_HTTP forwards nothing")
		}
		return summarizeAck(ack) + "; a request: " + tunnelStatus(r), nil
	})

	// The shadow stands down and the runner opens its work connection, as a runner moving onto the link does.
	shadow.close()
	<-shadow.cc.done
	work, err := dialDriver(ctx, d.cl, d.report)
	if !d.record("on: the runner opens its work connection", err == nil, time.Now(), errString(err)) {
		return
	}
	defer work.close()
	f["workConnection"] = work.cc.id
	if !work.step("on: welcomed in MODE_LINK, its heartbeat forwarded and reconciled", func() (string, error) {
		if m := work.cc.welcome.GetMode(); m != linkpb.Mode_MODE_LINK {
			return m.String(), errors.New("want MODE_LINK: is the gateway pinned with LINK_MODE=http and LINK_INTERNAL_API_URLS set?")
		}
		ack, err := work.heartbeat(work.beat(true))
		if err != nil {
			return "", err
		}
		if ack.GetMode() != linkpb.Mode_MODE_LINK {
			return summarizeAck(ack), errors.New("want MODE_LINK")
		}
		return checkReconciled(ack)
	}) {
		return
	}
	sid, claimed, ok := work.leasedSession(own, o, "switch drill")
	if !ok {
		return
	}
	f["session"], f["sessionUuid"] = claimed.SessionID, sid
	next := claimed.MaxSeq + 1
	var acked uint64
	stream := func(drv *driver, batches int) (string, error) {
		for i := 0; i < batches; i++ {
			ack, err := drv.events(drv.batch(sid, next, next+switchBatch-1, "assistant", 0), 30*time.Second)
			if err != nil {
				return "", err
			}
			if ack.GetFailure() != nil || ack.GetDurableSeq() != next+switchBatch-1 {
				return summarizeEventAck(ack), errors.New("want the batch stored")
			}
			acked = ack.GetDurableSeq()
			next += switchBatch
		}
		return fmt.Sprintf("durable_seq %d", acked), nil
	}
	if !work.step(fmt.Sprintf("on: %d batches of %d events stored over the link and acknowledged", switchBefore, switchBatch), func() (string, error) {
		return stream(work, switchBefore)
	}) {
		return
	}
	f["ackedBeforeOff"] = acked

	// Off, in the middle of the stream.
	if !work.step("off in the middle of the stream: the administrator switches it off", func() (string, error) { return flip(false) }) {
		return
	}
	work.step("off: the work connection is told MODE_HTTP at its heartbeat, with nothing to apply", func() (string, error) {
		ack, err := work.beatUntil(linkpb.Mode_MODE_HTTP)
		if err != nil {
			return "", err
		}
		if len(ack.GetReconcileJson()) != 0 {
			return summarizeAck(ack), errors.New("the beat was reconciled: a beat answered MODE_HTTP is sent again over HTTPS, so it must not be forwarded")
		}
		return summarizeAck(ack), nil
	})
	work.step("off: its requests are refused LINK_MODE_HTTP, without reaching the server", func() (string, error) {
		r, err := work.rpc(work.nextID("me"), "GET", "/runner/me", nil, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetFailure().GetCode() != "LINK_MODE_HTTP" {
			return tunnelStatus(r), errors.New("want LINK_MODE_HTTP")
		}
		return tunnelStatus(r), nil
	})
	work.step(fmt.Sprintf("off: the %d batches it still sends on that connection are stored and acknowledged", switchAfter), func() (string, error) {
		return stream(work, switchAfter)
	})
	f["ackedOnTheLink"] = acked
	work.step("off: HTTPS serves the daemon again", func() (string, error) {
		answer, waited, err := d.httpsUntil(false)
		if err != nil {
			return answer, err
		}
		return fmt.Sprintf("after %s: %s", waited.Round(time.Millisecond), answer), nil
	})

	// The runner leaves the connection; the rest of the stream goes over HTTPS, from the last batch whose
	// acknowledgement it might have missed.
	work.close()
	<-work.cc.done
	work.step(fmt.Sprintf("the runner leaves the connection: the last batch again, then %d more, over HTTPS", switchHTTPS), func() (string, error) {
		from := acked - switchBatch + 1
		end := acked + switchHTTPS*switchBatch
		for start := from; start <= end; start += switchBatch {
			body := eventsRequestBody(work.batch(sid, start, start+switchBatch-1, "assistant", 0), d.cl.o.processID)
			status, answer, err := d.daemonOverHTTPS("POST", "/api/runner/sessions/"+claimed.SessionID+"/events", "", body, nil)
			if err != nil || status/100 != 2 {
				return fmt.Sprintf("seqs %d..%d: %d %s", start, start+switchBatch-1, status, clip(string(answer), 300)), errOr(err, "want 2xx")
			}
		}
		next = end + 1
		return fmt.Sprintf("seqs %d..%d posted", from, end), nil
	})
	final := next - 1
	f["finalSeq"] = final
	work.step("the session's stored events: every seq from 1 to the last, once, with no gap", func() (string, error) {
		seqs, err := d.storedSeqsOverHTTPS(claimed.SessionID)
		if err != nil {
			return "", err
		}
		for i, s := range seqs {
			if s != uint64(i)+1 {
				return fmt.Sprintf("%d events, seq %d at %d", len(seqs), s, i+1), errors.New("a seq is missing, out of place or stored twice")
			}
		}
		if uint64(len(seqs)) != final {
			return fmt.Sprintf("%d events stored", len(seqs)), fmt.Errorf("want %d", final)
		}
		return fmt.Sprintf("seqs 1..%d", len(seqs)), nil
	})

	again, err := dialDriver(ctx, d.cl, d.report)
	if !d.record("off: a new connection", err == nil, time.Now(), errString(err)) {
		return
	}
	defer again.close()
	again.step("off: welcomed in MODE_HTTP", func() (string, error) {
		if m := again.cc.welcome.GetMode(); m != linkpb.Mode_MODE_HTTP {
			return m.String(), errors.New("want MODE_HTTP")
		}
		return "MODE_HTTP", nil
	})
}

// beatUntil sends heartbeats on the connection until one is answered with mode, within switchWithin: the gateway reads
// the switch every second.
func (d *driver) beatUntil(mode linkpb.Mode) (*linkpb.HeartbeatAck, error) {
	deadline := time.Now().Add(switchWithin)
	for {
		ack, err := d.heartbeat(d.beat(true))
		if err != nil {
			return nil, err
		}
		if ack.GetMode() == mode {
			return ack, nil
		}
		if time.Now().After(deadline) {
			return ack, fmt.Errorf("still told %s after %s", ack.GetMode(), switchWithin)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// httpsUntil calls GET /api/runner/me over HTTPS as the daemon does until it is answered UPGRADE_REQUIRED (refused) or
// served, within switchWithin: each apiserver replica reads the switch at most a second after its last read.
func (d *driver) httpsUntil(refused bool) (string, time.Duration, error) {
	started := time.Now()
	for {
		status, body, err := d.daemonOverHTTPS("GET", "/api/runner/me", "", nil, nil)
		if err != nil {
			return "", time.Since(started), err
		}
		var answer struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &answer)
		upgrade := status == http.StatusUpgradeRequired && answer.Code == "UPGRADE_REQUIRED"
		if upgrade && !strings.Contains(answer.Message, "orbit upgrade") {
			return clip(string(body), 300), time.Since(started), errors.New("the answer does not say to run `orbit upgrade`")
		}
		if upgrade == refused && (refused || status == http.StatusOK) {
			return fmt.Sprintf("%d %s", status, clip(string(body), 300)), time.Since(started), nil
		}
		if time.Since(started) > switchWithin {
			return fmt.Sprintf("%d %s", status, clip(string(body), 300)), time.Since(started), fmt.Errorf("not within %s", switchWithin)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// daemonOverHTTPS is one call with the runner token over HTTPS, as the daemon makes it, or naming caller in
// X-Orbit-Runner-Caller as `orbit mcp`, the Antigravity hook and the CLI do.
func (d *driver) daemonOverHTTPS(method, path, caller string, in, out any) (int, []byte, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, d.cl.o.api+path, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+d.cl.o.runnerToken)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if caller != "" {
		req.Header.Set("X-Orbit-Runner-Caller", caller)
	}
	resp, err := d.cl.api.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if out != nil && resp.StatusCode/100 == 2 {
		if err := json.Unmarshal(b, out); err != nil {
			return resp.StatusCode, b, err
		}
	}
	return resp.StatusCode, b, nil
}

// storedSeqsOverHTTPS is storedSeqs read over HTTPS, as a runner whose link is in MODE_HTTP reads its transcript.
func (d *driver) storedSeqsOverHTTPS(session string) ([]uint64, error) {
	var seqs []uint64
	after := uint64(0)
	for {
		var page struct {
			Events []struct {
				Seq uint64 `json:"seq"`
			} `json:"events"`
			HasMore bool `json:"hasMore"`
		}
		status, body, err := d.daemonOverHTTPS("GET", fmt.Sprintf("/api/runner/sessions/%s/events?after=%d&limit=1000", session, after), "", nil, &page)
		if err != nil || status != http.StatusOK {
			return nil, fmt.Errorf("reading the events: %d %s %v", status, clip(string(body), 300), err)
		}
		for _, e := range page.Events {
			seqs = append(seqs, e.Seq)
			after = e.Seq
		}
		if !page.HasMore || len(page.Events) == 0 {
			return seqs, nil
		}
	}
}
