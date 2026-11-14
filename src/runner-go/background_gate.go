package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// The gate on every background job a session starts. A job runs under the runner's account, outside any
// sandbox an engine has, so whether it may start is the session's permission mode to say, and this is the
// one place that says it: bgJobService.handle's `run`, which every engine's bg_run and a shell that reaches
// the socket by itself all come through.
//
//	Plan, Don't Ask      refused, with what to do instead
//	Default, Accept Edits a card, showing what would run
//	Auto, Bypass         started
//	DeepSeek Harness Auto started if it is routine (dshAutoRoutineEscalation), otherwise a card
//
// A card can take longer than this door or an engine's tool call can stay open (bgSocketTimeout, and the
// call deadlines of envMCPCallTimeout), so a job in front of a person does not hold the call. It is
// registered as a job that has not started, under the id it will keep (bgJob.awaitingOwner), and its card
// names that id, which keeps the card alive past the end of the turn (apiserver
// sessions/abandoned-approvals.ts). An answer that comes within bgGateInlineWait goes back in the call, as
// a Bash card's does; after that the call says the job is waiting, and the answer wakes the session.

const (
	// bgStatusWaitingForOwner is a job as bg_run, bg_output and bg_list show it before its card is answered.
	// The control plane is told `running` (runningPayload): its set of running jobs is what keeps a card
	// that names one alive.
	bgStatusWaitingForOwner = "waiting_for_owner"

	// bgNotAllowedReason marks the end of a job that never started because its card was not answered yes.
	bgNotAllowedReason = "not_allowed"

	// bgGateCardToolName is what the card is filed as. It asks about a shell command, and every client and
	// the control plane read a card by this name the same way a native shell's is read: what it shows, the
	// "always allow" it offers (one rule per command prefix, never a tool-wide yes) and the rules that
	// answer it.
	bgGateCardToolName = "Bash"

	bgGatePlanRefusal = "Not started. This session is in Plan mode, which runs nothing until the plan is approved," +
		" and a background job would run outside it. Do not retry this, and do not use Bash with run_in_background:" +
		" put the command in your plan, and run it once the owner has approved the plan or switched this session" +
		" out of Plan mode."

	bgGateDontAskRefusal = "Not started. This session is in Don't Ask mode, which refuses anything not already" +
		" approved and asks nobody, and a background job would run outside it. Do not retry this, and do not use" +
		" Bash with run_in_background: tell the owner what you need to run and why. They can run it themselves, or" +
		" switch this session to a mode that can ask them."

	bgGateWaitingNote = "Not started yet: this session's permission mode asks before a background job runs, so the" +
		" owner has a card showing this command. Do not call bg_run again for it, and do not run it with Bash" +
		" instead: end your turn or go on with other work. Orbit wakes this session when the owner answers. If they" +
		" allow it, it starts as this same job; if they refuse, it never runs. bg_output reads where it stands, and" +
		" bg_kill withdraws it."

	// What the job's own output says about the wait, which a wake quotes: the note is for the call that returns it.
	bgGateWaitingLine = "[orbit] Waiting for the owner's approval. This command has not started."
	bgGateAllowedLine = "[orbit] The owner allowed this job. It is starting now."
)

// bgGateInlineWait is how long a call stays open for the owner's answer before it says the job is waiting:
// inside this door's bgSocketTimeout and half of the shortest engine deadline (longestInlineWait), and long
// enough that someone at the screen answers in the call. A variable so a test need not sit it out.
var bgGateInlineWait = 20 * time.Second

// bgGateVerdict is what the gate says about one job: start it, ask the owner, or the refusal.
type bgGateVerdict struct {
	ask     bool
	refusal string
}

// admit reads the session's mode at this call, not as it was when the session started: a person may switch
// it at any time. A mode it does not know asks. The one thing it never does is start a job on a mode it
// could not read.
func (s *bgJobService) admit(spec bgJobSpec) bgGateVerdict {
	if s.mode == nil {
		return bgGateVerdict{refusal: "Not started. Orbit could not read this session's permission mode."}
	}
	switch mode := s.mode(); mode {
	case "plan":
		return bgGateVerdict{refusal: bgGatePlanRefusal}
	case "dontAsk":
		return bgGateVerdict{refusal: bgGateDontAskRefusal}
	case "bypassPermissions":
		return bgGateVerdict{}
	case "auto", "":
		// An unset mode is the server's floor, Auto (apiserver common/permission-mode.ts). DeepSeek Harness
		// keeps a file sandbox in Auto, and a job outside it is an escalation, judged by Auto's own rule.
		return bgGateVerdict{ask: s.engine == providerDsh && !s.routineOnDsh(spec)}
	}
	return bgGateVerdict{ask: true}
}

// routineOnDsh applies Auto's rule for one sandbox escalation to a job. The rule reads a command line, so a
// request that also sets variables is not routine: LD_PRELOAD or BASH_ENV change what that line does.
func (s *bgJobService) routineOnDsh(spec bgJobSpec) bool {
	if s.requestSetsEnv(spec) {
		return false
	}
	return dshAutoRoutineEscalation(dshPermissionAsk{Name: "bash", Input: map[string]interface{}{
		"command": spec.Command, "workdir": spec.Dir, "sandbox_permissions": "require_escalated",
	}}, s.execDir)
}

// requestSetsEnv reports whether a job's environment holds anything beyond the agent's own.
func (s *bgJobService) requestSetsEnv(spec bgJobSpec) bool {
	for key, value := range spec.Env {
		if own, ok := s.env[key]; !ok || own != value {
			return true
		}
	}
	return false
}

// cardInput is what the owner reads on the card: everything that decides what the job does, and that it runs
// outside the engine's sandbox, which nothing else about a shell command says.
func (s *bgJobService) cardInput(spec bgJobSpec) map[string]interface{} {
	input := map[string]interface{}{
		"command": spec.Command,
		"cwd":     spec.Dir,
		"kind":    spec.Kind,
		"runsOn":  "the Orbit runner, as a background job, outside this engine's sandbox",
	}
	if spec.Description != "" {
		input["description"] = spec.Description
	}
	if s.requestSetsEnv(spec) {
		env := map[string]string{}
		for key, value := range spec.Env {
			if own, ok := s.env[key]; !ok || own != value {
				env[key] = value
			}
		}
		input["env"] = env
	}
	return input
}

// askOwner files the card for a job and waits for its answer: "" for a yes, and otherwise what to tell the
// agent. The card is the job's, under the job's own id, so a retried filing finds the same card, and it asks
// nobody twice. Nothing but ALLOWED lets the job start.
func (s *bgJobService) askOwner(ctx context.Context, jobID string, input map[string]interface{}) string {
	if s.t == nil {
		return "Not started. Orbit could not ask the owner: this runner has no control plane to file a card on."
	}
	approvalID, err := s.t.createApproval(ctx, s.sessionID, map[string]interface{}{
		"toolName": bgGateCardToolName, "input": input, "toolUseId": jobID, "backgroundJobId": jobID,
	})
	if err == nil {
		var decision *ApprovalDecisionResponse
		if decision, err = awaitApprovalDecision(ctx, s.t, s.sessionID, approvalID); err == nil {
			return bgGateRefusalFrom(decision)
		}
	}
	if ctx.Err() != nil {
		return "Not started. It was withdrawn before the owner answered."
	}
	return fmt.Sprintf("Not started. Orbit could not get the owner's answer (%v). Try bg_run again in a moment;"+
		" do not use Bash with run_in_background instead.", err)
}

// bgGateRefusalFrom says what became of a card that was answered: "" for a yes.
func bgGateRefusalFrom(decision *ApprovalDecisionResponse) string {
	message := strings.TrimSpace(decision.Message)
	switch decision.Status {
	case "ALLOWED":
		return ""
	case "DENIED":
		refusal := "Not started. The owner refused this job, so it did not run."
		if message != "" {
			refusal = "Not started. The owner refused this job, so it did not run: " + message + "."
		}
		return refusal + " Do not retry it with bg_run or Bash: ask the owner what they want instead."
	}
	// Nobody answered: the card was collected because nothing was left to read it (ABANDONED).
	refusal := "Not started. Nobody answered the card for this job before it was withdrawn."
	if message != "" {
		refusal = "Not started. Nobody answered the card for this job before it was withdrawn: " + message + "."
	}
	return refusal + " Run bg_run again if it is still needed."
}

// bgGatedJob is a job waiting for its card, as startGatedJob and its goroutine share it.
type bgGatedJob struct {
	*bgPreparedJob
	// ask files the card and waits for the answer: "" for a yes, and otherwise why it did not start.
	ask func(ctx context.Context, jobID string) string
	// answered closes when the card's answer has been acted on, whichever it was.
	answered chan struct{}
	// refusal is why the job did not start, read after answered closes.
	refusal string
}

// startGatedJob registers a job that has not started, asks the owner on a goroutine of its own, and waits for
// the answer for at most bgGateInlineWait.
func (s *bgJobService) startGatedJob(spec bgJobSpec) (bgJobStatus, error) {
	input := s.cardInput(spec)
	gated, err := s.bg.holdJobForOwner(spec, func(ctx context.Context, jobID string) string {
		return s.askOwner(ctx, jobID, input)
	})
	if err != nil {
		return bgJobStatus{}, err
	}
	select {
	case <-gated.answered:
	case <-time.After(bgGateInlineWait):
	}
	return s.bg.gatedJobAnswer(gated)
}

// holdJobForOwner is startJob for a job that waits for its card first. Its goroutine holds the place prepareJob
// reserved for the job's waiter, and hands it on when the process starts.
func (b *bgTailer) holdJobForOwner(spec bgJobSpec, ask func(ctx context.Context, jobID string) string) (*bgGatedJob, error) {
	prepared, err := b.prepareJob(spec)
	if err != nil {
		return nil, err
	}
	job := prepared.job
	gated := &bgGatedJob{bgPreparedJob: prepared, ask: ask, answered: make(chan struct{})}
	now := time.Now()
	b.mu.Lock()
	if b.stopping || b.runnerStoppingLocked() {
		b.mu.Unlock()
		prepared.cancel()
		prepared.output.Close()
		b.wg.Done()
		return nil, errRunnerShuttingDown
	}
	job.awaitingOwner = true
	job.startedAt, job.lastOutputAt = now, now
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	b.jobs[job.id] = job
	// The checkout is held from here, or a parked session could lose it before the owner answers. Through
	// the door that costs no capacity: a job a person has not allowed takes no slot of this machine's.
	if b.holds != nil {
		b.holds.holdRunnerWatch(job.id, job.id)
	}
	b.mu.Unlock()
	// Before the card is filed, so that the control plane has this job among those running when the card
	// names it (running_bg_shells, which decides whether the card is offered).
	b.emit(evBackgroundTask, job.runningPayload(now))
	go b.awaitOwnerThenStart(gated)
	return gated, nil
}

// awaitOwnerThenStart asks, and acts on the answer. A job leaves awaitingOwner in one step with reading whether
// a call has told the agent it is waiting, under b.mu against gatedJobAnswer, so that a call giving up on the
// wait and an answer arriving at the same moment cannot each leave the telling to the other.
func (b *bgTailer) awaitOwnerThenStart(g *bgGatedJob) {
	job := g.job
	refusal := g.ask(g.ctx, job.id)

	b.mu.Lock()
	job.awaitingOwner = false
	told := job.ownerWaitAnnounced
	killed := job.killReason != "" || g.ctx.Err() != nil
	stopping := b.stopping || b.runnerStoppingLocked()
	if refusal != "" || killed || stopping {
		b.mu.Unlock()
		switch {
		case killed && refusal == "":
			refusal = "Not started. It was withdrawn before it could start."
		case stopping && refusal == "":
			refusal = "Not started. The runner is stopping; run bg_run again once the session resumes."
		}
		b.endUnstartedJob(g, refusal, told)
		return
	}
	var wake bgWake
	if told {
		_, _ = fmt.Fprintln(g.output, bgGateAllowedLine)
		wake = job.wakeLocked(bgWakeOnOutput, outputSizeOf(job.outputPath))
	}
	b.releaseHold(job.id)
	b.mu.Unlock()
	if _, err := b.launchJob(g.bgPreparedJob); err != nil {
		b.endUnstartedJob(g, fmt.Sprintf("Not started. It was allowed, but could not start: %v.", err), told)
		return
	}
	close(g.answered)
	if told {
		b.sendWake(wake)
	}
}

// endUnstartedJob ends a job whose process never ran, as what it is: killed, with the reason nobody started it,
// and no exit code, which only a process has. A session that was told the job is waiting is told how the wait
// ended, even if the job asked for no wake, unless what ended it is the person or the session's own end
// (wakeFor). A call still open tells the agent itself, so no wake then.
func (b *bgTailer) endUnstartedJob(g *bgGatedJob, refusal string, told bool) {
	job := g.job
	b.mu.Lock()
	if job.killReason == "" {
		job.killReason = bgNotAllowedReason
		if b.stopping || b.runnerStoppingLocked() || b.ctx.Err() != nil {
			job.killReason, _ = b.drainReasonsLocked()
		}
	}
	job.wakeOnExit = told
	job.wakeOnOutput = false
	g.refusal = refusal
	b.releaseHold(job.id)
	b.mu.Unlock()
	_, _ = fmt.Fprintln(g.output, "[orbit] "+refusal)
	g.cancel()
	g.output.Close()
	close(g.answered)
	b.finishJob(job, 0)
	job.releaseWaiter(&b.wg)
}

// gatedJobAnswer is what the call says about a gated job when it stops waiting: how it went, if that is
// settled, and otherwise that it is waiting, after which the answer has to wake the session.
func (b *bgTailer) gatedJobAnswer(g *bgGatedJob) (bgJobStatus, error) {
	job := g.job
	b.mu.Lock()
	if job.awaitingOwner {
		job.ownerWaitAnnounced = true
		_, _ = fmt.Fprintln(g.output, bgGateWaitingLine)
		status := job.statusLocked()
		b.mu.Unlock()
		return status, nil
	}
	b.mu.Unlock()
	// Past waiting: its goroutine has settled which way, or is about to. Bounded by that goroutine doing only
	// local work from here (starting the process, or ending the job).
	select {
	case <-g.answered:
	case <-time.After(bgSocketTimeout / 2):
		return bgJobStatus{}, errors.New("the job's start did not settle; bg_list says where it stands")
	}
	if g.refusal != "" {
		return bgJobStatus{}, errors.New(g.refusal)
	}
	status, _ := b.jobStatus(job.id)
	return status, nil
}

// The live permission mode of a session, for the goroutines that serve its socket. job.Agent.PermissionMode is
// the supervisor's own, written on its goroutine and re-read there; this holder is what crosses over.
type sessionLiveMode struct {
	mu   sync.RWMutex
	mode string
}

// notePermissionMode publishes the mode this session is now in: where the supervisor wrote a new mode to
// job.Agent, and where the engine itself reports it (claudeNoteEngineMode).
func (j *ClaimedSession) notePermissionMode(mode string) {
	if j.liveMode == nil {
		return
	}
	j.liveMode.mu.Lock()
	j.liveMode.mode = mode
	j.liveMode.mu.Unlock()
}

// permissionModeForPlanGate is this session's mode as Orbit's Plan gate reads it (plan_gate.go): a service wired
// with no mode cannot say, which the gate treats as a mode it could not read.
func (s *bgJobService) permissionModeForPlanGate() (string, bool, error) {
	if s.mode == nil {
		return "", true, errors.New("this session's permission mode is not known to the runner")
	}
	return s.mode(), true, nil
}

// current reads what notePermissionMode last published.
func (m *sessionLiveMode) current() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.mode
}

// claudeNoteEngineMode takes a session's mode from what the CLI says it is in. Claude Code changes it by
// itself as well: an approved plan leaves Plan, and a model can enter it. Nothing else reports either,
// and job.Agent keeps the mode the next process is to be started with, so this goes to the holder alone.
func claudeNoteEngineMode(job *ClaimedSession, msg map[string]interface{}) {
	if msg["type"] != "system" || (msg["subtype"] != "init" && msg["subtype"] != "status") || msg["parent_tool_use_id"] != nil {
		return
	}
	if mode, _ := msg["permissionMode"].(string); mode != "" {
		job.notePermissionMode(mode)
	}
}

// startOwnerWait is the one way a hosted job starts without passing the gate, and what it can do is fixed here
// rather than asked for: it is `orbit mcp` serving a single call that puts a card in front of the owner and
// blocks until it is answered (handOffOwnerWait), under this session's own identity. The caller names the call
// and nothing that runs, so a client that reaches this door can only cause a card, which it could raise anyway
// through the tool itself. Not a run: Don't Ask refuses a job, not a question put to a person. Plan refuses the
// write the question is about, though (plan_gate.go), and says so here as the tool does: the job's `orbit mcp`
// has no socket to read the mode from, so this is the last place it can be read before the card is filed.
func (s *bgJobService) startOwnerWait(args map[string]interface{}) bgSocketResponse {
	name := getString(args, "tool")
	arguments, _ := args["arguments"].(map[string]interface{})
	if !waitsForTheOwner(name, arguments) {
		return bgSocketResponse{Error: fmt.Sprintf("%s is not a call that waits for the owner", name)}
	}
	if refusal := mcpPlanRefusal(name, arguments, s.permissionModeForPlanGate); refusal != "" {
		return bgSocketResponse{Error: refusal}
	}
	exe := orbitCLIExecutable()
	if exe == "" {
		return bgSocketResponse{Error: "the orbit executable could not be resolved"}
	}
	params, err := json.Marshal(map[string]interface{}{"name": name, "arguments": arguments})
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	request, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "tools/call", Params: params})
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	if err := os.MkdirAll(s.scratchDir, 0o755); err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	file, err := os.CreateTemp(s.scratchDir, "orbit-mcp-handoff-*.json")
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	_, err = file.Write(append(request, '\n'))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(file.Name())
		return bgSocketResponse{Error: err.Error()}
	}
	// The job's environment is the runner's, which carries this session and the job's own id but not the
	// rest of who is asking: the agent the write is attributed to, the current task, the orchestration
	// switch. The timeout is cleared so the job waits as long as the owner takes, and only this tool is
	// served. The request file is unlinked once open, so nothing is left behind however the job ends.
	command := fmt.Sprintf("{ rm -f %s && ORBIT_AGENT_ID=%s ORBIT_TASK_ID=%s %s=%s %s=%s %s= %s mcp; } < %s",
		shellQuote(file.Name()), shellQuote(s.agentID), shellQuote(s.taskID),
		envMCPOrchestration, orchestrationEnv(s.allowOrchestration), envMCPTools, shellQuote(name), envMCPCallTimeout,
		shellQuote(exe), shellQuote(file.Name()))
	status, err := s.bg.startJob(bgJobSpec{
		Command:     command,
		Kind:        bgKindWatch,
		Dir:         s.execDir,
		ScratchDir:  s.scratchDir,
		Description: "Orbit " + name + ": waiting for the owner's confirmation",
		Env:         mergedBgEnv(s.env, nil),
		SessionID:   s.sessionID,
		WakeOnExit:  true,
	})
	if err != nil {
		_ = os.Remove(file.Name())
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: status}
}
