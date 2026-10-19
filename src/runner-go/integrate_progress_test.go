//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The v2 progress protocol (docs/project-integration-line-contract.md §2.2 J-T4), against real
// repositories and real processes as integrate_test.go's cases are.
//
// What a v2 claim has to get right, and what a legacy claim must not change:
//   * a report inside every 30 seconds while the local lock waits, the tree is prepared and a check
//     runs, carrying the step, the check in flight and how idle its output is;
//   * a stop request read off every answer — cancelRequested answers CANCELLED and kills the check's
//     process group, while 409/404 report nothing — and neither is handed back;
//   * a synchronous report before the push that nothing pushes without.

// progressControlPlane answers a runner's progress, result and release calls and records them.
type progressControlPlane struct {
	mu       sync.Mutex
	reports  []IntegrationJobProgressRequest
	at       []time.Time
	results  []IntegrationJobResultRequest
	releases []IntegrationJobReleaseRequest
	outputs  []IntegrationJobOutputRequest
	// answer decides the answer to the nth progress report (1-based). Nil accepts and denies.
	answer func(n int, req IntegrationJobProgressRequest) (status int, payload string)
}

func (cp *progressControlPlane) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/progress"):
			var body IntegrationJobProgressRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.reports = append(cp.reports, body)
			cp.at = append(cp.at, time.Now())
			n := len(cp.reports)
			answer := cp.answer
			cp.mu.Unlock()
			status, payload := http.StatusOK, `{"accepted":true,"cancelRequested":false}`
			if answer != nil {
				status, payload = answer(n, body)
			}
			w.WriteHeader(status)
			_, _ = w.Write([]byte(payload))
		case strings.HasSuffix(r.URL.Path, "/release"):
			var body IntegrationJobReleaseRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.releases = append(cp.releases, body)
			cp.mu.Unlock()
			_, _ = w.Write([]byte(`{"released":true,"state":"QUEUED"}`))
		case strings.HasSuffix(r.URL.Path, "/output"):
			var body IntegrationJobOutputRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.outputs = append(cp.outputs, body)
			cp.mu.Unlock()
			_, _ = w.Write([]byte(`{"accepted":true}`))
		case strings.HasSuffix(r.URL.Path, "/result"):
			var body IntegrationJobResultRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			cp.results = append(cp.results, body)
			cp.mu.Unlock()
			_, _ = w.Write([]byte(`{"accepted":true,"state":"` + body.State + `","receiptIds":[],"openItemId":null}`))
		default:
			cp.mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (cp *progressControlPlane) snapshot() (reports []IntegrationJobProgressRequest, at []time.Time, results []IntegrationJobResultRequest, releases []IntegrationJobReleaseRequest) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]IntegrationJobProgressRequest(nil), cp.reports...),
		append([]time.Time(nil), cp.at...),
		append([]IntegrationJobResultRequest(nil), cp.results...),
		append([]IntegrationJobReleaseRequest(nil), cp.releases...)
}

// waitForReport waits for a report the test is looking for, so a case asserts on what was sent
// rather than on how fast the machine happened to be.
/** The output chunks the control plane was sent, in arrival order. */
func (cp *progressControlPlane) outputSnapshot() []IntegrationJobOutputRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]IntegrationJobOutputRequest(nil), cp.outputs...)
}

func (cp *progressControlPlane) waitForReport(t *testing.T, what string, match func(IntegrationJobProgressRequest) bool) IntegrationJobProgressRequest {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		reports, _, _, _ := cp.snapshot()
		for _, report := range reports {
			if match(report) {
				return report
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no progress report ever said %s", what)
	return IntegrationJobProgressRequest{}
}

// v2Job is a claimed job as the control plane sends it to a runner that declared
// integration-progress/v2, with the two timings shortened so the same code path runs in a test.
func v2Job(r *integrationRepo, source, target string, checks ...IntegrationCheckSpec) IntegrationJobCommand {
	job := r.command(source, target, checks...)
	job.ReportBeforePush = true
	job.ClaimGeneration = "1"
	job.LeaseOwner = "the-process"
	job.progressEvery = 20 * time.Millisecond
	return job
}

// TestV2ProgressReportsInsideEveryWindowForALongCheck: a check may run for twelve minutes, and the
// control plane has to hear from the claim inside every thirty seconds all the way through. The
// twelve minutes are compressed here — the job's own interval is 20 ms and the check runs for a few
// hundred milliseconds — because the cadence is the ticker's, not the clock's; the constant the
// production path uses is asserted against the contract's thirty seconds separately.
func TestV2ProgressReportsInsideEveryWindowForALongCheck(t *testing.T) {
	if integrationProgressEvery > 30*time.Second {
		t.Fatalf("integrationProgressEvery = %v, want inside the contract's 30 seconds", integrationProgressEvery)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/long", "main")
	r.write("long.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/long")
	r.checkout("main")

	// Output keeps moving for the first half, then goes quiet: both facts have to be visible.
	check := IntegrationCheckSpec{
		Name:             "TASK_ACCEPTANCE",
		Command:          "for i in $(seq 1 20); do echo tick; sleep 0.012; done; sleep 0.35",
		ExpectedExitCode: 0,
		TimeoutSeconds:   600,
	}
	job := v2Job(r, "task/long", "project/line", check)
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)

	reports, at, results, releases := cp.snapshot()
	if len(results) != 1 || results[0].State != "LANDED" {
		t.Fatalf("results = %+v, want one LANDED", results)
	}
	if len(releases) != 0 {
		t.Fatalf("releases = %+v, want none: the job was not stopped", releases)
	}
	var inCheck []int
	for i, report := range reports {
		if report.Check != nil {
			inCheck = append(inCheck, i)
			if report.Phase != "CHECK" {
				t.Fatalf("report %d carries a check but phase %q", i, report.Phase)
			}
			if report.Check.Name != "TASK_ACCEPTANCE" || report.Check.Index != 1 || report.Check.Count != 1 {
				t.Fatalf("check in flight = %+v, want TASK_ACCEPTANCE 1 of 1", report.Check)
			}
			if report.Check.BudgetSeconds != 600 {
				t.Fatalf("budgetSeconds = %d, want 600", report.Check.BudgetSeconds)
			}
			if _, err := time.Parse(time.RFC3339Nano, report.Check.StartedAt); err != nil {
				t.Fatalf("startedAt %q is not an instant: %v", report.Check.StartedAt, err)
			}
		}
	}
	if len(inCheck) < 8 {
		t.Fatalf("only %d reports carried the check over a %v check: %v", len(inCheck), 600*time.Second, reports)
	}
	// Inside the contract's window: no two consecutive reports during the check are more than ten
	// ticks apart (the ticker's own interval, with room for a slow request and a loaded machine).
	for k := 1; k < len(inCheck); k++ {
		gap := at[inCheck[k]].Sub(at[inCheck[k-1]])
		if gap > 10*job.progressEvery {
			t.Fatalf("reports %d and %d are %v apart, want inside %v", inCheck[k-1], inCheck[k], gap, 10*job.progressEvery)
		}
	}
	// outputIdleMs is the bg_run model: while output moves it stays small, and the silent tail is
	// measured rather than guessed — the last report of the check has been quiet for most of it.
	var early, late *IntegrationJobProgressRequest
	for i := range reports {
		if reports[i].Check == nil || reports[i].OutputIdleMs == nil {
			continue
		}
		if early == nil {
			early = &reports[i]
		}
		late = &reports[i]
	}
	if early == nil || late == nil {
		t.Fatalf("no report carried outputIdleMs: %v", reports)
	}
	if *early.OutputIdleMs > 200 {
		t.Fatalf("the first check report says output has been idle for %dms while it was being written", *early.OutputIdleMs)
	}
	if *late.OutputIdleMs < 250 {
		t.Fatalf("the last check report says output has been idle for %dms, want the silent tail measured", *late.OutputIdleMs)
	}
	if late.OutputBytes == nil || *late.OutputBytes < int64(len("tick\n")) {
		t.Fatalf("outputBytes = %v, want the check's output counted", late.OutputBytes)
	}
}

// TestV2ProgressNamesTheLocalLockWaitAndThePrepareStep: the two steps the contract names have
// their own spelling, so a reader can tell a job queued behind this machine's lock from one that is
// laying the tree's environment down (§2.2 J-T4: WAITING_LOCAL_LOCK inside FETCH, PREPARE inside
// CHECK).
func TestV2ProgressNamesTheLocalLockWaitAndThePrepareStep(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.writeIn("scripts/worktree-overlay.sh", "#!/usr/bin/env bash\nsleep 0.25\n")
	r.commit("the environment recipe")
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/steps", "main")
	r.write("steps.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/steps")
	r.checkout("main")

	check := IntegrationCheckSpec{Name: "MERGE_CHECK", Command: "exit 0", ExpectedExitCode: 0, TimeoutSeconds: 60}
	job := v2Job(r, "task/steps", "project/line", check)
	root, err := git(r.work, "rev-parse", "--show-toplevel")
	if err != nil {
		t.Fatalf("rev-parse: %v", err)
	}
	held := integrationLock(root, job.TargetRef)
	held.Lock()
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	done := make(chan integrationResult, 1)
	go func() {
		done <- runIntegrationJobUntilWithProgress(context.Background(), job, silent, func(ctx context.Context, req IntegrationJobProgressRequest) (*IntegrationJobProgressResponse, error) {
			return NewTransport(srv.URL, "tok").integrationJobProgress(ctx, job.JobID, req)
		})
	}()
	// The job is waiting for this machine's lock, and says so before it blocks.
	waiting := cp.waitForReport(t, "WAITING_LOCAL_LOCK", func(report IntegrationJobProgressRequest) bool {
		return report.Step == "WAITING_LOCAL_LOCK"
	})
	if waiting.Phase != "FETCH" {
		t.Fatalf("the local lock wait was reported in phase %q, want FETCH", waiting.Phase)
	}
	held.Unlock()
	preparing := cp.waitForReport(t, "PREPARE", func(report IntegrationJobProgressRequest) bool {
		return report.Step == "PREPARE"
	})
	if preparing.Phase != "CHECK" {
		t.Fatalf("the prepare step was reported in phase %q, want CHECK", preparing.Phase)
	}
	select {
	case result := <-done:
		if result.State != "LANDED" {
			t.Fatalf("result = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the job did not finish")
	}
	if !held.TryLock() {
		t.Fatal("the integration lock was not released")
	}
	held.Unlock()
}

// TestV2StopEndsTheJobWithoutPushing: every stop signal — cancelRequested, 409 STALE_CLAIM, 409
// ALREADY_FINAL, 404 — kills the check's whole process group at once. A cancellation is answered
// CANCELLED (J-T12); a refused claim is reported to nobody and handed back to nobody, because there
// is no claim left (§2.2 J-T4).
func TestV2StopEndsTheJobWithoutPushing(t *testing.T) {
	cases := []struct {
		name    string
		answer  string
		status  int
		results int
		state   string
	}{
		{"cancelRequested", `{"accepted":true,"cancelRequested":true}`, http.StatusOK, 1, "CANCELLED"},
		{"409 STALE_CLAIM", `{"code":"STALE_CLAIM"}`, http.StatusConflict, 0, ""},
		{"409 ALREADY_FINAL", `{"code":"ALREADY_FINAL"}`, http.StatusConflict, 0, ""},
		{"404", `{"code":"NOT_FOUND"}`, http.StatusNotFound, 0, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
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
			before := r.originRev("refs/heads/project/line")

			pidFile := filepath.Join(t.TempDir(), "child.pid")
			check := IntegrationCheckSpec{
				Name: "MERGE_CHECK", Command: childOfACheck(pidFile), ExpectedExitCode: 0, TimeoutSeconds: 600,
			}
			job := v2Job(r, "task/stopped", "project/line", check)
			job.JobID = "job-" + strings.ReplaceAll(c.name, " ", "-")
			var fired sync.Mutex
			stopped := false
			cp := &progressControlPlane{}
			cp.answer = func(_ int, req IntegrationJobProgressRequest) (int, string) {
				fired.Lock()
				defer fired.Unlock()
				// Every report before the check starts is accepted: the job has to get as far as
				// running the check, which is the process the stop has to kill.
				if req.Check == nil || !stopped {
					return http.StatusOK, `{"accepted":true,"cancelRequested":false}`
				}
				return c.status, c.answer
			}
			srv := cp.serve(t)
			transport := NewTransport(srv.URL, "tok")
			done := make(chan struct{})
			go func() {
				defer close(done)
				runIntegrationJobAndReport(context.Background(), context.Background(), transport, job)
			}()
			child := waitForPID(t, pidFile)
			fired.Lock()
			stopped = true
			fired.Unlock()

			select {
			case <-done:
			case <-time.After(30 * time.Second):
				t.Fatal("the job did not stop")
			}
			if !processEnded(child) {
				t.Fatalf("the check's child %d outlived the stop", child)
			}
			if after := r.originRev("refs/heads/project/line"); after != before {
				t.Fatalf("the line moved from %s to %s: a stopped job pushed", before, after)
			}
			reports, _, results, releases := cp.snapshot()
			if len(releases) != 0 {
				t.Fatalf("releases = %+v, want none: only a runner stop is handed back", releases)
			}
			if len(results) != c.results {
				t.Fatalf("results = %+v, want %d", results, c.results)
			}
			if c.results > 0 {
				if results[0].State != c.state {
					t.Fatalf("state = %q, want %q", results[0].State, c.state)
				}
			}
			var sawStop bool
			for _, report := range reports {
				if report.Step == "PREPARE" || report.Check != nil {
					sawStop = true
				}
			}
			if !sawStop {
				t.Fatalf("reports = %+v, want the job to have reported its check", reports)
			}
			root, err := git(r.work, "rev-parse", "--show-toplevel")
			if err != nil {
				t.Fatalf("rev-parse: %v", err)
			}
			lock := integrationLock(root, job.TargetRef)
			if !lock.TryLock() {
				t.Fatal("the integration lock was not released")
			}
			lock.Unlock()
			if _, err := os.Stat(r.scratchPath(job.JobID)); !os.IsNotExist(err) {
				t.Fatalf("the scratch worktree is still on disk (%v)", err)
			}
		})
	}
}

// TestAV2JobTheRunnerStopsIsStillHandedBack: the cause is what tells the two early ends apart. A
// runner stop is not a cancellation and not a lost claim: the job answers nothing, hands its claim
// back (J-T11), and the check's process group is ended exactly as any other stop ends it.
func TestAV2JobTheRunnerStopsIsStillHandedBack(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/v2-stop", "main")
	r.write("v2.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/v2-stop")
	r.checkout("main")
	before := r.originRev("refs/heads/project/line")

	pidFile := filepath.Join(t.TempDir(), "child.pid")
	check := IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: childOfACheck(pidFile), ExpectedExitCode: 0, TimeoutSeconds: 600,
	}
	job := v2Job(r, "task/v2-stop", "project/line", check)
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	stop, stopOperations := context.WithCancel(context.Background())
	defer stopOperations()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runIntegrationJobAndReport(stop, context.Background(), NewTransport(srv.URL, "tok"), job)
	}()
	child := waitForPID(t, pidFile)
	stopOperations()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the job did not stop")
	}
	if !processEnded(child) {
		t.Fatalf("the check's child %d outlived the stop", child)
	}
	_, _, results, releases := cp.snapshot()
	if len(results) != 0 {
		t.Fatalf("results = %+v, want none: a stopped job is handed back, not answered", results)
	}
	want := []IntegrationJobReleaseRequest{{ClaimGeneration: job.ClaimGeneration, LeaseOwner: job.LeaseOwner}}
	if len(releases) != 1 || releases[0] != want[0] {
		t.Fatalf("releases = %+v, want the claim handed back once: %+v", releases, want)
	}
	if after := r.originRev("refs/heads/project/line"); after != before {
		t.Fatalf("the line moved from %s to %s: a stopped job pushed", before, after)
	}
}

// TestV2PushWaitsForAClearAnswer: the synchronous report before J-S6 (§2.2 J-T4). A cancelled
// answer pushes nothing and answers CANCELLED; an answer that never comes inside the lease window
// pushes nothing and ends ERROR / PUSH_REPORT_UNREACHABLE; a clear answer lets the push through.
func TestV2PushWaitsForAClearAnswer(t *testing.T) {
	run := func(t *testing.T, name string, checks ...IntegrationCheckSpec) (*integrationRepo, *progressControlPlane, *Transport) {
		t.Helper()
		t.Setenv("ORBIT_HOME", t.TempDir())
		r := newIntegrationRepo(t)
		r.checkoutNew("project/line", "main")
		r.push("project/line")
		r.checkoutNew("task/"+name, "main")
		r.write(name+".txt", "the task's work\n")
		r.commit("task work")
		r.push("task/" + name)
		r.checkout("main")
		cp := &progressControlPlane{}
		srv := cp.serve(t)
		return r, cp, NewTransport(srv.URL, "tok")
	}
	t.Run("cancelRequested", func(t *testing.T) {
		r, cp, transport := run(t, "push-cancel")
		before := r.originRev("refs/heads/project/line")
		pushes := watchIntegrationPush(t)
		job := v2Job(r, "task/push-cancel", "project/line")
		cp.answer = func(_ int, req IntegrationJobProgressRequest) (int, string) {
			if req.Phase == "PUSH" {
				return http.StatusOK, `{"accepted":true,"cancelRequested":true}`
			}
			return http.StatusOK, `{"accepted":true,"cancelRequested":false}`
		}
		runIntegrationJobAndReport(context.Background(), context.Background(), transport, job)
		_, _, results, _ := cp.snapshot()
		if len(results) != 1 || results[0].State != "CANCELLED" || results[0].Phase != "PUSH" {
			t.Fatalf("results = %+v, want one CANCELLED / PUSH", results)
		}
		if pushes.count(r.work) != 0 {
			t.Fatalf("the push was attempted %d time(s) after a cancelled answer", pushes.count(r.work))
		}
		if after := r.originRev("refs/heads/project/line"); after != before {
			t.Fatalf("the line moved from %s to %s", before, after)
		}
	})
	t.Run("no answer inside the lease window", func(t *testing.T) {
		r, cp, transport := run(t, "push-unreachable")
		before := r.originRev("refs/heads/project/line")
		pushes := watchIntegrationPush(t)
		job := v2Job(r, "task/push-unreachable", "project/line")
		job.pushReportBudget = 100 * time.Millisecond
		cp.answer = func(_ int, req IntegrationJobProgressRequest) (int, string) {
			if req.Phase == "PUSH" {
				return http.StatusServiceUnavailable, `{"code":"UNAVAILABLE"}`
			}
			return http.StatusOK, `{"accepted":true,"cancelRequested":false}`
		}
		runIntegrationJobAndReport(context.Background(), context.Background(), transport, job)
		_, _, results, _ := cp.snapshot()
		if len(results) != 1 || results[0].State != "ERROR" || results[0].ErrorCode != "PUSH_REPORT_UNREACHABLE" {
			t.Fatalf("results = %+v, want one ERROR / PUSH_REPORT_UNREACHABLE", results)
		}
		if pushes.count(r.work) != 0 {
			t.Fatalf("the push was attempted %d time(s) without an answer", pushes.count(r.work))
		}
		if after := r.originRev("refs/heads/project/line"); after != before {
			t.Fatalf("the line moved from %s to %s", before, after)
		}
	})
	t.Run("a clear answer lands", func(t *testing.T) {
		r, cp, transport := run(t, "push-clear")
		pushes := watchIntegrationPush(t)
		job := v2Job(r, "task/push-clear", "project/line")
		runIntegrationJobAndReport(context.Background(), context.Background(), transport, job)
		_, _, results, _ := cp.snapshot()
		if len(results) != 1 || results[0].State != "LANDED" {
			t.Fatalf("results = %+v, want one LANDED", results)
		}
		if pushes.count(r.work) != 1 {
			t.Fatalf("the push was attempted %d time(s), want 1", pushes.count(r.work))
		}
		reports, _, _, _ := cp.snapshot()
		var sawPushReport bool
		for _, report := range reports {
			if report.Phase == "PUSH" {
				sawPushReport = true
			}
		}
		if !sawPushReport {
			t.Fatal("no synchronous PUSH report was sent")
		}
	})
	t.Run("a promotion asks the same way", func(t *testing.T) {
		// M-S4's push is the same synchronous report as J-S6's, and a landing of the project branch
		// into main must be held by it too.
		t.Setenv("ORBIT_HOME", t.TempDir())
		r := newIntegrationRepo(t)
		r.checkoutNew("project/promote-cancel", "main")
		r.write("promote.txt", "the project's work\n")
		r.commit("project work")
		r.push("project/promote-cancel")
		r.checkout("main")
		before := r.originRev("refs/heads/main")
		job := r.promotionCommand("LAND_PROMOTION", "project/promote-cancel", "PROJECT_BRANCH")
		job.ReportBeforePush = true
		job.ClaimGeneration = "1"
		job.LeaseOwner = "the-process"
		job.progressEvery = 20 * time.Millisecond
		pushes := watchIntegrationPush(t)
		cp := &progressControlPlane{}
		cp.answer = func(_ int, req IntegrationJobProgressRequest) (int, string) {
			if req.Phase == "PUSH" {
				return http.StatusOK, `{"accepted":true,"cancelRequested":true}`
			}
			return http.StatusOK, `{"accepted":true,"cancelRequested":false}`
		}
		srv := cp.serve(t)
		runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)
		_, _, results, _ := cp.snapshot()
		if len(results) != 1 || results[0].State != "CANCELLED" || results[0].Phase != "PUSH" {
			t.Fatalf("results = %+v, want one CANCELLED / PUSH", results)
		}
		if pushes.count(r.work) != 0 {
			t.Fatalf("the push was attempted %d time(s) after a cancelled answer", pushes.count(r.work))
		}
		if after := r.originRev("refs/heads/main"); after != before {
			t.Fatalf("main moved from %s to %s", before, after)
		}
	})
}

// watchIntegrationPush records pushes without changing them, keyed by the repository they were
// made from: a case asserts about its own repository, so another test running beside it (or a
// subcase of this one) cannot make its count.
type pushWatch struct {
	mu   sync.Mutex
	from map[string]int
	base func(repoRoot, scratch, remote, targetRef, tested, expectedBefore string, local bool) error
}

func watchIntegrationPush(t *testing.T) *pushWatch {
	t.Helper()
	watch := &pushWatch{from: map[string]int{}, base: integrationPush}
	integrationPush = func(repoRoot, scratch, remote, targetRef, tested, expectedBefore string, local bool) error {
		watch.mu.Lock()
		watch.from[repoRoot]++
		watch.mu.Unlock()
		return watch.base(repoRoot, scratch, remote, targetRef, tested, expectedBefore, local)
	}
	t.Cleanup(func() { integrationPush = watch.base })
	return watch
}

func (w *pushWatch) count(repoRoot string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.from[repoRoot]
}

// TestALegacyClaimPushesWithoutAsking: reportBeforePush is what makes a claim v2, and a claim
// without it keeps the old shape — the phase report is best effort and its answer is discarded, so
// a control plane that says "stop" is not read by a legacy job and the push goes ahead (§2.2 J-T4,
// legacy claims).
func TestALegacyClaimPushesWithoutAsking(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/legacy", "main")
	r.write("legacy.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/legacy")
	r.checkout("main")

	job := r.command("task/legacy", "project/line")
	job.ClaimGeneration = "1"
	job.LeaseOwner = "the-process"
	if job.ReportBeforePush {
		t.Fatal("the helper built a v2 claim")
	}
	cp := &progressControlPlane{}
	cp.answer = func(int, IntegrationJobProgressRequest) (int, string) {
		// What would stop a v2 claim. A legacy claim never reads it.
		return http.StatusOK, `{"accepted":true,"cancelRequested":true}`
	}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, "tok"), job)
	_, _, results, _ := cp.snapshot()
	if len(results) != 1 || results[0].State != "LANDED" {
		t.Fatalf("results = %+v, want one LANDED: a legacy claim pushes without asking", results)
	}
	reports, _, _, _ := cp.snapshot()
	for _, report := range reports {
		if report.Step != "" || report.Check != nil || report.OutputIdleMs != nil || report.Round != 0 {
			t.Fatalf("a legacy claim sent the v2 shape: %+v", report)
		}
	}
}
