package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
)

func init() { subagentChildRunners[providerKimi] = runKimiChild }

// runKimiChild runs Kimi Code as a SubAgent: the session's own ACP launch (startKimiACP, its private home overlay
// and MCP configuration) and notification parsing (handleKimiNotification) in the parent's cwd, in child mode — the
// overlay under the run's own dir, an ACP session of its own (session/resume of it on a resume), one
// session/prompt, and no inbox, turn-complete, diff, finalize or commit. `orbit mcp` inherits the kimi process's
// environment, ORBIT_SUBAGENT_RUN_ID included, so the child is not offered delegate. Permission requests go through
// the session's bridge under the child's context, so a card names the run.
func runKimiChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	resumeID := ""
	if c.resume {
		resumeID = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerKimi, resumeID)
	if err := guardKimiProjectMCP(c.cwd); err != nil {
		return ExecResult{Status: stFailed}, "", err
	}
	if msg := kimiToolPolicyError(child.Agent); msg != "" {
		return ExecResult{Status: stFailed}, "", errors.New(msg)
	}
	realHome, err := effectiveKimiHome(envWithAgent(child.Agent.Env), c.cwd)
	if err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to resolve the Kimi home directory: " + err.Error())
	}
	if err := ensureKimiHomeStores(realHome); err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to prepare the Kimi home: " + err.Error())
	}
	_ = os.MkdirAll(c.scratch, 0o700)
	kimiHome, err := prepareKimiHomeOverlay(c.scratch, realHome)
	if err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to prepare the private Kimi home: " + err.Error())
	}
	defer func() { _ = removeKimiHomeOverlay(kimiHome) }()
	orbitExe := orbitCLIExecutable()
	if err := writeKimiHomeMCPConfig(kimiHome, kimiMCPConfigRecord(child.Agent, orbitExe)); err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to write the Kimi MCP configuration: " + err.Error())
	}
	app, err := startKimiACP(ctx, c.t, child, c.cwd, kimiHome, c.emit)
	if err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to spawn kimi acp: " + err.Error())
	}
	c.started(app.cmd)
	defer app.close()

	var activeMu sync.Mutex
	var active *kimiActiveTurn
	gauge := &kimiUsageGauge{}
	var sessionMu sync.Mutex
	expected := ""
	// The single consumer of Kimi's stdout, as the session's: responses carry FIFO barriers, so every
	// notification before a response is handled before the response is read.
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		process := func(item kimiInboundItem) {
			if item.barrier != nil {
				close(item.barrier)
				return
			}
			if item.message != nil {
				sessionMu.Lock()
				id := expected
				sessionMu.Unlock()
				// A call's arguments come in its tool_call_update (its tool_call carries rawInput null): told to
				// the changedFiles collector before the update's result, and after the call it completes.
				update := kimiChildToolInput(*item.message)
				if update != nil && update["kind"] == "tool_call_update" {
					c.emit(evSubagentToolInput, update)
				}
				handleKimiNotification(id, *item.message, c.emit, &activeMu, &active, gauge, nil)
				if update != nil && update["kind"] == "tool_call" {
					c.emit(evSubagentToolInput, update)
				}
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-app.done:
				for {
					select {
					case item := <-app.notifications:
						process(item)
					default:
						return
					}
				}
			case item := <-app.notifications:
				process(item)
			}
		}
	}()

	if err := app.initialize(ctx); err != nil {
		return kimiChildFailure(ctx, "", errors.New(kimiAuthMessage(err)))
	}
	sessionID, err := app.startOrResumeSession(ctx, child, c.cwd)
	if err != nil {
		return kimiChildFailure(ctx, resumeID, errors.New(kimiAuthMessage(err)))
	}
	child.RuntimeSessionID = sessionID
	sessionMu.Lock()
	expected = sessionID
	sessionMu.Unlock()
	if err := app.configureSession(ctx, sessionID, child.Agent); err != nil {
		return kimiChildFailure(ctx, sessionID, errors.New("failed to configure Kimi session: "+err.Error()))
	}

	activeMu.Lock()
	active = &kimiActiveTurn{orbitTurnID: c.runID, seenTools: map[string]bool{}, doneTools: map[string]bool{}}
	activeMu.Unlock()
	app.beginPermissionTurn()
	wire, wireFrom := kimiTurnWire(realHome, sessionID)
	text := kimiPromptText(child.instructionAgent(), orbitExe, c.prompt, child.insideRecordedWork(), child.watchesOn())
	result, promptErr := app.request(ctx, "session/prompt", map[string]interface{}{
		"sessionId": sessionID,
		"prompt":    []map[string]interface{}{{"type": "text", "text": text}},
	})
	app.cancelPermissions()
	var outcome kimiTurnOutcome
	if promptErr == nil && strings.EqualFold(firstString(result, "stopReason", "stop_reason"), "end_turn") {
		outcome = readKimiTurnOutcome(ctx, wire, wireFrom)
	}
	// What the stream said before the answer was handled before it (the barrier); close the turn.
	activeMu.Lock()
	turn := active
	active = nil
	activeMu.Unlock()
	if turn != nil {
		turn.flushThought(c.emit)
		turn.flushText(c.emit)
	}
	if promptErr != nil {
		return kimiChildFailure(ctx, sessionID, promptErr)
	}
	reply := ""
	if turn != nil {
		reply = strings.TrimSpace(turn.text.String())
	}
	switch strings.ToLower(firstString(result, "stopReason", "stop_reason")) {
	case "cancelled":
		return ExecResult{Status: stCancelled, Result: reply}, sessionID, nil
	case "refusal":
		return subagentChildResult(stFailed, reply, "Kimi refused the task", 0, nil), sessionID, nil
	}
	switch {
	case outcome.failure != "":
		return subagentChildResult(stFailed, reply, outcome.failure, 0, nil), sessionID, nil
	case outcome.read && !outcome.ran && turn != nil && kimiTurnSaidNothing(turn):
		return subagentChildResult(stFailed, "", kimiNoTurn, 0, nil), sessionID, nil
	}
	return subagentChildResult(stSucceeded, reply, "", 0, nil), sessionID, nil
}

func kimiChildFailure(ctx context.Context, sessionID string, err error) (ExecResult, string, error) {
	if ctx.Err() != nil {
		return ExecResult{Status: stCancelled}, sessionID, nil
	}
	return ExecResult{Status: stFailed}, sessionID, fmt.Errorf("%w", err)
}

// kimiChildToolInput is a session/update's tool arguments as an evSubagentToolInput payload (plus the update's
// kind), or nil for an update that carries none.
func kimiChildToolInput(msg kimiRPCMessage) map[string]interface{} {
	if msg.Method != "session/update" {
		return nil
	}
	update := mapValue(rawObject(msg.Params)["update"])
	kind := firstString(update, "sessionUpdate", "session_update")
	if kind != "tool_call" && kind != "tool_call_update" {
		return nil
	}
	id := firstString(update, "toolCallId", "tool_call_id")
	input := mapValue(firstPresent(update, "rawInput", "raw_input"))
	if id == "" || input == nil {
		return nil
	}
	return map[string]interface{}{"kind": kind, "toolUseId": id, "input": input}
}
