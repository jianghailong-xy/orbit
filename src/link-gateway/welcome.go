package main

import (
	"context"
	"encoding/json"
	"net/http"

	"orbit/link-gateway/linkpb"
)

// Welcome's sessions and release (docs/runner-link-design.md §5.3, §5.4, §5.8, §7). Before a MODE_LINK connection's
// Welcome is written, the gateway asks the apiserver's welcome route (POST /runner/link/welcome,
// src/apiserver/src/runner-api/runner-link-welcome.ts) where each session the Hello names stands, how far its events
// are stored and whether this process still holds it, and which release the runner is assigned. The route decides
// both; the gateway copies what it says.
//
// When the route gives no usable answer within linkTuning.WelcomeTimeout (no backend reached, a refusal, an answer that
// does not read), the Welcome goes without sessions and without a release. The handshake is not refused for it: an
// apiserver older than the route, or a database that is down, must not keep every runner off the link. A Welcome without
// sessions says nothing about them, which is not the same as their events being stored nowhere or their leases being
// lost: the runner keeps every event no EventAck has covered and sends it again (each seq is stored once), and learns of
// a lease it lost from the next heartbeat's reconcile, as it always has. README.md, "Welcome", says the same for runners.

// welcomeAnswer is what the welcome route answers.
type welcomeAnswer struct {
	Sessions []struct {
		SessionID  string  `json:"sessionId"`
		DurableSeq *uint64 `json:"durableSeq"`
		LeaseHeld  *bool   `json:"leaseHeld"`
	} `json:"sessions"`
	Release *struct {
		Version  string `json:"version"`
		Rollback bool   `json:"rollback"`
	} `json:"release"`
}

// welcome is what Welcome says of hello's sessions and of the runner's release, as the welcome route answers it: both
// nil when the route did not say.
func (l *linkState) welcome(hello *linkpb.Hello) ([]*linkpb.SessionState, *linkpb.AssignedRelease) {
	c, m := l.c, l.c.g.metrics
	named := hello.GetSessions()
	ids := make([]string, len(named))
	for i, s := range named {
		// In the spelling the route reads them in, as a heartbeat's are forwarded. An id that is neither UUID nor public id
		// goes as it came, and the route answers it as naming nothing.
		ids[i] = s.GetSessionId()
		if uuid, ok := sessionUUID(ids[i]); ok {
			ids[i] = uuid
		}
	}
	body, _ := json.Marshal(map[string]any{"sessionIds": ids})
	ctx, cancel := context.WithTimeout(c.ctx, c.g.cfg.link.WelcomeTimeout)
	defer cancel()
	answer, err := c.g.backends.do(ctx, backendCall{
		kind: "welcome", method: http.MethodPost, path: "/api/runner/link/welcome", body: body, header: l.headers(),
		// Safe to send again: all it writes is the runner's last beat before this connection, the same each time.
		idempotent: true,
	})
	var a welcomeAnswer
	result := "answered"
	switch {
	case err != nil:
		result = "failed"
		l.logFailure("the welcome route gave no answer: Welcome goes without sessions or release", "failure", err.Error())
	case answer.status/100 != 2:
		code, _, _ := answerCode(answer)
		result = "refused"
		l.logFailure("the welcome route refused: Welcome goes without sessions or release", "status", answer.status, "code", code)
	case json.Unmarshal(answer.body, &a) != nil || !a.states(ids):
		result = "malformed"
		l.logFailure("the welcome route's answer does not state each session asked about: Welcome goes without sessions or release")
	}
	m.welcomeLookups.inc(result)
	if result != "answered" {
		return nil, nil
	}
	sessions := make([]*linkpb.SessionState, len(named))
	for i, s := range a.Sessions {
		// Under the id the runner sent.
		sessions[i] = &linkpb.SessionState{SessionId: named[i].GetSessionId(), DurableSeq: *s.DurableSeq, LeaseHeld: *s.LeaseHeld}
	}
	var release *linkpb.AssignedRelease
	if r := a.Release; r != nil && r.Version != "" {
		release = &linkpb.AssignedRelease{Version: r.Version, Rollback: r.Rollback}
	}
	return sessions, release
}

// states reports whether the answer states each of ids, in the order asked: the route's contract.
func (a *welcomeAnswer) states(ids []string) bool {
	if len(a.Sessions) != len(ids) {
		return false
	}
	for i, s := range a.Sessions {
		if s.SessionID != ids[i] || s.DurableSeq == nil || s.LeaseHeld == nil {
			return false
		}
	}
	return true
}
