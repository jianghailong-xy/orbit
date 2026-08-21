package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// What happens to a mid-turn message when things go wrong, which for a steer is a category of its
// own: it is leased once and never re-leased, it produces no reply to notice the absence of, and
// Codex does not de-duplicate — so "send it again and see" is not available as a recovery, on
// either side. Every failure has to be answered exactly once, and answered with the right one of
// two words: PROVABLY not delivered (safe to re-file, nobody need ever know) or NOT KNOWN to be
// delivered (report it, and let a person decide).
//
// These drive the same fake app-server the delivery tests do (codex_steer_test.go), because the
// races worth testing are between the same three goroutines — the one that sent the request, the
// one reading notifications, and the turn ending underneath both.

// steerCompletion waits for a steer's own turn to be settled and returns how.
func steerCompletion(t *testing.T, s *codexSteerSession, turnID string) TurnCompleteRequest {
	t.Helper()
	waitFor(t, "the steer to be settled", func() bool { return s.completionFor(turnID) != nil })
	return *s.completionFor(turnID)
}

// A turn can end between the control plane deciding this message joins it and the runner getting
// there — the two are a network apart, and "the turn just ended" is the commonest reason a steer
// is refused at all. Codex rejects it before reading the input, so the message provably never
// entered the conversation, and the right outcome is the one nobody has to be told about: it
// becomes the ordinary next message, exactly as if it had been sent a moment later.
func TestATurnEndingUnderASteerRefilesItAsAnOrdinaryMessage(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.refuse(s.fake.take("turn/steer"), "no active turn to steer")
	<-done

	c := steerCompletion(t, s, steerOrbitTurn)
	if c.Subtype != subtypeSteerRequeue || c.Status != stSucceeded {
		t.Errorf("completion = %+v, want a succeeded %q", c, subtypeSteerRequeue)
	}
	// Nothing at all in the transcript. The row goes back to being a queued message and the
	// delivery that eventually runs it writes the one bubble this message gets — a bubble left
	// here would be that message shown twice, one of them permanently stuck mid-flight.
	if got := s.deliveries(steerOrbitTurn); len(got) != 0 {
		t.Errorf("delivery events = %v, want none: a re-filed message has not failed", got)
	}
	if n := s.bubbles(steerOrbitTurn); n != 0 {
		t.Errorf("user events = %d, want none", n)
	}
}

// Every refusal Codex issues before it reads the input is the same kind of fact — the message is
// provably not in the conversation — whatever prose it arrives in. They are all re-filed, and the
// runner's own pre-flight refusals (nothing was sent at all) with them.
func TestEveryProvablyUndeliveredSteerIsRefiled(t *testing.T) {
	for _, tc := range []struct {
		name string
		// refuse is how this failure reaches the dispatcher: an answer from Codex, or a state
		// the runner refuses in before sending anything.
		refuse func(*codexSteerSession)
		aimed  bool
	}{
		{
			name:   "the turn ended first",
			refuse: func(s *codexSteerSession) { s.fake.refuse(s.fake.take("turn/steer"), "no active turn to steer") },
			aimed:  true,
		},
		{
			name: "the turn moved on",
			refuse: func(s *codexSteerSession) {
				s.fake.refuse(s.fake.take("turn/steer"),
					"expected active turn id `"+steerCodexTurn+"` but found `"+steerNoSuchTurn+"`")
			},
			aimed: true,
		},
		{
			name: "codex answered for a different turn",
			refuse: func(s *codexSteerSession) {
				s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerNoSuchTurn})
			},
			aimed: true,
		},
		{
			name: "this codex has no turn/steer at all",
			refuse: func(s *codexSteerSession) {
				s.fake.refuse(s.fake.take("turn/steer"),
					"Invalid request: unknown variant `turn/steer`, expected one of `initialize`, `turn/start`")
			},
			aimed: true,
		},
		{
			// Never aimed: turn/start has not named the turn, so there is no expectedTurnId to
			// address the request to and not a byte goes out.
			name:   "the turn was never named",
			refuse: func(s *codexSteerSession) {},
			aimed:  false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newCodexSteerSession(t)
			s.startTurn()
			if tc.aimed {
				s.name(steerCodexTurn)
			}
			ctx := context.Background()
			if !tc.aimed {
				// Bound the wait for a turn id that is never coming, instead of the ten seconds
				// the real budget would spend on it.
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 150*time.Millisecond)
				defer cancel()
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				s.steer(ctx, steerOrbitTurn, "actually, call it gadget")
			}()
			tc.refuse(s)
			<-done

			c := steerCompletion(t, s, steerOrbitTurn)
			if c.Subtype != subtypeSteerRequeue || c.Status != stSucceeded {
				t.Errorf("completion = %+v, want a succeeded %q", c, subtypeSteerRequeue)
			}
			if got := s.deliveries(steerOrbitTurn); len(got) != 0 {
				t.Errorf("delivery events = %v, want none", got)
			}
		})
	}
}

// The other half of the same rule, and the half that matters more: an outcome that is merely
// UNKNOWN must never be re-filed. Codex inserts whatever it is given, so a message it had in fact
// taken would be executed twice — once inside the turn and once as the turn after it — and the
// second one reads as the model doing unasked-for work. A visible failure is the correct trade:
// the person can see it and re-send, and nothing runs that they did not ask for.
func TestASteerWithAnUnknownOutcomeIsReportedRatherThanRefiled(t *testing.T) {
	for _, tc := range []struct {
		name      string
		answer    func(*codexSteerSession)
		wantCode  string
		retryable bool
	}{
		{
			// The request went out and no answer came back. It may have been read.
			name: "the app-server stopped answering",
			answer: func(s *codexSteerSession) {
				s.fake.take("turn/steer") // taken and deliberately never answered
			},
			wantCode:  "E-TIMEOUT",
			retryable: true,
		},
		{
			name: "a refusal nobody has seen before",
			answer: func(s *codexSteerSession) {
				s.fake.refuse(s.fake.take("turn/steer"), "the turn is in a state that cannot be steered")
			},
			wantCode:  "E-UNKNOWN",
			retryable: true,
		},
		{
			// Orbit built the request wrong. Re-filing it would rebuild the same request and hit
			// the same wall, forever, silently — so this one is reported and NOT retryable.
			name: "orbit sent a malformed request",
			answer: func(s *codexSteerSession) {
				s.fake.refuse(s.fake.take("turn/steer"), "Invalid request: missing field `expectedTurnId`")
			},
			wantCode:  "E-BAD-REQUEST",
			retryable: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newCodexSteerSession(t)
			s.startTurn()
			s.name(steerCodexTurn)
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			done := make(chan struct{})
			go func() {
				defer close(done)
				s.steer(ctx, steerOrbitTurn, "actually, call it gadget")
			}()
			tc.answer(s)
			<-done

			c := steerCompletion(t, s, steerOrbitTurn)
			if c.Subtype != subtypeSteer || c.Status != stFailed {
				t.Errorf("completion = %+v, want a failed %q — never a re-file", c, subtypeSteer)
			}
			// The failure is in the transcript, with the retryable semantics that say whether
			// sending it again is a recovery or a loop.
			last := s.lastDelivery(steerOrbitTurn)
			if asString(last["delivery"]) != string(deliveryFailed) {
				t.Errorf("last delivery = %v, want failed", last)
			}
			if last["retryable"] != tc.retryable {
				t.Errorf("retryable = %v, want %v", last["retryable"], tc.retryable)
			}
			if strings.TrimSpace(asString(last["reason"])) == "" {
				t.Error("the failure carries no reason; a person has nothing to act on")
			}
			// One bubble, showing the message that did not arrive rather than nothing at all.
			if n := s.bubbles(steerOrbitTurn); n != 1 {
				t.Errorf("user events = %d, want exactly one", n)
			}
		})
	}
}

// A control plane that predates `steer_requeue` reads a turn-complete's status and ignores its
// subtype, so re-filing through one would ack the row — and a steer that has been acked is never
// delivered again by anything. The message would be gone with no event and no trace, which is
// strictly worse than the failure it was trying to avoid. So the runner asks first, and the
// answer rides on the delivery itself.
func TestASteerIsNotRefiledThroughAControlPlaneThatCannotTakeItBack(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steerFromLegacyControlPlane(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.refuse(s.fake.take("turn/steer"), "no active turn to steer")
	<-done

	c := steerCompletion(t, s, steerOrbitTurn)
	if c.Subtype == subtypeSteerRequeue {
		t.Fatalf("re-filed through a control plane that would have acked it away: %+v", c)
	}
	if c.Subtype != subtypeSteer || c.Status != stFailed {
		t.Errorf("completion = %+v, want a failed %q", c, subtypeSteer)
	}
	// Visible and re-sendable: nothing was written, so sending it again is safe.
	if last := s.lastDelivery(steerOrbitTurn); asString(last["delivery"]) != string(deliveryFailed) ||
		last["retryable"] != true {
		t.Errorf("last delivery = %v, want a retryable failure", last)
	}
}

// The same conversation turn handed over twice. It should not happen — the control plane leases a
// steer once and never re-leases it — but "should not" is not a guarantee anything downstream can
// rest on, and the cost of being wrong here is not a duplicate event: Codex does not de-duplicate
// on clientUserMessageId, so a second delivery would put the person's message into the
// conversation a second time and the model would read it as asking twice.
func TestTheSameSteerDeliveredTwiceIsOnlyWrittenOnce(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	first := s.fake.take("turn/steer")
	s.fake.answer(first, map[string]interface{}{"turnId": steerCodexTurn})
	<-done

	// The copy, arriving after the original was written into the turn.
	s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")

	if got := s.fake.methods(); len(got) != 1 || got[0] != "turn/steer" {
		t.Errorf("requests sent = %v, want exactly one turn/steer", got)
	}
	// And the copy is not re-filed either: re-filing would queue a duplicate of a message the
	// engine already has, which is the very thing refusing it prevented.
	_, completions := s.snapshot()
	for _, c := range completions {
		if c.TurnID == steerOrbitTurn && c.Subtype == subtypeSteerRequeue {
			t.Fatalf("a duplicate delivery was re-filed as a second message: %+v", c)
		}
	}
	// The original's own state is untouched by the copy: it is still on its way in, not failed.
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryWritten) {
		t.Errorf("delivery states = %v, want the original still written", got)
	}
	if n := s.bubbles(steerOrbitTurn); n != 1 {
		t.Errorf("user events = %d, want exactly one", n)
	}
}

// Contract §4.4, and §8's first open question with it: a steer Codex accepted and then never
// echoed back. The measured cause is an interrupt landing while it was still buffered, which
// Codex discards silently — no notification, nothing in the thread.
//
// The turn ending is what settles it, and it settles as UNKNOWN rather than as provably
// undelivered: the observed order is always echo-then-completed, but "always observed" is not
// "cannot happen", and the cost of being wrong is a duplicate message in the conversation. The
// two orderings are both tested here, so the day the answer is proven the change to make is
// visible: only the first of these could ever become a re-file.
func TestAnAcceptedSteerThatWasNeverEchoedIsReportedNotRefiled(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
	<-done
	waitFor(t, "the steer to report written", func() bool {
		return len(s.deliveries(steerOrbitTurn)) >= 1
	})

	// The turn ends without the echo ever arriving.
	s.finalize(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})

	c := steerCompletion(t, s, steerOrbitTurn)
	if c.Subtype != subtypeSteer || c.Status != stFailed {
		t.Errorf("completion = %+v, want a failed %q", c, subtypeSteer)
	}
	if !strings.Contains(c.Result, "not delivered") {
		t.Errorf("completion result = %q, want it to say the message did not arrive", c.Result)
	}
	last := s.lastDelivery(steerOrbitTurn)
	if asString(last["delivery"]) != string(deliveryFailed) || last["retryable"] != true {
		t.Errorf("last delivery = %v, want a retryable failure", last)
	}
	// One bubble still: the message was announced when Codex took it, and the turn ending
	// amended that same bubble rather than adding another.
	if n := s.bubbles(steerOrbitTurn); n != 1 {
		t.Errorf("user events = %d, want exactly one", n)
	}

	// An echo arriving after all that — the reordering §4.4 leaves open — does not walk the
	// failure back, and above all does not settle the turn a second time.
	before := len(s.deliveries(steerOrbitTurn))
	s.echo(steerOrbitTurn)
	time.Sleep(50 * time.Millisecond)
	if got := s.deliveries(steerOrbitTurn); len(got) != before {
		t.Errorf("a late echo changed the settled report: %v", got)
	}
}

// The same turn ending, the other way round: the echo lands first. Then the message IS in the
// conversation, and the turn ending has nothing left to answer for.
func TestAnEchoBeforeTheTurnEndsSettlesTheSteerAsDelivered(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
	<-done

	s.echo(steerOrbitTurn)
	waitFor(t, "the steer to be acknowledged", func() bool { return s.completionFor(steerOrbitTurn) != nil })
	s.finalize(codexTurnResult{Status: stSucceeded, Subtype: "completed"})

	c := *s.completionFor(steerOrbitTurn)
	if c.Subtype != subtypeSteer || c.Status != stSucceeded {
		t.Errorf("completion = %+v, want a succeeded %q", c, subtypeSteer)
	}
	// Settled exactly once. The turn ending claims every steer still open on it, and a steer the
	// echo already answered is not one of them.
	_, completions := s.snapshot()
	settlements := 0
	for _, done := range completions {
		if done.TurnID == steerOrbitTurn {
			settlements++
		}
	}
	if settlements != 1 {
		t.Errorf("the steer was settled %d times, want once", settlements)
	}
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryAcknowledged) {
		t.Errorf("delivery states = %v, want acknowledged last", got)
	}
}

// A steer's whole outcome lives on the session's event stream, and only a live runner writes to
// that stream. So a process that dies holding one leaves a row nothing will ever come back for:
// the inbox only hands out a PENDING steer, its lease is deliberately not reclaimable, and the
// turn it was aimed at only re-files a steer that never left PENDING. The control plane hands it
// to whoever takes the session over, which is the only party that can still say what became of it.
func TestASteerStrandedByADeadProcessIsAnsweredByTheNextOne(t *testing.T) {
	for _, tc := range []struct {
		name        string
		announced   bool
		wantBubbles int
	}{
		// The dead process never got as far as the transcript, so the report has to open the
		// bubble as well as settle it — otherwise the message is invisible in every view there is.
		{name: "the message was never announced", announced: false, wantBubbles: 1},
		// It did, so the bubble is already there. A second would show the same message twice.
		{name: "the message was already announced", announced: true, wantBubbles: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newCodexSteerSession(t)
			reportAbandonedSteer(
				AbandonedSteer{TurnID: steerOrbitTurn, Content: "actually, call it gadget", Announced: tc.announced},
				s.job, s.dispatch.emitFor, s.dispatch.completeTurn)

			if n := s.bubbles(steerOrbitTurn); n != tc.wantBubbles {
				t.Errorf("user events = %d, want %d", n, tc.wantBubbles)
			}
			last := s.lastDelivery(steerOrbitTurn)
			if asString(last["delivery"]) != string(deliveryFailed) {
				t.Errorf("last delivery = %v, want failed", last)
			}
			// Retryable, because nothing here proves it did NOT arrive either — re-sending is
			// the person's call, made with the fact in front of them.
			if last["retryable"] != true {
				t.Errorf("retryable = %v, want true", last["retryable"])
			}
			if !strings.Contains(asString(last["reason"]), "unknown") {
				t.Errorf("reason = %q, want it to say the outcome is not known", last["reason"])
			}
			// Settled as a steer: its own row is answered and nothing else is. The session it
			// belongs to is being taken over, and failing it over a message that never reached
			// the engine would end a run that is about to resume.
			c := steerCompletion(t, s, steerOrbitTurn)
			if c.Subtype != subtypeSteer || c.Status != stFailed {
				t.Errorf("completion = %+v, want a failed %q", c, subtypeSteer)
			}
			if c.NumTurns != 0 || c.Usage != nil {
				t.Errorf("completion carried turn accounting: %+v", c)
			}
		})
	}
}

// A steer never carries the accounting of the turn it joined. It has no result, no usage and no
// turn of its own to count — the turn it was written into owns all of it — and a completion that
// claimed any of them would bill and settle that turn on the strength of a side-channel message.
func TestASteerSettlesOnlyItselfAndCountsNothing(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
	<-done
	s.echo(steerOrbitTurn)
	waitFor(t, "the steer to be acknowledged", func() bool { return s.completionFor(steerOrbitTurn) != nil })

	c := *s.completionFor(steerOrbitTurn)
	if c.NumTurns != 0 || c.CostUsd != 0 || c.Usage != nil || c.ModelUsage != nil {
		t.Errorf("steer completion carried the turn's accounting: %+v", c)
	}
	if c.Result != "" {
		t.Errorf("steer completion carried a result: %q — the turn it joined owns that", c.Result)
	}
	if c.ChangedFiles != nil || c.ChangedDiff != nil || c.BranchMerged || c.WorktreeDirty {
		t.Errorf("steer completion carried worktree state: %+v", c)
	}

	// And the turn it joined settles on its own terms, unchanged by any of it.
	s.finalize(codexTurnResult{Status: stSucceeded, Subtype: "completed"})
	main := steerCompletion(t, s, steerMainTurn)
	if main.Status != stSucceeded || main.Subtype != "completed" {
		t.Errorf("the steered turn settled as %+v, want its own succeeded result", main)
	}
}

// An engine generation ending under a queue of mid-turn messages — a provider switch respawning
// the app-server, a warm-timer eviction, a shutdown. Whatever the reason, nothing was sent for
// the messages still waiting, so they are provably not in the conversation and all of them go
// back to being ordinary queued messages. The alternative is what makes this worth a test: they
// are leased, so a queue simply dropped on the floor is that many messages gone with no trace.
func TestMessagesStillQueuedWhenTheEngineEndsAreAllRefiled(t *testing.T) {
	s := newCodexSteerSession(t)
	queued := []string{steerOrbitTurn, steerOtherTurn}

	// The drain the session loop runs on its way out (codex_appserver.go).
	for _, turnID := range queued {
		s.dispatch.refuse(&RunInboxResponse{
			TurnID: turnID, Kind: "steer", Content: "actually, call it gadget", SteerRequeue: true,
		}, errCodexSteerEngineGone)
	}

	for _, turnID := range queued {
		assertSteerRefiled(t, s, turnID)
	}
	// Not one request went out for any of them, which is what makes re-filing them safe.
	if got := s.fake.methods(); len(got) != 0 {
		t.Errorf("requests = %v, want none", got)
	}
}

// The failure table is closed: every way turn/steer can answer lands on a row of it, including
// answers nobody has seen. That is what makes the states Codex has that Orbit cannot easily
// construct — waiting on an approval, waiting on user input (contract §8, open question 2) —
// safe to leave unmeasured. Whatever prose such a refusal arrives in, it is either recognised
// (and re-filed only if the recognition PROVES non-delivery) or unrecognised, and unrecognised
// means reported: visible, retryable, and never silently doubled.
func TestAnUnrecognisedRefusalIsReportedRatherThanGuessedAt(t *testing.T) {
	for _, message := range []string{
		"turn is waiting on approval",
		"turn is waiting on user input",
		"the thread is busy",
		"",
	} {
		refusal := classifyCodexSteerFailure(errors.New("turn/steer: " + message))
		if refusal.requeue {
			t.Errorf("%q was treated as provably undelivered; an unknown answer must never re-file", message)
		}
		if refusal.code != "E-UNKNOWN" {
			t.Errorf("%q classified as %s, want E-UNKNOWN", message, refusal.code)
		}
		if !refusal.retryable {
			t.Errorf("%q was reported as not worth re-sending", message)
		}
	}
}
