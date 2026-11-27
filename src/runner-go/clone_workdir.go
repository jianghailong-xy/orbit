package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A workspace Orbit makes from a GitHub repository (POST /sessions newWorkspace.github,
// docs/github-workspace-design.md §6) is cloned here on request. Every full heartbeat answer lists each such
// workspace of this runner that is PENDING or CLONING (cloneRequests); the runner clones each one once, into a
// temporary directory beside its target that is renamed into place when the clone is whole, and says where it stands on
// the heartbeat (cloneReports) until the answer stops listing it.
//
//   - The target is held to home or the repos root, as a new folder is (cloneWorkDirTarget): <home>/<name> from a
//     control plane that reads clone-workdir/v2, <reposRoot>/<name> from an older one. Never home itself.
//   - A target that is already there is READY when it is a clone of the same repository, and FAILED
//     "<path> already exists on <machine>" otherwise: nothing is cloned over it.
//   - The clone is full (no --depth): landing and merge-base need the history.
//   - Its credential is the machine's own first, then Orbit's GitHub App token when that one could not
//     authenticate (github_credential.go). The report says which one cloned it.
//   - A clone whose progress output stops for cloneStallTimeout fails.
//   - A restart leaves a temporary directory behind: the first reconcile removes every one, and a clone the
//     control plane still lists as CLONING starts again.
const (
	cloneWorkDirCapabilityV1 = "clone-workdir/v1"
	// cloneWorkDirCapabilityV2: a clone may be named anywhere in home, not only in the repos root.
	cloneWorkDirCapabilityV2 = "clone-workdir/v2"
)

// cloneStallTimeout is how long a clone may go without progress output before it is stopped and fails.
var cloneStallTimeout = 30 * time.Minute

// cloneTempPrefix begins the name of a clone's temporary directory, made in the directory its target goes in.
const cloneTempPrefix = ".orbit-clone-"

// Clone states, as @orbit/shared spells them.
const (
	cloneStatePending = "PENDING"
	cloneStateCloning = "CLONING"
	cloneStateReady   = "READY"
	cloneStateFailed  = "FAILED"
)

// Which credential cloned a repository (CloneReport.credential).
const (
	cloneCredentialMachine   = "machine"
	cloneCredentialGithubApp = "github-app"
)

// CloneRequest mirrors @orbit/shared CloneRequest.
type CloneRequest struct {
	WorkspaceID string  `json:"workspaceId"`
	WorkDir     string  `json:"workDir"`
	URL         string  `json:"url"`
	Ref         *string `json:"ref"`
	State       string  `json:"state"`
}

// CloneReport mirrors @orbit/shared CloneReport.
type CloneReport struct {
	WorkspaceID string `json:"workspaceId"`
	State       string `json:"state"`
	Error       string `json:"error,omitempty"`
	Progress    *int   `json:"progress,omitempty"`
	Credential  string `json:"credential,omitempty"`
}

// cloneJob is one requested clone this process has started.
type cloneJob struct {
	request CloneRequest
	cancel  context.CancelFunc
	report  CloneReport
	done    bool
	// The beat that first carried the job's outcome; 0 until one has.
	reportedSeq uint64
}

// cloner runs the clones the heartbeat asks for and holds what the next beat reports about them.
type cloner struct {
	ctx     context.Context
	machine string
	// Called when a clone starts or ends: the work directory is probed again and the next beat sent now.
	changed func()

	mu    sync.Mutex
	jobs  map[string]*cloneJob
	seq   uint64
	swept bool
	wg    sync.WaitGroup
}

func newCloner(ctx context.Context, machine string, changed func()) *cloner {
	if changed == nil {
		changed = func() {}
	}
	return &cloner{ctx: ctx, machine: machine, changed: changed, jobs: map[string]*cloneJob{}}
}

// snapshot is what the next beat reports, and that beat's number, which the answer to it is reconciled against.
func (c *cloner) snapshot() ([]CloneReport, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	ids := make([]string, 0, len(c.jobs))
	for id := range c.jobs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	reports := make([]CloneReport, 0, len(ids))
	for _, id := range ids {
		job := c.jobs[id]
		report := job.report
		if report.Progress != nil {
			p := *report.Progress
			report.Progress = &p
		}
		if job.done && job.reportedSeq == 0 {
			job.reportedSeq = c.seq
		}
		reports = append(reports, report)
	}
	return reports, c.seq
}

// reconcile applies a full answer's cloneRequests, the answer to beat seq. Absent states nothing. A listed workspace
// this process has not started is started (unless start is false: the process is draining), one no longer listed is
// stopped and forgotten, and one listed PENDING again after the beat that carried its outcome was answered (a
// Retry) is started afresh.
func (c *cloner) reconcile(requests *[]CloneRequest, seq uint64, start bool) {
	if requests == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.swept {
		c.swept = true
		sweepCloneTemps()
	}
	listed := map[string]bool{}
	for _, request := range *requests {
		if request.WorkspaceID == "" || listed[request.WorkspaceID] {
			continue
		}
		listed[request.WorkspaceID] = true
		job := c.jobs[request.WorkspaceID]
		if job != nil && job.done && request.State == cloneStatePending && job.reportedSeq != 0 && job.reportedSeq <= seq {
			delete(c.jobs, request.WorkspaceID)
			job = nil
		}
		if job == nil && start {
			c.startLocked(request)
		}
	}
	for id, job := range c.jobs {
		if !listed[id] {
			job.cancel()
			delete(c.jobs, id)
		}
	}
}

func (c *cloner) startLocked(request CloneRequest) {
	ctx, cancel := context.WithCancel(c.ctx)
	job := &cloneJob{request: request, cancel: cancel, report: CloneReport{WorkspaceID: request.WorkspaceID, State: cloneStateCloning}}
	c.jobs[request.WorkspaceID] = job
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer cancel()
		c.changed()
		report := cloneWorkDir(ctx, request, c.machine, func(progress int) {
			c.mu.Lock()
			job.report.Progress = &progress
			c.mu.Unlock()
		})
		if ctx.Err() != nil {
			return // no longer asked for, or the runner is stopping: nothing to report
		}
		c.mu.Lock()
		job.report, job.done = report, true
		c.mu.Unlock()
		if report.State == cloneStateFailed {
			logln(fmt.Sprintf("workspace %s — clone of %s failed: %s", request.WorkspaceID, request.URL, report.Error))
		} else {
			logln(fmt.Sprintf("workspace %s — %s is ready at %s (%s credential)", request.WorkspaceID, request.URL, request.WorkDir, firstNonEmpty(report.Credential, "existing")))
		}
		c.changed()
	}()
}

// wait is for tests: every clone this cloner started has ended.
func (c *cloner) wait() { c.wg.Wait() }

// cloneWorkDirTarget is the directory a clone lands in, symlinks resolved, held where a new folder is made
// (orbitWorkDirTarget): inside home, or inside the repos root where an older control plane names it.
func cloneWorkDirTarget(dir string) (string, error) {
	return orbitWorkDirTarget(dir)
}

// cloneWorkDir clones request's repository into its work directory and answers where that leaves it.
func cloneWorkDir(ctx context.Context, request CloneRequest, machine string, progress func(int)) CloneReport {
	failed := func(why string) CloneReport {
		return CloneReport{WorkspaceID: request.WorkspaceID, State: cloneStateFailed, Error: why}
	}
	target, err := cloneWorkDirTarget(request.WorkDir)
	if err != nil {
		return failed(fmt.Sprintf("Orbit cannot clone into %s: %v.", request.WorkDir, err))
	}
	if _, err := os.Lstat(target); err == nil {
		if !cloneOfSameRepository(target, request.URL) {
			return failed(fmt.Sprintf("%s already exists on %s", request.WorkDir, machine))
		}
		_ = markGithubWorkspace(target, request.WorkspaceID)
		return CloneReport{WorkspaceID: request.WorkspaceID, State: cloneStateReady}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return failed(fmt.Sprintf("Orbit cannot read %s: %v.", request.WorkDir, err))
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return failed(fmt.Sprintf("Orbit cannot create %s: %v.", parent, err))
	}
	temp := filepath.Join(parent, cloneTempPrefix+request.WorkspaceID)
	_ = os.RemoveAll(temp)
	defer os.RemoveAll(temp)

	credential := cloneCredentialMachine
	err = runClone(ctx, parent, temp, request, nil, progress)
	if errors.Is(err, errGitAuthFailed) && ctx.Err() == nil {
		path, ok := githubRepoPath(request.URL)
		if !ok {
			return failed(fmt.Sprintf("The machine's Git credential could not clone %s, and Orbit holds credentials for github.com only.", request.URL))
		}
		orbit, askErr := askOrbitGitCredential(request.WorkspaceID, path)
		if askErr != nil {
			return failed(fmt.Sprintf("GitHub refused to clone %s with this machine's credential, and Orbit could not get one: %v", path, askErr))
		}
		_ = os.RemoveAll(temp)
		credential = cloneCredentialGithubApp
		err = runClone(ctx, parent, temp, request, orbit, progress)
	}
	if err != nil {
		return failed(err.Error())
	}
	if err := markGithubWorkspace(temp, request.WorkspaceID); err != nil {
		return failed(fmt.Sprintf("Orbit cannot mark the clone as this workspace's: %v.", err))
	}
	if err := os.Rename(temp, target); err != nil {
		if _, statErr := os.Lstat(target); statErr == nil {
			return failed(fmt.Sprintf("%s already exists on %s", request.WorkDir, machine))
		}
		return failed(fmt.Sprintf("Orbit cannot move the clone into %s: %v.", request.WorkDir, err))
	}
	done := 100
	return CloneReport{WorkspaceID: request.WorkspaceID, State: cloneStateReady, Progress: &done, Credential: credential}
}

// cloneOfSameRepository reports whether dir is the top of a checkout whose origin is url.
func cloneOfSameRepository(dir, url string) bool {
	top, err := git(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return false
	}
	resolvedTop, err1 := filepath.EvalSymlinks(top)
	resolvedDir, err2 := filepath.EvalSymlinks(dir)
	if err1 != nil || err2 != nil || resolvedTop != resolvedDir {
		return false
	}
	origin, err := git(dir, "remote", "get-url", "origin")
	if err != nil {
		return false
	}
	if a, ok := githubRepoPath(origin); ok {
		b, ok := githubRepoPath(url)
		return ok && a == b
	}
	return strings.TrimSuffix(strings.TrimSpace(origin), "/") == strings.TrimSuffix(strings.TrimSpace(url), "/")
}

// cloneProgressPattern reads git's progress lines: receiving is the first nine tenths, resolving deltas the last.
var cloneProgressPattern = regexp.MustCompile(`(Receiving objects|Resolving deltas):\s+(\d{1,3})%`)

// runClone is one `git clone` of request into temp, run from parent, with Orbit's credential when credential is
// set. It is stopped when ctx ends or its output stops for cloneStallTimeout.
func runClone(ctx context.Context, parent, temp string, request CloneRequest, credential *orbitGitCredential, progress func(int)) error {
	args := []string{"clone", "--origin", "origin", "--progress"}
	if request.Ref != nil && *request.Ref != "" {
		args = append(args, "--branch", *request.Ref)
	}
	args = append(args, "--", request.URL, temp)

	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	cmd := exec.CommandContext(runCtx, "git", networkGitArgsWith(parent, credential, args)...)
	cmd.Env = networkGitCommandEnv(credential)
	cmd.Cancel = func() error { return interruptGit(cmd.Process) }
	cmd.WaitDelay = networkGitWaitDelay
	var stalled atomic.Bool
	stall := time.AfterFunc(cloneStallTimeout, func() {
		stalled.Store(true)
		stop()
	})
	defer stall.Stop()
	output := &cloneOutput{progress: progress, last: -1, wrote: func() { stall.Reset(cloneStallTimeout) }}
	// A writer rather than a pipe read here, so that WaitDelay ends the wait even while a process git started
	// (git-remote-https) still holds the stream open.
	cmd.Stderr = output
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil
	}
	if stalled.Load() {
		return fmt.Errorf("git clone made no progress for %s and was stopped", cloneStallTimeout)
	}
	if err == nil {
		return nil
	}
	said := output.lines()
	text := strings.Join(said, "\n")
	if failure := gitAuthFailure(text); failure != nil {
		return failure
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("git clone failed: %s", clip(firstNonEmpty(text, err.Error()), 1000))
}

// cloneOutput reads git clone's stderr as it is written: its progress lines, which end in a carriage return, go to
// progress as one overall percentage (receiving is the first nine tenths, resolving deltas the last), and the last
// lines of everything else are kept for the error.
type cloneOutput struct {
	progress func(int)
	wrote    func()

	mu      sync.Mutex
	partial []byte
	said    []string
	last    int
}

func (o *cloneOutput) Write(p []byte) (int, error) {
	o.wrote()
	o.mu.Lock()
	defer o.mu.Unlock()
	o.partial = append(o.partial, p...)
	for {
		i := bytes.IndexAny(o.partial, "\r\n")
		if i < 0 {
			break
		}
		o.line(strings.TrimSpace(string(o.partial[:i])))
		o.partial = o.partial[i+1:]
	}
	return len(p), nil
}

func (o *cloneOutput) line(line string) {
	if line == "" {
		return
	}
	if m := cloneProgressPattern.FindStringSubmatch(line); m != nil {
		p, _ := strconv.Atoi(m[2])
		p = min(p, 100)
		overall := p * 9 / 10
		if m[1] == "Resolving deltas" {
			overall = 90 + p/10
		}
		if overall != o.last {
			o.last = overall
			o.progress(overall)
		}
		return
	}
	o.said = append(o.said, line)
	if len(o.said) > 20 {
		o.said = o.said[1:]
	}
}

func (o *cloneOutput) lines() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.line(strings.TrimSpace(string(o.partial)))
	o.partial = nil
	return append([]string(nil), o.said...)
}

// sweepCloneTemps removes every clone's temporary directory from home and the repos root, where clones are named: a
// process that stopped mid-clone left it, and its clone starts again from nothing.
func sweepCloneTemps() {
	swept := map[string]bool{}
	for _, root := range []string{userHome(), reposRoot()} {
		if root == "" {
			continue
		}
		resolved, err := filepath.EvalSymlinks(root)
		if err != nil || swept[resolved] {
			continue
		}
		swept[resolved] = true
		sweepCloneTempsIn(resolved)
	}
}

func sweepCloneTempsIn(resolved string) {
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), cloneTempPrefix) {
			path := filepath.Join(resolved, entry.Name())
			if err := os.RemoveAll(path); err != nil {
				logln(fmt.Sprintf("cannot remove the unfinished clone %s: %v", path, err))
			} else {
				logln(fmt.Sprintf("removed the unfinished clone %s", path))
			}
		}
	}
}
