//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A landing the runner's own stop ends (runIntegrationJobUntil, handBackIntegrationJob), against real
// repositories and real processes, as integrate_test.go's cases are. What the lab saw on 2026-10-17
// (task T03): the check was killed with the Pod, its scratch worktree stayed on the volume, and the job
// waited out its lease. What must hold instead: the check and everything it started are ended, the
// worktree is gone, nothing is pushed, and the claim is handed back.

// childOfACheck is a check command that starts a child of its own and waits for it, writing the
// child's pid where the test can find it: the shape of `npm test` under `bash -lc`, where the work is
// never the shell itself.
func childOfACheck(pidFile string) string {
	return fmt.Sprintf("sleep 300 & echo $! > %q; wait", pidFile)
}

func waitForPID(t *testing.T, pidFile string) int {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(pidFile); err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(data))); convErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the check never started its child (%s)", pidFile)
	return 0
}

// processEnded waits for pid to be gone, and says whether it went.
func processEnded(pid int) bool {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// integrationControlPlane records what a runner told it about one job.
type integrationControlPlane struct {
	mu       sync.Mutex
	phases   []string
	releases []IntegrationJobReleaseRequest
	results  []IntegrationJobResultRequest
	// releaseStatus answers each release in turn; past its end, the last status repeats.
	releaseStatus []int
}

func (cp *integrationControlPlane) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		defer cp.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/progress"):
			var body IntegrationJobProgressRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.phases = append(cp.phases, body.Phase)
			_, _ = w.Write([]byte(`{"accepted":true}`))
		case strings.HasSuffix(r.URL.Path, "/release"):
			var body IntegrationJobReleaseRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.releases = append(cp.releases, body)
			status := http.StatusOK
			if n := len(cp.releaseStatus); n > 0 {
				status = cp.releaseStatus[min(len(cp.releases), n)-1]
			}
			if status != http.StatusOK {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"code":"REFUSED"}`))
				return
			}
			_, _ = w.Write([]byte(`{"released":true,"state":"QUEUED"}`))
		case strings.HasSuffix(r.URL.Path, "/result"):
			var body IntegrationJobResultRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.results = append(cp.results, body)
			_, _ = w.Write([]byte(`{"accepted":true,"state":"` + body.State + `","receiptIds":[],"openItemId":null}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The lab's case: a landing's merge check is running when the runner stops. At the end of the stop's
// budget the check is ended with the child it started, the scratch worktree is removed, nothing is
// pushed, and the claim the job was handed under is given back — not a result: the check measured
// nothing.
func TestALandingTheStopEndsMidCheckIsHandedBack(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/stopped", "main")
	r.write("stopped.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/stopped")
	r.checkout("main")
	lineBefore := r.originRev("refs/heads/project/line")

	pidFile := filepath.Join(t.TempDir(), "child.pid")
	job := r.command("task/stopped", "project/line", IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: childOfACheck(pidFile), ExpectedExitCode: 0, TimeoutSeconds: 600,
	})
	job.JobID = "job-the-stop-ends"
	job.ClaimGeneration = "3"
	job.LeaseOwner = "the-stopping-process"
	cp := &integrationControlPlane{}
	srv := cp.serve(t)

	stop, stopOperations := context.WithCancel(context.Background())
	defer stopOperations()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runIntegrationJobAndReport(stop, context.Background(), NewTransport(srv.URL, "tok"), job)
	}()
	child := waitForPID(t, pidFile)
	scratch := r.scratchPath(job.JobID)
	if _, err := os.Stat(scratch); err != nil {
		t.Fatalf("the check is running but its scratch worktree is not there: %v", err)
	}

	stopOperations()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the landing did not stop")
	}

	cp.mu.Lock()
	defer cp.mu.Unlock()
	if want := []IntegrationJobReleaseRequest{{ClaimGeneration: "3", LeaseOwner: "the-stopping-process"}}; !slices.Equal(cp.releases, want) {
		t.Fatalf("releases = %+v, want the claim handed back once: %+v", cp.releases, want)
	}
	if len(cp.results) != 0 {
		t.Fatalf("a result was reported for a check that measured nothing: %+v", cp.results)
	}
	if !slices.Contains(cp.phases, "CHECK") {
		t.Fatalf("phases = %v, want the job to have reached its check", cp.phases)
	}
	if !processEnded(child) {
		t.Fatalf("the check's child %d outlived the job", child)
	}
	if _, err := os.Stat(scratch); !os.IsNotExist(err) {
		t.Fatalf("the scratch worktree is still on disk (%v)", err)
	}
	listed, err := git(r.work, "worktree", "list")
	if err != nil {
		t.Fatalf("worktree list: %v", err)
	}
	if strings.Contains(listed, integrateScratchPrefix) {
		t.Fatalf("the repository still lists the scratch worktree:\n%s", listed)
	}
	if after := r.originRev("refs/heads/project/line"); after != lineBefore {
		t.Fatalf("the line moved from %s to %s: an interrupted landing pushed", lineBefore, after)
	}
	if spooledResultOnDisk(t, job.JobID, job.ClaimGeneration) {
		t.Fatal("an interrupted landing spooled a result for the next start to report")
	}
}

// The fallback when a stop could not clean up — the process was killed before it got that far: the
// same job id names the same scratch path, and the rerun the next process is handed removes what the
// killed attempt left there before it stages its own, as the entry removal promises. The leftover is
// neither in the tree the rerun checks nor in its way.
func TestTheRerunIsNotTrippedByWhatAKilledAttemptLeft(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/rerun", "main")
	r.write("rerun.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/rerun")
	r.checkout("main")
	job := r.command("task/rerun", "project/line", IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: "test ! -e left-by-a-killed-attempt.txt", ExpectedExitCode: 0, TimeoutSeconds: 60,
	})
	scratch := r.scratchPath(job.JobID)
	if err := os.MkdirAll(r.scratch, 0o755); err != nil {
		t.Fatalf("create the scratch root: %v", err)
	}
	mustRun(t, r.work, "git", "worktree", "add", "--quiet", "--detach", scratch, "main")
	if err := os.WriteFile(filepath.Join(scratch, "left-by-a-killed-attempt.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatalf("write the leftover: %v", err)
	}

	result := runIntegrationJob(job, silent)
	if result.State != "LANDED" {
		t.Fatalf("the rerun answered %+v, want LANDED", result)
	}
	if _, err := os.Stat(scratch); !os.IsNotExist(err) {
		t.Fatalf("the scratch worktree is still on disk after the rerun (%v)", err)
	}
}

// A stop that has come before the job begins starts nothing: no worktree, no git work, handed back.
func TestALandingHandedOverAsTheStopBeganStartsNothing(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("task/never", "main")
	r.write("never.txt", "never landed\n")
	r.commit("task work")
	r.push("task/never")
	r.checkout("main")
	stop, stopOperations := context.WithCancel(context.Background())
	stopOperations()
	var phases []string
	result := runIntegrationJobUntil(stop, r.command("task/never", "project/line"), func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})
	if !result.Interrupted || result.Phase != "FETCH" {
		t.Fatalf("result = %+v, want interrupted before FETCH", result)
	}
	if len(phases) != 0 {
		t.Fatalf("a stopped landing reported steps: %v", phases)
	}
	if origin := r.originRev("refs/heads/project/line"); origin != "" {
		t.Fatalf("the line was created at %s", origin)
	}
}

// A check the stop ends measured nothing, so it is neither a failure nor a timeout.
func TestACheckTheStopEndsIsNotACheckThatFailed(t *testing.T) {
	stop, stopOperations := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		stopOperations()
	}()
	result, interrupted := runIntegrationCheckUntil(stop, t.TempDir(), IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: "sleep 30", ExpectedExitCode: 0, TimeoutSeconds: 60,
	})
	if !interrupted {
		t.Fatalf("result = %+v, want interrupted", result)
	}
	if result.TimedOut || result.ExitCode != nil {
		t.Fatalf("an interrupted check reads as a verdict: %+v", result)
	}
}

// A check that runs out of its own budget is still a timeout, and is ended with what it started: a
// check ended by its shell's PID alone left `sleep`, `node` or `go test` running in the worktree that
// was about to be removed.
func TestACheckPastItsBudgetIsEndedWithItsChildren(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	started := time.Now()
	result, interrupted := runIntegrationCheckUntil(context.Background(), t.TempDir(), IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: childOfACheck(pidFile), ExpectedExitCode: 0, TimeoutSeconds: 1,
	})
	if interrupted || !result.TimedOut || result.ExitCode != nil {
		t.Fatalf("result = %+v (interrupted %v), want a timeout", result, interrupted)
	}
	if took := time.Since(started); took > 20*time.Second {
		t.Fatalf("the check took %v to end past a 1s budget", took)
	}
	child := waitForPID(t, pidFile)
	if !processEnded(child) {
		t.Fatalf("the check's child %d outlived its budget", child)
	}
}

// Only a command the stop ended is an interruption. One that ended by itself as the stop came has an
// answer, and the answer stands; one past its budget is a timeout.
func TestStoppedByTheRunnerIsOnlyWhatTheStopEnded(t *testing.T) {
	exitedWith := func(script string) error { return exec.Command("sh", "-c", script).Run() }
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, expire := context.WithTimeout(context.Background(), time.Nanosecond)
	defer expire()
	<-expired.Done()
	running := context.Background()

	for _, c := range []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"killed by the stop", cancelled, exitedWith("kill -9 $$"), true},
		{"never started, the stop having come", cancelled, context.Canceled, true},
		{"exited zero as the stop came", cancelled, nil, false},
		{"exited one as the stop came", cancelled, exitedWith("exit 1"), false},
		{"killed at its budget", expired, exitedWith("kill -9 $$"), false},
		{"killed by somebody else", running, exitedWith("kill -9 $$"), false},
	} {
		if got := stoppedByTheRunner(c.ctx, c.err); got != c.want {
			t.Errorf("%s: stoppedByTheRunner = %v, want %v", c.name, got, c.want)
		}
	}
}

// The hand-back is sent until the control plane answers. A refusal ends it — 409, the claim moved on
// or the job is final; 404, a job this runner cannot see or a control plane with no such route, where
// the lease hands the job on as before — and so does the end of the stop's time for it.
func TestTheHandBackIsSentUntilTheControlPlaneAnswers(t *testing.T) {
	fastIntegrationResultRetry(t)
	job := IntegrationJobCommand{JobID: "job-handed-back", ClaimGeneration: "7", LeaseOwner: "the-stopping-process"}
	for _, c := range []struct {
		name     string
		statuses []int
		sends    int
	}{
		{"taken at once", []int{http.StatusOK}, 1},
		{"taken once the control plane is back", []int{http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusOK}, 3},
		{"the claim moved on", []int{http.StatusConflict}, 1},
		{"a control plane with no hand-back", []int{http.StatusNotFound}, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			cp := &integrationControlPlane{releaseStatus: c.statuses}
			srv := cp.serve(t)
			handBackIntegrationJob(context.Background(), NewTransport(srv.URL, "tok"), job)
			cp.mu.Lock()
			defer cp.mu.Unlock()
			if len(cp.releases) != c.sends {
				t.Fatalf("sent %d hand-backs, want %d", len(cp.releases), c.sends)
			}
			for _, sent := range cp.releases {
				if sent != (IntegrationJobReleaseRequest{ClaimGeneration: "7", LeaseOwner: "the-stopping-process"}) {
					t.Fatalf("sent %+v, want the claim the job was handed under", sent)
				}
			}
		})
	}
	t.Run("the stop's time for it runs out", func(t *testing.T) {
		cp := &integrationControlPlane{releaseStatus: []int{http.StatusServiceUnavailable}}
		srv := cp.serve(t)
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		started := time.Now()
		handBackIntegrationJob(ctx, NewTransport(srv.URL, "tok"), job)
		if took := time.Since(started); took > 5*time.Second {
			t.Fatalf("the hand-back went on for %v after its time ran out", took)
		}
		cp.mu.Lock()
		defer cp.mu.Unlock()
		if len(cp.releases) < 2 {
			t.Fatalf("sent %d hand-backs to an unwell control plane, want it tried again", len(cp.releases))
		}
	})
}
