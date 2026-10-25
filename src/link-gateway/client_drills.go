package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"orbit/link-gateway/linkpb"
)

// The drills themselves (client_link.go says what each one shows).

// claimedSession is what a claim answers with that the drills read (ClaimedSession, src/shared/src/dto.ts). Its
// sessionUuid is the engine's own session id, not the Orbit session's.
type claimedSession struct {
	SessionID  string `json:"sessionId"`
	MaxSeq     uint64 `json:"maxSeq"`
	LeaseOwner string `json:"leaseOwner"`
}

func (d *driver) linkDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	w := d.cc.welcome
	if !d.step("welcome: MODE_LINK, with credit", func() (string, error) {
		detail := fmt.Sprintf("mode %s, credit %d events / %d bytes, frames of at most %d bytes", w.GetMode(),
			w.GetCredit().GetMaxUnackedEvents(), w.GetCredit().GetMaxUnackedBytes(), w.GetLimits().GetMaxFrameBytes())
		if w.GetMode() != linkpb.Mode_MODE_LINK {
			return detail, errors.New("the gateway is not in MODE_LINK: start the stack with ORBIT_LINK_STAGING_MODE=link")
		}
		if w.GetCredit().GetMaxUnackedEvents() == 0 || w.GetLimits().GetMaxFrameBytes() != maxFrameBytes {
			return detail, errors.New("no credit, or another frame limit")
		}
		return detail, nil
	}) {
		return
	}

	// Heartbeats, reconciled by the heartbeat route; facts sent by digest once the gateway holds them.
	d.step("heartbeat: every fact whole, reconciled by the heartbeat route", func() (string, error) {
		ack, err := d.heartbeat(d.beat(true))
		if err != nil {
			return "", err
		}
		return checkReconciled(ack)
	})
	d.step("heartbeat: facts by digest, filled from what the connection holds", func() (string, error) {
		ack, err := d.heartbeat(d.beat(false))
		if err != nil {
			return "", err
		}
		if len(ack.GetWantFacts()) > 0 {
			return "", fmt.Errorf("the gateway asked for %v", ack.GetWantFacts())
		}
		return checkReconciled(ack)
	})
	d.step("heartbeat: a digest the connection does not hold is asked for whole, and that beat not forwarded", func() (string, error) {
		d.facts["reposRoot"] = drillFact("reposRoot", fmt.Sprintf("/srv/link-drill/repos-%d", time.Now().UnixNano()))
		ack, err := d.heartbeat(d.beat(false))
		if err != nil {
			return "", err
		}
		if strings.Join(ack.GetWantFacts(), ",") != "reposRoot" || len(ack.GetReconcileJson()) != 0 {
			return summarizeAck(ack), errors.New("want reposRoot asked for and nothing reconciled")
		}
		ack, err = d.heartbeat(d.beat(true))
		if err != nil {
			return "", err
		}
		detail, err := checkReconciled(ack)
		return "asked for [reposRoot], then " + detail, err
	})

	// A session, created by its owner on this runner: its claim hint, and the claim.
	own, err := newOwner(d.cl, o.ownerEmail, o.ownerPasswordFile)
	if !d.record("the owner signs in", err == nil, time.Now(), errString(err)) {
		return
	}
	var session, sid string
	if !d.step("the owner creates a session on this runner", func() (string, error) {
		var ws struct {
			ID string `json:"id"`
		}
		status, body, err := own.call("POST", "/api/workspaces", map[string]any{
			"name": "link drill " + time.Now().UTC().Format("2006-01-02T15:04:05Z"), "runnerId": d.runnerID, "workDir": o.workDir,
		}, &ws)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST /api/workspaces %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		var s struct {
			ID string `json:"id"`
		}
		status, body, err = own.call("POST", "/api/sessions", map[string]any{"workspaceId": ws.ID, "engine": "claude", "prompt": "link drill"}, &s)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST /api/sessions %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		session = s.ID
		f["workspace"], f["session"] = ws.ID, s.ID
		return "session " + s.ID + " in workspace " + ws.ID, nil
	}) {
		return
	}
	d.step("the claim hint reaches this runner over NATS and the gateway", func() (string, error) {
		_, err := d.waitHint(20*time.Second, func(h *linkpb.Hint) bool { return h.GetClaim() != nil })
		return "Hint{claim}", err
	})
	claimID := d.nextID("claim")
	var claimed claimedSession
	if !d.step("claim: forwarded with this runner's headers, answered with the session", func() (string, error) {
		r, err := d.rpc(claimID, "GET", "/runner/sessions/claim", nil, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetTunnel().GetStatus() != 200 || json.Unmarshal(r.GetTunnel().GetJsonBody(), &claimed) != nil {
			return tunnelStatus(r), errors.New("want 200 with the session claimed")
		}
		want, _ := sessionUUID(session)
		if got, _ := sessionUUID(claimed.SessionID); got != want {
			return tunnelStatus(r), errors.New("another session was claimed")
		}
		sid = want
		f["sessionUuid"], f["claimRequestId"] = sid, claimID
		return fmt.Sprintf("200, session %s, maxSeq %d", claimed.SessionID, claimed.MaxSeq), nil
	}) {
		return
	}
	d.step("claim sent again under the same request_id: the same session, and nothing else claimed", func() (string, error) {
		r, err := d.rpc(claimID, "GET", "/runner/sessions/claim", nil, "", 0)
		if err != nil {
			return "", err
		}
		var again claimedSession
		if r.GetTunnel().GetStatus() != 200 || json.Unmarshal(r.GetTunnel().GetJsonBody(), &again) != nil || again.SessionID != claimed.SessionID {
			return tunnelStatus(r), errors.New("want the session the first claim answered")
		}
		return "200, session " + again.SessionID, nil
	})
	d.step("claim under a new request_id: nothing more to claim, answered at once", func() (string, error) {
		started := time.Now()
		r, err := d.rpc(d.nextID("claim"), "GET", "/runner/sessions/claim", nil, "", 0)
		if err != nil {
			return "", err
		}
		var other claimedSession
		_ = json.Unmarshal(r.GetTunnel().GetJsonBody(), &other)
		took := time.Since(started)
		detail := fmt.Sprintf("%s in %s", tunnelStatus(r), took.Round(time.Millisecond))
		if r.GetTunnel().GetStatus() != 200 || other.SessionID != "" {
			return detail, errors.New("want 200 claiming nothing")
		}
		if took > 5*time.Second {
			return detail, errors.New("a link claim waited instead of answering at once")
		}
		return detail, nil
	})

	// The session's leases, for this process, as a runner takes them over and activates them once it has claimed
	// (src/runner-go/transport.go takeoverClaimedSession, activateTurnLeases).
	generation := newUUID()
	d.step("take over and activate the session's leases for this process: POSTs forwarded, their answers relayed", func() (string, error) {
		var expected any
		if claimed.LeaseOwner != "" {
			expected = claimed.LeaseOwner
		}
		takeover, _ := json.Marshal(map[string]any{"leaseOwner": d.cl.o.processID, "expectedLeaseOwner": expected})
		r, err := d.rpc(d.nextID("takeover"), "POST", "/runner/sessions/"+claimed.SessionID+"/takeover-leases", takeover, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetTunnel().GetStatus()/100 != 2 {
			return "takeover " + tunnelStatus(r), errors.New("want 2xx")
		}
		detail := "takeover " + tunnelStatus(r)
		body, _ := json.Marshal(map[string]string{"leaseOwner": d.cl.o.processID, "leaseGeneration": generation})
		r, err = d.rpc(d.nextID("activate"), "POST", "/runner/sessions/"+claimed.SessionID+"/activate-leases", body, "", 0)
		if err != nil {
			return detail, err
		}
		detail += "; activate " + tunnelStatus(r)
		if r.GetTunnel().GetStatus() != 200 {
			return detail, errors.New("want 200")
		}
		return detail, nil
	})

	// A message for the session: its inbox hint, HeartbeatAck's hints, and the inbox.
	d.step("a message for the session: the inbox hint, and the heartbeat's hints name the session", func() (string, error) {
		status, body, err := own.call("POST", "/api/sessions/"+session+"/turns", map[string]any{"clientTurnId": newUUID(), "content": "a second message"}, nil)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST turns %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		if _, err := d.waitHint(20*time.Second, func(h *linkpb.Hint) bool { return h.GetInbox().GetSessionId() == sid }); err != nil {
			return "", err
		}
		ack, err := d.heartbeat(d.beat(false, claimed.SessionID))
		if err != nil {
			return "", err
		}
		for _, id := range ack.GetHints().GetInboxSessionIds() {
			if id == sid {
				return "Hint{inbox}, and HeartbeatAck.hints.inbox_session_ids holds the session", nil
			}
		}
		return summarizeAck(ack), errors.New("HeartbeatAck.hints does not name the session")
	})
	d.step("inbox: forwarded and answered at once", func() (string, error) {
		started := time.Now()
		r, err := d.rpc(d.nextID("inbox"), "GET", "/runner/sessions/"+claimed.SessionID+"/inbox?leaseGeneration="+generation+"&acceptsSteer=1&runningTurnId=", nil, "", 0)
		if err != nil {
			return "", err
		}
		detail := fmt.Sprintf("%s in %s", tunnelStatus(r), time.Since(started).Round(time.Millisecond))
		if r.GetTunnel().GetStatus() != 200 || time.Since(started) > 5*time.Second {
			return detail, errors.New("want 200, at once")
		}
		return detail, nil
	})
	d.step("a route's refusal comes back whole: its status, code and retryable", func() (string, error) {
		r, err := d.rpc(d.nextID("meta"), "GET", "/runner/sessions/"+newUUID()+"/meta", nil, "", 0)
		if err != nil {
			return "", err
		}
		var body struct {
			Code      string `json:"code"`
			Retryable *bool  `json:"retryable"`
		}
		t := r.GetTunnel()
		if t == nil || t.GetStatus()/100 != 4 || json.Unmarshal(t.GetJsonBody(), &body) != nil || body.Code == "" || body.Retryable == nil || *body.Retryable {
			return tunnelStatus(r), errors.New("want a 4xx with the link's code and retryable false")
		}
		return tunnelStatus(r), nil
	})
	d.step("a path that is not a plain runner route is refused, and nothing forwarded", func() (string, error) {
		var seen []string
		for _, p := range []string{"/auth/login", "/runner/../auth/login", "/runner/sessions//claim"} {
			r, err := d.rpc(d.nextID("bad"), "POST", p, []byte(`{}`), "", 0)
			if err != nil {
				return "", err
			}
			if r.GetFailure().GetCode() != "RPC_BAD_REQUEST" || r.GetFailure().GetRetryable() {
				return tunnelStatus(r), fmt.Errorf("%s was not refused", p)
			}
			seen = append(seen, p+" → RPC_BAD_REQUEST")
		}
		return strings.Join(seen, "; "), nil
	})

	// Durable events.
	next := claimed.MaxSeq + 1
	var durable uint64
	d.step("durable events: stored by the ingest route and acknowledged", func() (string, error) {
		ack, err := d.events(d.batch(claimed.SessionID, next, next+2, "assistant", 0), 30*time.Second)
		if err != nil {
			return "", err
		}
		if ack.GetFailure() != nil || ack.GetDurableSeq() != next+2 {
			return summarizeEventAck(ack), errors.New("want durable_seq at the batch's last seq")
		}
		durable = ack.GetDurableSeq()
		n, err := own.storedEvents(session, next-1, next+2)
		if err != nil || n != 3 {
			return fmt.Sprintf("durable_seq %d, %d stored", durable, n), errOr(err, "the owner does not read the three events")
		}
		return fmt.Sprintf("durable_seq %d; the owner reads the 3 events", durable), nil
	})
	d.step("the same batch again: acknowledged, nothing stored twice", func() (string, error) {
		ack, err := d.events(d.batch(claimed.SessionID, next, next+2, "assistant", 0), 30*time.Second)
		if err != nil {
			return "", err
		}
		n, err := own.storedEvents(session, next-1, next+2)
		if ack.GetFailure() != nil || ack.GetDurableSeq() != durable || err != nil || n != 3 {
			return fmt.Sprintf("%s, %d stored", summarizeEventAck(ack), n), errOr(err, "want the same durable_seq and three events")
		}
		return fmt.Sprintf("durable_seq %d, still 3 events", ack.GetDurableSeq()), nil
	})
	d.step("a batch that would leave a gap is refused, retryable, and not forwarded", func() (string, error) {
		ack, err := d.events(d.batch(claimed.SessionID, durable+2, durable+3, "assistant", 0), 30*time.Second)
		if err != nil {
			return "", err
		}
		if ack.GetFailure().GetCode() != "EVENT_SEQ_GAP" || !ack.GetFailure().GetRetryable() || ack.GetDurableSeq() != durable {
			return summarizeEventAck(ack), errors.New("want EVENT_SEQ_GAP at the durable_seq stored")
		}
		return summarizeEventAck(ack), nil
	})
	d.step("after_seq: a turn completion waiting for events not stored is refused retryable", func() (string, error) {
		body, _ := json.Marshal(map[string]any{"turnId": newUUID(), "status": "AWAITING_INPUT", "leaseOwner": d.cl.o.processID})
		r, err := d.rpc(d.nextID("complete"), "POST", "/runner/sessions/"+claimed.SessionID+"/turn-complete", body, sid, durable+100)
		if err != nil {
			return "", err
		}
		code, _, _ := answerCode(&backendAnswer{body: r.GetTunnel().GetJsonBody()})
		if r.GetTunnel().GetStatus() != 503 || code != "RUNNER_LINK_AFTER_SEQ_PENDING" || r.GetTunnel().GetRetryAfterMs() == 0 {
			return tunnelStatus(r), errors.New("want 503 RUNNER_LINK_AFTER_SEQ_PENDING with a retry hint")
		}
		pending := fmt.Sprintf("after_seq %d: 503 %s, retry_after_ms %d", durable+100, code, r.GetTunnel().GetRetryAfterMs())
		r, err = d.rpc(d.nextID("complete"), "POST", "/runner/sessions/"+claimed.SessionID+"/turn-complete", body, sid, durable)
		if err != nil {
			return pending, err
		}
		code, _, _ = answerCode(&backendAnswer{body: r.GetTunnel().GetJsonBody()})
		if code == "RUNNER_LINK_AFTER_SEQ_PENDING" {
			return pending, errors.New("a completion after stored events was still refused as pending")
		}
		return pending + fmt.Sprintf("; after_seq %d passes the wait: %s", durable, tunnelStatus(r)), nil
	})

	// Credit: a burst past it is refused, then stored in order once the runner sends again from durable_seq + 1.
	d.step("a burst past the connection's credit: refused retryable, then all stored in order", func() (string, error) {
		credit := uint64(w.GetCredit().GetMaxUnackedEvents())
		const per = 1000
		batches := int(credit/per) + 3
		first := durable + 1
		target := durable + uint64(batches*per)
		for i := 0; i < batches; i++ {
			from := first + uint64(i*per)
			if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: d.batch(claimed.SessionID, from, from+per-1, "system", 300)}}); err != nil {
				return "", err
			}
		}
		refused := map[string]int{}
		for i := 0; i < batches; i++ {
			ack, err := d.nextEventAck(claimed.SessionID, 60*time.Second)
			if err != nil {
				return fmt.Sprintf("%d acks of %d", i, batches), err
			}
			if fl := ack.GetFailure(); fl != nil {
				refused[fl.GetCode()]++
			}
			durable = max(durable, ack.GetDurableSeq())
		}
		if refused["CREDIT_EXCEEDED"] == 0 {
			return fmt.Sprintf("%d batches of %d, refused %v", batches, per, refused), errors.New("no batch was refused for credit")
		}
		resent := 0
		for durable < target {
			to := min(durable+per, target)
			ack, err := d.events(d.batch(claimed.SessionID, durable+1, to, "system", 300), 60*time.Second)
			if err != nil {
				return "", err
			}
			if ack.GetFailure() != nil {
				time.Sleep(time.Duration(max(ack.GetFailure().GetRetryAfterMs(), 100)) * time.Millisecond)
				continue
			}
			durable = ack.GetDurableSeq()
			resent++
		}
		f["durableSeq"] = durable
		return fmt.Sprintf("%d batches of %d sent at once against a credit of %d: refused %v; sent again from durable_seq + 1 in %d batches, durable_seq %d",
			batches, per, credit, refused, resent, durable), nil
	})

	// The live stream, published only while a client watches, and the turn prefix asked of this runner.
	turn := newUUID()
	var probe *natsProbe
	if o.natsURL != "" {
		probe, err = newNATSProbe(o.natsURL, o.natsSeedFile, sid)
		d.record("a probe reads the session's live subject as the apiserver's NATS user", err == nil, time.Now(), errString(err))
		if probe != nil {
			defer probe.close()
		}
	}
	live := func(seqs map[uint64]string) error {
		lb := &linkpb.LiveBatch{SessionId: claimed.SessionID}
		keys := make([]uint64, 0, len(seqs))
		for seq := range seqs {
			keys = append(keys, seq)
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
		for _, seq := range keys {
			payload, _ := json.Marshal(map[string]string{"text": seqs[seq]})
			lb.Events = append(lb.Events, &linkpb.LiveEvent{LiveSeq: seq, Type: "text_delta", TsUnixMs: time.Now().UnixMilli(), TurnId: turn, PayloadJson: payload})
		}
		return d.send(&linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: lb}})
	}
	d.step("live, nobody watching: not published, and the runner told nobody watches", func() (string, error) {
		if err := live(map[uint64]string{1: "Hel", 2: "lo wor"}); err != nil {
			return "", err
		}
		if _, err := d.waitHint(10*time.Second, func(h *linkpb.Hint) bool {
			return h.GetWatchers() != nil && h.GetWatchers().GetSessionId() == sid && h.GetWatchers().GetWatchers() == 0
		}); err != nil {
			return "", err
		}
		if probe != nil {
			if n, _ := probe.published(time.Second); n != 0 {
				return "", fmt.Errorf("%d batches were published while nobody watched", n)
			}
			return "Hint{watchers: 0}; nothing on the live subject", nil
		}
		return "Hint{watchers: 0}", nil
	})
	d.prefix.Store(&linkpb.TurnPrefixResponse{TurnId: turn, Text: "Hello wor", Thinking: "pondering", ThroughLiveSeq: 2})
	watchCtx, stopWatching := context.WithCancel(ctx)
	defer stopWatching()
	var stream <-chan streamEvent
	d.step("a client opens the session: the runner is told it is watched and asked for its turn prefix", func() (string, error) {
		var err error
		if stream, err = own.watch(watchCtx, session); err != nil {
			return "", err
		}
		if _, err := d.waitHint(15*time.Second, func(h *linkpb.Hint) bool {
			return h.GetWatchers() != nil && h.GetWatchers().GetSessionId() == sid && h.GetWatchers().GetWatchers() >= 1
		}); err != nil {
			return "", err
		}
		select {
		case req := <-d.prefixes:
			return "Hint{watchers: 1}; TurnPrefixRequest " + req.GetRequestId() + " answered with \"Hello wor\" through live_seq 2", nil
		case <-time.After(15 * time.Second):
			return "Hint{watchers: 1}", errors.New("no TurnPrefixRequest")
		}
	})
	d.step("the client is handed the prefix, then only the live events after it, which go through NATS", func() (string, error) {
		if stream == nil {
			return "", errors.New("no stream")
		}
		time.Sleep(500 * time.Millisecond) // the stream has taken the prefix over from its replay
		if err := live(map[uint64]string{2: "STALE", 3: "ld!"}); err != nil {
			return "", err
		}
		var seen []string
		deadline := time.After(15 * time.Second)
		for !(contains(seen, "text_delta:Hello wor") && contains(seen, "text_delta:ld!")) {
			select {
			case e, ok := <-stream:
				if !ok {
					return strings.Join(seen, " | "), errors.New("the stream ended")
				}
				if e.Type == "text_delta" || e.Type == "thinking_delta" {
					seen = append(seen, e.Type+":"+e.text())
				}
			case <-deadline:
				return strings.Join(seen, " | "), errors.New("the client did not see the prefix and the new delta")
			}
		}
		if contains(seen, "text_delta:STALE") {
			return strings.Join(seen, " | "), errors.New("a delta the prefix folded in reached the client again")
		}
		detail := "the client saw " + strings.Join(seen, " | ")
		if probe != nil {
			n, seqs := probe.published(2 * time.Second)
			if n == 0 {
				return detail, errors.New("nothing was published on the live subject")
			}
			detail += fmt.Sprintf("; the live subject carried %d batch(es), live_seq %v", n, seqs)
		}
		return detail, nil
	})
	d.step("the client leaves: the runner is told nobody watches", func() (string, error) {
		stopWatching()
		_, err := d.waitHint(15*time.Second, func(h *linkpb.Hint) bool {
			return h.GetWatchers() != nil && h.GetWatchers().GetSessionId() == sid && h.GetWatchers().GetWatchers() == 0
		})
		return "Hint{watchers: 0}", err
	})

	// An answer larger than a frame, and a control frame between its pieces.
	d.step("an answer larger than a frame reaches the runner in pieces it joins", func() (string, error) {
		d.mu.Lock()
		d.raw = d.raw[:0]
		d.mu.Unlock()
		id := d.nextID("events")
		result := make(chan *linkpb.RpcResult, 1)
		var rerr error
		go func() {
			r, err := d.rpc(id, "GET", "/runner/sessions/"+claimed.SessionID+"/events?after=0&limit=1000", nil, "", 0)
			rerr = err
			result <- r
		}()
		time.Sleep(20 * time.Millisecond)
		_, _ = d.heartbeat(d.beat(false, claimed.SessionID))
		r := <-result
		if rerr != nil {
			return "", rerr
		}
		var page struct {
			Events []json.RawMessage `json:"events"`
		}
		t := r.GetTunnel()
		if t.GetStatus() != 200 || json.Unmarshal(t.GetJsonBody(), &page) != nil || len(page.Events) != 1000 {
			return tunnelStatus(r), errors.New("want 200 with 1000 events")
		}
		d.mu.Lock()
		order := append([]string(nil), d.raw...)
		d.mu.Unlock()
		// Between a frame's first piece and its last, did a control frame arrive?
		pieces, between, open := 0, false, false
		for _, name := range order {
			if rest, ok := strings.CutPrefix(name, "chunk:"); ok {
				parts := strings.Split(rest, ":")
				pieces++
				open = len(parts) == 3 && parts[2] != "true"
				continue
			}
			if open && name == "heartbeat_ack" {
				between = true
			}
		}
		detail := fmt.Sprintf("%d bytes in %d pieces; a heartbeat's acknowledgement written between two of them: %v", len(t.GetJsonBody()), pieces, between)
		if len(t.GetJsonBody()) <= maxFrameBytes || pieces < 2 {
			return detail, errors.New("the answer did not travel in pieces")
		}
		f["chunkedAnswer"] = map[string]any{"bytes": len(t.GetJsonBody()), "pieces": pieces, "controlBetweenPieces": between}
		return detail, nil
	})
	d.step("the connection stayed up through every step", func() (string, error) {
		select {
		case <-d.cc.done:
			return "", fmt.Errorf("it ended: %v %v", d.closed, d.cc.err)
		default:
		}
		return "connection " + d.cc.id, nil
	})
}

// cancelDrill: a claim waits for the claim lock, which the script holds, and the runner goes away under it.
func (d *driver) cancelDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	d.step("heartbeat", func() (string, error) {
		ack, err := d.heartbeat(d.beat(true))
		if err != nil {
			return "", err
		}
		return checkReconciled(ack)
	})
	own, err := newOwner(d.cl, o.ownerEmail, o.ownerPasswordFile)
	if !d.record("the owner signs in", err == nil, time.Now(), errString(err)) {
		return
	}
	if !d.step("the owner creates a session on this runner", func() (string, error) {
		var ws, s struct {
			ID string `json:"id"`
		}
		status, body, err := own.call("POST", "/api/workspaces", map[string]any{
			"name": "link drill cancel " + time.Now().UTC().Format("15:04:05"), "runnerId": d.runnerID, "workDir": o.workDir}, &ws)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("%d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		status, body, err = own.call("POST", "/api/sessions", map[string]any{"workspaceId": ws.ID, "engine": "claude", "prompt": "link drill: cancelled claim"}, &s)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("%d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		f["session"] = s.ID
		return "session " + s.ID, nil
	}) {
		return
	}
	d.step("a claim is sent while the claim lock is held, and the runner goes away under it", func() (string, error) {
		id := d.nextID("claim")
		f["claimRequestId"] = id
		ch := make(chan *linkpb.RpcResult, 1)
		d.mu.Lock()
		d.rpcs[id] = ch
		d.mu.Unlock()
		if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id,
			Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/sessions/claim"}}}}}); err != nil {
			return "", err
		}
		select {
		case r := <-ch:
			return tunnelStatus(r), errors.New("the claim was answered: the claim lock is not held")
		case <-time.After(o.cancelAfter):
		}
		_ = d.cc.ws.CloseNow()
		<-d.cc.done
		return fmt.Sprintf("no answer within %s; connection dropped", o.cancelAfter), nil
	})
}

// retryDrill: heartbeats and reads, every few hundred milliseconds, while a backend goes away and comes back.
func (d *driver) retryDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	session := o.session
	if session == "" {
		session = newUUID()
	}
	var mu sync.Mutex
	outcomes := map[string]int{}
	var slowest time.Duration
	note := func(kind, outcome string, took time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		outcomes[kind+" "+outcome]++
		slowest = max(slowest, took)
	}
	end := time.Now().Add(o.runFor)
	calls := 0
	// A new connection holds no facts: the first beat carries them whole, and so does any beat after one asked for.
	whole := true
	beat := func() {
		started := time.Now()
		ack, err := d.heartbeat(d.beat(whole, session))
		switch {
		case err != nil:
			note("heartbeat", "error: "+err.Error(), time.Since(started))
		case len(ack.GetWantFacts()) > 0:
			note("heartbeat", "asked for facts", time.Since(started))
		case len(ack.GetReconcileJson()) == 0:
			note("heartbeat", "unreconciled", time.Since(started))
		default:
			note("heartbeat", "reconciled", time.Since(started))
		}
		whole = err == nil && len(ack.GetWantFacts()) > 0
	}
	read := func() {
		started := time.Now()
		r, err := d.rpc(d.nextID("read"), "GET", "/runner/sessions/"+session+"/meta", nil, "", 0)
		switch {
		case err != nil:
			note("read", "error: "+err.Error(), time.Since(started))
		case r.GetFailure() != nil:
			note("read", "failure "+r.GetFailure().GetCode(), time.Since(started))
		default:
			note("read", fmt.Sprintf("answered %d", r.GetTunnel().GetStatus()), time.Since(started))
		}
	}
	for round := 0; time.Now().Before(end) && ctx.Err() == nil; round++ {
		// The gateway hands calls to its backends in turn, whatever they are for: sent always in the same order, each
		// kind would keep to one backend. Swapping the order every round sends each kind to both.
		if round%2 == 0 {
			beat()
			read()
		} else {
			read()
			beat()
		}
		calls += 2
		time.Sleep(250 * time.Millisecond)
	}
	f["outcomes"], f["slowestMs"], f["calls"] = outcomes, slowest.Milliseconds(), calls
	failed := 0
	for k, n := range outcomes {
		if !strings.HasSuffix(k, " reconciled") && !strings.Contains(k, " answered ") {
			failed += n
		}
	}
	d.record("every heartbeat and read was answered while a backend went away and came back", failed == 0 && calls > 0, time.Now(),
		fmt.Sprintf("%d calls over %s: %v; slowest %s", calls, o.runFor, outcomes, slowest.Round(time.Millisecond)))
}

// slowDrill: a runner that stops reading. Live frames are dropped while the connection stays; answers the runner does
// not read then fill its queue, and the gateway closes it as a slow consumer. The runner reads through a small socket
// buffer (clientMain) and leaves more unread than the sockets on the way hold, so the rest waits at the gateway. Once
// the gateway's writer is stuck it gives up after its write timeout (10 s), as a lost connection: both steps fit well
// inside it.
func (d *driver) slowDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	session := o.session
	if session == "" {
		d.record("a session to read", false, time.Now(), "-session is required: the session the link drill claimed")
		return
	}
	own, err := newOwner(d.cl, o.ownerEmail, o.ownerPasswordFile)
	if !d.record("the owner signs in", err == nil, time.Now(), errString(err)) {
		return
	}
	d.step("heartbeat, naming the session this runner holds", func() (string, error) {
		ack, err := d.heartbeat(d.beat(true, session))
		if err != nil {
			return "", err
		}
		return checkReconciled(ack)
	})
	page := "/runner/sessions/" + session + "/events?after=0&limit=1000"
	var pageBytes int
	if !d.step("a page of the session's events, read whole: the answer the runner then leaves unread", func() (string, error) {
		r, err := d.rpc(d.nextID("page"), "GET", page, nil, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetTunnel().GetStatus() != http.StatusOK {
			return tunnelStatus(r), errors.New("want 200")
		}
		pageBytes = len(r.GetTunnel().GetJsonBody())
		f["pageBytes"] = pageBytes
		if pageBytes < 64<<10 {
			return fmt.Sprintf("%d bytes", pageBytes), errors.New("too small to stop the gateway's writer: the link drill's session, with its 13,000 events, is")
		}
		return fmt.Sprintf("%d bytes", pageBytes), nil
	}) {
		return
	}
	// send asks for n answers, 16 at a time, fewer than the calls the connection may have in flight.
	send := func(n int, path string, every time.Duration) {
		for i := 0; i < n; i++ {
			if i > 0 && i%16 == 0 {
				time.Sleep(every)
			}
			_ = d.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: d.nextID("unread"),
				Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: path}}}}})
		}
	}
	d.paused.Store(true)
	d.cl.readPaused.Store(true)
	d.step("the runner stops reading; its answers fill the socket; clients open the session meanwhile", func() (string, error) {
		// 20 MiB: more than the sockets on the way hold (about 12 MB on staging, most of it in docker-proxy's two),
		// and well within the 32 MiB the gateway queues before it closes.
		pages := (20<<20 + pageBytes - 1) / pageBytes
		send(pages, page, 250*time.Millisecond)
		time.Sleep(time.Second)
		watchCtx, stop := context.WithCancel(ctx)
		defer stop()
		opened := 0
		for i := 0; i < 100; i++ {
			if _, err := own.watch(watchCtx, session); err == nil {
				opened++
			}
		}
		time.Sleep(time.Second)
		select {
		case <-d.cc.done:
			return "", errors.New("the connection was closed while only droppable frames waited")
		default:
		}
		f["streamsOpened"] = opened
		return fmt.Sprintf("%d pages of %d bytes left unread, then %d clients opened the session; the connection stays", pages, pageBytes, opened), nil
	})
	d.step("answers the runner does not read pass the connection's bound: closed as a slow consumer", func() (string, error) {
		// Small answers, each one more frame in the queue of 256 that hints and answers share.
		send(320, "/runner/sessions/"+session+"/meta", 100*time.Millisecond)
		time.Sleep(time.Second)
		d.cl.readPaused.Store(false)
		d.paused.Store(false)
		select {
		case <-d.cc.done:
		case <-time.After(30 * time.Second):
			return "", errors.New("the connection is still open")
		}
		d.mu.Lock()
		closed := d.closed
		order := append([]string(nil), d.raw...)
		d.mu.Unlock()
		// The Close, a control frame, written while an answer was halfway through its pieces?
		between, open := false, false
		for _, name := range order {
			if rest, ok := strings.CutPrefix(name, "chunk:"); ok {
				parts := strings.Split(rest, ":")
				open = len(parts) == 3 && parts[2] != "true"
				continue
			}
			if open && name == "close" {
				between = true
			}
		}
		f["closeBetweenPieces"] = between
		if closed == nil {
			return "the connection ended without a Close frame: " + errString(d.cc.err), nil
		}
		if closed.GetCode() != linkpb.CloseCode_CLOSE_CODE_SLOW_CONSUMER {
			return closed.GetCode().String(), errors.New("closed for another reason")
		}
		return fmt.Sprintf("Close{%s: %s}; written between two pieces of an answer: %v", closed.GetCode(), closed.GetMessage(), between), nil
	})
}

// storedEvents is how many of the session's events with after < seq ≤ through the owner reads.
func (o *owner) storedEvents(session string, after, through uint64) (int, error) {
	var page struct {
		Events []struct {
			Seq uint64 `json:"seq"`
		} `json:"events"`
	}
	status, body, err := o.call("GET", fmt.Sprintf("/api/sessions/%s/events/page?after=%d&limit=200", session, after), nil, &page)
	if err != nil || status != http.StatusOK {
		return 0, fmt.Errorf("events page %d %s %v", status, clip(string(body), 200), err)
	}
	n := 0
	for _, e := range page.Events {
		if e.Seq > after && e.Seq <= through {
			n++
		}
	}
	return n, nil
}

func checkReconciled(ack *linkpb.HeartbeatAck) (string, error) {
	var reconcile map[string]json.RawMessage
	if ack.GetMode() != linkpb.Mode_MODE_LINK {
		return summarizeAck(ack), errors.New("not MODE_LINK")
	}
	if err := json.Unmarshal(ack.GetReconcileJson(), &reconcile); err != nil || reconcile["maxConcurrent"] == nil {
		return summarizeAck(ack), errors.New("reconcile_json is not the heartbeat route's answer")
	}
	if _, leaked := reconcile["linkHints"]; leaked {
		return summarizeAck(ack), errors.New("linkHints was left in reconcile_json")
	}
	if ack.GetHints() == nil {
		return summarizeAck(ack), errors.New("no HintState")
	}
	return summarizeAck(ack), nil
}

func summarizeAck(ack *linkpb.HeartbeatAck) string {
	return fmt.Sprintf("HeartbeatAck{mode %s, reconcile %d bytes, want %v, hints: inbox %d, claim %v, watchers %d}", ack.GetMode(),
		len(ack.GetReconcileJson()), ack.GetWantFacts(), len(ack.GetHints().GetInboxSessionIds()), ack.GetHints().GetClaim(), len(ack.GetHints().GetWatchers()))
}

func summarizeEventAck(ack *linkpb.EventAck) string {
	s := fmt.Sprintf("EventAck{durable_seq %d", ack.GetDurableSeq())
	if fl := ack.GetFailure(); fl != nil {
		s += fmt.Sprintf(", failure %s retryable=%v retry_after_ms=%d", fl.GetCode(), fl.GetRetryable(), fl.GetRetryAfterMs())
	}
	return s + "}"
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func errOr(err error, fallback string) error {
	if err != nil {
		return err
	}
	return errors.New(fallback)
}
