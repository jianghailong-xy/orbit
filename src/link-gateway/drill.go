package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"orbit/link-gateway/linkpb"
)

// A drill's fault (docs/runner-link-design.md §10, an answer lost on its way; task C1c): LINK_DRILL_LOSE_ANSWERS makes
// the gateway lose answers on their way to the runner, so that a staging drill can watch the runner and the control
// plane recover them (scripts/runner-link/drills/lost-answer-drill.sh). The gateway has the apiserver's answer, so the
// claim or the lease it hands out is committed, and instead of relaying it the gateway cuts the runner's connection,
// with no Close frame, as a network that drops does. The runner reconnects and sends the call again under the same
// request_id. The gateway logs the loss, and the answer that call gets next: how long after the loss, and what it hands
// out.
//
// Unset, which is the default and every deployment's setting, the gateway loses nothing.

// drillCall is a call whose answers a drill can lose. An answer is lost only when it hands out work, which the route
// has then recorded as handed out to this runner.
type drillCall struct {
	method string
	path   *regexp.Regexp // the TunnelRequest's path, its query left out
	work   string         // the answer's field naming what it hands out; empty or absent, it hands out nothing
	kinds  []string       // when set, the answer's kind must be one of them
}

// drillCalls are the calls LINK_DRILL_LOSE_ANSWERS can name.
var drillCalls = map[string]drillCall{
	// A claim that handed out a session: the session is RUNNING, claimed by this runner under the call's request id.
	"claim": {method: "GET", path: regexp.MustCompile(`^/runner/sessions/claim$`), work: "sessionId"},
	// An inbox fetch that leased a message or shell turn: the turn is IN_FLIGHT under the fetch's lease generation.
	// Control turns and steers are never lost.
	"inbox": {method: "GET", path: regexp.MustCompile(`^/runner/sessions/[^/]+/inbox$`), work: "turnId",
		kinds: []string{"message", "shell"}},
}

// handsOut is what an answer of the call hands out, "" when it hands out nothing, as a refusal never does.
func (d drillCall) handsOut(t *linkpb.TunnelResponse) string {
	if t.GetStatus()/100 != 2 {
		return ""
	}
	var answer map[string]any
	if json.Unmarshal(t.GetJsonBody(), &answer) != nil {
		return ""
	}
	work, _ := answer[d.work].(string)
	if work == "" {
		return ""
	}
	if len(d.kinds) > 0 {
		if kind, _ := answer["kind"].(string); !slices.Contains(d.kinds, kind) {
			return ""
		}
	}
	return work
}

// parseDrillLoseAnswers reads LINK_DRILL_LOSE_ANSWERS: the names of drillCalls, comma-separated, each with how many of
// its answers to lose (claim:3), one when it says no number. Empty, it arms nothing.
func parseDrillLoseAnswers(v string) (map[string]int, error) {
	entries := splitList(v)
	if len(entries) == 0 {
		return nil, nil
	}
	counts := map[string]int{}
	for _, entry := range entries {
		name, count, numbered := strings.Cut(entry, ":")
		if _, ok := drillCalls[name]; !ok {
			return nil, fmt.Errorf("LINK_DRILL_LOSE_ANSWERS: %q is not claim or inbox", name)
		}
		n := 1
		if numbered {
			var err error
			if n, err = strconv.Atoi(count); err != nil || n <= 0 {
				return nil, fmt.Errorf("LINK_DRILL_LOSE_ANSWERS: %q is not a call and a positive count, such as claim:3", entry)
			}
		}
		counts[name] += n
	}
	return counts, nil
}

// drillFaults is what LINK_DRILL_LOSE_ANSWERS armed, and the calls whose answers it lost.
type drillFaults struct {
	mu   sync.Mutex
	left map[string]int         // by call: answers still to lose
	lost map[string]*lostAnswer // by runner and request_id: no more of them than were armed
}

type lostAnswer struct {
	call, work string
	at         time.Time
	answered   bool // the call has been answered again since
}

func newDrillFaults(counts map[string]int) *drillFaults {
	d := &drillFaults{left: map[string]int{}, lost: map[string]*lostAnswer{}}
	for name, n := range counts {
		d.left[name] = n
	}
	return d
}

// String is what is armed, as LINK_DRILL_LOSE_ANSWERS spells it.
func (d *drillFaults) String() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	parts := make([]string, 0, len(d.left))
	for name, n := range d.left {
		parts = append(parts, name+":"+strconv.Itoa(n))
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// lose decides whether result, the answer to rpc, is lost on its way to c's runner. When it is, the connection is cut
// in its place, and lose reports true: the caller relays nothing. A call's answer is lost once: the call sent again
// under the same request_id is answered, whatever is left to lose.
func (d *drillFaults) lose(c *conn, rpc *linkpb.Rpc, result *linkpb.RpcResult) bool {
	if d == nil {
		return false
	}
	name, call, ok := drillCallOf(rpc.GetTunnel())
	if !ok {
		return false
	}
	work := call.handsOut(result.GetTunnel())
	if work == "" {
		return false
	}
	key := c.claims.RunnerID + " " + rpc.GetRequestId()
	d.mu.Lock()
	if _, again := d.lost[key]; again || d.left[name] == 0 {
		d.mu.Unlock()
		return false
	}
	d.left[name]--
	left := d.left[name]
	d.lost[key] = &lostAnswer{call: name, work: work, at: time.Now()}
	d.mu.Unlock()
	c.log.Warn("drill: an answer is lost on its way to the runner; the connection is cut",
		"call", name, "request", rpc.GetRequestId(), "work", work, "left", left)
	c.setReason("drill_lost_answer")
	_ = c.ws.CloseNow()
	return true
}

// relayed notes a frame written to c's runner: the first RpcResult for a call whose answer was lost is that call
// answered again, on whichever connection the runner sent it on.
func (d *drillFaults) relayed(c *conn, f *linkpb.Frame) {
	if d == nil {
		return
	}
	res := f.GetRpcResult()
	if res == nil {
		return
	}
	d.mu.Lock()
	lost := d.lost[c.claims.RunnerID+" "+res.GetRequestId()]
	first := lost != nil && !lost.answered
	if first {
		lost.answered = true
	}
	d.mu.Unlock()
	if !first {
		return
	}
	work, outcome := drillCalls[lost.call].handsOut(res.GetTunnel()), res.GetFailure().GetCode()
	if t := res.GetTunnel(); t != nil {
		outcome = strconv.Itoa(int(t.GetStatus()))
	}
	c.log.Warn("drill: the call whose answer was lost is answered again",
		"call", lost.call, "request", res.GetRequestId(), "after_ms", time.Since(lost.at).Milliseconds(),
		"answer", outcome, "work", work, "same_work", work == lost.work)
}

// drillCallOf is the drill call a TunnelRequest makes, if any.
func drillCallOf(t *linkpb.TunnelRequest) (string, drillCall, bool) {
	path, _, _ := strings.Cut(t.GetPath(), "?")
	for name, call := range drillCalls {
		if t.GetMethod() == call.method && call.path.MatchString(path) {
			return name, call, true
		}
	}
	return "", drillCall{}, false
}

// A load test's slow ingest (LINK_DRILL_INGEST_RATE): the gateway forwards at most that many durable events a second,
// each batch in its turn in the order it came, so that a staging load test can have its runners send faster than the
// events are stored and watch the ingest queue stop at its bound (events.go). A batch waiting its turn counts in the
// queue as one the apiserver is slow to store does. Unset, which is every deployment's setting, batches are forwarded
// as they come.

// pacer holds batches to a rate of events.
type pacer struct {
	mu    sync.Mutex
	every time.Duration // the time one event takes
	next  time.Time     // when the next batch may go
}

func newPacer(rate float64) *pacer {
	return &pacer{every: time.Duration(float64(time.Second) / rate)}
}

// wait holds a batch of n events until its turn. False when ctx ended first.
func (p *pacer) wait(ctx context.Context, n int) bool {
	p.mu.Lock()
	at := p.next
	if now := time.Now(); at.Before(now) {
		at = now
	}
	p.next = at.Add(time.Duration(n) * p.every)
	p.mu.Unlock()
	t := time.NewTimer(time.Until(at))
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
