package main

import (
	"errors"
	"sync"
)

// Delivery receipts for the user messages a session sends its engine.
//
// A user bubble in the transcript is a claim: "this was sent". The claim used to be made
// before anything had been handed to the CLI — the inbox poller emitted the `user` event
// and only then wrote the frame — so a write that failed left the claim standing with the
// message nowhere. That is the fake send this file exists to remove: nothing enters the
// transcript for a message the runtime refused, and a message that was accepted carries
// how far it actually got.
//
// The states a message passes through, each a fact about a different party:
//
//	pending       built by the poller; nothing has taken responsibility for it yet
//	enqueued      the runtime accepted it — it will be written, in this order
//	written       its bytes are in the CLI's stdin
//	acknowledged  the CLI echoed it back (--replay-user-messages): it is in the conversation
//	failed        it will never arrive, and why
//
// enqueued and written are genuinely different: a `claude` inside a tool call stops
// reading stdin, so an accepted message can sit unwritten for as long as the tool runs.
// written and acknowledged are different for the same kind of reason — bytes in a pipe
// are not yet a turn the model has taken.
type deliveryState string

const (
	deliveryPending      deliveryState = "pending"
	deliveryEnqueued     deliveryState = "enqueued"
	deliveryWritten      deliveryState = "written"
	deliveryAcknowledged deliveryState = "acknowledged"
	deliveryFailed       deliveryState = "failed"
)

// messageDelivery is one user message's progress towards the CLI. turnID is the
// conversation turn the control plane handed out, which is what every report about this
// message is addressed to; receipt is the writer's own answer for it, and the only account
// of what reached the CLI that survives a process going away mid-report.
type messageDelivery struct {
	turnID  string
	receipt *writeReceipt
	state   deliveryState
}

// deliveryLedger correlates the messages a session hands to its CLI with the echoes the
// CLI sends back.
//
// Correlation is positional, not by content: one writer emits frames in the order they
// were accepted and the CLI replays them in the order it reads them, so the n-th replay
// answers the n-th unacknowledged message. Two messages carrying the very same text are
// therefore still told apart — matching on text could not tell them apart at all.
//
// Scoped to one process. A re-spawn starts an empty ledger, because a new CLI replays
// only what this process feeds it.
type deliveryLedger struct {
	mu    sync.Mutex
	queue []*messageDelivery // accepted, not yet acknowledged — in the order accepted
}

// newMessageDelivery opens the record for a message the poller has pulled but not yet
// offered to the runtime. It is deliberately a state of its own: assembling the turn
// fetches every attachment over the network first, so "pulled" and "handed over" are
// minutes apart on a turn carrying a large image, and in between nobody has promised the
// message anything.
func newMessageDelivery(turnID string) *messageDelivery {
	return &messageDelivery{turnID: turnID, state: deliveryPending}
}

// accept records that the runtime has taken responsibility for delivering the message,
// and the receipt that will answer for it. Called while the caller holds a reserved write
// slot — before the frame can reach the CLI — so the ledger is never behind the replay it
// has to answer, and never holds a message it cannot look up the fate of.
func (l *deliveryLedger) accept(d *messageDelivery, receipt *writeReceipt) {
	l.mu.Lock()
	defer l.mu.Unlock()
	d.state = deliveryEnqueued
	d.receipt = receipt
	l.queue = append(l.queue, d)
}

// markWritten records that the bytes reached the CLI's stdin. A message already answered
// keeps its answer: the replay may well arrive before the writer's receipt is observed.
func (l *deliveryLedger) markWritten(d *messageDelivery) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if d.state != deliveryEnqueued {
		return false
	}
	d.state = deliveryWritten
	return true
}

// acknowledgeNext answers the oldest unacknowledged message: the CLI replays what it
// reads, in order, so this is the message that replay belongs to.
func (l *deliveryLedger) acknowledgeNext() (*messageDelivery, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.queue) == 0 {
		return nil, false
	}
	d := l.queue[0]
	l.queue = l.queue[1:]
	d.state = deliveryAcknowledged
	return d, true
}

// fail records that a message will never arrive and drops it from the correlation queue,
// so the replays that follow still line up with the messages that did.
func (l *deliveryLedger) fail(d *messageDelivery) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if d.state == deliveryAcknowledged || d.state == deliveryFailed {
		return false
	}
	d.state = deliveryFailed
	for i, q := range l.queue {
		if q == d {
			l.queue = append(l.queue[:i], l.queue[i+1:]...)
			break
		}
	}
	return true
}

// outstanding lists the messages still unanswered, oldest first — what a process that is
// going away has to account for. Only the fields fixed at acceptance (the turn and its
// receipt) may be read off the result; `state` belongs to the ledger's lock.
func (l *deliveryLedger) outstanding() []*messageDelivery {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]*messageDelivery(nil), l.queue...)
}

// isReplayedUserTurn reports whether a stream-json message is the CLI echoing back a user
// turn we fed it (--replay-user-messages), as opposed to the other things that arrive as
// user-role messages: tool results, background-task notifications and compaction
// summaries, all of which are the CLI's own traffic.
//
// The test is what our own frames look like (userFrame): a top-level message —
// parent_tool_use_id null, since a sub-agent's turns are not ours — whose content is a
// list of the block types we send. One tool_result block is enough to disqualify it, and
// so is a plain-string content, which is how the notifications arrive.
func isReplayedUserTurn(msg map[string]interface{}) bool {
	if msg["type"] != frameUser {
		return false
	}
	if parent, _ := msg["parent_tool_use_id"].(string); parent != "" {
		return false
	}
	message, _ := msg["message"].(map[string]interface{})
	if message == nil {
		return false
	}
	content, ok := message["content"].([]interface{})
	if !ok || len(content) == 0 {
		return false
	}
	for _, c := range content {
		block, _ := c.(map[string]interface{})
		if block == nil {
			return false
		}
		switch block["type"] {
		case "text", "image", "document":
		default:
			return false
		}
	}
	return true
}

// deliveryReporter publishes one message's delivery state. The state is passed in rather
// than read back off the record: it is settled under the ledger's lock, and what a report
// must say is the transition it belongs to, not whatever the record holds by the time the
// event is built.
type deliveryReporter func(turnID string, state deliveryState, reason string, retryable bool)

// failUndeliveredTurn settles a turn whose message never reached the CLI. It is reported
// FAILED rather than left unanswered: nothing ran, and parking the session at
// AWAITING_INPUT would leave an ordinary-looking idle conversation with the user's
// message sitting in it — the fake send in its most durable form. FAILED is what the
// session list shows; the session stays resumable, so a re-send is one message away.
func failUndeliveredTurn(turnID string, cause error, job *ClaimedSession, completeTurn turnCompleter) {
	if err := completeTurn(TurnCompleteRequest{
		TurnID:           turnID,
		Status:           stFailed,
		Result:           "message not delivered to the engine: " + cause.Error(),
		Subtype:          "delivery_failed",
		RuntimeSessionID: currentRuntimeSessionID(job),
		BranchSha:        effectiveBranchSha(job.WT),
	}); err != nil {
		logln("delivery-failure turn-complete failed for", job.SessionID+":", err)
	}
}

// The two things a process on its way out can owe, and what each one means for whoever
// sent the message.
var (
	// Provably not delivered: the bytes never left the runner, so nothing ran and the
	// same message can be sent again with no risk of doing the work twice.
	errNeverWritten = errors.New("the engine exited before this message was written to it")
	// Genuinely unknown: the CLI was handed the message and never echoed it back, so it
	// may have read and acted on it before it died, or never seen it at all.
	errDeliveryUnconfirmed = errors.New("delivery unconfirmed: the engine exited without echoing this message back, so whether it acted on it is unknown")
)

// settleUndeliveredMessages accounts for what a dying process still owed. This is the
// restart policy, and it turns on one distinction:
//
//   - The engine never took the message. Nothing ran, so re-sending it cannot do the work
//     twice: the turn is left unanswered for the next process to feed, and the failed
//     attempt goes on the record rather than being quietly forgotten.
//   - The engine took it and never echoed it back. Whether it read the frame and acted on
//     it before dying, or never saw it, is not knowable from here — so the turn is settled
//     as a failure and a person decides. Re-delivering an ambiguous message is the one
//     thing this must not do: that is how work gets done twice.
func settleUndeliveredMessages(l *deliveryLedger, job *ClaimedSession, completeTurn turnCompleter, report deliveryReporter) {
	// Every message is reported before any turn is settled. A failed turn ends the session,
	// and ending it seals event admission — so a report filed after the first settlement
	// would be dropped, and the messages after the first would go unaccounted for in the
	// one place a person reads.
	var unconfirmed []string
	for _, d := range l.outstanding() {
		// The writer's own receipt, not the ledger's state: by the time a process is being
		// accounted for, the writer has answered for every frame it was given, while the
		// goroutines watching those answers may not have run yet. A message whose receipt
		// says nothing arrived is one that never left this machine.
		writeErr, settled := d.receipt.settled()
		if !l.fail(d) {
			continue // already answered while this was being read
		}
		if !settled || writeErr != nil {
			cause := errNeverWritten
			if writeErr != nil {
				cause = writeErr
			}
			report(d.turnID, deliveryFailed, cause.Error(), true)
			continue
		}
		report(d.turnID, deliveryFailed, errDeliveryUnconfirmed.Error(), false)
		unconfirmed = append(unconfirmed, d.turnID)
	}
	for _, turnID := range unconfirmed {
		failUndeliveredTurn(turnID, errDeliveryUnconfirmed, job, completeTurn)
	}
}
