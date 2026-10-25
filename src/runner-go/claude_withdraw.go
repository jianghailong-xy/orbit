package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Taking back a steer the engine has not read yet.
//
// A steer is written into the turn that is running, and `claude` folds it into the conversation
// only at its next tool boundary — which, behind a long tool call, can be minutes away. Until then
// the message waits in the CLI's own queue, and the CLI can drop it from there: the control
// request `cancel_async_message` names it by the uuid its frame carried (userTurnFrame) and
// answers whether it was dropped. That answer is what makes this safe. It is decided inside the
// engine — `cancelled: true` means nothing will ever read the message, `false` means something
// already has — so a withdrawal never has to guess whether the model saw what it takes back.
//
// Measured on 2.1.296 and 2.1.300 (a turn in a 20 s `sleep`, two messages written into it, the
// first withdrawn): the CLI answered in under 10 ms, 16 s before the tool ended; the withdrawn
// message was never echoed, never reached the model, and is not in the conversation file a resume
// rebuilds from; the other message arrived as usual. Asking about a message the CLI had already
// read answers false, and so does asking about one it never had.
//
// The control plane files a `withdraw` turn naming the steer, the poller hands it here, and the
// turn is completed with what came of it (subtypeSteerWithdraw): the person who asked is waiting
// for that answer on the other side of an HTTP request.

// claudeSteerWithdrawFloor is the oldest CLI the withdrawal was measured on. Below it, or before a
// process has said which version it is, a steer is not offered as withdrawable. A withdrawal asked
// for anyway is still sent: the CLI's own answer, a refusal included, is what decides.
const claudeSteerWithdrawFloor = "2.1.296"

// claudeWithdrawTimeout bounds the wait for the CLI's answer. The CLI services control requests
// beside whatever tool it is running and answers this one at once. The control plane waits longer
// than this for the whole round trip, so an answer that comes is never one nobody is waiting for.
const claudeWithdrawTimeout = 5 * time.Second

// subtypeSteerWithdraw completes a `withdraw` turn (TURN_COMPLETE_STEER_WITHDRAW in @orbit/shared).
const subtypeSteerWithdraw = "steer_withdraw"

// What a withdrawal came to (SteerWithdrawOutcome in @orbit/shared).
const (
	withdrawWithdrawn   = "withdrawn"
	withdrawAlreadyRead = "already_read"
	withdrawNotWaiting  = "not_waiting"
	withdrawFailed      = "failed"
)

var errWithdrawUnreadable = errors.New("the withdraw request names no message")

// withdrawTarget reads the steer a `withdraw` turn is about out of its content ({"turnId": …}).
func withdrawTarget(content string) (string, error) {
	var req struct {
		TurnID string `json:"turnId"`
	}
	if err := json.Unmarshal([]byte(content), &req); err != nil {
		return "", fmt.Errorf("%w: %v", errWithdrawUnreadable, err)
	}
	if strings.TrimSpace(req.TurnID) == "" {
		return "", errWithdrawUnreadable
	}
	return req.TurnID, nil
}

// steerWithdrawable says whether a steer written to a CLI of this version can be offered for
// withdrawal: one the withdrawal was measured on, so the uuid its frame carries is kept and
// `cancel_async_message` exists.
func steerWithdrawable(version string) bool {
	return claudeVersionAtLeast(version, claudeSteerWithdrawFloor)
}

// withdrawSteer asks the CLI to drop the steer delivered for turnID, and says what came of it.
// On `withdrawn` the message has already left the ledger — on the stdout reader's goroutine,
// before the frame after the CLI's answer was matched against it — and nothing reports on it again.
func withdrawSteer(ctx context.Context, rt *claudeRuntime, ledger *deliveryLedger, turnID string) (outcome, reason string) {
	d, read := ledger.waiting(turnID)
	if d == nil {
		if read {
			return withdrawAlreadyRead, "the engine had already read it into the turn"
		}
		return withdrawNotWaiting, "this engine process holds no such message on its way in"
	}
	if d.uuid == "" {
		return withdrawFailed, "this message was written without the id a withdrawal names it by"
	}
	withdrawn := false
	w, err := rt.requestControlAnswered(ctrlCancelAsyncMessage,
		map[string]interface{}{"message_uuid": d.uuid},
		func(resp claudeControlResponse, err error) {
			if err == nil && resp.Response["cancelled"] == true {
				withdrawn = ledger.withdraw(d)
			}
		})
	if err != nil {
		return withdrawFailed, err.Error()
	}
	if err := rt.awaitControl(ctx, w, claudeWithdrawTimeout); err != nil {
		return withdrawFailed, err.Error()
	}
	if withdrawn {
		return withdrawWithdrawn, ""
	}
	// `cancelled: false`: the CLI had taken it into the turn before this arrived, and its echo
	// is on the way.
	return withdrawAlreadyRead, "the engine had already read it into the turn"
}

// settleWithdrawTurn completes a `withdraw` turn with what came of it. The steer itself is not
// settled here: a withdrawn one's row is the control plane's to remove, which it does in this same
// completion, and every other outcome leaves the steer on its way to being read, answered for by
// its echo or by the turn it was aimed at exactly as before.
func settleWithdrawTurn(turnID, outcome, reason string, job *ClaimedSession, completeTurn turnCompleter) {
	if err := completeTurn(TurnCompleteRequest{
		TurnID:           turnID,
		Status:           stSucceeded,
		Result:           outcome,
		Error:            reason,
		Subtype:          subtypeSteerWithdraw,
		RuntimeSessionID: currentRuntimeSessionID(job),
	}); err != nil {
		logln("withdraw turn-complete failed for", job.SessionID+":", err)
	}
}
