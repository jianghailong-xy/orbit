package main

import (
	"strings"
	"sync"
	"time"
)

// Stop on a Codex app-server session is a request with an answer, as it is on the Claude path
// (session.go's interrupt arm): the runner asks Codex with turn/interrupt, and the transcript is
// marked Interrupted only once Codex says the turn ended — its answer, or the turn ending
// interrupted — or told the stop did not take (interruptFailureMessage). A Stop that went
// unanswered or was refused leaves nothing in flight, so pressing Stop again asks again.

// codexInterruptTimeout is how long a Stop waits for Codex to answer turn/interrupt before it says
// the stop did not take. A var so tests can shorten it.
var codexInterruptTimeout = 10 * time.Second

// codexStopState is what Stop needs beyond the Orbit turn in flight. Guarded by the session's activeMu.
type codexStopState struct {
	// running is the Codex turn its notifications say is under way, whoever started it. Codex also
	// runs turns nobody handed it — a background task reporting in — and those are exactly the
	// ones somebody presses Stop over.
	running string
	// runningInterruptSent: a turn/interrupt for running, sent while no Orbit turn was active, is
	// waiting for its answer.
	runningInterruptSent bool
	// waiting: a Stop has asked Codex to end a turn and has not had its answer yet. orbitTurnID is
	// the Orbit turn it was pressed on, where its marker or its failure goes: "" for a turn Codex
	// started itself.
	waiting     bool
	orbitTurnID string
}

// codexStopPlan is what one Stop does now.
type codexStopPlan struct {
	// interrupt: send turn/interrupt for this Codex turn. Empty with nothing else set, a
	// turn/interrupt is already on its way, or turn/start has not named the turn yet and
	// markCodexAppTurnStarted sends it once it does.
	interrupt string
	// beforeStart: the Orbit turn never reached Codex, so it is finalized as interrupted here.
	beforeStart bool
	// idle: nothing is running for the Stop to end.
	idle bool
}

// planCodexStop records a Stop and says what to send for it.
func planCodexStop(activeMu *sync.Mutex, active **codexAppActiveTurn, stop *codexStopState) codexStopPlan {
	activeMu.Lock()
	defer activeMu.Unlock()
	a := *active
	if a == nil || a.finishing {
		// No Orbit turn, or one already ending on its own (its turn_end says how). A turn Codex
		// started itself is still Codex's to stop.
		if stop.running == "" {
			return codexStopPlan{idle: true}
		}
		stop.await("")
		if stop.runningInterruptSent {
			return codexStopPlan{}
		}
		stop.runningInterruptSent = true
		return codexStopPlan{interrupt: stop.running}
	}
	stop.await(a.orbitTurnID)
	codexTurnID, beforeStart := requestCodexAppInterruptLocked(a)
	return codexStopPlan{interrupt: codexTurnID, beforeStart: beforeStart}
}

func (s *codexStopState) await(orbitTurnID string) {
	if !s.waiting {
		s.waiting, s.orbitTurnID = true, orbitTurnID
	}
}

// takeCodexStop ends the Stop waiting on Codex and returns the Orbit turn its answer goes on: any
// Stop when anyTurn, else only the one pressed on orbitTurnID. ok is false when no such Stop is
// waiting, so each Stop is answered once however many of its outcomes arrive.
func takeCodexStop(activeMu *sync.Mutex, stop *codexStopState, orbitTurnID string, anyTurn bool) (string, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if !stop.waiting || (!anyTurn && stop.orbitTurnID != orbitTurnID) {
		return "", false
	}
	stop.waiting = false
	return stop.orbitTurnID, true
}

// forgetCodexInterrupt says the turn/interrupt for codexTurnID is no longer on its way — answered,
// refused or timed out — so the next Stop sends another.
func forgetCodexInterrupt(activeMu *sync.Mutex, active **codexAppActiveTurn, stop *codexStopState, codexTurnID string) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if a := *active; a != nil && a.codexTurnID == codexTurnID {
		a.interruptSent = false
	}
	if stop.running == codexTurnID {
		stop.runningInterruptSent = false
	}
}

// trackCodexRunningTurn follows which Codex turn is running, from the session thread's own
// notifications. ended reports a turn/completed for the turn it was following (or for any, when it
// followed none), and interrupted whether that turn ended interrupted.
func trackCodexRunningTurn(threadID string, msg codexRPCMessage, activeMu *sync.Mutex, stop *codexStopState) (ended, interrupted bool) {
	if n := codexNotificationThreadID(msg); threadID != "" && n != "" && n != threadID {
		return false, false
	}
	switch msg.Method {
	case "turn/started":
		if id := nestedString(rawObject(msg.Params), "turn", "id"); id != "" {
			activeMu.Lock()
			stop.running, stop.runningInterruptSent = id, false
			activeMu.Unlock()
		}
	case "turn/completed":
		turn := mapValue(rawObject(msg.Params)["turn"])
		id := firstString(turn, "id")
		activeMu.Lock()
		defer activeMu.Unlock()
		if stop.running != "" && id != "" && id != stop.running {
			return false, false
		}
		stop.running, stop.runningInterruptSent = "", false
		return true, strings.ToLower(firstString(turn, "status")) == "interrupted"
	}
	return false, false
}
