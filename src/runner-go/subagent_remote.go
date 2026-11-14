package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cross-workspace SubAgents, the runner's two halves (docs/subagent-design.md §10.2, §10.3).
//
// The target: a runner whose heartbeat lists a remote run (remoteSubagentRuns) claims it for one of its workspaces,
// makes a temporary detached worktree of that workspace's workDir at its own HEAD (outside the workDir, under this
// machine's ~/.orbit), runs the child engine there exactly as a same-machine SubAgent runs (child mode, preamble,
// definition, permission rules: the subagentChildRunners), relays its events to the server, and removes the worktree
// at the end. The result is text only: when the child changed anything, the runner says what it discarded
// (discardedChangesLine). A run the heartbeat says to stop (stopSubagentRunIds) is stopped with the same grace a
// same-machine SubAgent gets; a run this process was hosting when it stopped is reported INTERRUPTED, by the stop
// itself or, after a crash, by the next process from the record it left (recoverRemoteSubagents).
//
// The parent: a delegate call the server placed on another workspace is answered without an exec. The parent's
// runner starts no child; it reads the relayed events and writes them into the session's stream, which only it
// numbers, until the run ends (followRemoteSubagent).

// subagentStopParent is why the target stops a remote run: its parent session stopped it or ended.
const subagentStopParent = "parent_stopped"

// remoteSubagentRecord is what the target keeps on disk while it hosts a remote run, so the next process cleans up
// and reports a run this one was hosting when it died.
type remoteSubagentRecord struct {
	RunID   string `json:"runId"`
	WorkDir string `json:"workDir"`
	Tree    string `json:"tree"`
}

func remoteSubagentsDir() string { return filepath.Join(machineHome(), "remote-subagents") }

func remoteSubagentDir(runID string) string { return filepath.Join(remoteSubagentsDir(), runID) }

// remoteSubagentClaim is the server's answer to a claim (RemoteSubagentClaim).
type remoteSubagentClaim struct {
	RunID            string          `json:"runId"`
	SessionID        string          `json:"sessionId"`
	ToolUseID        string          `json:"toolUseId"`
	WorkspaceID      string          `json:"workspaceId"`
	WorkDir          string          `json:"workDir"`
	Type             string          `json:"type"`
	DefinitionSource string          `json:"definitionSource"`
	Description      string          `json:"description"`
	Background       bool            `json:"background"`
	Prompt           string          `json:"prompt"`
	Exec             AgentExecConfig `json:"exec"`
}

// remoteSubagentTask is one remote run this process hosts.
type remoteSubagentTask struct {
	runID  string
	cancel context.CancelFunc
	done   chan struct{}

	// Under remoteSubagentHost.mu.
	cmd        *exec.Cmd
	stopReason string
}

// remoteSubagentHost is the remote runs this process hosts, by run id.
type remoteSubagentHost struct {
	mu   sync.Mutex
	runs map[string]*remoteSubagentTask
	// ending are the runs this process reports STOPPED without having hosted them (an unclaimed run whose parent
	// ended), so a heartbeat that lists one again before the report lands does not send it twice.
	ending map[string]bool
}

var remoteSubagents = &remoteSubagentHost{runs: map[string]*remoteSubagentTask{}, ending: map[string]bool{}}

// onHeartbeat acts on what one heartbeat said of the remote runs this runner is the target of: claims the new
// ones (not while draining) and stops the ones whose parent stopped them or ended.
func (h *remoteSubagentHost) onHeartbeat(t *Transport, claim, stop []string, draining bool) {
	stopping := map[string]bool{}
	for _, id := range stop {
		stopping[id] = true
		if !h.stop(id, subagentStopParent) {
			h.reportUnhosted(t, id)
		}
	}
	if draining {
		return
	}
	for _, id := range claim {
		if id == "" || stopping[id] {
			continue
		}
		h.mu.Lock()
		_, hosted := h.runs[id]
		var task *remoteSubagentTask
		if !hosted {
			ctx, cancel := context.WithCancel(context.Background())
			task = &remoteSubagentTask{runID: id, cancel: cancel, done: make(chan struct{})}
			h.runs[id] = task
			go func() {
				defer func() {
					h.mu.Lock()
					delete(h.runs, id)
					h.mu.Unlock()
					cancel()
					close(task.done)
				}()
				runRemoteSubagent(ctx, t, task)
			}()
		}
		h.mu.Unlock()
	}
}

// stop asks a hosted run to stop, for reason: SIGINT to its child's process group, then, subagentStopGrace later,
// the kill. False when this process does not host it.
func (h *remoteSubagentHost) stop(runID, reason string) bool {
	h.mu.Lock()
	task := h.runs[runID]
	if task == nil {
		h.mu.Unlock()
		return false
	}
	first := task.stopReason == ""
	if first {
		task.stopReason = reason
	}
	cmd := task.cmd
	h.mu.Unlock()
	if !first {
		return true
	}
	logln("stopping remote SubAgent", runID, "("+reason+")")
	if cmd != nil {
		_ = interruptSessionProcessGroup(cmd)
	}
	time.AfterFunc(subagentStopGrace, task.cancel)
	return true
}

// stopAll ends every hosted run as the runner process stops (INTERRUPTED), and waits for each to be reported, at
// most the grace and subagentStopReportWait.
func (h *remoteSubagentHost) stopAll(reason string) {
	h.mu.Lock()
	var tasks []*remoteSubagentTask
	for _, task := range h.runs {
		tasks = append(tasks, task)
	}
	h.mu.Unlock()
	for _, task := range tasks {
		h.stop(task.runID, reason)
	}
	deadline := time.After(subagentStopGrace + subagentStopReportWait)
	for _, task := range tasks {
		select {
		case <-task.done:
		case <-deadline:
			logln("remote SubAgents were not all reported before the runner stopped; the next start reports them")
			return
		}
	}
}

// reportUnhosted ends a run the server says to stop that this process does not host: one its parent stopped
// before it was claimed here. A run another process of this runner hosted is reported by its record.
func (h *remoteSubagentHost) reportUnhosted(t *Transport, runID string) {
	h.mu.Lock()
	if h.ending[runID] {
		h.mu.Unlock()
		return
	}
	h.ending[runID] = true
	h.mu.Unlock()
	go func() {
		defer func() {
			// Kept a while, so a heartbeat answered before the report landed does not send it again.
			time.Sleep(time.Minute)
			h.mu.Lock()
			delete(h.ending, runID)
			h.mu.Unlock()
		}()
		reportRemoteSubagentEnd(t, runID, subagentStatusStopped,
			"The SubAgent was stopped before it started on the workspace it was handed to.", nil, 0)
	}()
}

// recoverRemoteSubagents cleans up after remote runs a previous process of this runner was hosting when it ended
// without reporting them: removes their worktrees and reports them INTERRUPTED (a run that was reported is not
// changed by a second report). Run once as the runner starts.
func recoverRemoteSubagents(t *Transport) {
	entries, err := os.ReadDir(remoteSubagentsDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(remoteSubagentsDir(), entry.Name())
		var rec remoteSubagentRecord
		if raw, err := os.ReadFile(filepath.Join(dir, "run.json")); err == nil {
			_ = json.Unmarshal(raw, &rec)
		}
		if rec.RunID == "" {
			rec.RunID = entry.Name()
		}
		if rec.WorkDir != "" && rec.Tree != "" {
			removeRemoteSubagentTree(rec.WorkDir, rec.Tree)
		}
		logln("remote SubAgent", rec.RunID, "was running when this runner last stopped; reporting it interrupted")
		if reportRemoteSubagentEnd(t, rec.RunID, subagentStatusInterrupted,
			"The SubAgent was interrupted: the runner of the workspace it ran on stopped (a restart or an update) before "+
				"it ended. Nothing it changed there comes back.", nil, 0) {
			_ = os.RemoveAll(dir)
		}
	}
}

// runRemoteSubagent claims one remote run and runs it to its reported end.
func runRemoteSubagent(ctx context.Context, t *Transport, task *remoteSubagentTask) {
	var claim remoteSubagentClaim
	if err := t.do(ctx, "POST", "/runner/subagent-runs/"+url.PathEscape(task.runID)+"/claim", map[string]interface{}{}, &claim, 30*time.Second); err != nil {
		// A 409 is the server ending it (stopped, or the workspace cannot run it); anything else is tried again at
		// the next heartbeat, which lists the run until a claim lands.
		logln("could not claim remote SubAgent", task.runID+":", err)
		return
	}
	if claim.RunID == "" {
		claim.RunID = task.runID
	}
	status, result, cost, usage := runClaimedRemoteSubagent(ctx, t, task, claim)
	reportRemoteSubagentEnd(t, claim.RunID, status, result, usage, cost)
	_ = os.RemoveAll(remoteSubagentDir(claim.RunID))
}

// runClaimedRemoteSubagent runs a claimed run in a temporary worktree and removes it, answering the run's end.
func runClaimedRemoteSubagent(ctx context.Context, t *Transport, task *remoteSubagentTask, claim remoteSubagentClaim) (string, string, float64, *TokenUsage) {
	fail := func(why string) (string, string, float64, *TokenUsage) {
		return subagentStatusFailed, "The SubAgent failed: " + why, 0, nil
	}
	workDir := strings.TrimSpace(expandTilde(claim.WorkDir))
	if workDir == "" {
		return fail("the workspace it was handed to has no work directory.")
	}
	dir := remoteSubagentDir(claim.RunID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail("could not make its scratch directory: " + err.Error())
	}
	tree := filepath.Join(dir, "tree")
	// Recorded before the worktree exists, so a crash while it is made still leaves the next start a record to clean.
	_ = writeJSONFile(filepath.Join(dir, "run.json"), remoteSubagentRecord{RunID: claim.RunID, WorkDir: workDir, Tree: tree})
	if err := addRemoteSubagentTree(claim.RunID, workDir, tree); err != nil {
		return fail(err.Error())
	}
	defer removeRemoteSubagentTree(workDir, tree)

	// The definition as the target workspace's own HEAD has it, read from the worktree the child runs in.
	def, err := findSubagentDefinition(sessionSubagentDefinitions(tree), claim.Type)
	if err != nil {
		return fail(err.Error())
	}
	// The parent session's claim as far as a child needs one: approvals are filed under the parent's id (the server
	// lets this runner, the run's target, file them), and the server's exec is the child's engine and mode.
	parent := &ClaimedSession{
		SessionID: claim.SessionID, Provider: claim.Exec.Provider, Agent: claim.Exec, WorkDir: tree,
		WatchesDisabled: true, WikiDisabled: true,
	}
	engine := subagentEngine(claim.Exec, parent)
	runChild, ok := subagentChildRunners[engine]
	if !ok {
		return fail(fmt.Sprintf("SubAgents cannot run on the %s engine on this runner.", engine))
	}
	engineSession := ""
	if engine == providerClaude {
		if engineSession, err = randomUUID(); err != nil {
			return fail(err.Error())
		}
	}
	scratch := filepath.Join(dir, "scratch")
	_ = os.MkdirAll(scratch, 0o700)
	relay := newRemoteSubagentRelay(t, claim.RunID)
	go relay.run()
	spawned := func(cmd *exec.Cmd) {
		remoteSubagents.mu.Lock()
		task.cmd = cmd
		stopping := task.stopReason != ""
		remoteSubagents.mu.Unlock()
		if stopping {
			_ = interruptSessionProcessGroup(cmd)
		}
	}
	remoteSubagents.mu.Lock()
	stopped := task.stopReason != ""
	remoteSubagents.mu.Unlock()
	var res ExecResult
	if !stopped && ctx.Err() == nil {
		logln(fmt.Sprintf("remote SubAgent %s — running %s in a worktree of %s", claim.RunID, engine, workDir))
		res, _, err = runChild(withSubagentApprovals(ctx, claim.RunID), subagentChild{
			t: t, parent: parent, exec: claim.Exec, def: def, runID: claim.RunID, engineSession: engineSession,
			cwd: tree, scratch: scratch, stateDir: scratch, prompt: claim.Prompt, emit: relay.add, spawned: spawned,
		})
	}
	changed := remoteSubagentTreeChanges(tree)
	relay.close(15 * time.Second)

	remoteSubagents.mu.Lock()
	stopReason := task.stopReason
	remoteSubagents.mu.Unlock()
	status, result := subagentStatusDone, strings.TrimSpace(res.Result)
	switch {
	case stopReason == subagentStopRunnerStopped:
		status = subagentStatusInterrupted
		result = strings.TrimSpace("The SubAgent was interrupted: the runner of the workspace it ran on stopped (a restart" +
			" or an update).\n" + result)
	case stopReason != "" || ctx.Err() != nil:
		status = subagentStatusStopped
		if result == "" {
			result = "The SubAgent was stopped by its parent session."
		}
	case err != nil:
		status = subagentStatusFailed
		result = strings.TrimSpace("The SubAgent failed: " + err.Error() + "\n" + result)
	case res.Status != stSucceeded || isAPIError(result) || isAuthError(result):
		status = subagentStatusFailed
		if result == "" {
			result = "The SubAgent failed: " + firstNonEmpty(res.ErrorMsg, res.Subtype, "no result")
		}
	}
	if line := discardedChangesLine(changed); line != "" {
		result = strings.TrimSpace(result + "\n\n" + line)
	}
	// spawnClaude makes the parent session's uploads dir; on this machine nothing else uses it.
	_ = os.Remove(uploadsDir(claim.SessionID))
	return status, result, res.CostUsd, res.Usage
}

// addRemoteSubagentTree makes the temporary detached worktree of workDir at its own HEAD, leaving out what the
// repository's checkout-exclude declares, as a session checkout does. Refuses a workDir that is not a git repository.
func addRemoteSubagentTree(runID, workDir, tree string) error {
	head, err := git(workDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil || head == "" {
		return fmt.Errorf("the work directory %s of the workspace it was handed to is not a git repository with a commit, so it cannot run there in a worktree of its own (SUBAGENT_WORKSPACE_NOT_GIT).", workDir)
	}
	declared, _ := sessionCheckoutExclusions(workDir, head)
	if _, _, err := makeSessionCheckout("subagent "+runID, workDir, tree, head, declared, false, []string{"--detach", tree, head}); err != nil {
		removeRemoteSubagentTree(workDir, tree)
		return fmt.Errorf("could not make a worktree of %s at %s: %s", workDir, shortSha(head), gitStderr(err))
	}
	return nil
}

// removeRemoteSubagentTree removes the temporary worktree, and git's record of it in workDir.
func removeRemoteSubagentTree(workDir, tree string) {
	removePartialCheckout(workDir, tree)
}

// remoteSubagentTreeChanges is every path the child left changed in its worktree, tracked or not, sorted.
func remoteSubagentTreeChanges(tree string) []string {
	out, err := exec.Command("git", "-C", tree, "status", "--porcelain=v1", "-z", "--untracked-files=all").Output()
	if err != nil {
		return nil
	}
	return parsePorcelainZPaths(string(out))
}

// parsePorcelainZPaths reads `git status --porcelain=v1 -z`: entries "XY path", a rename or copy followed by its
// source path, which is not named again.
func parsePorcelainZPaths(out string) []string {
	seen := map[string]bool{}
	var paths []string
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue
		}
		code, path := entry[:2], entry[3:]
		if code[0] == 'R' || code[0] == 'C' {
			i++ // the source of the rename or copy
		}
		if !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}

// discardedChangesMaxPaths is how many paths the discarded-changes line names before it counts the rest.
const discardedChangesMaxPaths = 20

// discardedChangesLine is what a remote run's result ends with when its child changed anything (§10.2): nothing
// came back, and the parent is told what did not. "" when nothing changed.
func discardedChangesLine(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	named := paths
	more := ""
	if len(named) > discardedChangesMaxPaths {
		named = named[:discardedChangesMaxPaths]
		more = fmt.Sprintf(", and %d more", len(paths)-discardedChangesMaxPaths)
	}
	noun := "files"
	if len(paths) == 1 {
		noun = "file"
	}
	return fmt.Sprintf("Discarded changes: %d %s (%s%s)", len(paths), noun, strings.Join(named, ", "), more)
}

// reportRemoteSubagentEnd sends a remote run's end, tried again while the control plane does not answer. True once
// the server has it (a 404 or 409 included: there is nothing more to tell it).
func reportRemoteSubagentEnd(t *Transport, runID, status, result string, usage *TokenUsage, costUsd float64) bool {
	body := map[string]interface{}{
		"status": status, "resultSummary": result, "changedFiles": []string{}, "costUsd": costUsd, "wake": false,
	}
	if usage != nil {
		body["usage"] = usage
	}
	for attempt := 1; attempt <= 5; attempt++ {
		err := t.do(nil, "PATCH", "/runner/subagent-runs/"+url.PathEscape(runID), body, nil, 15*time.Second)
		if err == nil || isTransportHTTPStatus(err, http.StatusNotFound) || isTransportHTTPStatus(err, http.StatusConflict) {
			return true
		}
		if !isRetryableTransportError(err) || attempt == 5 {
			logln("could not report the end of remote SubAgent", runID+":", err)
			return false
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	return false
}

// ── The relay ────────────────────────────────────────────────────────────────────────────────────────────

// remoteSubagentRelay sends a remote child's events to the server in order, numbered from 1, in batches. A batch the
// server did not take is sent again (it keeps each seq once).
type remoteSubagentRelay struct {
	t     *Transport
	runID string

	mu      sync.Mutex
	pending []map[string]interface{}
	seq     int
	wake    chan struct{}
	closing chan struct{}
	done    chan struct{}
}

// remoteRelayBatchMax is the most events one POST carries (SUBAGENT_RELAY_BATCH_MAX on the server).
const remoteRelayBatchMax = 200

var remoteRelayInterval = 500 * time.Millisecond

func newRemoteSubagentRelay(t *Transport, runID string) *remoteSubagentRelay {
	return &remoteSubagentRelay{t: t, runID: runID, wake: make(chan struct{}, 1), closing: make(chan struct{}), done: make(chan struct{})}
}

// add queues one child event, if it is one the parent's stream carries (rewriteSubagentEvent's kinds).
func (r *remoteSubagentRelay) add(eventType string, payload map[string]interface{}) {
	if _, ok := rewriteSubagentEvent(r.runID, "", eventType, payload); !ok {
		return
	}
	r.mu.Lock()
	r.seq++
	r.pending = append(r.pending, map[string]interface{}{"seq": r.seq, "type": eventType, "payload": payload})
	full := len(r.pending) >= remoteRelayBatchMax
	r.mu.Unlock()
	if full {
		select {
		case r.wake <- struct{}{}:
		default:
		}
	}
}

func (r *remoteSubagentRelay) run() {
	defer close(r.done)
	ticker := time.NewTicker(remoteRelayInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-r.wake:
		case <-r.closing:
			return
		}
		r.flush()
	}
}

// flush sends what is queued, a batch at a time; false when a batch was not taken.
func (r *remoteSubagentRelay) flush() bool {
	for {
		r.mu.Lock()
		n := len(r.pending)
		if n > remoteRelayBatchMax {
			n = remoteRelayBatchMax
		}
		batch := append([]map[string]interface{}(nil), r.pending[:n]...)
		r.mu.Unlock()
		if len(batch) == 0 {
			return true
		}
		err := r.t.do(nil, "POST", "/runner/subagent-runs/"+url.PathEscape(r.runID)+"/events",
			map[string]interface{}{"events": batch}, nil, 30*time.Second)
		if err != nil && !isTransportHTTPStatus(err, http.StatusBadRequest) {
			if !errors.Is(err, context.Canceled) {
				logln("relaying events of remote SubAgent", r.runID, "failed:", err)
			}
			return false
		}
		// Taken, or refused as malformed, which no retry would change.
		r.mu.Lock()
		r.pending = r.pending[len(batch):]
		r.mu.Unlock()
	}
}

// close stops the loop and sends what is left, trying until wait has passed.
func (r *remoteSubagentRelay) close(wait time.Duration) {
	close(r.closing)
	<-r.done
	deadline := time.Now().Add(wait)
	for !r.flush() && time.Now().Before(deadline) {
		time.Sleep(time.Second)
	}
}

// ── The parent's half ────────────────────────────────────────────────────────────────────────────────────

// remoteSubagentEventsPage is the server's page of a remote run's relayed events (RemoteSubagentEventsPage),
// already nested under the delegate call.
type remoteSubagentEventsPage struct {
	Events []struct {
		Seq     int                    `json:"seq"`
		Type    string                 `json:"type"`
		Payload map[string]interface{} `json:"payload"`
	} `json:"events"`
	Status        string  `json:"status"`
	ResultSummary *string `json:"resultSummary"`
}

var remoteSubagentPollInterval = time.Second

// followRemoteSubagent writes a remote run's relayed events into the parent session's stream until the run ends,
// then ends it here as runSubagent ends a local one. The target reported the end to the server, so nothing is sent.
func (s *bgJobService) followRemoteSubagent(ctx context.Context, run *subagentRun) {
	defer run.cancel()
	after := 0
	status, result := "", ""
	failures := 0
	for status == "" {
		var page remoteSubagentEventsPage
		path := "/runner/sessions/" + s.sessionID + "/subagents/" + url.PathEscape(run.id) + "/events?after=" + strconv.Itoa(after)
		err := s.t.do(ctx, "GET", path, nil, &page, 30*time.Second)
		switch {
		case ctx.Err() != nil:
			status, result = subagentStatusStopped, "The SubAgent was stopped because the session ended; it may still be stopping on the workspace it ran on."
			continue
		case err != nil && isTransportHTTPStatus(err, http.StatusNotFound):
			status, result = subagentStatusFailed, "The SubAgent run is gone from the server."
			continue
		case err != nil:
			failures++
			if failures%30 == 1 {
				logln("reading the events of remote SubAgent", run.id, "failed:", err)
			}
		default:
			failures = 0
			for _, event := range page.Events {
				if event.Seq > after {
					after = event.Seq
				}
				if event.Payload != nil {
					s.bg.emit(event.Type, event.Payload)
				}
			}
			// The end only once every event before it was read: a full page may have more behind it.
			if page.Status != "" && page.Status != subagentStatusRunning && len(page.Events) == 0 {
				status = page.Status
				if page.ResultSummary != nil {
					result = *page.ResultSummary
				}
				continue
			}
			if len(page.Events) > 0 {
				continue // read on at once
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(remoteSubagentPollInterval):
		}
	}

	s.subagents.mu.Lock()
	run.endedAt = time.Now()
	run.status, run.result = status, result
	answeredElsewhere := run.background || run.detached
	s.subagents.mu.Unlock()
	if answeredElsewhere || status == subagentStatusStopped || status == subagentStatusInterrupted {
		bgStatus := map[string]string{subagentStatusDone: bgStatusCompleted, subagentStatusFailed: bgStatusFailed}[status]
		if bgStatus == "" {
			bgStatus = bgStatusKilled
		}
		s.bg.emit(evBackgroundTask, map[string]interface{}{
			"toolUseId": run.toolUseID, "status": bgStatus, "summary": "SubAgent " + run.id + " " + strings.ToLower(status),
			"output": result, "subagentRunId": run.id,
		})
	}
	s.bg.subagentsLive.Add(-1)
	s.subagents.mu.Lock()
	close(run.done)
	s.subagents.mu.Unlock()
}

// requestRemoteStop asks the server to stop a remote run; its target stops the child (§10.3).
func (s *bgJobService) requestRemoteStop(runID string) {
	for attempt := 1; attempt <= 3; attempt++ {
		err := s.t.do(nil, "POST", "/runner/sessions/"+s.sessionID+"/subagents/"+url.PathEscape(runID)+"/stop", map[string]interface{}{}, nil, 15*time.Second)
		if err == nil || !isRetryableTransportError(err) {
			if err != nil {
				logln("could not stop remote SubAgent", runID+":", err)
			}
			return
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
}
