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
// at the end. A claim marked inPlace (a read-only run on a work dir that is not a git repository) runs the child in the
// workDir itself, read-only, and makes and removes no worktree. The result is text only: when the child changed anything, the runner says what it discarded
// (discardedChangesLine). The run's conversation is kept after it ends (remoteSubagentKeep), so a claim that names it
// in resumeOf continues it, in a new worktree at the same path, which is where the engine looks for it. A run the heartbeat says to stop (stopSubagentRunIds) is stopped with the same grace a
// same-machine SubAgent gets; a run this process was hosting when it stopped is reported INTERRUPTED, by the stop
// itself or, after a crash, by the next process from the record it left (recoverRemoteSubagents).
//
// The parent: a delegate call the server placed on another workspace is answered without an exec. The parent's
// runner starts no child; it reads the relayed events and writes them into the session's stream, which only it
// numbers, until the run ends (followRemoteSubagent).

// subagentRemoteResumeCapabilityV1 declares that this runner keeps a remote run's conversation and continues it on a
// claim's resumeOf: @orbit/shared's SUBAGENT_REMOTE_RESUME_V1. The server refuses a resume for a runner without it.
const subagentRemoteResumeCapabilityV1 = "subagent-remote-resume/v1"

// subagentRemoteInPlaceCapabilityV1 declares that this runner runs a read-only remote SubAgent in a work dir that is
// not a git repository, in that directory itself, on a claim's inPlace: @orbit/shared's SUBAGENT_REMOTE_IN_PLACE_V1.
// The server places no such run on a runner without it.
const subagentRemoteInPlaceCapabilityV1 = "subagent-remote-in-place/v1"

// subagentStopParent is why the target stops a remote run: its parent session stopped it or ended.
const subagentStopParent = "parent_stopped"

// remoteSubagentRecord is what the target keeps on disk while it hosts a remote run, so the next process cleans up
// and reports a run this one was hosting when it died.
type remoteSubagentRecord struct {
	RunID   string `json:"runId"`
	WorkDir string `json:"workDir"`
	// Tree is the temporary worktree the run works in; "" for a run in place, which works in WorkDir and must never
	// have it removed.
	Tree    string `json:"tree"`
	InPlace bool   `json:"inPlace,omitempty"`
	// The conversation a resume continues: its engine, the engine's id for it, and the directory holding the engine's
	// state for it. A resume runs in Tree again, which may be another run's directory's, and so may StateDir be.
	Engine        string `json:"engine,omitempty"`
	EngineSession string `json:"engineSession,omitempty"`
	StateDir      string `json:"stateDir,omitempty"`
	// Ended is set once the run is over: the record stays only for a resume, until remoteSubagentKeep has passed.
	Ended bool `json:"ended,omitempty"`
}

// remoteSubagentKeep is how long an ended remote run's conversation is kept after its last run for a resume.
const remoteSubagentKeep = 7 * 24 * time.Hour

// readRemoteSubagentRecord reads the record a remote run left in its directory.
func readRemoteSubagentRecord(runID string) (remoteSubagentRecord, bool) {
	var rec remoteSubagentRecord
	raw, err := os.ReadFile(filepath.Join(remoteSubagentDir(runID), "run.json"))
	if err != nil || json.Unmarshal(raw, &rec) != nil {
		return remoteSubagentRecord{}, false
	}
	return rec, true
}

// endRemoteSubagentRecord keeps an ended run's directory for a resume when it holds a conversation, else removes it.
func endRemoteSubagentRecord(dir string, rec remoteSubagentRecord) {
	if rec.EngineSession == "" {
		_ = os.RemoveAll(dir)
		return
	}
	rec.Ended = true
	_ = writeJSONFile(filepath.Join(dir, "run.json"), rec)
}

// gcRemoteSubagentConversations removes the ended remote runs' directories nothing will resume: ended, last written
// longer than remoteSubagentKeep ago, and holding no state a kept or running run's conversation uses.
func gcRemoteSubagentConversations(now time.Time) {
	entries, err := os.ReadDir(remoteSubagentsDir())
	if err != nil {
		return
	}
	keep := map[string]bool{}
	var ended []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(remoteSubagentsDir(), entry.Name())
		info, err := os.Stat(filepath.Join(dir, "run.json"))
		rec, ok := readRemoteSubagentRecord(entry.Name())
		if err != nil || !ok || !rec.Ended || now.Sub(info.ModTime()) < remoteSubagentKeep {
			keep[dir] = true
			if ok && rec.StateDir != "" {
				keep[filepath.Dir(rec.StateDir)] = true
			}
			continue
		}
		ended = append(ended, dir)
	}
	for _, dir := range ended {
		if !keep[dir] {
			_ = os.RemoveAll(dir)
			logln("gc: removed the conversation of remote SubAgent", filepath.Base(dir))
		}
	}
}

func remoteSubagentsDir() string { return filepath.Join(machineHome(), "remote-subagents") }

func remoteSubagentDir(runID string) string { return filepath.Join(remoteSubagentsDir(), runID) }

// remoteSubagentClaim is the server's answer to a claim (RemoteSubagentClaim).
type remoteSubagentClaim struct {
	// ResumeOf is the earlier run of this runner whose conversation this one continues; "" for a new one.
	ResumeOf         string          `json:"resumeOf"`
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
	// ParentPermissionMode is the parent session's mode, which a read-only child's requests are answered by
	// (readonlySubagentAnswer); "" from a server that does not send it, when the child's own mode stands in.
	ParentPermissionMode string `json:"parentPermissionMode"`
	// InPlace runs the child read-only in WorkDir itself, which is not a git repository: no worktree is made.
	InPlace bool `json:"inPlace"`
}

// remoteSubagentParent is the parent session's claim as far as a remote child needs one, and the child's exec:
// approvals are filed under the parent's id (the server lets this runner, the run's target, file them), and the
// server's exec is the child's engine and mode. The parent's mode is the one the claim names, as it was at the claim:
// a read-only child's requests are answered by it (readonlySubagentAnswer), and the child's Plan gate reads it, as a
// local child's reads the parent's socket — this machine hosts no socket for the parent session. A server that does
// not name it leaves the child's own mode in its place.
func remoteSubagentParent(claim remoteSubagentClaim, cwd string) (AgentExecConfig, *ClaimedSession) {
	childExec := claim.Exec
	childExec.Env = map[string]string{}
	for k, v := range claim.Exec.Env {
		childExec.Env[k] = v
	}
	parentMode := firstNonEmpty(strings.TrimSpace(claim.ParentPermissionMode), strings.TrimSpace(childExec.PermissionMode))
	if parentMode != "" {
		childExec.Env[envSubagentRemoteMode] = parentMode
	}
	parent := &ClaimedSession{
		SessionID: claim.SessionID, Provider: childExec.Provider, Agent: childExec, WorkDir: cwd,
		WatchesDisabled: true, WikiDisabled: true,
	}
	parent.Agent.PermissionMode = parentMode
	return childExec, parent
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
	// trees are the worktree paths a hosted run works in: two resumes of one conversation would share one.
	trees map[string]bool
}

var remoteSubagents = &remoteSubagentHost{runs: map[string]*remoteSubagentTask{}, ending: map[string]bool{}, trees: map[string]bool{}}

// takeTree reserves a worktree path for a hosted run; false while another run works in it.
func (h *remoteSubagentHost) takeTree(tree string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.trees[tree] {
		return false
	}
	h.trees[tree] = true
	return true
}

func (h *remoteSubagentHost) releaseTree(tree string) {
	h.mu.Lock()
	delete(h.trees, tree)
	h.mu.Unlock()
}

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
// changed by a second report), keeping a conversation for a resume as an ended run's is. Ended runs' records are
// left as they are, and the ones past remoteSubagentKeep removed. Run once as the runner starts.
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
		rec, _ := readRemoteSubagentRecord(entry.Name())
		if rec.Ended {
			continue
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
			endRemoteSubagentRecord(dir, rec)
		}
	}
	gcRemoteSubagentConversations(time.Now())
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
	rec, _ := readRemoteSubagentRecord(claim.RunID)
	endRemoteSubagentRecord(remoteSubagentDir(claim.RunID), rec)
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
	scratch := filepath.Join(dir, "scratch")
	_ = os.MkdirAll(scratch, 0o700)
	// A new conversation runs in this run's own tree. A resume runs in the tree of the run that opened the
	// conversation, at the same path, which is where the engine finds it, and on that run's engine state. A run in
	// place has no tree: it works in workDir, which is never removed.
	rec := remoteSubagentRecord{RunID: claim.RunID, WorkDir: workDir, Tree: filepath.Join(dir, "tree"), StateDir: scratch, InPlace: claim.InPlace}
	if claim.InPlace {
		rec.Tree = ""
	}
	if claim.ResumeOf != "" {
		prev, ok := readRemoteSubagentRecord(claim.ResumeOf)
		if !ok || !prev.Ended || prev.EngineSession == "" {
			return fail("this runner no longer has the conversation of the SubAgent it was to continue (an ended one's is" +
				" kept for 7 days after its last run). Start a new SubAgent with the full brief instead.")
		}
		if prev.InPlace != claim.InPlace {
			return fail("its work directory has become or stopped being a git repository since that SubAgent ran, so its" +
				" conversation is not where the engine would look for it. Start a new SubAgent with the full brief instead.")
		}
		rec.Tree, rec.StateDir, rec.Engine, rec.EngineSession = prev.Tree, prev.StateDir, prev.Engine, prev.EngineSession
	}
	tree := rec.Tree
	cwd := tree
	// Two runs may not continue one conversation at once: its worktree, or for a run in place its engine state.
	busy := tree
	if claim.InPlace {
		cwd, busy = workDir, rec.StateDir
	}
	if !remoteSubagents.takeTree(busy) {
		return fail("another run is already continuing that SubAgent's conversation; resume it once that run has ended.")
	}
	defer remoteSubagents.releaseTree(busy)
	if claim.ResumeOf != "" && !claim.InPlace {
		// A worktree an earlier run of the conversation left behind, of the work dir it had then.
		if prev, ok := readRemoteSubagentRecord(claim.ResumeOf); ok {
			removeRemoteSubagentTree(firstNonEmpty(prev.WorkDir, workDir), tree)
		}
	}
	// Recorded before the worktree exists, so a crash while it is made still leaves the next start a record to clean.
	_ = writeJSONFile(filepath.Join(dir, "run.json"), rec)
	if claim.InPlace {
		if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
			return fail(fmt.Sprintf("the work directory %s of the workspace it was handed to does not exist on this machine.", workDir))
		}
	} else {
		if err := addRemoteSubagentTree(claim.RunID, workDir, tree); err != nil {
			return fail(err.Error())
		}
		defer removeRemoteSubagentTree(workDir, tree)
	}

	// The definition as the target workspace has it, read from the directory the child runs in.
	def, err := findSubagentDefinition(sessionSubagentDefinitions(cwd), claim.Type)
	if err != nil {
		return fail(err.Error())
	}
	if claim.InPlace {
		// Nothing discards what a run in place writes: it is read-only whatever the definition found here says.
		def.Readonly = true
	}
	childExec, parent := remoteSubagentParent(claim, cwd)
	engine := subagentEngine(childExec, parent)
	runChild, ok := subagentChildRunners[engine]
	if !ok {
		return fail(fmt.Sprintf("SubAgents cannot run on the %s engine on this runner.", engine))
	}
	prompt := claim.Prompt
	if claim.ResumeOf != "" {
		if rec.Engine != engine {
			return fail(fmt.Sprintf("its conversation is on %s, and this workspace now runs SubAgents on %s. Start a new"+
				" SubAgent with the full brief instead.", rec.Engine, engine))
		}
		if err := subagentResumeRefusal(&subagentRecord{RunID: claim.ResumeOf, Engine: rec.Engine, EngineSession: rec.EngineSession}); err != nil {
			return fail(err.Error())
		}
		if !claim.InPlace {
			head, _ := git(tree, "rev-parse", "--short", "HEAD")
			prompt = fmt.Sprintf("(From Orbit: you continue in a new worktree of this workspace at %s. The worktree you"+
				" worked in before was discarded when you ended, so anything you changed there is gone.)\n\n%s", head, prompt)
		}
	} else {
		rec.Engine = engine
		if engine == providerClaude {
			if rec.EngineSession, err = randomUUID(); err != nil {
				return fail(err.Error())
			}
		}
		_ = writeJSONFile(filepath.Join(dir, "run.json"), rec)
	}
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
		where := "in a worktree of"
		if claim.InPlace {
			where = "read-only in"
		}
		logln(fmt.Sprintf("remote SubAgent %s — running %s %s %s", claim.RunID, engine, where, workDir))
		var conversation string
		res, conversation, err = runChild(withSubagentApprovals(ctx, claim.RunID), subagentChild{
			t: t, parent: parent, exec: childExec, def: def, runID: claim.RunID, engineSession: rec.EngineSession,
			resume: claim.ResumeOf != "", cwd: cwd, scratch: scratch, stateDir: rec.StateDir, prompt: prompt,
			emit: relay.add, spawned: spawned,
		})
		if conversation != "" && conversation != rec.EngineSession {
			// The conversation the engine opened, which a resume continues.
			rec.EngineSession = conversation
			_ = writeJSONFile(filepath.Join(dir, "run.json"), rec)
		}
	}
	var changed []string
	if !claim.InPlace {
		changed = remoteSubagentTreeChanges(tree)
	}
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
	// A workflow's call is answered to its script (subagent_workflow.go), not as a background_task.
	if run.workflowID == "" && (answeredElsewhere || status == subagentStatusStopped || status == subagentStatusInterrupted) {
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
