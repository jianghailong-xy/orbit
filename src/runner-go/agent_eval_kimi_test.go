package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// ── Kimi Code ────────────────────────────────────────────────────────────────────────────────────────

// kimiEvalEngine drives Kimi Code as runKimiSessionProcess does: the session's private Kimi home with Orbit's MCP
// server in it (prepareKimiHomeOverlay, kimiMCPConfigRecord), `kimi acp` with the session's environment
// (startKimiACP), its handshake and configuration, each prompt as prepareKimiPrompt builds it, and its stream read by
// handleKimiNotification, with the session's kimiInstructionLedger deciding which prompts carry the instructions. Kimi's permission requests go to the eval's control plane (bridgeKimiPermission), which
// answers them as the scenario's owner. It has no reset: a compaction or a resume is not played (reset answers false).
type kimiEvalEngine struct {
	model, version string
	app            *kimiACPClient
	sessionID      string
	overlay        string
	instructions   *kimiInstructionLedger
	activeMu       sync.Mutex
	active         *kimiActiveTurn
	gauge          kimiUsageGauge
	loopDone       chan struct{}
	nextTurn       int
}

func (e *kimiEvalEngine) identity() (string, string, string, string) {
	if e.model == "" {
		return providerKimi, "live", e.version, "engine-default"
	}
	return providerKimi, "live", e.version, e.model
}

func (e *kimiEvalEngine) start(s *evalSession) error {
	exe, err := evalPinEngine(s, providerKimi, "")
	if err != nil {
		return err
	}
	e.version = evalVersionRE.FindString(engineVersion(exe))
	s.job.Provider, s.job.Agent.Provider = providerKimi, providerKimi
	s.job.Agent.Model = e.model
	if msg := kimiToolPolicyError(s.job.Agent); msg != "" {
		return errors.New(msg)
	}
	realHome, err := effectiveKimiHome(envWithAgent(s.job.Agent.Env), s.work)
	if err != nil {
		return err
	}
	if err := ensureKimiHomeStores(realHome); err != nil {
		return err
	}
	if e.overlay, err = prepareKimiHomeOverlay(s.scratch, realHome); err != nil {
		return err
	}
	overlay := e.overlay
	s.cleanup = append(s.cleanup, func() { _ = removeKimiHomeOverlay(overlay) })
	if err := writeKimiHomeMCPConfig(e.overlay, kimiMCPConfigRecord(s.job.Agent, s.exe)); err != nil {
		return err
	}
	s.probeMCP(false)
	s.context.EngineInstructions = len(kimiAgentInstructionsOf(s.job.Agent, s.exe, s.job.insideRecordedWork(), s.job.watchesOn(), true))

	plane := NewTransport(s.plane.srv.URL, "eval-runner-token")
	app, err := startKimiACP(s.ctx, plane, s.job, s.work, e.overlay, s.rec.emit)
	if err != nil {
		return err
	}
	e.app = app
	e.loopDone = make(chan struct{})
	sessionID := make(chan string, 1)
	go func() {
		defer close(e.loopDone)
		expected := ""
		for {
			select {
			case id := <-sessionID:
				expected = id
			case <-s.ctx.Done():
				return
			case <-app.done:
				return
			case item := <-app.notifications:
				if item.barrier != nil {
					close(item.barrier)
					continue
				}
				if item.message != nil {
					handleKimiNotification(expected, *item.message, s.rec.emit, &e.activeMu, &e.active, &e.gauge, s.bg)
				}
			}
		}
	}()
	if err := app.initialize(s.ctx); err != nil {
		return fmt.Errorf("initialize: %s", kimiAuthMessage(err))
	}
	id, err := app.startOrResumeSession(s.ctx, s.job, s.work)
	if err != nil {
		return fmt.Errorf("session: %s", kimiAuthMessage(err))
	}
	sessionID <- id
	e.sessionID = id
	e.instructions = newKimiInstructionLedger(realHome, id)
	s.job.RuntimeSessionID = id
	if err := app.configureSession(s.ctx, id, s.job.Agent); err != nil {
		return fmt.Errorf("configure: %w", err)
	}
	return nil
}

func (e *kimiEvalEngine) setMode(s *evalSession, mode string) error {
	s.job.Agent.PermissionMode = mode
	return e.app.configureSession(s.ctx, e.sessionID, s.job.Agent)
}

func (e *kimiEvalEngine) turn(s *evalSession, log *evalTurnLog) error {
	e.nextTurn++
	turn := &kimiActiveTurn{orbitTurnID: fmt.Sprintf("eval-turn-%d", e.nextTurn),
		seenTools: map[string]bool{}, doneTools: map[string]bool{}, unsent: make(chan struct{})}
	e.activeMu.Lock()
	if e.active != nil {
		e.activeMu.Unlock()
		return errors.New("a kimi turn is still active")
	}
	e.active = turn
	e.activeMu.Unlock()
	prepared := prepareKimiPrompt(s.ctx, nil, s.job, &RunInboxResponse{Content: log.Prompt}, nil, e.instructions)
	s.rec.emit(evUser, map[string]interface{}{"text": log.Prompt})
	e.app.beginPermissionTurn()
	result, err := e.app.request(s.ctx, "session/prompt", map[string]interface{}{"sessionId": e.sessionID, "prompt": prepared.blocks})
	e.app.cancelPermissions()
	e.activeMu.Lock()
	e.active = nil
	e.activeMu.Unlock()
	turn.flushThought(s.rec.emit)
	turn.flushText(s.rec.emit)
	if err != nil {
		return fmt.Errorf("session/prompt: %w", err)
	}
	if stop := strings.ToLower(firstString(result, "stopReason", "stop_reason")); stop != "end_turn" {
		log.Error = "stopped: " + stop
	}
	return nil
}

func (e *kimiEvalEngine) reset(*evalSession, string) (bool, error) { return false, nil }

func (e *kimiEvalEngine) stop(*evalSession) {
	if e.app != nil {
		e.app.close()
		if e.loopDone != nil {
			<-e.loopDone
		}
		e.app = nil
	}
}
