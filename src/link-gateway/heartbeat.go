package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// Heartbeats (docs/runner-link-design.md §5.7). A Heartbeat is forwarded to the apiserver's heartbeat route as the
// body a runner posts over HTTPS today, the exact inverse of the shadow comparison's mapping (README.md, "Shadow
// comparison"): the typed fields become their members, and each Fact's JSON becomes the member it is named after. The
// route does everything it does today, the runner's presence included, and its answer, today's HeartbeatResponse,
// goes back as HeartbeatAck.reconcile_json for the runner to apply as it applies that response today.
//
// A Fact may come by digest only, when the runner sent its content before. The connection keeps the last full value of
// each kind, and a digest it holds is filled from it. A digest it does not hold is named in want_facts, and that beat
// is not forwarded: an absent heartbeat member has a meaning (it keeps or clears what the server holds), so a body
// missing one would say something the runner did not. The runner sends those parts whole in its next beat, at once.

// The members a heartbeat's typed fields fill (heartbeatTypedMembers, shadow.go); a Fact of one of these kinds is
// ignored rather than allowed to replace it.

// factCache is the last full value of each fact kind a connection's runner sent.
type factCache struct {
	byKind map[string]cachedFact
	bytes  int
}

type cachedFact struct {
	sha  string
	json []byte
}

// Bounds on what one connection's cache holds. A fact past them is used for its beat and not kept, so its next
// digest-only beat asks for it again.
const (
	maxFactKinds = 64
	maxFactBytes = 4 << 20
)

func newFactCache() factCache { return factCache{byKind: map[string]cachedFact{}} }

// resolve is each Fact's JSON by kind, and the kinds whose digest the cache does not hold (want).
func (fc *factCache) resolve(facts []*linkpb.Fact, m *gatewayMetrics) (members map[string]json.RawMessage, want []string) {
	members = map[string]json.RawMessage{}
	wanted := map[string]bool{}
	for _, f := range facts {
		kind := f.GetKind()
		if kind == "" || heartbeatTypedMembers[kind] {
			m.heartbeatFacts.inc("ignored")
			continue
		}
		raw := f.GetJson()
		if len(raw) == 0 {
			if cached, ok := fc.byKind[kind]; ok && cached.sha == f.GetSha256() {
				members[kind] = cached.json
				m.heartbeatFacts.inc("cached")
			} else {
				wanted[kind] = true
				m.heartbeatFacts.inc("unknown_digest")
			}
			continue
		}
		if !json.Valid(raw) {
			// Not JSON: the runner is asked for it again rather than the route sent a body it cannot read.
			wanted[kind] = true
			m.heartbeatFacts.inc("invalid_json")
			continue
		}
		delete(wanted, kind)
		members[kind] = json.RawMessage(raw)
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != strings.ToLower(f.GetSha256()) {
			// The content is what the beat says; a digest that is not its own cannot name it later, so it is not kept.
			m.heartbeatFacts.inc("digest_mismatch")
			continue
		}
		m.heartbeatFacts.inc("whole")
		fc.keep(kind, cachedFact{sha: strings.ToLower(f.GetSha256()), json: append([]byte(nil), raw...)})
	}
	for kind := range wanted {
		want = append(want, kind)
	}
	sort.Strings(want)
	return members, want
}

func (fc *factCache) keep(kind string, f cachedFact) {
	old, had := fc.byKind[kind]
	size := fc.bytes + len(f.json)
	if had {
		size -= len(old.json)
	}
	if size > maxFactBytes || (!had && len(fc.byKind) >= maxFactKinds) {
		if had {
			// Stale now: it no longer matches what the runner holds.
			fc.bytes -= len(old.json)
			delete(fc.byKind, kind)
		}
		return
	}
	fc.byKind[kind] = f
	fc.bytes = size
}

// onHeartbeat hands the beat to the connection's heartbeat worker. A beat still waiting for its turn is replaced by
// the newer one: each beat is complete and reconciled level-triggered, so the newest says everything the older did.
func (l *linkState) onHeartbeat(hb *linkpb.Heartbeat) {
	for {
		select {
		case l.beats <- hb:
			return
		default:
		}
		select {
		case <-l.beats:
			l.c.g.metrics.heartbeatForwards.inc("superseded")
		default:
		}
	}
}

// heartbeatLoop forwards the connection's heartbeats one at a time, in order.
func (l *linkState) heartbeatLoop() {
	for {
		select {
		case <-l.c.ctx.Done():
			return
		case hb := <-l.beats:
			l.forwardHeartbeat(hb)
		}
	}
}

func (l *linkState) forwardHeartbeat(hb *linkpb.Heartbeat) {
	c, m := l.c, l.c.g.metrics
	if p := hb.GetProcessId(); p != "" && !strings.EqualFold(p, c.claims.LeaseOwner) {
		// The process is the connection's, which its link token names; a beat naming another is answered for this one.
		m.heartbeatForwards.inc("other_process")
		l.logFailure("a heartbeat names another process than its connection's; it is forwarded for the connection's", "named", p)
	}
	l.noteHeartbeat(hb)
	members, want := l.facts.resolve(hb.GetFacts(), m)
	ack := &linkpb.HeartbeatAck{Mode: c.mode}
	if len(want) > 0 {
		// Nothing was reconciled: no reconcile_json, and no HintState, which the route was not asked for.
		m.heartbeatForwards.inc("want_facts")
		ack.WantFacts = want
		c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}}, true)
		return
	}
	l.mu.Lock()
	hello := l.hello
	l.mu.Unlock()
	body, err := json.Marshal(heartbeatRequestBody(hb, c.claims.LeaseOwner, hello, members))
	if err != nil {
		m.heartbeatForwards.inc("unencodable")
		c.log.Error("a heartbeat does not encode as JSON; not forwarded", "err", err)
		c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}}, true)
		return
	}
	started := time.Now()
	answer, err := c.g.backends.do(c.ctx, backendCall{
		kind: "heartbeat", method: "POST", path: "/api/runner/heartbeat", body: body, header: l.headers(),
		// Reconciled level-triggered: a beat that reached the route twice says the same thing twice.
		idempotent: true,
	})
	switch {
	case err != nil:
		if err == errCallCancelled {
			return
		}
		m.heartbeatForwards.inc("failed")
		l.logFailure("a heartbeat got no answer; the runner applies nothing for it", "failure", err.Error())
	case answer.status/100 != 2:
		code, _, _ := answerCode(answer)
		m.heartbeatForwards.inc("refused")
		l.logFailure("the heartbeat route refused a heartbeat", "status", answer.status, "code", code)
	default:
		reconcile, hints := splitLinkHints(answer.body)
		ack.ReconcileJson = reconcile
		if hints != nil {
			// An answer without them says nothing about what waits, which is not the same as nothing waiting.
			ack.Hints = c.g.hintState(c.claims.RunnerID, hints)
			if r := hints.Release; r != nil && r.Version != "" {
				ack.Release = &linkpb.AssignedRelease{Version: r.Version, Rollback: r.Rollback}
			}
		}
		m.heartbeatForwards.inc("forwarded")
		m.heartbeatDuration.observe(time.Since(started))
	}
	c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: ack}}, true)
}

// noteHeartbeat keeps what a beat says that later calls need: the engines it supports now, sent with every call as
// today's X-Orbit-Supported-Providers header is, and the sessions it supervises, where a turn prefix is asked (live.go).
func (l *linkState) noteHeartbeat(hb *linkpb.Heartbeat) {
	sessions := make(map[string]bool, len(hb.GetSessionIds()))
	for _, id := range hb.GetSessionIds() {
		if uuid, ok := sessionUUID(id); ok {
			sessions[uuid] = true
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// Proto3 cannot tell an empty list from an absent one, and no runner runs no engine: an empty list leaves the
	// last one in place.
	if p := hb.GetSupportedProviders(); len(p) > 0 {
		l.providers = p
	}
	l.sessions = sessions
}

// heartbeatRequestBody is the POST /runner/heartbeat body a Heartbeat stands for: the members a runner sends over HTTPS today
// (HeartbeatRequest, src/runner-go/types.go), with Go's omitempty where that struct has it, so the route reads the
// same body either way. The process is the connection's.
func heartbeatRequestBody(hb *linkpb.Heartbeat, process string, hello *linkpb.Hello, facts map[string]json.RawMessage) map[string]any {
	body := make(map[string]any, len(facts)+6)
	for kind, raw := range facts {
		body[kind] = raw
	}
	body["status"] = "ONLINE"
	body["idleCapacity"] = hb.GetIdleCapacity()
	body["leaseOwner"] = strings.ToLower(process)
	if v := hello.GetRunnerVersion(); v != "" {
		body["version"] = v
	}
	if ids := hb.GetSessionIds(); len(ids) > 0 {
		// In the spelling the route reads them in: a session's UUID. An id that is neither UUID nor public id is passed
		// as it came, for the route to refuse.
		supervised := make([]string, len(ids))
		for i, id := range ids {
			supervised[i] = id
			if uuid, ok := sessionUUID(id); ok {
				supervised[i] = uuid
			}
		}
		body["supervisedSessionIds"] = supervised
	}
	if hb.GetDraining() {
		body["draining"] = true
	}
	return body
}

// linkHints is what the heartbeat route adds to its answer for a link call (runner-api.controller.ts): what Hint
// frames would say, which the gateway states in HeartbeatAck.hints.
type linkHints struct {
	InboxSessionIDs []string `json:"inboxSessionIds"`
	Claim           bool     `json:"claim"`
	// Approvals are the approvals that have a decision while their reader is still waiting (runner-link-hints.ts).
	Approvals []struct {
		SessionID  string `json:"sessionId"`
		ApprovalID string `json:"approvalId"`
	} `json:"approvals"`
	// Watchers are the answering apiserver instance's own counts of the runner's watched sessions (live.go).
	Watchers *struct {
		Instance string `json:"instance"`
		Sessions []struct {
			SessionID string `json:"sessionId"`
			Watchers  uint32 `json:"watchers"`
		} `json:"sessions"`
	} `json:"watchers"`
	// Release is the release the runner is assigned, as GET /runner/release would answer it
	// (src/apiserver/src/runner-api/runner-release-feed.ts); absent when the apiserver can state none now.
	Release *struct {
		Version  string `json:"version"`
		Rollback bool   `json:"rollback"`
	} `json:"release"`
}

// splitLinkHints parts the route's answer into today's HeartbeatResponse, which goes to the runner as it is, and the
// link's hints, which the gateway reads. An answer without them is today's response whole.
func splitLinkHints(body []byte) (reconcile []byte, hints *linkHints) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(body, &members); err != nil || members == nil {
		return body, nil
	}
	raw, ok := members["linkHints"]
	if !ok {
		return body, nil
	}
	delete(members, "linkHints")
	var h linkHints
	if err := json.Unmarshal(raw, &h); err == nil {
		hints = &h
	}
	out, err := json.Marshal(members)
	if err != nil {
		return body, hints
	}
	return out, hints
}

// hintState is HeartbeatAck.hints: what the heartbeat route says waits for the runner, and the sessions watched live
// as the gateway sums them across apiserver instances, this answer's own counts merged in first.
func (g *gateway) hintState(runnerID string, h *linkHints) *linkpb.HintState {
	state := &linkpb.HintState{}
	if h != nil {
		state.InboxSessionIds = h.InboxSessionIDs
		state.Claim = h.Claim
		for _, a := range h.Approvals {
			state.Approvals = append(state.Approvals, &linkpb.ApprovalHint{SessionId: a.SessionID, ApprovalId: a.ApprovalID})
		}
		if w := h.Watchers; w != nil {
			counts := make(map[string]uint32, len(w.Sessions))
			for _, s := range w.Sessions {
				counts[s.SessionID] = s.Watchers
			}
			g.watchersFromSnapshot(runnerID, w.Instance, counts)
		}
	}
	state.Watchers = g.watchers.list(runnerID)
	return state
}
