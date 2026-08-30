package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Mid-turn user messages on Codex: `turn/steer`.
//
// A steer is a message written into the Codex turn that is ALREADY running. It opens no turn of
// its own and produces no second reply — the running turn's answer is what responds to it — so
// how far it got IS its whole visible outcome, which is why every stage here has a word for it.
//
// docs/codex-turn-steer-contract.md is the frozen protocol this implements, measured against a
// real app-server; the § numbers below point into it. Three of its findings shape everything:
//
//  1. Codex does not de-duplicate. The same clientUserMessageId sent twice inserts the message
//     twice, so at-most-once is Orbit's to keep: nothing on this path ever retries by itself.
//  2. An OK response is not delivery. Codex buffers a steer until its next model request — 31
//     seconds, in the measured case — so `written` (Codex took it) and `acknowledged` (it is in
//     the conversation) are genuinely different states, and only the echo settles the message.
//  3. Every failure carries the same JSON-RPC code, "no such method" included. The message text
//     is the only thing that tells them apart (classifyCodexSteerFailure).

// codexSteerRequestTimeout bounds one turn/steer round trip, and separately the wait for the
// running turn to be named. Measured responses come back in milliseconds — the call returns
// before the message is injected, so it is unrelated to how long a tool runs — which leaves this
// budget for an app-server that has stopped answering. It stays well under the inbox lease so a
// wedged engine cannot cost the session its lease (§4.5).
const codexSteerRequestTimeout = 10 * time.Second

// codexSteerTargetPoll is how often a waiting steer re-reads the running turn.
const codexSteerTargetPoll = 25 * time.Millisecond

// codexSteerQueueDepth is what one session may have waiting to be delivered. Deliveries are
// quick, so a queue this deep means the app-server has stopped answering; the messages behind it
// are refused where the sender can see them rather than piling up invisibly.
const codexSteerQueueDepth = 32

var (
	// errCodexSteerUnaimed: a turn is running but turn/start has not named it yet, and
	// expectedTurnId is mandatory. Nothing was sent.
	errCodexSteerUnaimed = errors.New("the running turn had not been started yet, so this message could not be written into it; send it again")
	// errCodexSteerBacklogged: too many steers are already waiting on this session.
	errCodexSteerBacklogged = errors.New("too many messages are already waiting to join this turn; send it again once the turn ends")
	// errCodexSteerEngineGone: the app-server generation ended with this message still queued.
	errCodexSteerEngineGone = errors.New("the engine stopped before this message could be written into the running turn; send it again")
	// errCodexSteerTurnMismatch: turn/steer answered for a different turn than it was addressed
	// to. Never observed; asserted anyway, because taking the answer on faith would file a
	// message as delivered into a turn it did not join (§2).
	errCodexSteerTurnMismatch = errors.New("codex steered a different turn than the one this message was addressed to")
	// errCodexSteerTargetExpired is a runner-side fence against a stale inbox response. The
	// control plane names the exact Orbit executable turn for CURRENT_WORK; if the resident
	// runtime has already advanced, no turn/steer request may leave this process.
	errCodexSteerTargetExpired = errors.New("the CURRENT_WORK target turn is no longer active")
	// errCodexSteerDropped: Codex took the message and the turn ended without ever echoing it
	// back. The measured cause is an interrupt landing while the steer was still buffered, which
	// Codex discards silently — no notification, nothing in the thread (§4.4).
	errCodexSteerDropped = errors.New("the turn ended before codex read this message into the conversation; it was not delivered")
	// errCodexSteerUnsupported: this Codex build has no turn/steer at all (§5.2).
	errCodexSteerUnsupported = errors.New("this codex is too old to take a message while a turn is running; send it again once the turn ends")
	// errCodexSteerDuplicate: this conversation turn was handed over twice. Nothing was sent for
	// the second copy — which is the whole point, since Codex would insert the message twice.
	errCodexSteerDuplicate = errors.New("this message had already been delivered into the running turn")
)

// codexSteerDelivery is one mid-turn message's progress into the turn it was aimed at. It lives
// on the active turn, under the same activeMu, because that is exactly its lifetime: a turn that
// has ended cannot take one, and a turn that ends owes an answer for every steer still open on
// it. The states are the ones every provider reports (deliveryState) — no new vocabulary reaches
// the clients for this (§4.6).
type codexSteerDelivery struct {
	orbitTurnID string
	state       deliveryState
	// Codex reports one userMessage item twice over its normal lifecycle: item/started and
	// item/completed carry the same item id. Keep that id so the second notification is not
	// mistaken for a second copy in the conversation. A genuinely duplicated turn/steer gets a
	// new item id even when its clientUserMessageId is the same (contract probe A2/A3).
	echoItemID string
	// text/attachments are what the transcript bubble for this message is made of, kept here
	// because whoever announces it may not be the goroutine that was given it: Codex can echo a
	// steer back before its own response has been read (§3).
	text        string
	attachments []map[string]interface{}
	// announced: a `user` event for this message is in the transcript. The first outcome opens
	// the bubble and every later one amends it, so that exactly one bubble exists per message —
	// and so a message that ends up NOT joining the turn (requeued as an ordinary message) never
	// leaves one behind for the delivery that eventually runs it to duplicate.
	announced bool
}

// beginCodexSteer aims one message at the turn currently running and records it there before a
// byte is sent. The record has to exist first: Codex has been seen echoing a steer back before
// its own response was observed, and an echo with nothing to answer would go unmatched.
//
// It waits for turn/start to name the turn (§2.1). That request goes out on its own goroutine, so
// there is a window where a turn is running, is being interrupted, or has ended, and no Codex turn
// id is available to address a steer to. Waiting is bounded by ctx; every way out of here without
// an id is a message that provably never left the runner.
func beginCodexSteer(ctx context.Context, activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID, targetTurnID, text string, attachments []map[string]interface{}) (string, error) {
	tk := time.NewTicker(codexSteerTargetPoll)
	defer tk.Stop()
	for {
		activeMu.Lock()
		a := *active
		switch {
		case a == nil || a.finishing || a.interruptRequested:
			activeMu.Unlock()
			return "", errNoTurnToSteer
		case targetTurnID != "" && a.orbitTurnID != targetTurnID:
			activeMu.Unlock()
			return "", errCodexSteerTargetExpired
		case a.codexTurnID != "":
			if a.steers == nil {
				a.steers = map[string]*codexSteerDelivery{}
			}
			if existing := a.steers[orbitTurnID]; existing != nil {
				// The same conversation turn handed over twice. The control plane leases a steer
				// once and never re-leases it, so this is a delivery that should not exist —
				// and acting on it would put the message into the conversation twice, because
				// Codex does not de-duplicate (§0.1). Refuse the copy; the original stands.
				activeMu.Unlock()
				return "", errCodexSteerDuplicate
			}
			a.steers[orbitTurnID] = &codexSteerDelivery{
				orbitTurnID: orbitTurnID, state: deliveryEnqueued,
				text: text, attachments: attachments,
			}
			codexTurnID := a.codexTurnID
			activeMu.Unlock()
			return codexTurnID, nil
		}
		activeMu.Unlock()
		select {
		case <-tk.C:
		case <-ctx.Done():
			return "", errCodexSteerUnaimed
		}
	}
}

// markCodexSteerWritten records that Codex took the message. It is not a transition if the echo
// has already answered it: the response and the notification stream are read by different
// goroutines, so `acknowledged` can be reached first and must not be walked back.
func markCodexSteerWritten(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID string) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	d := codexSteerRecord(*active, orbitTurnID)
	if d == nil || d.state != deliveryEnqueued {
		return false
	}
	d.state = deliveryWritten
	return true
}

// failCodexSteer closes one steer as undelivered and answers whether this caller is the one that
// has to settle it. The transition is the single-flight token: a turn ending takes every steer
// still open on it (beginCodexAppTurnFinalize), so a request erroring at that same moment must
// not settle the same conversation turn a second time.
func failCodexSteer(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID string) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	d := codexSteerRecord(*active, orbitTurnID)
	if d == nil || d.state == deliveryAcknowledged || d.state == deliveryFailed {
		return false
	}
	d.state = deliveryFailed
	return true
}

// acknowledgeCodexSteerEcho answers the steer a userMessage echo belongs to, and names it. Codex
// replays the clientUserMessageId we sent on item.clientId, which is the only correlation key
// there is (§3) — the positional matching the claude path has to use, because its echoes carry no
// id at all, would be a downgrade here.
func acknowledgeCodexSteerEcho(activeMu *sync.Mutex, active **codexAppActiveTurn, item map[string]interface{}) string {
	clientID := firstString(item, "clientId", "client_id")
	if clientID == "" || !codexItemIsUserMessage(item) {
		return ""
	}
	activeMu.Lock()
	defer activeMu.Unlock()
	d := codexSteerRecord(*active, clientID)
	itemID := firstString(item, "id")
	switch {
	case d == nil:
		// The turn's own opening message, whose clientUserMessageId is the running turn's, or a
		// steer whose turn has already been finalized.
		return ""
	case d.state == deliveryAcknowledged:
		if itemID != "" && itemID == d.echoItemID {
			// The ordinary item/started -> item/completed pair for one persisted item.
			return ""
		}
		// Codex does not de-duplicate, so a second echo under one id means the message really is
		// in the conversation twice. It has a different item id from the lifecycle pair above.
		// Worth saying out loud: it is a bug on this side.
		logln("codex echoed steer", clientID, "twice; the message may be in the conversation more than once")
		return ""
	case d.state == deliveryFailed:
		// Reported undelivered and then echoed anyway. Only reachable if an echo can arrive after
		// its turn/completed, which is the reordering §4.4 leaves open — the log is what would
		// let a later task close it.
		logln("codex echoed steer", clientID, "after it was reported undelivered")
		return ""
	}
	d.state = deliveryAcknowledged
	d.echoItemID = itemID
	return d.orbitTurnID
}

// reportCodexSteerEcho hands a userMessage echo to whoever settles the steer it answers. It is
// deliberately outside the notification handler's own lock: settling a turn is a network call,
// and the lock it would be holding is the one the running turn's events go through.
func reportCodexSteerEcho(activeMu *sync.Mutex, active **codexAppActiveTurn, item map[string]interface{}, onSteerAck func(string)) {
	if onSteerAck == nil {
		return
	}
	if turnID := acknowledgeCodexSteerEcho(activeMu, active, item); turnID != "" {
		onSteerAck(turnID)
	}
}

// codexItemIsUserMessage matches the echo of a message we sent, in either casing the two Codex
// protocols use for item types.
func codexItemIsUserMessage(item map[string]interface{}) bool {
	kind := strings.ToLower(firstString(item, "type", "kind"))
	return strings.ReplaceAll(kind, "_", "") == "usermessage"
}

// codexSteerRecord looks one steer up on the turn it was written into. Callers hold activeMu.
func codexSteerRecord(a *codexAppActiveTurn, orbitTurnID string) *codexSteerDelivery {
	if a == nil {
		return nil
	}
	return a.steers[orbitTurnID]
}

// takeOpenCodexSteers claims every steer still unanswered on a turn, which is what a turn ending
// owes an answer for. Callers hold activeMu; claiming is the same single-flight transition
// failCodexSteer uses, so a steer taken here cannot also be settled by its own request.
func takeOpenCodexSteers(a *codexAppActiveTurn) []string {
	var open []string
	for _, d := range a.steers {
		if d.state == deliveryAcknowledged || d.state == deliveryFailed {
			continue
		}
		d.state = deliveryFailed
		open = append(open, d.orbitTurnID)
	}
	return open
}

// codexSteerRefusal is what one refused steer means, in the terms of the contract's failure table
// (§4.2).
type codexSteerRefusal struct {
	// code names the row of that table, and goes into the log line so a failure in production can
	// be read against the contract instead of guessed at from prose.
	code string
	// retryable: whether sending the same message again is safe. False only for a request Orbit
	// itself built wrong — re-sending that reproduces it, which is a loop, not a recovery.
	retryable bool
	// unsupported: this Codex has no turn/steer at all, so every later steer on this process is
	// refused without asking (§5.2).
	unsupported bool
	// requeue: Codex PROVED it never read this message — it refused the request before looking at
	// the input, or nothing was ever sent — so the message can go back to being an ordinary
	// queued one and run when the turn it missed ends. Nobody sees a failure and nothing is
	// re-executed (§4.3a).
	//
	// False is the safe answer and the default. "We do not know whether it arrived" must never
	// re-file: Codex does not de-duplicate, so a message it had in fact taken would be executed
	// twice — once inside the turn and once as the turn after it (§4.3b).
	requeue bool
}

// classifyCodexSteerFailure reads a refusal off its message. Codex answers EVERY failure with
// -32600 — including "no such method", which is not -32601 — so the code carries no information
// and the text is all there is (§4.1). Anything unrecognised is treated as "we do not know
// whether it arrived", which is the safe end of the guess: nothing here retries by itself,
// because a retry Codex accepts inserts the message a second time.
func classifyCodexSteerFailure(err error) codexSteerRefusal {
	msg := strings.ToLower(err.Error())
	switch {
	// Before the malformed-request row: Codex prefixes an absent method with "Invalid request"
	// too, and this one is the only refusal that is about the engine rather than the message.
	case errors.Is(err, errCodexSteerUnsupported) || strings.Contains(msg, "unknown variant `turn/steer`"):
		return codexSteerRefusal{code: "E-UNSUPPORTED", retryable: true, unsupported: true, requeue: true}
	case errors.Is(err, errNoTurnToSteer) || strings.Contains(msg, "no active turn to steer"):
		return codexSteerRefusal{code: "E-NO-ACTIVE", retryable: true, requeue: true}
	case errors.Is(err, errCodexSteerTurnMismatch) || errors.Is(err, errCodexSteerTargetExpired) || strings.Contains(msg, "expected active turn id"):
		return codexSteerRefusal{code: "E-MISMATCH", retryable: true, requeue: true}
	// The runner's own pre-flight refusals. Not a row of the table: they are §4.3a's "provably
	// not delivered" reached before anything was sent at all.
	case errors.Is(err, errCodexSteerUnaimed) || errors.Is(err, errCodexSteerBacklogged) ||
		errors.Is(err, errCodexSteerEngineGone):
		return codexSteerRefusal{code: "E-UNSENT", retryable: true, requeue: true}
	// A second copy of a message already delivered. Provably not sent — but re-filing it would
	// queue a duplicate of a message the engine has, which is the very thing the refusal
	// prevented. The original's own outcome is the one that reports this message.
	case errors.Is(err, errCodexSteerDuplicate):
		return codexSteerRefusal{code: "E-DUPLICATE", retryable: false}
	case strings.Contains(msg, "missing field") || strings.Contains(msg, "invalid request") ||
		strings.Contains(msg, "invalid thread id"):
		return codexSteerRefusal{code: "E-BAD-REQUEST", retryable: false}
	case errors.Is(err, errCodexSteerDropped):
		return codexSteerRefusal{code: "E-DROPPED", retryable: true}
	case errors.Is(err, errSteerAbandoned):
		return codexSteerRefusal{code: "E-ABANDONED", retryable: true}
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
		strings.Contains(msg, "app-server closed"):
		return codexSteerRefusal{code: "E-TIMEOUT", retryable: true}
	default:
		return codexSteerRefusal{code: "E-UNKNOWN", retryable: true}
	}
}

// codexSteerParams builds the request (§1). Deliberately minimal: turn/steer takes no turn-level
// overrides — no model, cwd, sandbox or effort — because it joins a turn whose context is already
// settled, and 0.149.0 IGNORES unknown params rather than rejecting them, so sending one would be
// silently wrong instead of loudly wrong. It carries no agent context either: that rides on
// turn/start, and re-injecting it here would advance the instruction generation of a turn that is
// already running.
func codexSteerParams(threadID, expectedTurnID, orbitTurnID, prompt string, imagePaths []string) map[string]interface{} {
	input := []map[string]interface{}{}
	if strings.TrimSpace(prompt) != "" || len(imagePaths) == 0 {
		input = append(input, map[string]interface{}{"type": "text", "text": prompt})
	}
	for _, p := range imagePaths {
		input = append(input, map[string]interface{}{"type": "localImage", "path": p})
	}
	return map[string]interface{}{
		"threadId":            threadID,
		"expectedTurnId":      expectedTurnID,
		"input":               input,
		"clientUserMessageId": orbitTurnID,
	}
}

// codexSteerDispatcher writes mid-turn messages into the Codex turn a session is running, and
// answers for each one. Scoped to a single app-server generation, and driven by a single worker
// so messages reach Codex in the order the inbox handed them out — Codex inserts them in arrival
// order, so two dispatches racing would reorder what the user wrote (§2.1).
type codexSteerDispatcher struct {
	app          *codexAppServer
	t            *Transport
	job          *ClaimedSession
	threadID     string
	activeMu     *sync.Mutex
	active       **codexAppActiveTurn
	emitFor      emitTurnFn
	completeTurn turnCompleter
}

// deliver writes one message into the running turn. Everything it can do ends in an answer for
// that message: a steer's row is leased and never re-delivered, so one dropped here is gone for
// good, with no event and no trace.
func (d *codexSteerDispatcher) deliver(ctx context.Context, resp *RunInboxResponse) {
	if d.app.steerUnsupported.Load() {
		// Asked once, answered for the whole process: this build has no turn/steer, and asking
		// again per message spends a round trip to be told the same thing (§5.2).
		d.refuse(resp, errCodexSteerUnsupported)
		return
	}
	// Attachments are fetched over the network, so this happens before the message is aimed at a
	// turn: holding a place on a running turn across a slow fetch would report a turn that ended
	// meanwhile as having dropped a message that was never sent.
	prepared := prepareCodexTurn(ctx, d.t, d.job, resp, nil)
	if ctx.Err() != nil {
		d.refuse(resp, errCodexSteerEngineGone)
		return
	}
	aimCtx, cancelAim := context.WithTimeout(ctx, codexSteerRequestTimeout)
	codexTurnID, err := beginCodexSteer(aimCtx, d.activeMu, d.active, resp.TurnID, resp.TargetTurnID,
		resp.Content, prepared.AttachmentRefs)
	cancelAim()
	if err != nil {
		d.refuse(resp, err)
		return
	}

	reqCtx, cancelReq := context.WithTimeout(ctx, codexSteerRequestTimeout)
	defer cancelReq()
	result, err := d.app.request(reqCtx, "turn/steer",
		codexSteerParams(d.threadID, codexTurnID, resp.TurnID, prepared.Prompt, prepared.ImagePaths))
	if err == nil {
		if steered := firstString(result, "turnId", "turn_id"); steered != codexTurnID {
			err = fmt.Errorf("%w: addressed to %s, answered for %q", errCodexSteerTurnMismatch, codexTurnID, steered)
		}
	}
	if err != nil {
		if failCodexSteer(d.activeMu, d.active, resp.TurnID) {
			d.settle(resp, err)
		}
		return
	}
	if markCodexSteerWritten(d.activeMu, d.active, resp.TurnID) {
		// Codex has it; the model has not seen it yet. That gap has been measured at 31 seconds,
		// and "Delivering…" for that long is the truth, not a stall (§4.6).
		d.announce(resp.TurnID, deliveryWritten, "", false)
	}
}

// acknowledge settles a steer Codex echoed back. The echo is a steer's only answer — it has no
// result of its own — and the turn it joined carries on regardless.
func (d *codexSteerDispatcher) acknowledge(turnID string) {
	d.announce(turnID, deliveryAcknowledged, "", false)
	settleSteerTurn(turnID, nil, d.job, d.completeTurn)
}

// refuse answers a steer that never got as far as being recorded on the running turn, so there is
// no record to open a bubble from — the inbox's own copy of the message is used instead.
func (d *codexSteerDispatcher) refuse(resp *RunInboxResponse, cause error) {
	if errors.Is(cause, errCodexSteerDuplicate) {
		// A second delivery of a message already being delivered. There is one row and the first
		// delivery owns it: answering here would report and settle the same conversation turn
		// twice, over a copy that was never sent. Refusing it silently IS the answer.
		logln("codex steer E-DUPLICATE for", d.job.SessionID+":", resp.TurnID,
			"was handed over twice; the first delivery answers for it")
		return
	}
	if d.requeue(resp, cause) {
		return
	}
	d.emitFor(resp.TurnID, evUser, map[string]interface{}{
		"text": resp.Content, "steer": true, "delivery": string(deliveryFailed),
	})
	d.fail(resp.TurnID, cause)
}

// settle answers a steer that WAS recorded and then refused by Codex. Same two outcomes as
// refuse, and the same order: re-file it if that is provably safe, otherwise report the failure.
func (d *codexSteerDispatcher) settle(resp *RunInboxResponse, cause error) {
	if d.requeue(resp, cause) {
		return
	}
	d.fail(resp.TurnID, cause)
}

// requeue un-files a steer Codex proved it never read, so that it runs as the ordinary message it
// would have been had it been sent a moment later. Answers whether it took the message.
//
// Deliberately silent: no `user` event, no delivery report. The row goes back to PENDING and the
// delivery that eventually runs it writes the one bubble that message ever gets — announcing it
// here would leave a second one behind, showing what the person sent twice. What they see in the
// meantime is the queued-message state the control plane already publishes for it.
func (d *codexSteerDispatcher) requeue(resp *RunInboxResponse, cause error) bool {
	refusal := classifyCodexSteerFailure(cause)
	if refusal.unsupported {
		d.app.steerUnsupported.Store(true)
	}
	if !refusal.requeue {
		return false
	}
	if !resp.SteerRequeue {
		// A control plane that predates `steer_requeue`. Its turn-complete does not read the
		// subtype, so re-filing would ack the row and lose the message outright; a visible
		// failure the person can re-send is the safe half of that trade (§5.3).
		logln("codex steer", refusal.code, "for", d.job.SessionID+
			": the control plane cannot re-file it, reporting it undelivered instead")
		return false
	}
	logln("codex steer", refusal.code, "for", d.job.SessionID+
		": provably not delivered, re-filing it as an ordinary message —", cause.Error())
	requeueSteerTurn(resp.TurnID, d.job, d.completeTurn)
	return true
}

// fail reports one steer as undelivered and settles it. It settles nothing else: the turn this
// message was aimed at is still running, and taking a working session down over a side-channel
// message that never arrived is the opposite of what a steer's own turn is for.
//
// This is where a turn ending answers for the steers it was still holding, too — a steer Codex
// took and never echoed back (§4.4) reaches it with a bubble already open, which the report
// amends rather than duplicating.
func (d *codexSteerDispatcher) fail(turnID string, cause error) {
	refusal := classifyCodexSteerFailure(cause)
	logln("codex steer", refusal.code, "for", d.job.SessionID+":", cause.Error())
	if refusal.unsupported {
		d.app.steerUnsupported.Store(true)
	}
	d.announce(turnID, deliveryFailed, cause.Error(), refusal.retryable)
	settleSteerTurn(turnID, cause, d.job, d.completeTurn)
}

// announce publishes one steer's delivery state, addressed to its own turn, opening the bubble if
// this is the first thing anyone has said about the message and amending it otherwise.
//
// The first word can come from either of two goroutines — the one that sent the request, or the
// one reading Codex's notifications, which has been seen echoing a steer back before the response
// to it was observed (§3) — so which of them opens the bubble is a race, and only that the bubble
// is opened exactly once is not.
//
// The state is passed in rather than read off the record: what a report must say is the
// transition it belongs to, not whatever the record holds by the time the event is built.
func (d *codexSteerDispatcher) announce(turnID string, state deliveryState, reason string, retryable bool) {
	d.activeMu.Lock()
	rec := codexSteerRecord(*d.active, turnID)
	opening := rec != nil && !rec.announced
	var text string
	var attachments []map[string]interface{}
	if opening {
		rec.announced = true
		text, attachments = rec.text, rec.attachments
	}
	d.activeMu.Unlock()
	if opening {
		userEv := map[string]interface{}{
			"text": text, "steer": true, "delivery": string(state),
		}
		if len(attachments) > 0 {
			userEv["attachments"] = attachments
		}
		d.emitFor(turnID, evUser, userEv)
	}
	d.report(turnID, state, reason, retryable)
}

// report files one delivery state against the message's own turn, without touching the bubble.
func (d *codexSteerDispatcher) report(turnID string, state deliveryState, reason string, retryable bool) {
	p := map[string]interface{}{"turnId": turnID, "delivery": string(state)}
	if reason != "" {
		p["reason"] = reason
		p["retryable"] = retryable
	}
	d.emitFor(turnID, evUserDelivery, p)
}
