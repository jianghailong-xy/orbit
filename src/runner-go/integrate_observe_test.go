package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// OBSERVE_LANDING against real repositories (docs/project-integration-line-contract.md §10.6, O-S1 to
// O-S3; §10.9 item 7): whether a delivered commit is on the upstream and on the integration line is
// git's answer to `merge-base --is-ancestor`, so real commits are what these cases are made of. The
// job only reads — every case that runs one also holds it to that: no ref on the origin moves, no
// worktree is staged and no check runs.

// observeCommand is an OBSERVE_LANDING as the control plane hands it out: the integration line as both
// target and source, its upstream, and the tasks the claim found waiting to be observed.
func (r *integrationRepo) observeCommand(line string, tasks ...IntegrationObserveTask) IntegrationJobCommand {
	return IntegrationJobCommand{
		JobID:        strings.ReplaceAll(r.t.Name(), "/", "-"),
		Kind:         "OBSERVE_LANDING",
		WorkDir:      r.work,
		RemoteName:   "origin",
		RefAuthority: "REMOTE",
		TargetRef:    "refs/heads/" + line,
		UpstreamRef:  "refs/heads/main",
		SourceRef:    "refs/heads/" + line,
		Checks:       []IntegrationCheckSpec{},
		ObserveTasks: tasks,
		scratchRoot:  r.scratch,
	}
}

// observed runs one observation and holds it to what O-S2 says it must not do: it pushes nothing,
// stages no worktree and runs no check (the command carries one that would leave a marker).
func observed(t *testing.T, r *integrationRepo, cmd IntegrationJobCommand) integrationResult {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "a check ran")
	cmd.Checks = append(cmd.Checks, IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: "touch '" + marker + "'", ExpectedExitCode: 0, TimeoutSeconds: 60,
	})
	refsBefore, _ := git(r.origin, "for-each-ref", "--format=%(refname) %(objectname)")
	worktreesBefore, _ := git(r.work, "worktree", "list", "--porcelain")
	result := runIntegrationJob(cmd, silent)
	if refsAfter, _ := git(r.origin, "for-each-ref", "--format=%(refname) %(objectname)"); refsAfter != refsBefore {
		t.Fatalf("an observation moved the origin's refs:\nbefore %s\nafter  %s", refsBefore, refsAfter)
	}
	if worktreesAfter, _ := git(r.work, "worktree", "list", "--porcelain"); worktreesAfter != worktreesBefore {
		t.Fatalf("an observation changed the checkout's worktrees:\nbefore %s\nafter  %s", worktreesBefore, worktreesAfter)
	}
	if _, err := os.Stat(r.scratchPath(cmd.JobID)); !os.IsNotExist(err) {
		t.Fatalf("an observation staged a scratch worktree (%v)", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("an observation ran a check")
	}
	return result
}

// observationOf is the one observation of a task, or a failure naming what came back instead.
func observationOf(t *testing.T, result integrationResult, taskID string) IntegrationObservation {
	t.Helper()
	if result.State != "OBSERVED" || result.Phase != "OBSERVE" {
		t.Fatalf("result = %s %s (%s %v), want OBSERVED in OBSERVE", result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
	}
	for _, o := range result.Observations {
		if o.TaskID == taskID {
			return o
		}
	}
	t.Fatalf("no observation of %s in %+v", taskID, result.Observations)
	return IntegrationObservation{}
}

func boolIs(got *bool, want bool) bool { return got != nil && *got == want }

func describe(p *bool) string {
	if p == nil {
		return "null"
	}
	if *p {
		return "true"
	}
	return "false"
}

// TestObserveLandingAnswersAncestryOnBothTips is O-S2's two questions on a PROJECT_BRANCH line: work
// an agent pushed to the upstream from another machine is on the upstream and not on the line, work
// landed on the line is on the line and not on the upstream, and work that went nowhere is on
// neither. Both tips moved on another machine, so they are the origin's as this job's own fetch read
// them, not whatever this checkout last saw.
func TestObserveLandingAnswersAncestryOnBothTips(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	r.checkoutNew("project/p", "main")
	r.push("project/p")
	r.checkout("main")

	// Pushed straight to the upstream from the machine the agent ran on (§10.1), and landed on the
	// line by another runner: this checkout has neither commit until the observation fetches.
	other := r.anotherMachine()
	other.write("pushed.txt", "pushed to main by the agent\n")
	pushed := other.commit("task pushed to main")
	other.push("main")
	other.checkoutNew("project/p", "origin/project/p")
	other.write("landed.txt", "landed on the line\n")
	landed := other.commit("task landed on the line")
	other.push("project/p")

	r.checkoutNew("orbit/task-nowhere", base)
	r.write("nowhere.txt", "never pushed\n")
	nowhere := r.commit("task that went nowhere")
	r.checkout("main")

	result := observed(t, r, r.observeCommand("project/p",
		IntegrationObserveTask{TaskID: "pushed", DeliveredSha: pushed, BaseSha: base},
		IntegrationObserveTask{TaskID: "landed", DeliveredSha: landed, BaseSha: base},
		IntegrationObserveTask{TaskID: "nowhere", DeliveredSha: nowhere, BaseSha: base},
	))
	if result.UpstreamSha != pushed {
		t.Fatalf("upstreamSha = %s, want the origin's main %s", result.UpstreamSha, pushed)
	}
	if result.TargetShaBefore != landed {
		t.Fatalf("targetShaBefore = %s, want the origin's line %s", result.TargetShaBefore, landed)
	}
	if len(result.Observations) != 3 {
		t.Fatalf("observations = %+v, want one per task", result.Observations)
	}
	for _, c := range []struct {
		task               string
		onUpstream, onLine bool
		fullyApplied       bool
	}{
		// On the upstream as itself: git cherry has no line to print, and every change is there.
		{"pushed", true, false, true},
		{"landed", false, true, false},
		{"nowhere", false, false, false},
	} {
		o := observationOf(t, result, c.task)
		if o.OnUpstream != c.onUpstream || !boolIs(o.OnIntegrationLine, c.onLine) {
			t.Errorf("%s: onUpstream = %v, onIntegrationLine = %s, want %v and %v",
				c.task, o.OnUpstream, describe(o.OnIntegrationLine), c.onUpstream, c.onLine)
		}
		if o.Empty {
			t.Errorf("%s: empty = true for a branch with a commit of its own", c.task)
		}
		if !boolIs(o.FullyApplied, c.fullyApplied) {
			t.Errorf("%s: fullyApplied = %s, want %v", c.task, describe(o.FullyApplied), c.fullyApplied)
		}
		if o.BaseSha == nil || *o.BaseSha != base {
			t.Errorf("%s: baseSha = %v, want the base it was asked about echoed", c.task, o.BaseSha)
		}
	}
}

// TestObserveLandingOnAMainLineAsksOneQuestion: on a MAIN line the integration line IS the upstream,
// so T = U and onIntegrationLine stays null (§10.4) — there is no second tip to measure against.
func TestObserveLandingOnAMainLineAsksOneQuestion(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	other := r.anotherMachine()
	other.write("pushed.txt", "pushed to main by the agent\n")
	pushed := other.commit("task pushed to main")
	other.push("main")

	result := observed(t, r, r.observeCommand("main",
		IntegrationObserveTask{TaskID: "pushed", DeliveredSha: pushed, BaseSha: base}))
	o := observationOf(t, result, "pushed")
	if !o.OnUpstream {
		t.Fatal("onUpstream = false for a commit the origin's main holds")
	}
	if o.OnIntegrationLine != nil {
		t.Fatalf("onIntegrationLine = %s on a MAIN line, want null", describe(o.OnIntegrationLine))
	}
	if result.UpstreamSha != pushed || result.TargetShaBefore != pushed {
		t.Fatalf("upstreamSha = %s, targetShaBefore = %s, want both the upstream tip %s",
			result.UpstreamSha, result.TargetShaBefore, pushed)
	}
}

// TestObserveLandingSeesAnEmptyBranch: a task whose delivered commit is its base made nothing of its
// own (O-L7). empty says so wherever that base is — on the upstream, or on the line only — and
// fullyApplied is false, as J-S3 answers the same branch: nothing of it was applied anywhere.
func TestObserveLandingSeesAnEmptyBranch(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	r.checkoutNew("project/p", "main")
	r.write("line.txt", "on the line\n")
	lineTip := r.commit("earlier work on the line")
	r.push("project/p")
	r.checkout("main")

	result := observed(t, r, r.observeCommand("project/p",
		IntegrationObserveTask{TaskID: "forked-from-main", DeliveredSha: base, BaseSha: base},
		IntegrationObserveTask{TaskID: "forked-from-the-line", DeliveredSha: lineTip, BaseSha: lineTip},
	))
	for _, c := range []struct {
		task               string
		onUpstream, onLine bool
	}{
		{"forked-from-main", true, true},
		{"forked-from-the-line", false, true},
	} {
		o := observationOf(t, result, c.task)
		if !o.Empty {
			t.Errorf("%s: empty = false for a delivered commit that is its own base", c.task)
		}
		if !boolIs(o.FullyApplied, false) {
			t.Errorf("%s: fullyApplied = %s, want false for a branch with no commit of its own", c.task, describe(o.FullyApplied))
		}
		if o.OnUpstream != c.onUpstream || !boolIs(o.OnIntegrationLine, c.onLine) {
			t.Errorf("%s: onUpstream = %v, onIntegrationLine = %s, want %v and %v",
				c.task, o.OnUpstream, describe(o.OnIntegrationLine), c.onUpstream, c.onLine)
		}
	}
}

// TestObserveLandingOfACommitOnlyAnotherMachineHas: the agent committed on its own machine and never
// pushed. This runner has no such object, and that is not a failure of the job: a commit on no line
// may well exist only where it was made, so both answers read false (O-S2), and fullyApplied — the
// one that needs base..delivered here — is null.
func TestObserveLandingOfACommitOnlyAnotherMachineHas(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	r.checkoutNew("project/p", "main")
	r.push("project/p")
	r.checkout("main")
	other := r.anotherMachine()
	other.checkoutNew("orbit/task-elsewhere", "main")
	other.write("elsewhere.txt", "only on the other machine\n")
	elsewhere := other.commit("task work never pushed")

	result := observed(t, r, r.observeCommand("project/p",
		IntegrationObserveTask{TaskID: "elsewhere", DeliveredSha: elsewhere, BaseSha: base}))
	o := observationOf(t, result, "elsewhere")
	if o.OnUpstream || !boolIs(o.OnIntegrationLine, false) || o.Empty {
		t.Fatalf("observation = onUpstream %v, onIntegrationLine %s, empty %v; want false, false, false",
			o.OnUpstream, describe(o.OnIntegrationLine), o.Empty)
	}
	if o.FullyApplied != nil {
		t.Fatalf("fullyApplied = %s for a range this machine does not have, want null", describe(o.FullyApplied))
	}
	if _, err := git(r.work, "cat-file", "-e", elsewhere+"^{commit}"); err == nil {
		t.Fatal("this checkout has the other machine's commit: the case did not test what it says")
	}
}

// TestObserveLandingReadsGitCherry: the work reached the upstream as other commits — cherry-picked,
// or rebased — so the delivered commit is not on it, and git cherry is what tells "every change is
// there" from "some are" (O-S2, O-R4's APPLIED_AS_OTHER_COMMITS).
func TestObserveLandingReadsGitCherry(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	r.checkoutNew("orbit/task-all", base)
	r.write("all-1.txt", "first\n")
	allFirst := r.commit("all: first")
	r.write("all-2.txt", "second\n")
	allDelivered := r.commit("all: second")
	r.checkoutNew("orbit/task-some", base)
	r.write("some-1.txt", "first\n")
	someFirst := r.commit("some: first")
	r.write("some-2.txt", "second\n")
	someDelivered := r.commit("some: second")

	// The upstream moves first, so a cherry-pick is a new commit rather than the same one again.
	r.checkout("main")
	r.write("upstream.txt", "moved on\n")
	r.commit("main moved")
	mustRun(t, r.work, "git", "cherry-pick", allFirst, allDelivered, someFirst)
	r.push("main")

	result := observed(t, r, r.observeCommand("main",
		IntegrationObserveTask{TaskID: "all", DeliveredSha: allDelivered, BaseSha: base},
		IntegrationObserveTask{TaskID: "some", DeliveredSha: someDelivered, BaseSha: base},
	))
	for _, c := range []struct {
		task         string
		fullyApplied bool
	}{{"all", true}, {"some", false}} {
		o := observationOf(t, result, c.task)
		if o.OnUpstream {
			t.Errorf("%s: onUpstream = true, but only copies of its commits are on main", c.task)
		}
		if !boolIs(o.FullyApplied, c.fullyApplied) {
			t.Errorf("%s: fullyApplied = %s, want %v", c.task, describe(o.FullyApplied), c.fullyApplied)
		}
	}
}

// TestObserveLandingAnswersAFetchThatGotNowhere is O-S1's two failures (§10.9 item 7): a remote that
// cannot be reached is FETCH_FAILED, and an upstream the remote does not have is BASE_REF_NOT_FOUND —
// the code that sends a reader to look at the branch, so it is given only when that is the problem.
// A project branch the remote does not have yet is neither: the line starts where the upstream is.
func TestObserveLandingAnswersAFetchThatGotNowhere(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	task := IntegrationObserveTask{TaskID: "task", DeliveredSha: base, BaseSha: base}

	t.Run("the remote cannot be reached", func(t *testing.T) {
		mustRun(t, r.work, "git", "remote", "add", "nowhere", filepath.Join(t.TempDir(), "no-such-repository"))
		cmd := r.observeCommand("main", task)
		cmd.RemoteName = "nowhere"
		result := observed(t, r, cmd)
		if result.State != "ERROR" || result.Phase != "FETCH" || result.ErrorCode != "FETCH_FAILED" {
			t.Fatalf("result = %s %s (%s %v), want ERROR FETCH FETCH_FAILED", result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
		}
		if len(result.Observations) != 0 {
			t.Fatalf("a failed fetch observed %+v", result.Observations)
		}
	})
	t.Run("the upstream does not exist", func(t *testing.T) {
		cmd := r.observeCommand("main", task)
		cmd.UpstreamRef = "refs/heads/no-such-branch"
		cmd.TargetRef, cmd.SourceRef = cmd.UpstreamRef, cmd.UpstreamRef
		result := observed(t, r, cmd)
		if result.State != "ERROR" || result.Phase != "FETCH" || result.ErrorCode != "BASE_REF_NOT_FOUND" {
			t.Fatalf("result = %s %s (%s %v), want ERROR FETCH BASE_REF_NOT_FOUND", result.State, result.Phase, result.ErrorCode, result.ErrorDetail)
		}
		if ref, _ := result.ErrorDetail["ref"].(string); ref != "refs/heads/no-such-branch" {
			t.Fatalf("errorDetail = %v, want it to name the upstream", result.ErrorDetail)
		}
	})
	t.Run("a project branch nothing has landed on yet", func(t *testing.T) {
		result := observed(t, r, r.observeCommand("project/never-pushed", task))
		o := observationOf(t, result, "task")
		if result.TargetShaBefore != result.UpstreamSha || result.UpstreamSha != base {
			t.Fatalf("targetShaBefore = %s, upstreamSha = %s, want the line read as the upstream %s",
				result.TargetShaBefore, result.UpstreamSha, base)
		}
		if !o.OnUpstream || !boolIs(o.OnIntegrationLine, true) {
			t.Fatalf("onUpstream = %v, onIntegrationLine = %s, want both true", o.OnUpstream, describe(o.OnIntegrationLine))
		}
	})
}

// TestObserveLandingRetriesARefLockAsEveryFetchDoes: the fetch is fetchRetryingRefLock's, so a
// remote-tracking ref another process is updating is waited out rather than reported — and one held
// past every retry is FETCH_FAILED, never BASE_REF_NOT_FOUND (the 2026-10-02 lesson, integrationFetch).
// Not parallel: the pause between attempts is a package variable.
func TestObserveLandingRetriesARefLockAsEveryFetchDoes(t *testing.T) {
	t.Run("released while the fetch waits", func(t *testing.T) {
		r := newIntegrationRepo(t)
		moved := moveOriginMainAhead(t, r)
		releaseRefLockOnFirstRetry(t, holdRefLock(t, r, "main"))
		result := observed(t, r, r.observeCommand("main",
			IntegrationObserveTask{TaskID: "moved", DeliveredSha: moved, BaseSha: r.rev("main")}))
		if o := observationOf(t, result, "moved"); !o.OnUpstream {
			t.Fatal("onUpstream = false after the retried fetch brought the commit")
		}
	})
	t.Run("held past every retry", func(t *testing.T) {
		r := newIntegrationRepo(t)
		moveOriginMainAhead(t, r)
		lock := holdRefLock(t, r, "main")
		restore := integrationFetchLockPause
		integrationFetchLockPause = func(time.Duration) {}
		t.Cleanup(func() {
			integrationFetchLockPause = restore
			_ = os.Remove(lock)
		})
		result := observed(t, r, r.observeCommand("main",
			IntegrationObserveTask{TaskID: "t", DeliveredSha: r.rev("main"), BaseSha: r.rev("main")}))
		if result.State != "ERROR" || result.ErrorCode != "FETCH_FAILED" {
			t.Fatalf("result = %s (%s %v), want ERROR FETCH_FAILED for a lock another process held", result.State, result.ErrorCode, result.ErrorDetail)
		}
	})
}

// TestObserveLandingUnderARunnerLocalAuthorityFetchesNothing: when this machine is the authority the
// refs are its own, as for every other job (integrationTip), and the remote is not asked at all.
func TestObserveLandingUnderARunnerLocalAuthorityFetchesNothing(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	base := r.rev("main")
	r.checkoutNew("project/p", "main")
	r.write("landed.txt", "landed on the line\n")
	landed := r.commit("task landed on the line")
	r.checkout("main")
	mustRun(t, r.work, "git", "remote", "set-url", "origin", filepath.Join(t.TempDir(), "gone"))

	cmd := r.observeCommand("project/p", IntegrationObserveTask{TaskID: "landed", DeliveredSha: landed, BaseSha: base})
	cmd.RefAuthority = "RUNNER_LOCAL"
	result := observed(t, r, cmd)
	o := observationOf(t, result, "landed")
	if result.UpstreamSha != base || result.TargetShaBefore != landed {
		t.Fatalf("upstreamSha = %s, targetShaBefore = %s, want the local tips %s and %s", result.UpstreamSha, result.TargetShaBefore, base, landed)
	}
	if o.OnUpstream || !boolIs(o.OnIntegrationLine, true) {
		t.Fatalf("onUpstream = %v, onIntegrationLine = %s, want false and true", o.OnUpstream, describe(o.OnIntegrationLine))
	}
}

// observeControlPlane answers an observation's progress, result and release calls, and keeps each
// result as the bytes that arrived: a null the struct would decode the same as an absent key.
type observeControlPlane struct {
	mu       sync.Mutex
	reports  []IntegrationJobProgressRequest
	results  [][]byte
	releases int
	// answer decides the answer to a progress report. Nil accepts it and asks nothing.
	answer func(req IntegrationJobProgressRequest) (status int, payload string)
}

func (cp *observeControlPlane) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cp.mu.Lock()
		defer cp.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/progress"):
			var req IntegrationJobProgressRequest
			_ = json.Unmarshal(body, &req)
			cp.reports = append(cp.reports, req)
			status, payload := http.StatusOK, `{"accepted":true,"cancelRequested":false}`
			if cp.answer != nil {
				status, payload = cp.answer(req)
			}
			w.WriteHeader(status)
			_, _ = w.Write([]byte(payload))
		case strings.HasSuffix(r.URL.Path, "/release"):
			cp.releases++
			_, _ = w.Write([]byte(`{"released":true,"state":"QUEUED"}`))
		case strings.HasSuffix(r.URL.Path, "/result"):
			cp.results = append(cp.results, body)
			var req IntegrationJobResultRequest
			_ = json.Unmarshal(body, &req)
			_, _ = w.Write([]byte(`{"accepted":true,"state":"` + req.State + `","receiptIds":[],"openItemId":null}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (cp *observeControlPlane) snapshot() (reports []IntegrationJobProgressRequest, results [][]byte, releases int) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]IntegrationJobProgressRequest(nil), cp.reports...), append([][]byte(nil), cp.results...), cp.releases
}

// waitForStep waits for a report naming a sub-step, so a case asserts on what was sent rather than on
// how fast the machine happened to be.
func (cp *observeControlPlane) waitForStep(t *testing.T, step string) IntegrationJobProgressRequest {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		reports, _, _ := cp.snapshot()
		for _, report := range reports {
			if report.Step == step {
				return report
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no progress report ever named %s", step)
	return IntegrationJobProgressRequest{}
}

// v2Observe is an observation claimed by a runner that declared integration-progress/v2.
func v2Observe(r *integrationRepo, line string, tasks ...IntegrationObserveTask) IntegrationJobCommand {
	job := r.observeCommand(line, tasks...)
	job.ReportBeforePush = true
	job.ClaimGeneration = "1"
	job.LeaseOwner = "the-process"
	job.progressEvery = 20 * time.Millisecond
	return job
}

// TestObserveLandingReportsTheContractShape is O-S3 on the wire: state OBSERVED, both tips, and an
// observation per task with the seven keys §10.4 names — the two that can be unknown sent as null —
// after v2 progress reports that name the two phases the job passes through. The ticker is slowed
// out of the way, so the reports are the step boundaries alone and arrive in the order they were made.
func TestObserveLandingReportsTheContractShape(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	base := r.rev("main")
	other := r.anotherMachine()
	other.write("pushed.txt", "pushed to main by the agent\n")
	pushed := other.commit("task pushed to main")
	other.push("main")
	other.checkoutNew("orbit/task-elsewhere", base)
	other.write("elsewhere.txt", "only on the other machine\n")
	elsewhere := other.commit("never pushed")

	job := v2Observe(r, "main",
		IntegrationObserveTask{TaskID: "pushed", DeliveredSha: pushed, BaseSha: base},
		IntegrationObserveTask{TaskID: "elsewhere", DeliveredSha: elsewhere, BaseSha: ""},
	)
	job.progressEvery = time.Hour
	cp := &observeControlPlane{}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)

	reports, results, releases := cp.snapshot()
	if len(results) != 1 || releases != 0 {
		t.Fatalf("results = %q, releases = %d, want one result and no release", results, releases)
	}
	var phases []string
	for _, report := range reports {
		if report.ClaimGeneration != "1" || report.LeaseOwner != "the-process" {
			t.Fatalf("a report left the claim fence out: %+v", report)
		}
		if len(phases) == 0 || phases[len(phases)-1] != report.Phase {
			phases = append(phases, report.Phase)
		}
	}
	if strings.Join(phases, ",") != "FETCH,OBSERVE" {
		t.Fatalf("phases reported = %v, want FETCH then OBSERVE", phases)
	}

	raw := results[0]
	var wire struct {
		ClaimGeneration string                       `json:"claimGeneration"`
		LeaseOwner      string                       `json:"leaseOwner"`
		State           string                       `json:"state"`
		Phase           string                       `json:"phase"`
		UpstreamSha     string                       `json:"upstreamSha"`
		TargetShaBefore string                       `json:"targetShaBefore"`
		Observations    []map[string]json.RawMessage `json:"observations"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("result body %s: %v", raw, err)
	}
	if wire.State != "OBSERVED" || wire.Phase != "OBSERVE" || wire.ClaimGeneration != "1" || wire.LeaseOwner != "the-process" {
		t.Fatalf("result = %s", raw)
	}
	if wire.UpstreamSha != pushed || wire.TargetShaBefore != pushed {
		t.Fatalf("upstreamSha = %s, targetShaBefore = %s, want both %s on a MAIN line", wire.UpstreamSha, wire.TargetShaBefore, pushed)
	}
	want := []map[string]string{
		{"taskId": `"pushed"`, "deliveredSha": `"` + pushed + `"`, "baseSha": `"` + base + `"`,
			"onUpstream": "true", "onIntegrationLine": "null", "empty": "false", "fullyApplied": "true"},
		{"taskId": `"elsewhere"`, "deliveredSha": `"` + elsewhere + `"`, "baseSha": "null",
			"onUpstream": "false", "onIntegrationLine": "null", "empty": "false", "fullyApplied": "null"},
	}
	if len(wire.Observations) != len(want) {
		t.Fatalf("observations = %s, want %d in the command's order", raw, len(want))
	}
	for i, keys := range want {
		if len(wire.Observations[i]) != len(keys) {
			t.Errorf("observation %d has keys %v, want exactly %v", i, wire.Observations[i], keys)
		}
		for key, value := range keys {
			if got := string(wire.Observations[i][key]); got != value {
				t.Errorf("observation %d %s = %s, want %s", i, key, got, value)
			}
		}
	}
	for _, key := range []string{`"sourceSha"`, `"testedSha"`, `"landedSha"`, `"checks"`} {
		if strings.Contains(string(raw), key) {
			t.Errorf("an observation's result carries %s: %s", key, raw)
		}
	}
}

// TestObserveLandingWithNoTaskSaysSoWithAnEmptyList: the claim found nothing waiting by the time it
// was made. The answer is still an observation, with a list that is empty rather than absent.
func TestObserveLandingWithNoTaskSaysSoWithAnEmptyList(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	cp := &observeControlPlane{}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), v2Observe(r, "main"))
	_, results, _ := cp.snapshot()
	if len(results) != 1 || !strings.Contains(string(results[0]), `"state":"OBSERVED"`) ||
		!strings.Contains(string(results[0]), `"observations":[]`) {
		t.Fatalf("results = %q, want one OBSERVED carrying \"observations\":[]", results)
	}
}

// TestObserveLandingFollowsTheStopProtocol: an observation is stopped the way every v2 claim is
// (§2.2 J-T4, J-T11, J-T12). A cancellation read off a progress answer is answered CANCELLED, a claim
// that is no longer this process's is reported to nobody, and a runner that stops while the job waits
// for this machine's lock hands it back.
func TestObserveLandingFollowsTheStopProtocol(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		answer  string
		results int
	}{
		{"cancelRequested", http.StatusOK, `{"accepted":true,"cancelRequested":true}`, 1},
		{"409 STALE_CLAIM", http.StatusConflict, `{"code":"STALE_CLAIM"}`, 0},
		{"404", http.StatusNotFound, `{"code":"NOT_FOUND"}`, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			fastIntegrationResultRetry(t)
			r := newIntegrationRepo(t)
			base := r.rev("main")
			cp := &observeControlPlane{}
			cp.answer = func(req IntegrationJobProgressRequest) (int, string) {
				if req.Phase == "OBSERVE" {
					return c.status, c.answer
				}
				return http.StatusOK, `{"accepted":true,"cancelRequested":false}`
			}
			srv := cp.serve(t)
			job := v2Observe(r, "main", IntegrationObserveTask{TaskID: "t", DeliveredSha: base, BaseSha: base})
			runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)
			_, results, releases := cp.snapshot()
			if releases != 0 || len(results) != c.results {
				t.Fatalf("results = %q, releases = %d, want %d result(s) and no release", results, releases, c.results)
			}
			if c.results > 0 {
				var result IntegrationJobResultRequest
				if err := json.Unmarshal(results[0], &result); err != nil {
					t.Fatalf("result %s: %v", results[0], err)
				}
				if result.State != "CANCELLED" || result.Phase != "OBSERVE" || result.Observations != nil {
					t.Fatalf("result = %s, want CANCELLED in OBSERVE with no observation", results[0])
				}
			}
		})
	}

	t.Run("the runner stops while the job waits for the lock", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		fastIntegrationResultRetry(t)
		r := newIntegrationRepo(t)
		job := v2Observe(r, "main")
		root, err := git(r.work, "rev-parse", "--show-toplevel")
		if err != nil {
			t.Fatalf("rev-parse: %v", err)
		}
		held := integrationLock(root, integrationLockRef(job))
		held.Lock()
		defer held.Unlock()
		cp := &observeControlPlane{}
		srv := cp.serve(t)
		stop, stopOperations := context.WithCancel(context.Background())
		defer stopOperations()
		done := make(chan struct{})
		go func() {
			defer close(done)
			runIntegrationJobAndReport(stop, context.Background(), NewTransport(srv.URL, "tok"), job)
		}()
		if waiting := cp.waitForStep(t, "WAITING_LOCAL_LOCK"); waiting.Phase != "FETCH" {
			t.Fatalf("the lock wait was reported in phase %q, want FETCH", waiting.Phase)
		}
		stopOperations()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Fatal("the job did not stop")
		}
		_, results, releases := cp.snapshot()
		if len(results) != 0 || releases != 1 {
			t.Fatalf("results = %q, releases = %d, want the claim handed back once and nothing answered", results, releases)
		}
	})
}

// TestObserveLandingDoesNotQueueBehindALanding: J1 serialises an observation apart from every
// branch's slot (`#observe:`), and so does this machine's lock. A landing of the same line holding its
// lock through an hour of checks does not hold the observation up; another observation of the line
// does, and the wait is the named step every v2 claim reports.
func TestObserveLandingDoesNotQueueBehindALanding(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	base := r.rev("main")
	job := v2Observe(r, "main", IntegrationObserveTask{TaskID: "t", DeliveredSha: base, BaseSha: base})
	root, err := git(r.work, "rev-parse", "--show-toplevel")
	if err != nil {
		t.Fatalf("rev-parse: %v", err)
	}
	landing := integrationLock(root, job.TargetRef)
	landing.Lock()
	defer landing.Unlock()
	another := integrationLock(root, integrationLockRef(job))
	if !another.TryLock() {
		t.Fatal("an observation's lock on this machine is the one the landing of its line holds")
	}

	cp := &observeControlPlane{}
	srv := cp.serve(t)
	done := make(chan integrationResult, 1)
	go func() {
		done <- runIntegrationJobUntilWithProgress(context.Background(), job, silent, func(ctx context.Context, req IntegrationJobProgressRequest) (*IntegrationJobProgressResponse, error) {
			return NewTransport(srv.URL, "tok").integrationJobProgress(ctx, job.JobID, req)
		})
	}()
	cp.waitForStep(t, "WAITING_LOCAL_LOCK")
	another.Unlock()
	select {
	case result := <-done:
		if o := observationOf(t, result, "t"); !o.OnUpstream {
			t.Fatalf("observation = %+v, want the base seen on main", o)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the observation waited behind the landing's lock")
	}
	if !another.TryLock() {
		t.Fatal("the observation's lock was not released")
	}
	another.Unlock()
}
