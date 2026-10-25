package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// The resume drill (scripts/runner-link/staging-check-link.sh, step 6): a session's durable events streamed, the
// connection cut while batches are in flight, and the runner back on a new connection carrying on from where its
// Welcome says the session's events are stored (docs/runner-link-design.md §5.4, §5.8; welcome.go). The runner here
// keeps every event no EventAck has covered, as a runner must, and resends from Welcome's durable_seq plus one.

const (
	resumeBatch      = 40 // events in a batch
	resumeAcked      = 5  // batches stored and acknowledged before the cut
	resumeInFlight   = 10 // batches sent back to back, the connection cut right after them
	resumeAfterwards = 3  // batches of new events once the runner is back
)

// heldEvents is the runner's buffer of one session's durable events: those no EventAck has covered yet.
type heldEvents struct {
	from, to uint64 // seqs from..to are held; empty when from > to
}

func (d *driver) resumeDrill(ctx context.Context, o drillOptions) {
	f := d.report.Facts
	if !d.step("welcome: MODE_LINK", func() (string, error) {
		if m := d.cc.welcome.GetMode(); m != linkpb.Mode_MODE_LINK {
			return m.String(), errors.New("the gateway is not in MODE_LINK: start the stack with ORBIT_LINK_STAGING_MODE=link")
		}
		return "connection " + d.cc.id, nil
	}) {
		return
	}
	d.step("heartbeat: every fact whole, reconciled by the heartbeat route", func() (string, error) {
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
	sid, claimed, ok := d.leasedSession(own, o, "link drill resume")
	if !ok {
		return
	}
	f["session"], f["sessionUuid"] = claimed.SessionID, sid
	held := heldEvents{from: claimed.MaxSeq + 1, to: claimed.MaxSeq}
	next := claimed.MaxSeq + 1

	// The stream: batches stored and acknowledged one after another.
	d.step(fmt.Sprintf("the stream: %d batches of %d events stored and acknowledged", resumeAcked, resumeBatch), func() (string, error) {
		for i := 0; i < resumeAcked; i++ {
			ack, err := d.events(d.batch(sid, next, next+resumeBatch-1, "assistant", 0), 30*time.Second)
			if err != nil {
				return "", err
			}
			if ack.GetFailure() != nil || ack.GetDurableSeq() != next+resumeBatch-1 {
				return summarizeEventAck(ack), errors.New("want the batch stored")
			}
			next += resumeBatch
			held.from = ack.GetDurableSeq() + 1
		}
		held.to = next - 1
		return fmt.Sprintf("durable_seq %d", held.from-1), nil
	})
	acked := held.from - 1
	f["ackedBeforeCut"] = acked

	// The cut: batches sent back to back, and the connection dropped with no close handshake as soon as the first of them
	// is acknowledged, while the gateway is storing the rest.
	var sentThrough uint64
	d.step(fmt.Sprintf("the stream cut: %d batches sent back to back, the connection dropped while they are being stored", resumeInFlight), func() (string, error) {
		for i := 0; i < resumeInFlight; i++ {
			if err := d.send(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: d.batch(sid, next, next+resumeBatch-1, "assistant", 0)}}); err != nil {
				return "", err
			}
			next += resumeBatch
		}
		sentThrough = next - 1
		first, err := d.nextEventAck(claimed.SessionID, 30*time.Second)
		if err != nil {
			return "", err
		}
		_ = d.cc.ws.CloseNow()
		<-d.cc.done
		if first.GetFailure() == nil && first.GetDurableSeq() >= held.from {
			held.from = first.GetDurableSeq() + 1
		}
		// What was acknowledged before the cut reached the runner, which drops it from its buffer.
		for {
			select {
			case a := <-d.eventAck:
				if a.GetSessionId() == claimed.SessionID && a.GetFailure() == nil && a.GetDurableSeq() >= held.from {
					held.from = a.GetDurableSeq() + 1
				}
				continue
			default:
			}
			break
		}
		held.to = sentThrough
		return fmt.Sprintf("sent through seq %d; acknowledged through %d before the cut, %d events held", sentThrough, held.from-1, held.to-held.from+1), nil
	})
	ackedAtCut := held.from - 1
	f["sentThrough"], f["ackedAtCut"] = sentThrough, ackedAtCut

	// Back on a new connection: the Welcome says how far the session is stored, and the runner resumes from there.
	resumed, err := dialDriver(ctx, d.cl, d.report, &linkpb.SessionResume{SessionId: claimed.SessionID, LastSeq: sentThrough})
	if !d.record("a new connection, its Hello naming the session and the last seq assigned", err == nil, time.Now(), errString(err)) {
		return
	}
	defer resumed.close()
	var durable uint64
	if !resumed.step("its Welcome: the session's durable_seq, and the lease this process holds", func() (string, error) {
		states := resumed.cc.welcome.GetSessions()
		if len(states) != 1 || states[0].GetSessionId() != claimed.SessionID {
			return fmt.Sprintf("%v", states), errors.New("want one SessionState, for the session Hello named: is the gateway older than B4a, or the welcome route unanswered?")
		}
		durable = states[0].GetDurableSeq()
		detail := fmt.Sprintf("durable_seq %d, lease_held %v (acknowledged through %d when the connection was cut, sent through %d)",
			durable, states[0].GetLeaseHeld(), ackedAtCut, sentThrough)
		switch {
		case !states[0].GetLeaseHeld():
			return detail, errors.New("the process holds the session's lease")
		case durable < ackedAtCut || durable > sentThrough:
			return detail, errors.New("want a durable_seq between what was acknowledged and what was sent")
		}
		return detail, nil
	}) {
		return
	}
	f["welcomeDurableSeq"] = durable

	// The runner's buffer: what Welcome says is stored goes; the rest is sent again, then new events follow.
	var final uint64
	resumed.step("resumed from durable_seq + 1: the held events again, then new ones, every batch acknowledged with no EVENT_SEQ_GAP", func() (string, error) {
		if durable+1 > held.from {
			held.from = durable + 1
		}
		resent := uint64(0)
		if held.to >= held.from {
			resent = held.to - held.from + 1
		}
		last := max(durable, sentThrough)
		end := last + resumeAfterwards*resumeBatch
		for from := held.from; from <= end; from += resumeBatch {
			to := min(from+resumeBatch-1, end)
			ack, err := resumed.events(resumed.batch(sid, from, to, "assistant", 0), 30*time.Second)
			if err != nil {
				return "", err
			}
			if fail := ack.GetFailure(); fail != nil {
				return summarizeEventAck(ack), fmt.Errorf("batch %d..%d refused", from, to)
			}
			if ack.GetDurableSeq() != to {
				return summarizeEventAck(ack), fmt.Errorf("want durable_seq %d", to)
			}
		}
		final = end
		return fmt.Sprintf("%d held events sent again from seq %d, then new events through %d: all acknowledged", resent, held.from, end), nil
	})
	f["finalSeq"] = final

	resumed.step("the session's stored events: every seq from 1 to the last, once, with no gap", func() (string, error) {
		seqs, err := resumed.storedSeqs(claimed.SessionID)
		if err != nil {
			return "", err
		}
		for i, s := range seqs {
			if s != uint64(i)+1 {
				return fmt.Sprintf("%d events, seq %d at %d", len(seqs), s, i+1), errors.New("a seq is missing or out of place")
			}
		}
		if uint64(len(seqs)) != final {
			return fmt.Sprintf("%d events stored", len(seqs)), fmt.Errorf("want %d", final)
		}
		return fmt.Sprintf("seqs 1..%d", len(seqs)), nil
	})

	// Once nothing is in flight, a Welcome says exactly how far the session is stored, and nothing of others.
	resumed.close()
	nobody := newUUID()
	again, err := dialDriver(ctx, d.cl, d.report,
		&linkpb.SessionResume{SessionId: claimed.SessionID, LastSeq: final},
		&linkpb.SessionResume{SessionId: nobody, LastSeq: 9},
		&linkpb.SessionResume{SessionId: "not.a.session"})
	if !d.record("a third connection, its Hello naming the session, a session of nobody's and an id of none", err == nil, time.Now(), errString(err)) {
		return
	}
	defer again.close()
	again.step("its Welcome: the session stored through its last seq and held; the others neither", func() (string, error) {
		var got []string
		for _, s := range again.cc.welcome.GetSessions() {
			got = append(got, fmt.Sprintf("%s:%d:%v", s.GetSessionId(), s.GetDurableSeq(), s.GetLeaseHeld()))
		}
		want := []string{fmt.Sprintf("%s:%d:true", claimed.SessionID, final), nobody + ":0:false", "not.a.session:0:false"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			return strings.Join(got, " "), errors.New("want " + strings.Join(want, " "))
		}
		return strings.Join(got, " "), nil
	})
	again.step("Welcome and HeartbeatAck name the release GET /api/runner/release assigns this runner", func() (string, error) {
		assigned, err := again.assignedRelease()
		if err != nil {
			return "", err
		}
		want := fmt.Sprintf("%s rollback=%v", assigned.Version, assigned.Rollback)
		w := again.cc.welcome.GetRelease()
		if w == nil || fmt.Sprintf("%s rollback=%v", w.GetVersion(), w.GetRollback()) != want {
			return fmt.Sprintf("Welcome %v", w), errors.New("want " + want)
		}
		ack, err := again.heartbeat(again.beat(true, claimed.SessionID))
		if err != nil {
			return "", err
		}
		if r := ack.GetRelease(); r == nil || fmt.Sprintf("%s rollback=%v", r.GetVersion(), r.GetRollback()) != want {
			return fmt.Sprintf("HeartbeatAck %v", r), errors.New("want " + want)
		}
		f["release"] = want
		return want + ", in both", nil
	})
}

// leasedSession is a session the owner creates on this runner, claimed by it and its leases taken over and activated
// for this process, as a runner does before it streams a session's events. It reports the session's UUID and the claim.
func (d *driver) leasedSession(own *owner, o drillOptions, prompt string) (string, claimedSession, bool) {
	var claimed claimedSession
	var sid string
	ok := d.step("the owner creates a session on this runner, which claims it and takes its leases", func() (string, error) {
		var ws, s struct {
			ID string `json:"id"`
		}
		status, body, err := own.call("POST", "/api/workspaces", map[string]any{
			"name": prompt + " " + time.Now().UTC().Format("2006-01-02T15:04:05Z"), "runnerId": d.runnerID, "workDir": o.workDir}, &ws)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST /api/workspaces %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		status, body, err = own.call("POST", "/api/sessions", map[string]any{"workspaceId": ws.ID, "engine": "claude", "prompt": prompt}, &s)
		if err != nil || status/100 != 2 {
			return fmt.Sprintf("POST /api/sessions %d %s", status, clip(string(body), 300)), errOr(err, "refused")
		}
		want, _ := sessionUUID(s.ID)
		r, err := d.rpc(d.nextID("claim"), "GET", "/runner/sessions/claim", nil, "", 0)
		if err != nil {
			return "", err
		}
		if r.GetTunnel().GetStatus() != 200 || json.Unmarshal(r.GetTunnel().GetJsonBody(), &claimed) != nil {
			return "claim " + tunnelStatus(r), errors.New("want 200 with the session claimed")
		}
		if got, _ := sessionUUID(claimed.SessionID); got != want {
			return "claim " + tunnelStatus(r), errors.New("another session was claimed: a PENDING session of this runner was left over")
		}
		var expected any
		if claimed.LeaseOwner != "" {
			expected = claimed.LeaseOwner
		}
		takeover, _ := json.Marshal(map[string]any{"leaseOwner": d.cl.o.processID, "expectedLeaseOwner": expected})
		if r, err = d.rpc(d.nextID("takeover"), "POST", "/runner/sessions/"+claimed.SessionID+"/takeover-leases", takeover, "", 0); err != nil || r.GetTunnel().GetStatus()/100 != 2 {
			return "takeover " + tunnelStatus(r), errOr(err, "want 2xx")
		}
		activate, _ := json.Marshal(map[string]string{"leaseOwner": d.cl.o.processID, "leaseGeneration": newUUID()})
		if r, err = d.rpc(d.nextID("activate"), "POST", "/runner/sessions/"+claimed.SessionID+"/activate-leases", activate, "", 0); err != nil || r.GetTunnel().GetStatus() != 200 {
			return "activate " + tunnelStatus(r), errOr(err, "want 200")
		}
		sid = want
		return fmt.Sprintf("session %s claimed (maxSeq %d), its leases this process's", claimed.SessionID, claimed.MaxSeq), nil
	})
	return sid, claimed, ok
}

// storedSeqs reads back the seqs of every event the session has stored, page by page, as a runner reads its transcript.
func (d *driver) storedSeqs(session string) ([]uint64, error) {
	var seqs []uint64
	after := uint64(0)
	for {
		r, err := d.rpc(d.nextID("events"), "GET", fmt.Sprintf("/runner/sessions/%s/events?after=%d&limit=1000", session, after), nil, "", 0)
		if err != nil {
			return nil, err
		}
		var page struct {
			Events []struct {
				Seq uint64 `json:"seq"`
			} `json:"events"`
			HasMore bool `json:"hasMore"`
		}
		if r.GetTunnel().GetStatus() != 200 || json.Unmarshal(r.GetTunnel().GetJsonBody(), &page) != nil {
			return nil, errors.New("reading the events: " + tunnelStatus(r))
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

// assignedRelease is what GET /api/runner/release answers this runner over HTTPS, asked with the two releases the
// server's /dl publishes, as a runner's release check asks it (src/runner-go/selfupdate.go).
func (d *driver) assignedRelease() (*struct {
	Version  string `json:"version"`
	Rollback bool   `json:"rollback"`
}, error) {
	get := func(path string, auth bool, out any) (int, error) {
		req, err := http.NewRequest(http.MethodGet, d.cl.o.api+path, nil)
		if err != nil {
			return 0, err
		}
		if auth {
			req.Header.Set("Authorization", "Bearer "+d.cl.o.runnerToken)
		}
		resp, err := d.cl.api.Do(req)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode == http.StatusOK {
			err = json.Unmarshal(b, out)
		}
		return resp.StatusCode, err
	}
	var latest, previous struct {
		Version string `json:"version"`
	}
	if status, err := get("/dl/version.json", false, &latest); err != nil || status != http.StatusOK {
		return nil, fmt.Errorf("/dl/version.json: %d %v", status, err)
	}
	query := url.Values{"latest": {latest.Version}}
	if status, err := get("/dl/previous/version.json", false, &previous); err != nil || (status != http.StatusOK && status != http.StatusNotFound) {
		return nil, fmt.Errorf("/dl/previous/version.json: %d %v", status, err)
	} else if status == http.StatusOK {
		query.Set("previous", previous.Version)
	}
	var assigned struct {
		Version  string `json:"version"`
		Rollback bool   `json:"rollback"`
	}
	if status, err := get("/api/runner/release?"+query.Encode(), true, &assigned); err != nil || status != http.StatusOK {
		return nil, fmt.Errorf("GET /api/runner/release?%s: %d %v", query.Encode(), status, err)
	}
	return &assigned, nil
}
