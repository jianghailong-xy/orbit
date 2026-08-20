package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// receipts: accepted is not arrived
// ---------------------------------------------------------------------------

// A frame handed to a CLI that is reading its stdin is accepted first and written after —
// two facts, in that order, both observable. Nothing may report the write before it happened.
func TestWriteReceiptSettlesOnlyOnceTheBytesAreWritten(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	slot, err := rt.reserve()
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	receipt := slot.commit(textFrame("hello"))
	// Nobody is reading the pipe, but the frame is small enough for the kernel buffer, so
	// this write completes on its own.
	if err := receipt.wait(testContext(t)); err != nil {
		t.Fatalf("receipt for a written frame: %v", err)
	}
	line, _ := readLine(t, rt.r)
	if got := userFrameText(t, decodeWrittenFrame(t, line)); got != "hello" {
		t.Errorf("the settled frame carried %q, want %q", got, "hello")
	}
}

// The case the split exists for: a `claude` inside a tool call has stopped reading stdin.
// The frame is accepted — the session owns delivering it — and stays unwritten for as long
// as the CLI is not reading. Anything that calls that "sent" is guessing.
func TestWriteReceiptStaysOpenWhileTheChildIsNotReading(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	// Fill the pipe so the writer parks inside a write, then queue the frame under test
	// behind it.
	if err := rt.send(textFrame(strings.Repeat("x", 128*1024))); err != nil {
		t.Fatal(err)
	}
	slot, err := rt.reserve()
	if err != nil {
		t.Fatalf("reserve behind a wedged write: %v", err)
	}
	receipt := slot.commit(textFrame("queued behind a tool call"))

	settled, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := receipt.wait(settled); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a frame behind a child that stopped reading settled as %v; it has not arrived", err)
	}

	// Drain the pipe: the parked write completes, the queue moves, and the frame lands.
	go func() {
		buf := make([]byte, 64*1024)
		for {
			if _, err := rt.r.Read(buf); err != nil {
				return
			}
		}
	}()
	if err := receipt.wait(testContext(t)); err != nil {
		t.Fatalf("receipt once the child resumed reading: %v", err)
	}
}

// A frame the queue refuses is refused before anything is written, so a caller can decide
// what to record knowing the answer. Every refusal names its own cause.
func TestReserveRefusesBeforeAnythingIsWritten(t *testing.T) {
	t.Run("queue full", func(t *testing.T) {
		rt := newUnreadPipeRuntime(t)
		// One frame is taken by the writer and parks there; the queue absorbs the depth
		// after it, and the reservation past that is refused.
		big := textFrame(strings.Repeat("x", 128*1024))
		var lastErr error
		for i := 0; i < claudeWriteQueueDepth+8; i++ {
			slot, err := rt.reserve()
			if err != nil {
				lastErr = err
				break
			}
			slot.commit(big)
		}
		if !errors.Is(lastErr, errWriteQueueFull) {
			t.Fatalf("reserving into a wedged child returned %v, want %v", lastErr, errWriteQueueFull)
		}
	})
	t.Run("closed stdin", func(t *testing.T) {
		rt := newPipeRuntime(t)
		rt.close() // what an `end` turn does
		if _, err := rt.reserve(); !errors.Is(err, errRuntimeClosed) {
			t.Fatalf("reserving on closed stdin returned %v, want %v", err, errRuntimeClosed)
		}
	})
	t.Run("process gone", func(t *testing.T) {
		rt := newPipeRuntime(t)
		rt.markTerminal()
		if _, err := rt.reserve(); !errors.Is(err, errRuntimeGone) {
			t.Fatalf("reserving on an exited child returned %v, want %v", err, errRuntimeGone)
		}
	})
}

// A place given back is a place another frame can take, so an abandoned reservation
// doesn't shrink the queue for the rest of the session.
func TestAbandonedReservationReturnsItsPlace(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	big := textFrame(strings.Repeat("x", 128*1024))
	slots := []*writeSlot{}
	for {
		slot, err := rt.reserve()
		if err != nil {
			break
		}
		slots = append(slots, slot)
	}
	if len(slots) == 0 {
		t.Fatal("a fresh runtime reserved nothing")
	}
	slots[0].abandon()
	slot, err := rt.reserve()
	if err != nil {
		t.Fatalf("the abandoned place was not returned: %v", err)
	}
	slot.commit(big)
}

// A frame accepted into a pipe that then breaks is reported, not dropped: the receipt is
// how a sender learns the message it was promised will never arrive.
func TestWriteReceiptReportsAFrameThatWillNeverArrive(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	rt.r.Close() // no reader left: the next write is EPIPE
	slot, err := rt.reserve()
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	receipt := slot.commit(textFrame("into the void"))
	err = receipt.wait(testContext(t))
	if err == nil {
		t.Fatal("a frame written into a broken pipe settled as delivered")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("a frame written into a broken pipe never settled at all")
	}
}

// Once the pipe is gone the writer stops writing — and still settles every frame it takes
// out of the queue, so a message behind the break is reported rather than silently lost.
func TestWriteReceiptSettlesFramesBehindABrokenPipe(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	rt.r.Close()
	first, err := rt.reserve()
	if err != nil {
		t.Fatal(err)
	}
	firstReceipt := first.commit(textFrame("breaks the pipe"))
	if err := firstReceipt.wait(testContext(t)); err == nil {
		t.Fatal("writing into a closed pipe reported success")
	}
	second, err := rt.reserve()
	if err == nil {
		if err := second.commit(textFrame("behind the break")).wait(testContext(t)); err == nil {
			t.Fatal("a frame behind a broken pipe settled as delivered")
		}
		return
	}
	// Reserving may already report the recorded write error — also an answer, never silence.
	if errors.Is(err, errWriteQueueFull) {
		t.Fatalf("a broken pipe was reported as a full queue: %v", err)
	}
}

// A slot is one frame's place: committing twice must not put a second frame on the wire
// (which would double the message) or hand back a place that was never taken.
func TestWriteSlotCommitsAtMostOneFrame(t *testing.T) {
	rt := newPipeRuntime(t)
	slot, err := rt.reserve()
	if err != nil {
		t.Fatal(err)
	}
	slot.commit(textFrame("once"))
	slot.commit(textFrame("twice"))
	if got := userFrameText(t, decodeWrittenFrame(t, rt.nextLine(t))); got != "once" {
		t.Fatalf("first frame carried %q, want %q", got, "once")
	}
	if err := rt.send(textFrame("after")); err != nil {
		t.Fatal(err)
	}
	if got := userFrameText(t, decodeWrittenFrame(t, rt.nextLine(t))); got != "after" {
		t.Errorf("a second commit put %q on the wire", got)
	}
}

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

// The whole progression, in the order the states are meant to occur.
func TestDeliveryLedgerWalksAMessageFromPendingToAcknowledged(t *testing.T) {
	l := &deliveryLedger{}
	d := newMessageDelivery("turn-1", false)
	if d.state != deliveryPending {
		t.Errorf("a pulled message starts at %q, want %q", d.state, deliveryPending)
	}
	l.accept(d, newWriteReceipt())
	if got := l.outstanding(); len(got) != 1 || got[0] != d {
		t.Fatalf("an accepted message is %v, want the one just accepted", got)
	}
	if !l.markWritten(d) {
		t.Fatal("the write of an enqueued message was not recorded")
	}
	if l.markWritten(d) {
		t.Error("a message already written was written a second time")
	}
	acked, ok := l.acknowledgeNext()
	if !ok || acked != d {
		t.Fatalf("the replay answered %v, want the one written message", acked)
	}
	if len(l.outstanding()) != 0 {
		t.Error("an acknowledged message is still outstanding")
	}
	if l.markWritten(d) {
		t.Error("an acknowledged message was moved back to written")
	}
}

// The property the whole correlation rests on: replays are matched by position, so two
// messages carrying the very same text are still told apart. Matching on content could
// not tell them apart at all.
func TestDeliveryLedgerCorrelatesIdenticalMessagesByOrder(t *testing.T) {
	l := &deliveryLedger{}
	first, second := newMessageDelivery("turn-1", false), newMessageDelivery("turn-2", false)
	l.accept(first, newWriteReceipt())
	l.accept(second, newWriteReceipt())

	got1, _ := l.acknowledgeNext()
	got2, _ := l.acknowledgeNext()
	if got1 != first || got2 != second {
		t.Fatalf("replays answered %v then %v, want turn-1 then turn-2",
			got1.turnID, got2.turnID)
	}
}

// A message that failed leaves the correlation queue, so the replays that follow still
// line up with the messages that are actually on their way.
func TestDeliveryLedgerKeepsCorrelationAfterAFailure(t *testing.T) {
	l := &deliveryLedger{}
	first, second := newMessageDelivery("turn-1", false), newMessageDelivery("turn-2", false)
	l.accept(first, newWriteReceipt())
	l.accept(second, newWriteReceipt())
	if !l.fail(first) {
		t.Fatal("failing an enqueued message was refused")
	}
	acked, ok := l.acknowledgeNext()
	if !ok || acked != second {
		t.Fatalf("the replay answered %v, want turn-2 — the failed message must not absorb it", acked)
	}
	if l.fail(second) {
		t.Error("an acknowledged message was re-settled as failed")
	}
}

// A replay with nothing outstanding — a tool result mistaken for one, say — answers no
// message rather than the next one to come along.
func TestDeliveryLedgerAnswersNothingWhenNoMessageIsOutstanding(t *testing.T) {
	l := &deliveryLedger{}
	if _, ok := l.acknowledgeNext(); ok {
		t.Error("a replay answered a message that was never sent")
	}
	d := newMessageDelivery("turn-1", false)
	l.accept(d, newWriteReceipt())
	if got, ok := l.acknowledgeNext(); !ok || got != d {
		t.Error("the message sent after a stray replay was not the one the next replay answered")
	}
}

// ---------------------------------------------------------------------------
// telling a replay from the CLI's own user-role traffic
// ---------------------------------------------------------------------------

func TestIsReplayedUserTurn(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		want bool
	}{
		{"our own frame echoed back", textFrame("rename the widget"), true},
		{"an image turn", userFrame("s", []map[string]interface{}{
			{"type": "image", "source": map[string]interface{}{"type": "base64"}},
			{"type": "text", "text": "what is this"},
		}), true},
		{"a tool result", `{"type":"user","parent_tool_use_id":null,"message":{"role":"user",` +
			`"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"widget.go"}]}}`, false},
		{"a background-task notification", `{"type":"user","parent_tool_use_id":null,` +
			`"message":{"role":"user","content":"<task-notification>done</task-notification>"}}`, false},
		{"a sub-agent's own turn", `{"type":"user","parent_tool_use_id":"toolu_9","message":` +
			`{"role":"user","content":[{"type":"text","text":"sub-agent prompt"}]}}`, false},
		{"an assistant message", assistantFrame("s", map[string]interface{}{"type": "text", "text": "hi"}), false},
		{"an empty content list", `{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[]}}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var msg map[string]interface{}
			if err := json.Unmarshal([]byte(c.msg), &msg); err != nil {
				t.Fatalf("bad fixture: %v", err)
			}
			if got := isReplayedUserTurn(msg); got != c.want {
				t.Errorf("isReplayedUserTurn = %v, want %v", got, c.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// what a dying process owes
// ---------------------------------------------------------------------------

type settledTurn struct {
	turnID string
	status string
	result string
}

type reportedDelivery struct {
	turnID    string
	state     deliveryState
	reason    string
	retryable bool
}

func recordingReporter(into *[]reportedDelivery) deliveryReporter {
	return func(turnID string, state deliveryState, reason string, retryable bool) {
		*into = append(*into, reportedDelivery{turnID, state, reason, retryable})
	}
}

func recordingCompleter(into *[]settledTurn) turnCompleter {
	return func(r TurnCompleteRequest, _ ...context.Context) error {
		*into = append(*into, settledTurn{r.TurnID, r.Status, r.Result})
		return nil
	}
}

// A message the engine never got is safe to send again — nothing ran — so the turn is left
// unanswered for the next process to feed, and the failed attempt goes on the record
// instead of standing as a message that looks delivered.
func TestSettleUndeliveredLeavesANeverWrittenMessageRetryable(t *testing.T) {
	l := &deliveryLedger{}
	d := newMessageDelivery("turn-1", false)
	l.accept(d, newWriteReceipt()) // still queued: the writer never got to it
	var settled []settledTurn
	var reports []reportedDelivery
	settleUndeliveredMessages(l, &ClaimedSession{}, recordingCompleter(&settled), recordingReporter(&reports))

	if len(settled) != 0 {
		t.Errorf("a message that was never written settled its turn as %v; it must stay retryable", settled)
	}
	if len(reports) != 1 || reports[0].state != deliveryFailed || !reports[0].retryable {
		t.Fatalf("reported %v, want one retryable failure", reports)
	}
	if !strings.Contains(reports[0].reason, "before this message was written") {
		t.Errorf("the failure reason %q does not say the message never reached the engine", reports[0].reason)
	}
}

// The ambiguous one: the engine was handed the message and died without echoing it back,
// so nobody can say whether it acted on it. Re-delivering would risk doing the work twice,
// so the turn is settled and the decision left to a person.
func TestSettleUndeliveredDoesNotRetryAnUnconfirmedMessage(t *testing.T) {
	l := &deliveryLedger{}
	acked, unconfirmed := newMessageDelivery("turn-1", false), newMessageDelivery("turn-2", false)
	l.accept(acked, writtenReceipt())
	l.accept(unconfirmed, writtenReceipt())
	l.acknowledgeNext() // turn-1 came back and is part of the conversation

	var settled []settledTurn
	var reports []reportedDelivery
	settleUndeliveredMessages(l, &ClaimedSession{}, recordingCompleter(&settled), recordingReporter(&reports))

	if len(settled) != 1 || settled[0].turnID != "turn-2" || settled[0].status != stFailed {
		t.Fatalf("settled %v, want turn-2 failed so it is never re-run", settled)
	}
	if !strings.Contains(settled[0].result, "unconfirmed") {
		t.Errorf("the turn result %q does not name the ambiguity", settled[0].result)
	}
	if len(reports) != 1 || reports[0].retryable {
		t.Fatalf("reported %v, want one failure that is NOT retryable", reports)
	}
}

// Two messages left unconfirmed: both are reported before either turn is settled.
// Settling the first ends the session, and ending it seals the transcript — a report
// filed after that would never reach the person who has to decide about it.
func TestSettleUndeliveredReportsEveryMessageBeforeSettlingAnyTurn(t *testing.T) {
	l := &deliveryLedger{}
	for _, turnID := range []string{"turn-1", "turn-2"} {
		l.accept(newMessageDelivery(turnID, false), writtenReceipt())
	}
	var trace []string
	settleUndeliveredMessages(l, &ClaimedSession{},
		func(r TurnCompleteRequest, _ ...context.Context) error {
			trace = append(trace, "settle:"+r.TurnID)
			return nil
		},
		func(turnID string, _ deliveryState, _ string, _ bool) {
			trace = append(trace, "report:"+turnID)
		})

	want := []string{"report:turn-1", "report:turn-2", "settle:turn-1", "settle:turn-2"}
	if strings.Join(trace, ",") != strings.Join(want, ",") {
		t.Errorf("accounting ran %v, want %v", trace, want)
	}
}

// ---------------------------------------------------------------------------

// writtenReceipt is a receipt for a frame the writer has already put on the wire.
func writtenReceipt() *writeReceipt {
	r := newWriteReceipt()
	r.settle(nil)
	return r
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), fakeClaudeTimeout)
	t.Cleanup(cancel)
	return ctx
}

// readLine reads one newline-terminated frame straight off a pipe.
func readLine(t *testing.T, f *os.File) (string, error) {
	t.Helper()
	buf := make([]byte, 0, 4096)
	one := make([]byte, 1)
	for {
		n, err := f.Read(one)
		if err != nil {
			return string(buf), err
		}
		if n == 0 {
			continue
		}
		if one[0] == '\n' {
			return string(buf), nil
		}
		buf = append(buf, one[0])
	}
}

// ---------------------------------------------------------------------------
// what a completion means for the session it belongs to
// ---------------------------------------------------------------------------

// Reporting a failed turn is what makes the runner seal its event stream and hand the
// session over to be terminalized. A steer's completion settles one mid-turn message and
// nothing else — sealing the transcript because a side message missed its window would
// stop the reply the user is actually waiting for.
func TestOnlyTheSessionsOwnTurnEndsTheRun(t *testing.T) {
	cases := []struct {
		name string
		req  TurnCompleteRequest
		want bool
	}{
		{"a failed turn", TurnCompleteRequest{Status: stFailed}, true},
		{"a failed steer", TurnCompleteRequest{Status: stFailed, Subtype: subtypeSteer}, false},
		{"a delivered steer", TurnCompleteRequest{Status: stSucceeded, Subtype: subtypeSteer}, false},
		{"a turn that succeeded", TurnCompleteRequest{Status: stSucceeded}, false},
		{"a turn the user interrupted", TurnCompleteRequest{Status: stInterrupted}, false},
		{"a failed shell turn", TurnCompleteRequest{Status: stFailed, Subtype: "shell"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := turnCompletionEndsSession(c.req); got != c.want {
				t.Errorf("turnCompletionEndsSession(%+v) = %v, want %v", c.req, got, c.want)
			}
		})
	}
}
