package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// The control channel on its own: what makes an interrupt an operation with an answer
// rather than a frame pushed into a pipe and hoped about.
//
// Every test here is about one question — can this code ever report an interrupt as done
// when the CLI did not say so? A refusal, a deadline, a broken stdin, a dead process and a
// straggling reply from a process that no longer exists all have to come back as failures,
// and the one success path has to be a reply carrying this request's own id.

// decodeControlRequest reads a control_request frame off the wire.
func decodeControlRequest(t *testing.T, line string) map[string]interface{} {
	t.Helper()
	var msg map[string]interface{}
	if err := json.Unmarshal([]byte(line), &msg); err != nil {
		t.Fatalf("control frame is not JSON (%v): %s", err, line)
	}
	if msg["type"] != frameControlRequest {
		t.Fatalf("frame is a %v, want a control_request: %s", msg["type"], line)
	}
	return msg
}

// controlRequestOn sends an interrupt and returns the waiter plus the id the CLI saw.
func controlRequestOn(t *testing.T, rt *pipeRuntime) (*controlWaiter, string) {
	t.Helper()
	w, err := rt.requestControl(ctrlInterrupt)
	if err != nil {
		t.Fatalf("requestControl: %v", err)
	}
	msg := decodeControlRequest(t, rt.nextLine(t))
	onWire, _ := msg["request_id"].(string)
	if onWire != w.id {
		t.Fatalf("the CLI was asked under id %q while the waiter is registered under %q", onWire, w.id)
	}
	return w, onWire
}

func successResponse(id string) claudeControlResponse {
	return claudeControlResponse{RequestID: id, Subtype: ctrlSuccess, Response: map[string]interface{}{}}
}

// The frame the CLI receives is a control_request carrying the interrupt subtype and the
// id its answer must echo — the shape claude_protocol.go promises, produced through the
// same single writer every other frame goes through.
func TestControlRequestReachesTheCLIAsAnInterruptItCanAnswer(t *testing.T) {
	rt := newPipeRuntime(t)
	w, id := controlRequestOn(t, rt)
	msg := decodeControlRequest(t, marshalFrame(map[string]interface{}{
		"type": frameControlRequest, "request_id": id,
		"request": map[string]interface{}{"subtype": w.subtype},
	}))
	req, _ := msg["request"].(map[string]interface{})
	if req == nil || req["subtype"] != ctrlInterrupt {
		t.Fatalf("the CLI was asked for %v, want an interrupt", req)
	}
	if id == "" {
		t.Fatal("the interrupt carried no request_id, so no answer could ever be routed to it")
	}
}

// A subtype's argument reaches the CLI through the same path the interrupt takes, in the
// request object beside the subtype — and under the id the waiter is registered on, so the
// answer to a mode or model change routes back like any other. An argument that never made
// it onto the wire would be a setting that silently did not change.
func TestControlRequestCarriesItsArgumentToTheCLI(t *testing.T) {
	rt := newPipeRuntime(t)
	w, err := rt.requestControlWith(ctrlSetModel, map[string]interface{}{"model": "claude-sonnet-5"})
	if err != nil {
		t.Fatalf("requestControlWith: %v", err)
	}
	msg := decodeControlRequest(t, rt.nextLine(t))
	if msg["request_id"] != w.id {
		t.Fatalf("the CLI was asked under id %v while the waiter is registered under %q", msg["request_id"], w.id)
	}
	req, _ := msg["request"].(map[string]interface{})
	if req == nil || req["subtype"] != ctrlSetModel || req["model"] != "claude-sonnet-5" {
		t.Fatalf("the CLI was asked %v, want set_model carrying the model", msg["request"])
	}
}

// Ids are unique — within one process and, crucially, across a re-spawn. A counter that
// restarted with each process would hand the session's second CLI the same id its first
// one used, and an answer from the first would then be matched against the second's
// request.
func TestControlRequestIDsAreUniqueAcrossProcessGenerations(t *testing.T) {
	first, second := newPipeRuntime(t), newPipeRuntime(t)
	if first.generation == second.generation {
		t.Fatalf("two processes share generation %d", first.generation)
	}
	seen := map[string]bool{}
	for _, rt := range []*pipeRuntime{first, second, first, second} {
		_, id := controlRequestOn(t, rt)
		if seen[id] {
			t.Fatalf("request id %q was minted twice", id)
		}
		seen[id] = true
		if got := controlIDGeneration(id); got != rt.generation {
			t.Errorf("id %q names generation %d, want %d", id, got, rt.generation)
		}
	}
}

// The success path, and the only one: the CLI answers THIS request's id, and the wait ends
// with no error.
func TestControlRequestSucceedsOnItsOwnAnswer(t *testing.T) {
	rt := newPipeRuntime(t)
	w, id := controlRequestOn(t, rt)
	if !rt.resolveControl(successResponse(id)) {
		t.Fatal("the CLI's answer matched no outstanding request")
	}
	if err := rt.awaitControl(context.Background(), w, fakeClaudeTimeout); err != nil {
		t.Fatalf("a request the CLI answered with success reported %v", err)
	}
}

// An answer to some other request settles nothing. With one shared slot instead of a
// routing table, this reply would be handed to whoever happens to be waiting — which is
// exactly how an interrupt gets reported as confirmed by the answer to something else.
func TestControlResponseForAnotherRequestResolvesNothing(t *testing.T) {
	rt := newPipeRuntime(t)
	w, id := controlRequestOn(t, rt)
	other := controlRequestID(rt.generation, 999)
	if rt.resolveControl(successResponse(other)) {
		t.Fatalf("a response for %q resolved something", other)
	}
	select {
	case <-w.done:
		t.Fatal("the outstanding request was settled by an answer that was not addressed to it")
	default:
	}
	rt.resolveControl(successResponse(id))
	if err := rt.awaitControl(context.Background(), w, fakeClaudeTimeout); err != nil {
		t.Fatalf("the request's own answer reported %v", err)
	}
}

// A reply from an earlier process — the two can overlap while one is being torn down —
// resolves nothing here, even though its counter value is one this process has also used.
// The generation in the id is what keeps the two apart, and one waiter table per process
// is what makes the straggler unroutable rather than merely improbable.
func TestControlResponseFromAnEarlierGenerationIsDropped(t *testing.T) {
	rt := newPipeRuntime(t)
	w, live := controlRequestOn(t, rt)
	stale := controlRequestID(rt.generation-1, rt.ctrlSeq.Load())
	if stale == live {
		t.Fatalf("the two generations minted the same id %q", live)
	}
	if rt.resolveControl(successResponse(stale)) {
		t.Fatalf("a straggler from generation %d was matched here", rt.generation-1)
	}
	select {
	case <-w.done:
		t.Fatal("a straggling answer from a dead process settled a live request")
	default:
	}
	if got := controlIDGeneration(stale); got != rt.generation-1 {
		t.Errorf("the stray id attributes itself to generation %d, want %d", got, rt.generation-1)
	}
}

// An answer is given once. Whichever path reaches the request first owns it — a CLI reply,
// a broken stdin, a deadline — and a second one changes nothing. Without that, the reply
// that turns up just after a timeout would overwrite the failure the caller was already
// told about, and an interrupt reported as failed would quietly become a success.
func TestARequestKeepsTheFirstAnswerItWasGiven(t *testing.T) {
	w := &controlWaiter{id: "req-1-1", subtype: ctrlInterrupt, done: make(chan struct{})}
	if !w.settle(claudeControlResponse{}, errControlUnanswered) {
		t.Fatal("the first answer was refused")
	}
	if w.settle(successResponse(w.id), nil) {
		t.Fatal("a second answer was accepted for a request that was already settled")
	}
	if !errors.Is(w.err, errControlUnanswered) {
		t.Fatalf("the request now reports %v, want the answer it was first given (%v)", w.err, errControlUnanswered)
	}
}

// An error answer is an answer: the request fails, carrying the CLI's own words, and is
// not rounded up to "it probably stopped".
func TestControlRequestFailsOnAnErrorResponse(t *testing.T) {
	rt := newPipeRuntime(t)
	w, id := controlRequestOn(t, rt)
	rt.resolveControl(claudeControlResponse{RequestID: id, Subtype: ctrlError, Error: "no turn is running"})
	err := rt.awaitControl(context.Background(), w, fakeClaudeTimeout)
	if err == nil {
		t.Fatal("a refused interrupt reported success")
	}
	if !strings.Contains(err.Error(), "no turn is running") {
		t.Fatalf("the failure lost the engine's own reason: %v", err)
	}
}

// Silence past the deadline is a failure, and the waiter is retired on the way out — so
// the answer that turns up a moment later has nothing left to resolve and cannot turn a
// reported failure into a success after the fact.
func TestControlRequestTimesOutAndIgnoresTheLateAnswer(t *testing.T) {
	rt := newPipeRuntime(t)
	w, id := controlRequestOn(t, rt)
	if err := rt.awaitControl(context.Background(), w, 20*time.Millisecond); !errors.Is(err, errControlUnanswered) {
		t.Fatalf("an unanswered interrupt reported %v, want %v", err, errControlUnanswered)
	}
	// Gone from the table the moment the caller stopped waiting. A session interrupting
	// all day would otherwise accumulate one dead entry per attempt, in a map nothing
	// ever prunes.
	rt.mu.Lock()
	outstanding := len(rt.control)
	rt.mu.Unlock()
	if outstanding != 0 {
		t.Fatalf("%d request(s) still outstanding after the wait gave up", outstanding)
	}
	if rt.resolveControl(successResponse(id)) {
		t.Fatal("an answer arriving after the timeout was still routed to the request that gave up")
	}
	if err := rt.awaitControl(context.Background(), w, time.Millisecond); !errors.Is(err, errControlUnanswered) {
		t.Fatalf("the settled request changed its answer to %v", err)
	}
}

// A process that has exited answers nothing. Every request outstanding fails at once,
// rather than each one waiting out its own deadline for a reply that cannot come.
func TestProcessGoingAwayFailsEveryOutstandingRequest(t *testing.T) {
	rt := newPipeRuntime(t)
	first, _ := controlRequestOn(t, rt)
	second, _ := controlRequestOn(t, rt)
	rt.markTerminal()
	for i, w := range []*controlWaiter{first, second} {
		if err := rt.awaitControl(context.Background(), w, time.Second); !errors.Is(err, errRuntimeGone) {
			t.Errorf("request %d on a dead process reported %v, want %v", i, err, errRuntimeGone)
		}
	}
}

// A request cannot even be made of a process that is already gone: it fails where it is
// asked for, leaving nothing outstanding for a reply that will never come.
func TestControlRequestIsRefusedByAProcessThatHasExited(t *testing.T) {
	rt := newPipeRuntime(t)
	rt.markTerminal()
	if _, err := rt.requestControl(ctrlInterrupt); !errors.Is(err, errRuntimeGone) {
		t.Fatalf("requesting control of a dead process reported %v, want %v", err, errRuntimeGone)
	}
}

// stdin broke while the request was in the queue: the frame the CLI would have answered
// never reached it, so the request fails with the write's own error instead of sitting out
// the deadline.
func TestControlRequestFailsWhenItsFrameCannotBeWritten(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	w, err := rt.requestControl(ctrlInterrupt)
	if err != nil {
		t.Fatalf("requestControl: %v", err)
	}
	rt.r.Close() // the reader is gone: the next write to this pipe fails
	if err := rt.awaitControl(context.Background(), w, fakeClaudeTimeout); err == nil {
		t.Fatal("a request whose frame never reached the CLI reported success")
	}
}

// A CLI that stopped reading stdin fills the queue. The interrupt is refused at the door,
// named as a queue that would not take it — never accepted and then silently dropped.
func TestControlRequestIsRefusedWhenTheQueueIsFull(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	filler := textFrame(strings.Repeat("x", 128*1024))
	for i := 0; i < claudeWriteQueueDepth+1; i++ {
		if err := rt.send(filler); err != nil {
			break
		}
	}
	if _, err := rt.requestControl(ctrlInterrupt); !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("an interrupt offered to a full queue reported %v, want %v", err, errWriteQueueFull)
	}
}

// The caller giving up — the process being torn down around it — is not a success either.
func TestControlRequestFailsWhenTheCallerStopsWaiting(t *testing.T) {
	rt := newPipeRuntime(t)
	w, _ := controlRequestOn(t, rt)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := rt.awaitControl(ctx, w, fakeClaudeTimeout); !errors.Is(err, context.Canceled) {
		t.Fatalf("an abandoned request reported %v, want %v", err, context.Canceled)
	}
}

// interruptRuntime is the whole operation: ask, and answer for it. Nothing here reaches for
// the process — the CLI is asked, and only its own answer makes this succeed.
func TestInterruptRuntimeSucceedsOnlyOnTheCLIsAnswer(t *testing.T) {
	rt := newPipeRuntime(t)
	done := make(chan error, 1)
	var id string
	go func() {
		gotID, err := interruptRuntime(context.Background(), rt.claudeRuntime)
		id = gotID
		done <- err
	}()
	msg := decodeControlRequest(t, rt.nextLine(t))
	onWire, _ := msg["request_id"].(string)
	rt.resolveControl(successResponse(onWire))
	if err := <-done; err != nil {
		t.Fatalf("a confirmed interrupt reported %v", err)
	}
	if id != onWire {
		t.Fatalf("interruptRuntime reported id %q, the CLI answered %q", id, onWire)
	}
	if rt.pid() == 0 && rt.cmd != nil {
		t.Fatal("the process was reached for instead of the protocol")
	}
}
