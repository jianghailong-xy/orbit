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

	// bgJobOutputCap bounds one bg_output read.
	bgJobOutputCap = 256 * 1024
)

// bgJobSpec is one request to run something in the background. Dir and ScratchDir
// come from the runner, never from the agent's request as-is (see bgJobService).
type bgJobSpec struct {
	Command     string
	Kind        string
	Dir         string // where the command runs
	ScratchDir  string // where its output file lives — runner-owned, outside the checkout
	Description string
	Env         map[string]string
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

	status   string
	exitCode *int
	endedAt  time.Time
	// killReason records that this process is dying because we asked, so the
	// waiter reports "killed" rather than inventing a completion out of the exit
	// status a SIGKILL leaves behind.
	killReason string
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
	if spec.Kind != bgKindService && spec.Kind != bgKindJob {
		return bgJobStatus{}, fmt.Errorf("kind must be %q or %q, got %q", bgKindService, bgKindJob, spec.Kind)
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
	cmd.Dir = spec.Dir
	cmd.Env = envWithAgent(spec.Env)
	cmd.Stdout = f
	cmd.Stderr = f
	if err := cmd.Start(); err != nil {
		cancel()
		f.Close()
		return bgJobStatus{}, err
	}
	job := &bgJob{
		id:          jobID,
		kind:        spec.Kind,
		command:     spec.Command,
		description: spec.Description,
		outputPath:  outputPath,
		pid:         cmd.Process.Pid,
		startedAt:   time.Now(),
		cancel:      cancel,
		done:        make(chan struct{}),
		status:      bgStatusRunning,
	}

	b.mu.Lock()
	if b.stopping {
		// stopAll ran while we were starting: this process belongs to an epoch
		// that is already being torn down, so it does not get to join the registry.
		b.mu.Unlock()
		cancel()
		f.Close()
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
	b.emit(evBackgroundTask, map[string]interface{}{
		"shellId":    jobID,
		"toolUseId":  jobID,
		"status":     bgStatusRunning,
		"kind":       spec.Kind,
		"command":    spec.Command,
		"outputPath": outputPath,
	})
	// Tails the output for live UI, registers the worktree hold, and — with
	// engineOwned false — puts this job outside killEngineShells' reach.
	b.startTail(jobID, jobID, outputPath, false)

	waiterStarted = true
	go func() {
		defer b.wg.Done()
		waitErr := waitSessionProcessTree(cmd)
		f.Close()
		b.finishJob(job, exitCodeFromWait(cmd, waitErr))
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

// finishJob retires a job whose process has gone: it ends the tail, releases the
// checkout, records the outcome, and emits the one terminal event.
func (b *bgTailer) finishJob(job *bgJob, exit int) {
	b.stop(job.id) // ends the tail, drops it from b.live, releases the worktree hold

	b.mu.Lock()
	reason := job.killReason
	status := bgStatusCompleted
	switch {
	case reason != "":
		status = bgStatusKilled
	case exit != 0:
		status = bgStatusFailed
	}
	job.status = status
	job.endedAt = time.Now()
	if status != bgStatusKilled {
		code := exit
		job.exitCode = &code
	}
	summary := fmt.Sprintf("Background %s completed (exit code %d)", job.kind, exit)
	if status == bgStatusKilled {
		summary = fmt.Sprintf("Background %s was killed", job.kind)
	}
	b.mu.Unlock()

	// The session is going away and events emitted now would be persisted but no
	// longer broadcast — except for a kill we performed, which is the one thing a
	// user must not have to guess about.
	if b.ctx.Err() == nil || reason != "" {
		if b.markTerminal(job.id) {
			payload := map[string]interface{}{
				"shellId":    job.id,
				"toolUseId":  job.id,
				"status":     status,
				"kind":       job.kind,
				"command":    job.command,
				"summary":    summary,
				"output":     readCapped(job.outputPath),
				"outputPath": job.outputPath,
			}
			if status != bgStatusKilled {
				payload["exitCode"] = exit
			}
			if reason != "" {
				payload["reason"] = reason
			}
			b.emit(evBackgroundTask, payload)
			b.alertIfNobodyIsWatching(job, status, exit)
		}
	}
	close(job.done)
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
// cut short never reads as a completion nobody witnessed.
func (b *bgTailer) drainJobs(budget time.Duration) {
	b.mu.Lock()
	var services, jobs []*bgJob
	for _, job := range b.jobs {
		if job.status != bgStatusRunning {
			continue
		}
		if job.kind == bgKindService {
			job.killReason = "drain"
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
// event says the budget ran out rather than leaving the user to guess.
func (b *bgTailer) killOverBudget(jobs []*bgJob) {
	b.mu.Lock()
	var killing []*bgJob
	for _, job := range jobs {
		if job.status != bgStatusRunning {
			continue
		}
		job.killReason = bgDrainCapReason
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
