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
//	acknowledged  the CLI echoed it back (--replay-user-messages), or its turn's result came
//	              back without an echo: it is in the conversation
//	requeued      it never arrived AND that is provable, so it goes back to being an ordinary
//	              queued message — the one non-delivery that is not a loss
//	failed        it will never arrive, and why
//	withdrawn     the person took it back and the CLI dropped it unread (claude_withdraw.go):
//	              nothing will ever read it, and its bubble leaves the transcript
//
// enqueued and written are genuinely different: a frame bigger than the pipe's buffer sits
// accepted-but-unwritten until the CLI drains it. written and acknowledged are different
// for a reason that holds for every frame — bytes in the CLI are not yet a turn the model
// has taken. A `claude` busy in a tool call reads a frame at once and queues it (measured on
// 2.1.296 and 2.1.300: queued in under 10 ms while a 20 s `sleep` ran), but folds it into the
// conversation only at the next tool boundary, which is when it echoes it back.
type deliveryState string

const (
	deliveryPending      deliveryState = "pending"
	deliveryEnqueued     deliveryState = "enqueued"
	deliveryWritten      deliveryState = "written"
	deliveryAcknowledged deliveryState = "acknowledged"
	deliveryRequeued     deliveryState = "requeued"
	deliveryFailed       deliveryState = "failed"
	deliveryWithdrawn    deliveryState = "withdrawn"
)

// messageDelivery is one user message's progress towards the CLI. turnID is the
// conversation turn the control plane handed out, which is what every report about this
// message is addressed to; receipt is the writer's own answer for it, and the only account
// of what reached the CLI that survives a process going away mid-report.
type messageDelivery struct {
	turnID string
	// targetTurnID is non-empty only for explicit CURRENT_WORK. A Claude replay must arrive
	// before this exact executable turn's result; otherwise the provider generation is fenced
	// off so an already-written stdin frame cannot become the next turn.
	targetTurnID string
	// steer: this message was written into a turn that was already running, so it has no
	// `result` of its own. Its turn settles on the engine's echo instead — the one moment
	// that says the message became part of the conversation it was aimed at.
	steer bool
	// requeueable: this control plane will take the message back and re-file it as an ordinary
	// queued turn if delivery provably did not happen (RunInboxResponse.SteerRequeue). Read off
	// the delivery rather than stored globally, because it answers for THIS message on THIS
	// control plane; a runner that assumed it would lose a message to an older one.
	requeueable bool
	// uuid is what the frame carried as its own `uuid`, when it carried one (a steer: see
	// userTurnFrame). The CLI echoes it back, so the echo names this message rather than
	// answering whichever one is oldest, and it is the only handle a withdrawal has on a
	// message still waiting in the CLI's queue.
	uuid    string
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
// The one exception is a frame that carried a uuid of its own (a steer, see userTurnFrame):
// the CLI echoes that uuid back, so its echo is matched by it, and only an echo naming none
// of ours falls back to position.
//
// Scoped to one process. A re-spawn starts an empty ledger, because a new CLI replays
// only what this process feeds it.
type deliveryLedger struct {
	mu    sync.Mutex
	queue []*messageDelivery // accepted, not yet acknowledged — in the order accepted
	// read holds the turns of the uuid-carrying messages this process saw the CLI read, so a
	// withdrawal asked after the echo can say "already read" rather than "not here".
	read map[string]bool
}

// newMessageDelivery opens the record for a message the poller has pulled but not yet
// offered to the runtime. It is deliberately a state of its own: assembling the turn
// fetches every attachment over the network first, so "pulled" and "handed over" are
// minutes apart on a turn carrying a large image, and in between nobody has promised the
// message anything.
func newMessageDelivery(turnID string, steer bool) *messageDelivery {
	return &messageDelivery{turnID: turnID, steer: steer, state: deliveryPending}
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
	return l.acknowledgeEcho("")
}

// acknowledgeEcho answers the message one echo belongs to: the one whose uuid it carries back,
// and otherwise — an echo naming none of ours — the oldest unacknowledged message, the way
// acknowledgeNext always has.
func (l *deliveryLedger) acknowledgeEcho(uuid string) (*messageDelivery, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	at := -1
	if uuid != "" {
		for i, d := range l.queue {
			if d.uuid == uuid {
				at = i
				break
			}
		}
	}
	if at < 0 {
		if len(l.queue) == 0 {
			return nil, false
		}
		at = 0
	}
	d := l.queue[at]
	l.queue = append(l.queue[:at], l.queue[at+1:]...)
	d.state = deliveryAcknowledged
	if d.uuid != "" {
		if l.read == nil {
			l.read = map[string]bool{}
		}
		l.read[d.turnID] = true
	}
	return d, true
}

// waiting finds the message a withdrawal is about: accepted for turnID and still on its way
// into the conversation — not echoed back, failed or withdrawn. When there is none, read says
// whether this process saw the CLI read it.
func (l *deliveryLedger) waiting(turnID string) (d *messageDelivery, read bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, q := range l.queue {
		if q.turnID == turnID && (q.state == deliveryEnqueued || q.state == deliveryWritten) {
			return q, false
		}
	}
	return nil, l.read[turnID]
}

// withdraw records that the CLI dropped a message unread. It leaves the correlation queue — no
// echo will ever come for it — and nothing answers for it again: not the writer's receipt, not
// the result of the turn it was aimed at, not a dying process's account of what it still owed.
func (l *deliveryLedger) withdraw(d *messageDelivery) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if d.state != deliveryEnqueued && d.state != deliveryWritten {
		return false
	}
	d.state = deliveryWithdrawn
	for i, q := range l.queue {
		if q == d {
			l.queue = append(l.queue[:i], l.queue[i+1:]...)
			break
		}
	}
	return true
}

// acknowledgeAnswered settles the message a result just answered, if its echo never came.
// The CLI does not replay everything it runs: a slash command (`/upgrade`, `/compact`) is
// recorded as a `<command-name>` string rather than as the frame we sent. The result is the
// engine's own answer to that message, so it settles it — and takes it out of the queue
// before the next frame is written, which is what keeps the next replay lined up with the
// next message instead of with this one.
func (l *deliveryLedger) acknowledgeAnswered(turnID string) (*messageDelivery, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, d := range l.queue {
		if d.turnID == turnID {
			l.queue = append(l.queue[:i], l.queue[i+1:]...)
			d.state = deliveryAcknowledged
			return d, true
		}
	}
	return nil, false
}

// fail records that a message will never arrive and drops it from the correlation queue,
// so the replays that follow still line up with the messages that did.
func (l *deliveryLedger) fail(d *messageDelivery) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if d.state == deliveryAcknowledged || d.state == deliveryFailed || d.state == deliveryWithdrawn {
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

// failUnacknowledgedTarget atomically withdraws every CURRENT_WORK delivery whose exact target
// just ended without replay acknowledgement. The caller must terminate the Claude generation
// before allowing another executable turn: a frame may already be in the pipe and cannot be
// retracted from the provider itself.
func (l *deliveryLedger) failUnacknowledgedTarget(targetTurnID string) []*messageDelivery {
	l.mu.Lock()
	defer l.mu.Unlock()
	if targetTurnID == "" {
		return nil
	}
	failed := make([]*messageDelivery, 0)
	kept := l.queue[:0]
	for _, d := range l.queue {
		if d.steer && d.targetTurnID == targetTurnID && d.state != deliveryAcknowledged && d.state != deliveryFailed {
			d.state = deliveryFailed
			failed = append(failed, d)
			continue
		}
		kept = append(kept, d)
	}
	l.queue = kept
	return failed
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

// echoUUID is the uuid a replayed user turn carries back: one of ours when the frame it echoes
// carried one (userTurnFrame), the CLI's own otherwise.
func echoUUID(msg map[string]interface{}) string {
	uuid, _ := msg["uuid"].(string)
	return uuid
}

// deliveryReporter publishes one message's delivery state. The state is passed in rather
// than read back off the record: it is settled under the ledger's lock, and what a report
// must say is the transition it belongs to, not whatever the record holds by the time the
// event is built.
type deliveryReporter func(turnID string, state deliveryState, reason string, retryable bool)

// orderedDeliveryReports files one process's delivery reports in the order its messages moved.
//
// Each state is settled under the ledger's lock but reported by whichever goroutine settled it, once
// that lock is gone: the receipt watcher says written, the stdout reader acknowledged, a withdrawal
// withdrawn. Nothing orders those goroutines, and a client applies a turn's reports in the order they
// were filed, the last one standing. A watcher set aside between recording a write and reporting it
// could therefore file `written` after the steer's `withdrawn` or `acknowledged`, and put a bubble that
// was taken back, or read, back on "written".
//
// So a turn's reports are filed one at a time, and one that would move the turn backwards is not filed
// at all: nothing comes after `written` but the turn's last word, and nothing after that. What each
// state means, and when it is reached, is the ledger's as before; this decides only what the stream
// hears, and in which order.
func orderedDeliveryReports(report deliveryReporter) deliveryReporter {
	var mu sync.Mutex
	// How far along each turn's reports have gone (deliveryProgress), for the life of the process:
	// a report can come in late after its turn's last word, so that word is never forgotten.
	filed := map[string]int{}
	return func(turnID string, state deliveryState, reason string, retryable bool) {
		mu.Lock()
		defer mu.Unlock()
		if at, ok := filed[turnID]; ok && deliveryProgress(state) <= at {
			return // late: this turn has already been reported as far as this, or further
		}
		filed[turnID] = deliveryProgress(state)
		report(turnID, state, reason, retryable)
	}
}

// deliveryProgress places a state on the one path a message's reports may take: pending, enqueued,
// written, then its last word — acknowledged, withdrawn, requeued or failed — after which nothing is
// said about it.
func deliveryProgress(state deliveryState) int {
	switch state {
	case deliveryPending:
		return 0
	case deliveryEnqueued:
		return 1
	case deliveryWritten:
		return 2
	}
	return 3
}

// fileWrittenReport files the report that a message reached its engine, which whoever saw it get
// there does on its own schedule: the receipt watcher once a frame's bytes are in the CLI's stdin,
// the Codex steer worker once turn/steer has answered. A variable only so a test can hold that report
// back until another goroutine has reported the same message further along — the interleaving a
// message's reports are put in order for (orderedDeliveryReports), at a moment nothing outside that
// goroutine can observe.
var fileWrittenReport = func(turnID string, file func()) { file() }

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

// subtypeSteer marks a completion that settles one mid-turn message rather than the
// session's own turn. The control plane does not take the runner's word for it — it reads
// the turn's kind off the row — but the runner needs to tell them apart locally, because a
// failed turn is what makes it seal the session's event stream (turnCompletionEndsSession).
const subtypeSteer = "steer"

// errNoTurnToSteer: a steer reached the runner with nothing running to fold it into. The
// server only hands one over while a turn holds the slot, so this is the turn ending in
// the gap between that decision and this delivery — and writing it anyway would open a
// turn of its own that no queued turn is waiting to answer.
var errNoTurnToSteer = errors.New("no turn was running to steer; send it again")

// errCurrentWorkTargetEnded is terminal for one explicit steer. The process generation is also
// stopped: even bytes already written to stdin must not survive to become the next turn.
var errCurrentWorkTargetEnded = errors.New("the target turn ended before the engine acknowledged this CURRENT_WORK message")

// errCurrentWorkTargetInterrupted: the turn a steer was waiting to be read in was stopped first. The
// fence proves the engine never read it, which is what would otherwise send it back to the queue; a
// Stop is the one ending that must not, because the turn it would open runs straight after the Stop.
var errCurrentWorkTargetInterrupted = errors.New("the turn was interrupted by Stop before the engine read this message")

// settleSteerTurn closes a steer's own conversation turn. Success or failure, it settles
// nothing else: the turn it was written into is still running, and its result — the slot,
// the billing, the session's status — belongs to that turn. A steer that failed says so
// through its user_delivery event, which is where a person can act on it, rather than by
// failing a session that is still working.
func settleSteerTurn(turnID string, cause error, job *ClaimedSession, completeTurn turnCompleter) {
	req := TurnCompleteRequest{
		TurnID:           turnID,
		Status:           stSucceeded,
		Subtype:          subtypeSteer,
		RuntimeSessionID: currentRuntimeSessionID(job),
	}
	if cause != nil {
		req.Status = stFailed
		req.Result = "steer not delivered to the engine: " + cause.Error()
	}
	if err := completeTurn(req); err != nil {
		logln("steer turn-complete failed for", job.SessionID+":", err)
	}
}

// subtypeSteerRequeue un-files a steer instead of settling it: the message goes back to being
// the ordinary queued message it would have been had it arrived a moment later, on the same row,
// and runs when the turn it could not join ends. Reserved for a message the engine PROVABLY never
// read — anything less certain has to be reported as a failure, because re-filing a message the
// engine did take is how one prompt gets executed twice.
const subtypeSteerRequeue = "steer_requeue"

// errSteerAbandoned: a mid-turn message that was leased by a runner process which then died
// holding it. Neither side can tell whether the engine read it first, so it is never re-delivered
// and never re-filed — it is reported undelivered, and re-sending it is the person's call.
var errSteerAbandoned = errors.New("the runner stopped while this message was on its way into the running turn, so whether the engine read it is unknown; send it again if it was not acted on")

// requeueSteerTurn takes a steer back off the running turn and files it as the next ordinary
// message. Nothing about the session changes: the turn this message failed to join is still
// running, and this row simply rejoins the queue behind it.
//
// Reported as SUCCEEDED because it IS one — the runner did what it could with this message and
// nothing was lost. A control plane too old to know the subtype would read it as an ordinary ack
// and drop the message, which is why the runner only sends it when the delivery it is answering
// said the control plane understands it (RunInboxResponse.SteerRequeue).
func requeueSteerTurn(turnID string, job *ClaimedSession, completeTurn turnCompleter) {
	if err := completeTurn(TurnCompleteRequest{
		TurnID:           turnID,
		Status:           stSucceeded,
		Subtype:          subtypeSteerRequeue,
		RuntimeSessionID: currentRuntimeSessionID(job),
	}); err != nil {
		logln("steer requeue turn-complete failed for", job.SessionID+":", err)
	}
}

// reportAbandonedSteer answers for one mid-turn message the process before this one left leased.
// It is the taking-over process that does this, on the session's live event stream, because that
// stream is the only place a steer's outcome is ever visible — a steer produces no reply of its
// own — and the control plane cannot write to it (a run event's sequence belongs to the runner
// holding the session).
//
// `announced` is the control plane's answer to whether the dead process got as far as putting a
// bubble in the transcript. This process cannot know: its predecessor's record died with it, and
// emitting a second `user` event for a turn that already has one shows the message twice.
func reportAbandonedSteer(steer AbandonedSteer, job *ClaimedSession, emitFor emitTurnFn, completeTurn turnCompleter) {
	logln("answering for a steer stranded by a previous process on", job.SessionID+":", steer.TurnID)
	if !steer.Announced {
		emitFor(steer.TurnID, evUser, map[string]interface{}{
			"text": steer.Content, "steer": true, "delivery": string(deliveryFailed),
		})
	}
	emitFor(steer.TurnID, evUserDelivery, map[string]interface{}{
		"turnId": steer.TurnID, "delivery": string(deliveryFailed),
		"reason": errSteerAbandoned.Error(), "retryable": true,
	})
	settleSteerTurn(steer.TurnID, errSteerAbandoned, job, completeTurn)
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
	var unconfirmed []*messageDelivery
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
			// A steer is settled even when it never left the runner: it is not re-delivered
			// (the server never re-leases one), so leaving its turn unanswered would leave a
			// row in flight that nothing will ever come back for.
			if d.steer {
				settleSteerTurn(d.turnID, cause, job, completeTurn)
			}
			continue
		}
		report(d.turnID, deliveryFailed, errDeliveryUnconfirmed.Error(), false)
		unconfirmed = append(unconfirmed, d)
	}
	for _, d := range unconfirmed {
		if d.steer {
			settleSteerTurn(d.turnID, errDeliveryUnconfirmed, job, completeTurn)
			continue
		}
		failUndeliveredTurn(d.turnID, errDeliveryUnconfirmed, job, completeTurn)
	}
}
