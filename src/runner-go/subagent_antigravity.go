package main

import (
	"context"
	"encoding/json"
	"errors"
)

func init() {
	subagentChildRunners[providerAntigravity] = runAntigravityChild
}

// antigravityConversationLostNote is what a resumed SubAgent's result starts with when agy could not find the
// conversation it was asked to continue and started a new one (handleInit's notice, contract §4.3).
const antigravityConversationLostNote = "Antigravity could not find this SubAgent's earlier conversation and started a new one, so it did not have what it was told before."

// runAntigravityChild runs agy as a SubAgent (subagentChildRunner): launched by the session's own spawn code
// (agyDriver.spawn — Gemini directory, Google sign-in or key, approval gate) in the parent's cwd, every step parsed
// by handleAgyStep, one message, and the turn settled by the session's own settleTurn. No inbox, no turn-complete,
// no diff and no session meta. The Gemini directory, which holds agy's conversations, is under the run's state
// dir: on a resume that is the opening run's, so --conversation finds what that run said.
func runAntigravityChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	conversation := ""
	if c.resume {
		conversation = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerAntigravity, conversation)
	if err := guardAntigravityProjectConfig(c.cwd, child.Agent.PermissionMode); err != nil {
		return ExecResult{Status: stFailed}, conversation, err
	}
	d := &agyDriver{
		ctx: ctx, t: c.t, job: child, execDir: c.cwd, scratchDir: firstNonEmpty(c.stateDir, c.scratch),
		emit: c.emit, setTurn: func(string) {},
	}
	defer func() {
		if d.stopTimer != nil {
			d.stopTimer.Stop()
		}
		if d.proc != nil {
			d.proc.stop(agyStopGrace)
		}
	}()
	if err := d.spawn(); errors.Is(err, errAgySignInRefused) {
		noteEngineSignedOut()
		return ExecResult{Status: stFailed}, conversation, errors.New(antigravityGoogleSignedOutMessage)
	} else if errors.Is(err, errAgySignInUnchecked) {
		return ExecResult{Status: stFailed}, conversation, errors.New(antigravityGoogleUnreachableMessage)
	} else if err != nil {
		return ExecResult{Status: stFailed}, conversation, errors.New("failed to start Antigravity: " + err.Error())
	}
	turn := newAgyTurn(c.runID)
	d.turn = turn
	frame, err := json.Marshal(map[string]interface{}{
		"event":   "user",
		"message": map[string]interface{}{"content": c.prompt},
	})
	if err != nil {
		return ExecResult{Status: stFailed}, conversation, err
	}
	d.proc.send(append(frame, '\n'))

	lost := false
	end := func(result map[string]interface{}, failure string) (ExecResult, string, error) {
		status, _, errText, text := d.settleTurn(turn, result, failure)
		if lost && text != "" {
			text = antigravityConversationLostNote + "\n\n" + text
		}
		usage := turn.usage
		// agy reports no cost.
		return subagentChildResult(status, text, errText, 0, &usage), child.RuntimeSessionID, nil
	}
	for {
		select {
		case <-ctx.Done():
			return ExecResult{Status: stCancelled}, child.RuntimeSessionID, nil
		case <-d.stopTimerC():
			d.stopTimer = nil
			if d.proc != nil {
				d.proc.cancel()
			}
		case event, ok := <-d.events():
			if !ok {
				d.proc.eventsDone = true
				continue
			}
			p := d.proc
			switch firstString(event, "event") {
			case "init":
				p.initialized = true
				if id := firstString(event, "conversation_id"); id != "" {
					lost = conversation != "" && id != conversation
					child.RuntimeSessionID = id
				}
			case "step_update":
				step := mapValue(event["step_update"])
				if step == nil {
					continue
				}
				if p.gate != nil {
					if problem := p.gate.check(step); problem != "" {
						// As breakGate: nothing would ask before agy acts, so it stops now.
						p.retiring = true
						p.interrupt()
						return end(nil, "Orbit stopped Antigravity because its approval hook is no longer in force: "+problem+".")
					}
				}
				handleAgyStep(step, turn, c.emit)
			case "result":
				result := mapValue(event["result"])
				// A Google sign-in agy could not use: whether it was refused is known once it has exited.
				if p.google && !p.initialized && firstString(result, "error") == "authentication failed or timed out" {
					d.retire()
					continue
				}
				return end(result, "")
			}
		case <-d.exited():
			p := d.proc
			switch p.authEnd() {
			case agyAuthEndRefused:
				noteEngineSignedOut()
				return end(nil, antigravityGoogleSignedOutMessage)
			case agyAuthEndNetwork:
				return end(nil, antigravityGoogleUnreachableMessage)
			}
			return end(nil, p.exitDetail())
		}
	}
}
