package main

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// What is executing in each session this process supervises, stated whole on every heartbeat (HeartbeatRequest.Executing;
// plan step 1.6 of docs/session-three-state-plan.md). The control plane keeps Session.engineTurnActive, runningSubagents,
// runningBgJobs and runningBgShells by folding the event batches it receives: an id goes in at a launch and comes out at
// an end report. A batch that never arrives leaves an id in for good. The beat states the current sets instead, and the
// control plane replaces its own with them (apiserver runners/runner-executing-sets.ts).
//
// Where each set comes from:
//   - jobs and shells are what the session's tailer is running (bgTailer.executingSets): its runner-hosted jobs, and every
//     background process it tails or registered, Monitors included. Those are this process's own records.
//   - the engine turn and the subagents are folded here from the session's own event stream (executingFold), exactly as
//     the control plane folds them, but from every event this process emits rather than the ones that reached the server.
//     A subagent the engine runs inside its own process (Claude Code's Agent, Task and Workflow tools) is not stated
//     while no engine is resident: it went with the engine.
//
// The beat says when it was composed (HeartbeatRequest.ExecutingAt), read before the probes are. Every change a probe
// reads is made before the event that reports it is stamped (emitOne observes before it buffers; a job enters or leaves
// the tailer's records before its launch or end is emitted), so a change a beat missed carries a TS no earlier than the
// beat's instant, and the control plane keeps a batch that moved the sets at or after it over the beat.
//
// A session is named only while its run has installed its probe (sessionPool.setExecutingProbe); one that is being
// reclaimed, or whose run has ended, is not named, and the control plane leaves it as it is.

// executingIDsMax bounds one set: a longer one is not stated (the control plane's EXECUTING_IDS_MAX), and the control
// plane keeps what it has for it.
const executingIDsMax = 256

// executingSessionsMax bounds the sessions one beat names (the control plane's BACKGROUND_JOB_SESSIONS_MAX).
const executingSessionsMax = 512

// SessionExecuting is one session's entry in HeartbeatRequest.Executing. A nil set is not stated.
type SessionExecuting struct {
	SessionID        string    `json:"sessionId"`
	EngineTurnActive bool      `json:"engineTurnActive"`
	Subagents        *[]string `json:"subagents,omitempty"`
	Jobs             *[]string `json:"jobs,omitempty"`
	Shells           *[]string `json:"shells,omitempty"`
}

// executingSnapshot is what a session run's probe answers.
type executingSnapshot struct {
	engineTurnActive bool
	subagents        []string
	jobs             []string
	shells           []string
}

// statedSet is ids as an entry states them: sorted, never nil, and not stated at all past executingIDsMax.
func statedSet(ids []string) *[]string {
	if len(ids) > executingIDsMax {
		return nil
	}
	out := append([]string{}, ids...)
	sort.Strings(out)
	return &out
}

// runtimeSubagentTools are the tools whose top-level call launches a subagent or a workflow: the control plane's
// RUNTIME_SUBAGENT_TOOLS. The first three run inside the engine's own process; Orbit's run in this runner.
var runtimeSubagentTools = map[string]bool{
	"Task": true, "Agent": true, "Workflow": true, "mcp__orbit__delegate": true, "mcp__orbit__workflow": true,
}

// inEngineSubagentTools are those of runtimeSubagentTools whose subagents live in the engine's process.
var inEngineSubagentTools = map[string]bool{"Task": true, "Agent": true, "Workflow": true}

var workflowLaunchReceiptRe = regexp.MustCompile(`^Workflow launched in background\. Task ID: \S+`)

// subagentLaunchReceipt reports whether a top-level tool_result says its subagent runs on past it: an async Agent's ack, a
// workflow's receipt, a background SubAgent's or an Orbit workflow's `running` receipt. Its end comes later, as a
// terminal background_task. The control plane's isAsyncAgentLaunchAck, workflowLaunchReceipt, orbitWorkflowLaunchReceipt
// and delegateLaunchReceipt.
func subagentLaunchReceipt(content interface{}) bool {
	text := toolResultText(content)
	if strings.Contains(text, "Async agent launched") || workflowLaunchReceiptRe.MatchString(strings.TrimLeft(text, " \t\r\n")) {
		return true
	}
	var receipt struct {
		Status        string `json:"status"`
		RunID         string `json:"runId"`
		WorkflowRunID string `json:"workflowRunId"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(text)), &receipt) != nil {
		return false
	}
	return receipt.Status == "running" && (receipt.RunID != "" || receipt.WorkflowRunID != "")
}

// executingFold folds one session run's events into whether its engine is in a turn and which subagents run, the way
// the control plane folds a batch (runner-api.controller events: subStarted, subRunning, bgEnded, subEnded, bgReset;
// engine-turn.ts engineTurnActiveAfter).
type executingFold struct {
	mu         sync.Mutex
	generating bool
	// subagents are the launch ids of the subagents running, in launch order; inEngine marks those that run inside
	// the engine's process.
	subagents []string
	inEngine  map[string]bool
}

func newExecutingFold() *executingFold {
	return &executingFold{inEngine: map[string]bool{}}
}

func (f *executingFold) add(id string, inEngine bool) {
	for _, have := range f.subagents {
		if have == id {
			return
		}
	}
	f.subagents = append(f.subagents, id)
	if inEngine {
		f.inEngine[id] = true
	}
}

func (f *executingFold) remove(id string) {
	f.subagents = removeString(f.subagents, id)
	delete(f.inEngine, id)
}

// observe folds one event the session emits.
func (f *executingFold) observe(eventType string, payload map[string]interface{}) {
	generating, ended := engineTurnSignal(eventType, payload)
	f.mu.Lock()
	defer f.mu.Unlock()
	if generating {
		f.generating = true
	} else if ended {
		f.generating = false
	}
	parent, _ := payload["parentToolUseId"].(string)
	switch eventType {
	case evSystem:
		// A respawn handshake: a fresh engine, whatever ran in the previous one is gone. The SubAgents this runner runs
		// are announced again behind it (announceSubagents) and come back in below.
		if subtype, _ := payload["subtype"].(string); subtype == "resumed" {
			f.subagents = nil
			f.inEngine = map[string]bool{}
		}
	case evToolUse:
		name, _ := payload["name"].(string)
		id, _ := payload["id"].(string)
		if id != "" && parent == "" && runtimeSubagentTools[name] {
			f.add(id, inEngineSubagentTools[name])
		}
	case evToolResult:
		id, _ := payload["toolUseId"].(string)
		if id != "" && parent == "" && !subagentLaunchReceipt(payload["content"]) {
			f.remove(id)
		}
	case evBackgroundTask:
		id, _ := payload["toolUseId"].(string)
		if id == "" {
			return
		}
		status, _ := payload["status"].(string)
		switch status {
		case "completed", "failed", "killed", "stopped":
			f.remove(id)
		case "running":
			run, _ := payload["subagentRunId"].(string)
			workflow, _ := payload["workflowRunId"].(string)
			if run != "" || workflow != "" {
				f.add(id, false)
			}
		}
	}
}

// read answers the fold as of now. With no engine resident there is no turn, and the subagents that lived in the
// engine's process are gone: they are forgotten, so a later engine does not inherit them.
func (f *executingFold) read(resident bool) (bool, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !resident {
		f.generating = false
		for id := range f.inEngine {
			f.subagents = removeString(f.subagents, id)
		}
		f.inEngine = map[string]bool{}
	}
	return f.generating, append([]string{}, f.subagents...)
}

// executingSets is what this tailer runs: the runner-hosted jobs still running but services (Session.runningBgJobs), and
// every background process still running, those jobs of every kind included (Session.runningBgShells).
func (b *bgTailer) executingSets() (jobs, shells []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	seen := map[string]bool{}
	for id := range b.live {
		seen[id] = true
	}
	for id := range b.monitors {
		seen[id] = true
	}
	for id, job := range b.jobs {
		if job.status != bgStatusRunning {
			continue
		}
		seen[id] = true
		if job.kind != bgKindService {
			jobs = append(jobs, id)
		}
	}
	for id := range seen {
		shells = append(shells, id)
	}
	return jobs, shells
}

// setExecutingProbe installs one session run's answer to "what is executing" and returns its deregistration, under the
// epoch rule of setMonitorProbe. The probe is called outside p.mu (executingEntries): it takes the tailer's lock, which
// is taken before p.mu elsewhere.
func (p *sessionPool) setExecutingProbe(s *liveSession, probe func(resident bool) executingSnapshot) func() {
	p.mu.Lock()
	if p.sessions[s.id] == s {
		s.executingProbe = probe
	}
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		if p.sessions[s.id] == s {
			s.executingProbe = nil
		}
		p.mu.Unlock()
	}
}

// executingEntries is HeartbeatRequest.Executing: an entry for each supervised session whose run installed its probe,
// sorted by session id, at most executingSessionsMax.
func (p *sessionPool) executingEntries() []SessionExecuting {
	type probed struct {
		id       string
		resident bool
		probe    func(bool) executingSnapshot
	}
	p.mu.Lock()
	probes := make([]probed, 0, len(p.sessions))
	for id, s := range p.sessions {
		if s.executingProbe != nil {
			probes = append(probes, probed{id: id, resident: s.resident, probe: s.executingProbe})
		}
	}
	p.mu.Unlock()
	sort.Slice(probes, func(i, j int) bool { return probes[i].id < probes[j].id })
	if len(probes) > executingSessionsMax {
		probes = probes[:executingSessionsMax]
	}
	var entries []SessionExecuting
	for _, it := range probes {
		snap := it.probe(it.resident)
		entries = append(entries, SessionExecuting{
			SessionID:        it.id,
			EngineTurnActive: snap.engineTurnActive,
			Subagents:        statedSet(snap.subagents),
			Jobs:             statedSet(snap.jobs),
			Shells:           statedSet(snap.shells),
		})
	}
	return entries
}

// executingProbeFor is a session run's probe: its fold and its tailer.
func executingProbeFor(fold *executingFold, bg *bgTailer) func(resident bool) executingSnapshot {
	return func(resident bool) executingSnapshot {
		turn, subagents := fold.read(resident)
		jobs, shells := bg.executingSets()
		return executingSnapshot{engineTurnActive: turn, subagents: subagents, jobs: jobs, shells: shells}
	}
}
