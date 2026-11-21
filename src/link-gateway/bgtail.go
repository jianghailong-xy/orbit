package main

import (
	"slices"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"orbit/link-gateway/linkpb"
)

// The newest lines of a bg_run job's output, for the job's card in the app (contracts/runner-link/v1,
// BackgroundJobTailRequest). The apiserver asks over NATS: a request on rnr.<runnerId> carrying a Frame with only
// background_job_tail_request set, in protobuf's canonical JSON (src/apiserver/src/realtime/runner-hints.ts). The
// gateway holding that runner sends it to the connection whose process supervises the session, else the newest, of
// those whose Hello declared bg-output-tail/v1, and answers the request's reply subject with the runner's
// BackgroundJobTailResponse. It answers itself, with the outcome that says why, when it holds no connection of the
// runner (NO_CONNECTION), when none declares the capability (UNSUPPORTED), and when the runner has not answered within
// bgTailTimeout (TIMEOUT), so the apiserver's request never waits out its own longer timeout.

const (
	// bgTailCapability is the Hello capability of a runner that answers BackgroundJobTailRequest.
	bgTailCapability = "bg-output-tail/v1"
)

// bgTailTimeout is how long a request waits for the runner's answer: a read of the end of one file. A variable only so
// that tests can shorten it; the apiserver waits longer (BACKGROUND_JOB_TAIL_TIMEOUT_MS).
var bgTailTimeout = 2500 * time.Millisecond

// pendingTail is a background job tail request relayed to the runner and not answered yet.
type pendingTail struct {
	requestID, sessionID, jobID, reply string
	timer                              *time.Timer
	done                               atomic.Bool
}

// answer publishes resp, or an answer with only the outcome, on the request's reply subject, once.
func (p *pendingTail) answer(g *gateway, resp *linkpb.BackgroundJobTailResponse, outcome linkpb.BackgroundJobTailOutcome, result string) {
	if !p.done.CompareAndSwap(false, true) {
		return
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	g.metrics.bgTailRequests.inc(result)
	if resp == nil {
		resp = &linkpb.BackgroundJobTailResponse{RequestId: p.requestID, SessionId: p.sessionID, JobId: p.jobID, Outcome: outcome}
	}
	if g.hints == nil {
		return
	}
	data, err := protojson.Marshal(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailResponse{BackgroundJobTailResponse: resp}})
	if err == nil {
		err = g.hints.nc.Publish(p.reply, data)
	}
	if err != nil {
		g.log.Warn("a background job tail answer was not published", "session", p.sessionID, "job", p.jobID, "err", err)
	}
}

// tailable reports whether the connection's Hello declared bg-output-tail/v1.
func (c *conn) tailable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Contains(c.hello.GetCapabilities(), bgTailCapability)
}

// relayTailRequest hands a background job tail request from NATS to the runner.
func (g *gateway) relayTailRequest(runner string, req *linkpb.BackgroundJobTailRequest, reply string) {
	session, ok := sessionUUID(req.GetSessionId())
	p := &pendingTail{requestID: req.GetRequestId(), sessionID: session, jobID: req.GetJobId(), reply: reply}
	if reply == "" || !requestIDPattern.MatchString(p.requestID) || !ok || req.GetJobId() == "" {
		g.metrics.bgTailRequests.inc("malformed")
		return
	}
	var best *conn
	var bestAt time.Time
	supervising, connected := false, false
	for _, c := range g.reg.connsOf(runner) {
		if c.link == nil {
			continue
		}
		connected = true
		if !c.tailable() {
			continue
		}
		owns := c.link.supervises(p.sessionID)
		at := c.welcomeTime()
		switch {
		case best == nil, owns && !supervising, owns == supervising && at.After(bestAt):
			best, bestAt, supervising = c, at, owns
		}
	}
	switch {
	case best != nil:
		best.link.askTail(p, req)
	case connected:
		p.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_UNSUPPORTED, "unsupported")
	default:
		p.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NO_CONNECTION, "no_connection")
	}
}

// askTail sends the runner the request, in the tier of hints and RPC results, and waits for its answer up to
// bgTailTimeout.
func (l *linkState) askTail(p *pendingTail, req *linkpb.BackgroundJobTailRequest) {
	g := l.c.g
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		p.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NO_CONNECTION, "closed")
		return
	}
	old := l.tails[p.requestID]
	// Set before p can be found, so whoever answers it reads its timer.
	p.timer = time.AfterFunc(bgTailTimeout, func() {
		if l.takeTail(p.requestID, p) {
			p.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_TIMEOUT, "timeout")
		}
	})
	l.tails[p.requestID] = p
	l.mu.Unlock()
	if old != nil {
		old.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_TIMEOUT, "superseded")
	}
	if !l.c.offer(&linkpb.Frame{Body: &linkpb.Frame_BackgroundJobTailRequest{BackgroundJobTailRequest: &linkpb.BackgroundJobTailRequest{
		RequestId: p.requestID, SessionId: p.sessionID, JobId: p.jobID,
		MaxLines: req.GetMaxLines(), MaxBytes: req.GetMaxBytes(),
	}}}) {
		if l.takeTail(p.requestID, p) {
			p.answer(g, nil, linkpb.BackgroundJobTailOutcome_BACKGROUND_JOB_TAIL_OUTCOME_NO_CONNECTION, "dropped")
		}
	}
}

// takeTail removes p from the waiting requests, if it is still there.
func (l *linkState) takeTail(id string, p *pendingTail) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.tails[id] != p {
		return false
	}
	delete(l.tails, id)
	return true
}

// onTailAnswer relays the runner's BackgroundJobTailResponse to whoever asked.
func (l *linkState) onTailAnswer(resp *linkpb.BackgroundJobTailResponse) {
	l.mu.Lock()
	p := l.tails[resp.GetRequestId()]
	delete(l.tails, resp.GetRequestId())
	l.mu.Unlock()
	if p == nil {
		l.c.g.metrics.bgTailRequests.inc("unknown_answer")
		return
	}
	p.answer(l.c.g, resp, resp.GetOutcome(), "answered")
}
