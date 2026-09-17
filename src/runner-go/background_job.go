package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Runner-hosted background jobs. The agent asks (over the per-session socket in
// background_socket.go), the runner spawns, and the runner waits — so a job's life
// ends when it exits, when the session ends, or when somebody kills it. Recycling
// the engine is not on that list, which is the whole point: an engine is a latency
// cache, and evicting a cache must not destroy work.
//
// The shape is startUserShell's, generalized: own process group, bound to the
// tailer's session context rather than the engine's, registered with engineOwned
// false so killEngineShells passes it by, exit code read from the runner's own
// Wait rather than parsed out of a <task-notification> the engine writes.
//
// Two things a user `!`-shell never needed and a job does: a kind, and an
// identity the agent can name later.

const (
	// bgKindService and bgKindJob are the two things an agent runs in the
	// background, and they are told apart by the caller, never inferred. A
	// service (vite, a watcher) is valuable while it runs and costs nothing to
	// restart; a job (build, test suite) is valuable when it finishes and costs
	// hours to restart. Nothing in a command line separates them — `npm run dev`
	// and `npm run build` differ by one word — and guessing wrong in the
	// dangerous direction kills the six-hour build this project exists to save.
	bgKindService = "service"
	bgKindJob     = "job"
	// bgKindWatch is a job whose value is what it waits for — CI, a deploy, a review — rather than
	// anything it computes or writes. It is drained and held exactly as a job is (a drain waits for
	// it, the worktree GC passes its checkout by), but it takes no admission slot: a session parked
	// on a forty-minute CI run costs this machine nothing, and counting it would keep new work off
	// a runner that is idle.
	bgKindWatch = "watch"

	bgStatusRunning   = "running"
	bgStatusCompleted = "completed"
	bgStatusFailed    = "failed"
	bgStatusKilled    = "killed"

	// bgDrainWaitCap is how long a drain waits for jobs (not services) to finish
	// before killing them. A drain runs where the checkout is about to be
	// rewritten or removed, so waiting cannot be unbounded — but a job seconds
	// from done should report its own exit code rather than be killed on the
	// doorstep.
	bgDrainWaitCap = 30 * time.Second

	// bgKillTeardownGrace bounds how long an explicit kill or an over-budget
	// drain waits for the process to actually go, so a wedged child cannot wedge
	// session teardown behind it.
	bgKillTeardownGrace = 5 * time.Second

	// bgDrainCapReason marks the one kill a user did not ask for. It rides on the
	// background_task event so "your build was killed" can say why, instead of
	// looking like the silent recycling this project is removing.
	bgDrainCapReason = "drain_cap"

	// bgRunnerShutdownReason marks a kill made because the runner process itself is going
	// away — re-executing into a self-update, or its service being stopped. That is not the
	// session ending, so it must not read as the session's `drain` or `drain_cap`: a count of
	// kills that sets session ends aside has to go on seeing these. Nor is it the turn's
	// evInterrupt reason "runner_restart", which marks a turn cut short, not a process killed.
	bgRunnerShutdownReason = "runner_shutdown"

	// bgSessionCancelledReason marks a kill the session's cancellation made: the control plane
	// cancelled the session, or its supervisor lost the session to a newer owner, and the jobs went
	// at once with the context they run under. Not `drain` or `drain_cap`: those are a session end
	// handled the way the two kinds are for, and a cancel handles neither kind that way. Not
	// runner_shutdown either, which is the runner going away under a session that was not ending.
	bgSessionCancelledReason = "session_cancelled"

	// bgJobOutputCap bounds one bg_output read.
	bgJobOutputCap = 256 * 1024

	// A job can ask to wake its session — when it exits, or when it writes something new. These are
	// the two triggers a wake names.
	bgWakeOnExit   = "exit"
	bgWakeOnOutput = "output"

	// bgWakeOutputWindow is how long new output gathers before it wakes the session. A CI log lands a
	// hundred lines at a time, and the wake should carry the burst rather than its first line.
	bgWakeOutputWindow = 10 * time.Second

	// bgWakeOutputInterval is the least time between two output wakes of one job: output that lands
	// inside it goes out as one wake once it has passed. Every wake is a turn somebody pays for.
	bgWakeOutputInterval = time.Minute

	// bgWakeExcerptCap bounds how much of the end of the output a wake quotes. The rest is one
	// bg_output away, and the wake names the file.
	bgWakeExcerptCap = 2000

	// bgWakeAttempts bounds how often one wake is tried against a control plane that does not
	// answer, bgWakeRetryDelay apart and growing: long enough for a blip, short enough that a session
	// ending behind it is not held up.
	bgWakeAttempts   = 3
	bgWakeRetryDelay = 2 * time.Second
)

// errRunnerShuttingDown refuses a job once the runner has begun to stop. The runner is the job's
// only host, so it would be killed within bgDrainWaitCap of starting, and nobody would start it
// again.
var errRunnerShuttingDown = errors.New("the runner is shutting down (restarting or updating); start the job again once the session resumes")

// bgJobSpec is one request to run something in the background. Dir and ScratchDir
// come from the runner, never from the agent's request as-is (see bgJobService).
type bgJobSpec struct {
	Command     string
	Kind        string
	Dir         string // where the command runs
	ScratchDir  string // where its output file lives — runner-owned, outside the checkout
	Description string
	Env         map[string]string
	// The session this job belongs to, as the RUNNER knows it — never as the caller claims it.
	// Set from `job.SessionID` where the service is wired, and spent below on `ORBIT_SESSION_ID`.
	SessionID string
	// WakeOnExit and WakeOnOutput ask the control plane to wake the session when the job exits, or
	// when it has written something new (bgWakeOutputWindow, bgWakeOutputInterval).
	WakeOnExit   bool
	WakeOnOutput bool
}

// bgJobStatus is one job as the agent sees it. Field names are the wire names of
// the bg_* tools.
type bgJobStatus struct {
	JobID string `json:"jobId"`
	// The same id under the name the event stream uses for it. A background_task
	// carries shellId, so a job and its events can be matched without a mapping
	// table that could disagree with itself.
	ShellID       string `json:"shellId"`
	Kind          string `json:"kind"`
	Command       string `json:"command"`
	Description   string `json:"description,omitempty"`
	Status        string `json:"status"`
	PID           int    `json:"pid"`
	ExitCode      *int   `json:"exitCode"`
	OutputPath    string `json:"outputPath"`
	StartedAt     string `json:"startedAt"`
	EndedAt       string `json:"endedAt,omitempty"`
	HoldsWorktree bool   `json:"holdsWorktree"`
	WakeOnExit    bool   `json:"wakeOnExit,omitempty"`
	WakeOnOutput  bool   `json:"wakeOnOutput,omitempty"`
}

// bgJobOutput is one incremental read of a job's output file.
type bgJobOutput struct {
	JobID      string `json:"jobId"`
	ShellID    string `json:"shellId"`
	Status     string `json:"status"`
	ExitCode   *int   `json:"exitCode"`
	Output     string `json:"output"`
	NextOffset int64  `json:"nextOffset"`
	Truncated  bool   `json:"truncated"`
	OutputPath string `json:"outputPath"`
}

// bgJob is the runner's own record of a process it started. Every field except
// the immutable ones is read and written under bgTailer.mu.
type bgJob struct {
	id          string
	kind        string
	command     string
	description string
	outputPath  string
	pid         int
	startedAt   time.Time
	cancel      context.CancelFunc // kills this job's process group, and only this one
	done        chan struct{}      // closed after the terminal event has been emitted

	wakeOnExit   bool
	wakeOnOutput bool

	status   string
	exitCode *int
	endedAt  time.Time
	// killReason records that this process is dying because we asked, so the
	// waiter reports "killed" rather than inventing a completion out of the exit
	// status a SIGKILL leaves behind.
	killReason string
	// wokenThrough is how many bytes of output the session has already been woken for: the next
	// wake reports from there. outputWakes numbers this job's output wakes, so each has an id of its
	// own that a retry of it is recognised by.
	wokenThrough int64
	outputWakes  int

	// recorded is whether the job has a record (background_job_record.go); one without is never
	// handed on. handedOff marks a job handed on to the runner's next image, which the tailer that
	// handed it on — formerHost — no longer kills, reaps or reports. reaping marks a job whose exited
	// process its waiter has begun to reap: it is ending here, and is not handed on. exited marks one
	// that exited after it was handed on, and adoptedExit is the exit code of one adopted from its
	// record that had exited already.
	recorded    bool
	handedOff   bool
	formerHost  *bgTailer
	reaping     bool
	exited      bool
	adoptedExit *int
	// kill ends the job's process group, and reap waits for its exited process and returns the exit
	// code: through the exec.Cmd that started it, or by pid for a job adopted from its record.
	kill func()
	reap func() int
	// waiterSlot gives the waiter's place in the tailer's WaitGroup back once (releaseWaiter).
	waiterSlot sync.Once
}

// statusLocked snapshots the job. Caller holds b.mu.
func (j *bgJob) statusLocked() bgJobStatus {
	st := bgJobStatus{
		JobID:         j.id,
		ShellID:       j.id,
		Kind:          j.kind,
		Command:       j.command,
		Description:   j.description,
		Status:        j.status,
		PID:           j.pid,
		ExitCode:      j.exitCode,
		OutputPath:    j.outputPath,
		StartedAt:     j.startedAt.UTC().Format(time.RFC3339),
		HoldsWorktree: j.status == bgStatusRunning,
		WakeOnExit:    j.wakeOnExit,
		WakeOnOutput:  j.wakeOnOutput,
	}
	if !j.endedAt.IsZero() {
		st.EndedAt = j.endedAt.UTC().Format(time.RFC3339)
	}
	return st
}

// newBgJobID mints the id the agent will use to name this job. The runner makes
// it, which is what keeps ownership constructed rather than inferred: an id the
// runner did not issue names nothing.
func newBgJobID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "bgj_" + hex.EncodeToString(b[:]), nil
}

// startJob spawns one runner-hosted background job and returns as soon as it is
// running.
func (b *bgTailer) startJob(spec bgJobSpec) (bgJobStatus, error) {
	if spec.Kind != bgKindService && spec.Kind != bgKindJob && spec.Kind != bgKindWatch {
		return bgJobStatus{}, fmt.Errorf("kind must be %q, %q or %q, got %q", bgKindService, bgKindJob, bgKindWatch, spec.Kind)
	}
	if strings.TrimSpace(spec.Command) == "" {
		return bgJobStatus{}, errors.New("command is required")
	}
	jobID, err := newBgJobID()
	if err != nil {
		return bgJobStatus{}, err
	}
	outputPath := filepath.Join(spec.ScratchDir, jobID+".output")

	// Reserve the waiter before any slow setup, exactly as startUserShell does:
	// stopAll closes this registration gate under the same mutex before it waits.
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return bgJobStatus{}, context.Canceled
	}
	if b.runnerStoppingLocked() {
		b.mu.Unlock()
		return bgJobStatus{}, errRunnerShuttingDown
	}
	b.wg.Add(1)
	b.mu.Unlock()
	waiterStarted := false
	defer func() {
		if !waiterStarted {
			b.wg.Done()
		}
	}()

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return bgJobStatus{}, err
	}
	f, err := os.Create(outputPath)
	if err != nil {
		return bgJobStatus{}, err
	}
	// A child of the tailer's context (the session), never the engine's — and its
	// own child at that, so one job can be killed without touching the others.
	jobCtx, cancel := context.WithCancel(b.ctx)
	cmd := exec.CommandContext(jobCtx, "bash", "-lc", spec.Command)
	configureSessionProcessTree(cmd)
	job := &bgJob{
		id:           jobID,
		kind:         spec.Kind,
		command:      spec.Command,
		description:  spec.Description,
		outputPath:   outputPath,
		cancel:       cancel,
		done:         make(chan struct{}),
		wakeOnExit:   spec.WakeOnExit,
		wakeOnOutput: spec.WakeOnOutput,
		status:       bgStatusRunning,
		kill:         func() { _ = terminateSessionProcessTree(cmd) },
		reap: func() int {
			waitErr := waitSessionProcessTree(cmd)
			f.Close()
			return exitCodeFromWait(cmd, waitErr)
		},
	}
	// A job handed on to the runner's next image is not this image's to kill, although the context it
	// was started under ends with this image's supervisor. Nor is there anything to wait out after a
	// cancel: the output goes to a file, not a pipe, and the delay would end in a kill of its own.
	cmd.Cancel = func() error {
		if !b.killable(job) {
			return os.ErrProcessDone
		}
		return terminateSessionProcessTree(cmd)
	}
	cmd.WaitDelay = 0
	cmd.Dir = spec.Dir
	// `envWithAgent` strips session context from BOTH the inherited environment and the caller's
	// env, and that stays true: an agent may not CLAIM a session it is not. The session is then put
	// back from what the runner itself knows, which is a different fact and the only one this job
	// can be about.
	//
	// It goes back because a job without it is not "headless" — it only looks that way to the gated
	// CLI writes, which read `ORBIT_SESSION_ID` to decide whether there is anybody to ask
	// (`askBeforeCreate`). Empty, `orbit task create` and `orbit project resolve-blocker` take the
	// terminal path and write without a card. The job never lost the AUTHORITY to write — it holds
	// the runner token through ORBIT_HOME either way — so stripping the id removed only the ability
	// to ASK, turning "put this in front of the owner" into "do it". 2026-09-17: that is how a
	// blocker a person was asked to rule on was resolved by an agent with no card ever shown.
	cmd.Env = envWithAgent(spec.Env)
	if spec.SessionID != "" {
		// Base62, like every other injection site (`public_id_env_test.go` scans for exactly this):
		// an id a job reads is an id it will hand back to the API and print to a person, and the
		// raw UUID is not the spelling anything else here speaks.
		cmd.Env = append(cmd.Env, "ORBIT_SESSION_ID="+publicID(spec.SessionID))
	}
	cmd.Stdout = f
	cmd.Stderr = f
	if err := cmd.Start(); err != nil {
		cancel()
		f.Close()
		return bgJobStatus{}, err
	}
	job.pid = cmd.Process.Pid
	job.startedAt = time.Now()
	job.recorded = b.recordJob(job)

	b.mu.Lock()
	if b.stopping || b.runnerStoppingLocked() {
		// stopAll ran, or the runner began to stop, while we were starting: this
		// process belongs to an epoch that is already being torn down, so it does not
		// get to join the registry.
		b.mu.Unlock()
		cancel()
		f.Close()
		if job.recorded {
			removeBgJobRecord(b.sessionID, jobID)
		}
		return bgJobStatus{}, context.Canceled
	}
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	b.jobs[jobID] = job
	status := job.statusLocked()
	b.mu.Unlock()

	// The launch pair the UI already understands: the "Background processes" tray
	// keys off a Bash tool_use with run_in_background, and clears on the terminal
	// background_task below. The runner emits it here because no engine tool call
	// produced this process — that is precisely what makes it survivable.
	b.emit(evToolUse, map[string]interface{}{
		"id": jobID, "name": "Bash",
		"input": map[string]interface{}{"command": spec.Command, "run_in_background": true},
	})
	b.emit(evToolResult, map[string]interface{}{
		"toolUseId": jobID,
		"content": fmt.Sprintf(
			"Command running in background with ID: %s. Output is being written to: %s. Read it with mcp__orbit__bg_output.",
			jobID, outputPath),
	})
	// The durable half of the launch, and the only place the command and the output file are
	// recorded as fields rather than as prose inside a tool_result. A replacement engine cannot
	// remember a job it never saw, so what the control plane hands it on resume is folded from
	// this event and the terminal one below — see apiserver background-jobs-context.ts. `kind`
	// rides along as the discriminator: an engine-owned shell has none, and it died with its
	// engine, so it must never be offered as work to pick back up.
	b.emit(evBackgroundTask, job.runningPayload())
	// Tails the output for live UI, registers the worktree hold, and — with
	// engineOwned false — puts this job outside killEngineShells' reach.
	b.startTail(jobID, jobID, outputPath, false)
	if spec.WakeOnOutput {
		b.startOutputWakes(job)
	}

	waiterStarted = true
	go func() {
		defer job.releaseWaiter(&b.wg)
		// Waits without reaping, so that a job handed on meanwhile stays unreaped for its next host.
		awaitChildExit(job.pid)
		if b.claimReap(job) {
			b.finishJob(job, job.reap())
		}
	}()
	return status, nil
}

// exitCodeFromWait reads the code the kernel reported for our own child. The
// ProcessState is the authority: waitSessionProcessTree also reaps stragglers and
// can return an error of its own for a process that exited perfectly well.
func exitCodeFromWait(cmd *exec.Cmd, waitErr error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode()
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// runningPayload is the `running` background_task a job is reported with while it runs: at its
// launch, when the runner image that adopted it after a self-update takes it on, and again behind
// every `resumed` handshake (announceRunningJobs). One shape for all three, since the control plane
// reads the job off it (runner-api.controller bgRunning, background-jobs-context.ts).
func (j *bgJob) runningPayload() map[string]interface{} {
	return map[string]interface{}{
		"shellId":    j.id,
		"toolUseId":  j.id,
		"status":     bgStatusRunning,
		"kind":       j.kind,
		"command":    j.command,
		"outputPath": j.outputPath,
	}
}

// announceRunningJobs reports every job this tailer hosts that is still running, as its launch did.
// emitThrough calls it behind each `resumed` handshake the session sends: on that handshake the
// control plane empties the session's running background set (runner-api.controller bgReset), since
// the replaced engine's own shells died with it — and these jobs did not (killEngineShells passes
// them by).
//
// Emitted under b.mu, where a job's end is recorded before it is reported (finishJob), so a job that
// ends meanwhile is announced before its end is reported or not at all. A `running` report that came
// after the end would put a job that has finished back in the set.
func (b *bgTailer) announceRunningJobs() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, job := range b.jobs {
		if job.status == bgStatusRunning {
			b.emit(evBackgroundTask, job.runningPayload())
		}
	}
}

// finishJob retires a job whose process has gone: it ends the tail, releases the
// checkout, records the outcome, and emits the one terminal event.
func (b *bgTailer) finishJob(job *bgJob, exit int) {
	b.stop(job.id) // ends the tail, drops it from b.live, releases the worktree hold

	b.mu.Lock()
	reason := job.killReason
	if reason == "" && b.ctx.Err() != nil {
		// Every kill this tailer makes is named before it cancels (killJob, drainJobs, stopAll), so
		// a job that ends unnamed once the context is cancelled went with that cancellation: the
		// session's, which reaches the process without the tailer.
		reason, _ = b.drainReasonsLocked()
		job.killReason = reason
	}
	status := job.endLocked(exit)
	b.mu.Unlock()

	// The session is going away and events emitted now would be persisted but no
	// longer broadcast — except for a kill we performed, which is the one thing a
	// user must not have to guess about.
	if b.ctx.Err() == nil || reason != "" {
		if b.markTerminal(job.id) {
			b.emit(evBackgroundTask, job.endPayload(status, exit, reason))
			b.alertIfNobodyIsWatching(job, status, exit)
			b.wakeOnEnd(job, reason)
		}
	}
	if job.recorded {
		removeBgJobRecord(b.sessionID, job.id)
	}
	close(job.done)
}

// endLocked records how a job ended — killed when a reason was named for killing it, otherwise as its
// exit code says — and returns that status. Caller holds b.mu.
func (j *bgJob) endLocked(exit int) string {
	status := bgStatusCompleted
	switch {
	case j.killReason != "":
		status = bgStatusKilled
	case exit != 0:
		status = bgStatusFailed
	}
	j.status = status
	j.endedAt = time.Now()
	if status != bgStatusKilled {
		code := exit
		j.exitCode = &code
	}
	return status
}

// endPayload is the one terminal background_task that reports how a job ended.
func (j *bgJob) endPayload(status string, exit int, reason string) map[string]interface{} {
	summary := fmt.Sprintf("Background %s completed (exit code %d)", j.kind, exit)
	if status == bgStatusKilled {
		summary = fmt.Sprintf("Background %s was killed", j.kind)
	}
	payload := map[string]interface{}{
		"shellId":    j.id,
		"toolUseId":  j.id,
		"status":     status,
		"kind":       j.kind,
		"command":    j.command,
		"summary":    summary,
		"output":     readCapped(j.outputPath),
		"outputPath": j.outputPath,
	}
	if status != bgStatusKilled {
		payload["exitCode"] = exit
	}
	if reason != "" {
		payload["reason"] = reason
	}
	return payload
}

// alertIfNobodyIsWatching is the whole point of stage 2b: a job that finishes while
// the session is cold has nobody to tell. The event above is durable, but a durable
// event is something you find when you come back — and "come back and find out" is
// the behaviour this project is removing.
//
// Cold only. A resident engine is going to be handed the transcript of this event on
// its next turn, and paying a lock-screen alert for something already on screen is
// how a channel gets muted. A kill is not announced either: an explicit one was asked
// for by whoever is reading the answer, and a drain kill happens while the session is
// being torn down around it.
//
// Called with b.mu released — engineResident takes the pool's lock, and the pool
// takes this tailer's.
func (b *bgTailer) alertIfNobodyIsWatching(job *bgJob, status string, exit int) {
	if b.notify == nil || b.engineResident == nil || b.engineResident() {
		return
	}
	if status != bgStatusCompleted && status != bgStatusFailed {
		return
	}
	// Read on a lock screen: what ended, how it ended, and the id that reads the rest.
	message := fmt.Sprintf("后台%s %s 已结束（退出码 %d）：%s", job.kind, job.id, exit, job.command)
	if err := b.notify(message); err != nil {
		logln("could not alert the owner about background job", job.id+":", err)
	}
}

// bgWake is what a job tells the control plane when it wakes its session. Field names are the wire
// names of POST /runner/sessions/:id/background-wake; the control plane files the wake as a turn
// of the session and writes these facts into it (apiserver runner-api/background-job-wake.ts).
type bgWake struct {
	// WakeID names this wake, so a retry of it is recognised: `<jobId>:exit`, or
	// `<jobId>:output:<n>` for the job's n-th output wake.
	WakeID      string `json:"wakeId"`
	JobID       string `json:"jobId"`
	Trigger     string `json:"trigger"`
	Kind        string `json:"kind"`
	Command     string `json:"command"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"`
	ExitCode    *int   `json:"exitCode,omitempty"`
	Reason      string `json:"reason,omitempty"`
	OutputPath  string `json:"outputPath"`
	// OutputOffset is where the output this wake is about begins — where the last wake's ended — and
	// OutputSize how long the file was when it was sent: bg_output with sinceOffset reads the rest.
	OutputOffset  int64  `json:"outputOffset"`
	OutputSize    int64  `json:"outputSize"`
	OutputExcerpt string `json:"outputExcerpt"`
}

// wakeLocked is one wake about this job, and marks the output it reports as reported. Caller holds
// b.mu.
func (j *bgJob) wakeLocked(trigger string, size int64) bgWake {
	wake := bgWake{
		JobID:        j.id,
		Trigger:      trigger,
		Kind:         j.kind,
		Command:      j.command,
		Description:  j.description,
		Status:       j.status,
		ExitCode:     j.exitCode,
		Reason:       j.killReason,
		OutputPath:   j.outputPath,
		OutputOffset: j.wokenThrough,
		OutputSize:   size,
	}
	if trigger == bgWakeOnOutput {
		j.outputWakes++
		wake.WakeID = fmt.Sprintf("%s:%s:%d", j.id, bgWakeOnOutput, j.outputWakes)
	} else {
		wake.WakeID = j.id + ":" + bgWakeOnExit
	}
	if size > j.wokenThrough {
		j.wokenThrough = size
	}
	return wake
}

// wakeOnEnd sends the wake a job's end owes its session: the exit it asked to be woken for, or —
// for a job that asked only about its output — what it wrote after its last wake. Not for a kill
// somebody asked for, who is reading the answer already, and not for one the session's own end
// made: that session is waiting for nothing. A kill made by the runner's stop or by the session's
// cancellation does wake it, since the session may go on without the job; whether it has ended is
// the control plane's to say.
func (b *bgTailer) wakeOnEnd(job *bgJob, reason string) {
	if wake, ok := b.wakeFor(job, reason); ok {
		b.sendWake(wake)
	}
}

// wakeFor is the wake wakeOnEnd sends, when the job's end owes its session one.
func (b *bgTailer) wakeFor(job *bgJob, reason string) (bgWake, bool) {
	switch reason {
	case "requested", "drain", bgDrainCapReason:
		return bgWake{}, false
	}
	size := outputSizeOf(job.outputPath)
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case job.wakeOnExit:
		return job.wakeLocked(bgWakeOnExit, size), true
	case job.wakeOnOutput && size > job.wokenThrough:
		return job.wakeLocked(bgWakeOnOutput, size), true
	}
	return bgWake{}, false
}

// startOutputWakes watches a job that asked to be woken for new output, for as long as it runs.
func (b *bgTailer) startOutputWakes(job *bgJob) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopping {
		return
	}
	b.wg.Add(1)
	go b.watchOutputForWakes(job)
}

// watchOutputForWakes wakes the session when the job writes something new. New output gathers for
// bgWakeOutputWindow before it wakes anybody, and the job wakes the session at most once per
// bgWakeOutputInterval, so a log that arrives a hundred lines at a time is one wake rather than a
// hundred. What was written after the last wake goes with the job's end (wakeOnEnd).
func (b *bgTailer) watchOutputForWakes(job *bgJob) {
	defer b.wg.Done()
	tick := time.NewTicker(bgPollInterval)
	defer tick.Stop()
	var gathering, lastWake time.Time
	for {
		var now time.Time
		select {
		case <-job.done:
			return
		case <-b.ctx.Done():
			return
		case now = <-tick.C:
		}
		size := outputSizeOf(job.outputPath)
		b.mu.Lock()
		if job.handedOff {
			// The runner's next image wakes the session for it, from where this one got to.
			b.mu.Unlock()
			return
		}
		if job.status != bgStatusRunning || size <= job.wokenThrough {
			b.mu.Unlock()
			continue
		}
		if gathering.IsZero() {
			gathering = now
		}
		if now.Sub(gathering) < bgWakeOutputWindow || (!lastWake.IsZero() && now.Sub(lastWake) < bgWakeOutputInterval) {
			b.mu.Unlock()
			continue
		}
		wake := job.wakeLocked(bgWakeOnOutput, size)
		b.mu.Unlock()
		gathering, lastWake = time.Time{}, now
		b.sendWake(wake)
	}
}

// sendWake hands one wake to the control plane without holding up whoever found it, and retries a
// control plane that does not answer for a little while. One that cannot be delivered is logged
// and dropped: the job's end is still in its durable event, which the session's next turn is told.
func (b *bgTailer) sendWake(wake bgWake) {
	if b.wake == nil {
		return
	}
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return
	}
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		b.deliverWake(wake)
	}()
}

// deliverWake sends one wake, retrying a control plane that does not answer for a little while.
func (b *bgTailer) deliverWake(wake bgWake) {
	if b.wake == nil {
		return
	}
	wake.OutputExcerpt = wakeExcerpt(wake.OutputPath)
	for attempt := 1; ; attempt++ {
		err := b.wake(wake)
		if err == nil {
			return
		}
		if attempt == bgWakeAttempts || !isRetryableTransportError(err) {
			logln("could not wake the session for background job", wake.JobID+":", err)
			return
		}
		time.Sleep(time.Duration(attempt) * bgWakeRetryDelay)
	}
}

func outputSizeOf(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

// wakeExcerpt is the end of a job's output as a wake quotes it: at most bgWakeExcerptCap bytes,
// starting on a whole line where there is one, without terminal colour codes or the NUL bytes a
// database text column refuses.
func wakeExcerpt(path string) string {
	text := strings.ReplaceAll(stripANSI(readCapped(path)), "\x00", "")
	if len(text) > bgWakeExcerptCap {
		text = text[len(text)-bgWakeExcerptCap:]
		if newline := strings.IndexByte(text, '\n'); newline >= 0 && newline < len(text)-1 {
			text = text[newline+1:]
		}
	}
	return strings.ToValidUTF8(text, "")
}

// jobStatus reports one job, running or finished.
func (b *bgTailer) jobStatus(jobID string) (bgJobStatus, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	job, ok := b.jobs[jobID]
	if !ok {
		return bgJobStatus{}, false
	}
	return job.statusLocked(), true
}

// listJobs is what an agent reads to find the work it left running — after an
// engine restart, that is the only way back to it.
func (b *bgTailer) listJobs(includeFinished bool) []bgJobStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []bgJobStatus{}
	for _, job := range b.jobs {
		if !includeFinished && job.status != bgStatusRunning {
			continue
		}
		out = append(out, job.statusLocked())
	}
	sortBgJobStatuses(out)
	return out
}

func sortBgJobStatuses(jobs []bgJobStatus) {
	// Oldest first, and by id within the same second: a list is built by ranging
	// over a map, so without the tiebreak two jobs started together would come
	// back in a different order every call.
	sort.Slice(jobs, func(i, j int) bool {
		if jobs[i].StartedAt != jobs[j].StartedAt {
			return jobs[i].StartedAt < jobs[j].StartedAt
		}
		return jobs[i].JobID < jobs[j].JobID
	})
}

// liveJobCount is how many of this session's runner-hosted jobs are still
// running.
func (b *bgTailer) liveJobCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, job := range b.jobs {
		if job.status == bgStatusRunning {
			n++
		}
	}
	return n
}

// jobOutput reads a job's output file. The file belongs to the runner, so this
// answers whether or not an engine is currently up — which is the state a job
// that outlived its engine leaves the session in.
func (b *bgTailer) jobOutput(jobID string, tail int, sinceOffset int64) (bgJobOutput, error) {
	b.mu.Lock()
	job, ok := b.jobs[jobID]
	if !ok {
		b.mu.Unlock()
		return bgJobOutput{}, fmt.Errorf("no such background job: %s", jobID)
	}
	status := job.statusLocked()
	b.mu.Unlock()

	if tail <= 0 {
		tail = bgTailCap
	}
	if tail > bgJobOutputCap {
		tail = bgJobOutputCap
	}
	out := bgJobOutput{
		JobID:      status.JobID,
		ShellID:    status.ShellID,
		Status:     status.Status,
		ExitCode:   status.ExitCode,
		OutputPath: status.OutputPath,
		NextOffset: sinceOffset,
	}
	f, err := os.Open(status.OutputPath)
	if err != nil {
		return out, nil // not written to yet; an empty read is not an error
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return out, err
	}
	start := sinceOffset
	if start < 0 || start > info.Size() {
		start = info.Size()
	}
	if sinceOffset <= 0 && info.Size()-start > int64(tail) {
		start = info.Size() - int64(tail)
		out.Truncated = true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return out, err
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(tail)))
	if err != nil {
		return out, err
	}
	out.Output = string(data)
	out.NextOffset = start + int64(len(data))
	out.Truncated = out.Truncated || out.NextOffset < info.Size()
	return out, nil
}

// killJob is the explicit end of a job's life — one of the three there are. A job
// that already finished by itself is reported as it actually ended, never
// relabelled as killed to match the request.
func (b *bgTailer) killJob(jobID string, grace time.Duration) (bgJobStatus, error) {
	b.mu.Lock()
	job, ok := b.jobs[jobID]
	if !ok {
		b.mu.Unlock()
		return bgJobStatus{}, fmt.Errorf("no such background job: %s", jobID)
	}
	if job.status != bgStatusRunning {
		status := job.statusLocked()
		b.mu.Unlock()
		return status, nil
	}
	job.killReason = "requested"
	cancel := job.cancel
	done := job.done
	b.mu.Unlock()

	cancel()
	select {
	case <-done:
	case <-time.After(grace):
	}
	status, _ := b.jobStatus(jobID)
	return status, nil
}

// drainJobs is what the two kinds are for. A service is killed at once: it is
// valuable while it runs, restarting it is cheap and idempotent, and holding a
// drain open for a watcher helps nobody. A job is given until budget to finish on
// its own, because restarting one costs hours — and whatever is still running
// when the budget runs out is killed AND reported as killed, so a build that was
// cut short never reads as a completion nobody witnessed. A runner re-executing into
// a self-update ends no job at all: it hands the jobs on (handOffJobs).
func (b *bgTailer) drainJobs(budget time.Duration) {
	if b.handOffJobs() {
		return
	}
	b.mu.Lock()
	serviceReason, _ := b.drainReasonsLocked()
	var services, jobs []*bgJob
	for _, job := range b.jobs {
		if job.status != bgStatusRunning {
			continue
		}
		if job.kind == bgKindService {
			job.killReason = serviceReason
			services = append(services, job)
			continue
		}
		jobs = append(jobs, job)
	}
	b.mu.Unlock()

	for _, service := range services {
		service.cancel()
	}
	deadline := time.Now().Add(budget)
	overBudget := false
	for _, job := range jobs {
		if overBudget {
			break
		}
		select {
		case <-job.done:
		case <-time.After(time.Until(deadline)):
			overBudget = true
		}
	}
	if overBudget {
		b.killOverBudget(jobs)
	}
	for _, service := range services {
		select {
		case <-service.done:
		case <-time.After(bgKillTeardownGrace):
		}
	}
}

// killOverBudget ends the jobs a drain could not wait out, marking each so its
// event says why rather than leaving the user to guess.
func (b *bgTailer) killOverBudget(jobs []*bgJob) {
	b.mu.Lock()
	_, reason := b.drainReasonsLocked()
	var killing []*bgJob
	for _, job := range jobs {
		if job.status != bgStatusRunning {
			continue
		}
		job.killReason = reason
		killing = append(killing, job)
	}
	b.mu.Unlock()
	for _, job := range killing {
		job.cancel()
	}
	for _, job := range killing {
		select {
		case <-job.done:
		case <-time.After(bgKillTeardownGrace):
		}
	}
}

// drainOnRunnerShutdown ends this session's jobs when the runner process stops — re-executing
// into a self-update, or its service being stopped — and files each as ended by that. Two things
// separate it from the drain the session's own end runs:
//
//   - Why. The session is not ending; the runner hosting its jobs is. Filed as `drain` and
//     `drain_cap`, every release restart read as a session end, and a count of kills that sets
//     session ends aside could not see the builds each release was killing. Every kill a drain
//     makes once the runner has begun to stop is filed as runner_shutdown (drainReasonsLocked).
//   - When. The supervisor only reaches stopAll after its turn drain, which may take all of
//     shutdownDrainTimeout, while the flush that has to deliver the kill is given a grace counted
//     from the moment the runner began to stop. A job drain that started behind the turn drain
//     spent its bgDrainWaitCap past that grace: the kill was emitted after the last flush had
//     been cancelled, and the job's last delivered event stayed `running`. Draining from the
//     moment the runner starts to stop keeps the kill and its report inside that grace, whatever
//     the turn drain does.
//
// Called once, before the session serves any job; shutdown is runLoop's loopCtx.
func (b *bgTailer) drainOnRunnerShutdown(shutdown context.Context) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.shutdown = shutdown
	b.stopShutdownDrain = context.AfterFunc(shutdown, func() {
		// Behind the same registration gate as every other goroutine stopAll joins.
		b.mu.Lock()
		if b.stopping {
			b.mu.Unlock()
			return
		}
		b.wg.Add(1)
		b.mu.Unlock()
		defer b.wg.Done()
		b.drainJobs(bgDrainWaitCap)
	})
}

// runnerStoppingLocked reports whether the runner process has begun to stop. Caller holds b.mu.
func (b *bgTailer) runnerStoppingLocked() bool {
	return b.shutdown != nil && b.shutdown.Err() != nil
}

// drainReasonsLocked names what a drain's kills are filed as — a service's, and a job's that
// outlasted the budget: the session's own end, its cancellation once the context the jobs run
// under is gone, or the runner's stop once that has begun. Caller holds b.mu.
func (b *bgTailer) drainReasonsLocked() (service, overBudget string) {
	if b.runnerStoppingLocked() {
		return bgRunnerShutdownReason, bgRunnerShutdownReason
	}
	// stopAll names its kills before it cancels the context itself, so a cancelled one here is
	// the session's: a drain racing that cancellation files what it ends as the cancellation does.
	if b.ctx.Err() != nil {
		return bgSessionCancelledReason, bgSessionCancelledReason
	}
	return "drain", bgDrainCapReason
}
