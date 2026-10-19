package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fastIntegrationResultRetry takes a test's waits off the wall clock. The shape of the waits (first,
// doubling, capped) is the policy's own; what a test needs is that the next send happens now.
func fastIntegrationResultRetry(t *testing.T) {
	t.Helper()
	restore := integrationResultRetry
	t.Cleanup(func() { integrationResultRetry = restore })
	integrationResultRetry.first = time.Millisecond
	integrationResultRetry.max = 4 * time.Millisecond
	integrationResultRetry.sleep = func(ctx context.Context, d time.Duration) {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
	}
}

// integrationJobResultBody is a result of the shape a finished job reports: what matters to these
// tests is the fence it carries (generation, lease owner) and that it is the body sent.
func integrationJobResultBody() IntegrationJobResultRequest {
	return IntegrationJobResultRequest{
		ClaimGeneration: "4",
		LeaseOwner:      "owner-of-the-dead-process",
		State:           "ERROR",
		Phase:           "CHECK",
		ErrorCode:       "CHECK_FAILED",
		TestedSha:       "1111111111111111111111111111111111111111",
		TestedTreeSha:   "2222222222222222222222222222222222222222",
	}
}

func spooledResultOnDisk(t *testing.T, jobID, claimGeneration string) bool {
	t.Helper()
	_, err := os.Stat(spoolFilePath(jobID, claimGeneration))
	if err == nil {
		return true
	}
	if !os.IsNotExist(err) {
		t.Fatalf("stat spooled result: %v", err)
	}
	return false
}

// 2026-10-09 14:48Z: the apiserver answered five 500s in a row to a CHECK_PROMOTION result that was
// finished, the runner gave up, and the control plane went on holding the job RUNNING for a process
// that never speaks again. A 5xx is the control plane saying it is unwell, not a verdict on the
// result: the send must go on until it lands.
func TestIntegrationJobResultIsSentAgainThroughAServerFault(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	var sends atomic.Int32
	var got IntegrationJobResultRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/integration-jobs/job-9/result") {
			t.Errorf("the result was sent to %s", r.URL.Path)
		}
		if sends.Add(1) <= 3 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"statusCode":500,"message":"constraint violation"}`))
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"ERROR","receiptIds":["r1"],"openItemId":null}`))
	}))
	t.Cleanup(srv.Close)

	body := integrationJobResultBody()
	deliverIntegrationResult(context.Background(), NewTransport(srv.URL, "tok"), "job-9", body)

	if n := sends.Load(); n != 4 {
		t.Fatalf("the control plane was told %d times, want the three 500s and the send that landed", n)
	}
	if got.ClaimGeneration != "4" || got.LeaseOwner != "owner-of-the-dead-process" || got.State != "ERROR" {
		t.Fatalf("the send that landed carried %#v, want the job's own result and fence", got)
	}
	if spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the result landed, but the copy spooled for it is still on disk")
	}
}

// A 409 STALE_CLAIM is the control plane answering about the report itself: this claim is not this
// process's any more (the fence moved), so the send stops after one attempt and the spooled copy goes
// with it. Retrying a judgement cannot change it, and leaving the file would send it again at every
// start for ever.
func TestIntegrationJobResultStopsAndDropsTheSpoolOnAStaleClaim(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"STALE_CLAIM","message":"this job's claim has moved on"}`))
	}))
	t.Cleanup(srv.Close)

	deliverIntegrationResult(context.Background(), NewTransport(srv.URL, "tok"), "job-9", integrationJobResultBody())

	if n := sends.Load(); n != 1 {
		t.Fatalf("the control plane was told %d times, want one: a stale claim is an answer, not a fault", n)
	}
	if spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the result was refused for good, but the copy spooled for it is still on disk")
	}
}

// A process that stops between running a job and being told its result was taken leaves the report
// behind — a self-update, a restart, a kill. The next process sends it before its first heartbeat,
// which is what would otherwise claim the job again and run an hour of checks a second time. The
// copy says which job it is and the fence it was reported under, so the control plane can refuse it
// if that claim has moved on in the meantime.
func TestASpooledIntegrationJobResultIsSentByTheNextProcess(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	fastIntegrationResultRetry(t)

	// The process that ran the job: its report never landed, and it stopped.
	dead := spooledIntegrationResult{
		JobID:           "job-9",
		ClaimGeneration: "4",
		LeaseOwner:      "owner-of-the-dead-process",
		Result:          integrationJobResultBody(),
	}
	if err := spoolIntegrationResult(dead); err != nil {
		t.Fatalf("spool the result: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "integration-results", spoolFileName("job-9", "4")))
	if err != nil {
		t.Fatalf("read the spooled result: %v", err)
	}
	var onDisk map[string]interface{}
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("the spooled result is not JSON: %v", err)
	}
	for field, want := range map[string]interface{}{
		"jobId": "job-9", "claimGeneration": "4", "leaseOwner": "owner-of-the-dead-process",
	} {
		if onDisk[field] != want {
			t.Fatalf("the spooled result's %s = %v, want %v: the file says which job and which claim it is about",
				field, onDisk[field], want)
		}
	}

	var sends atomic.Int32
	var got IntegrationJobResultRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		if !strings.HasSuffix(r.URL.Path, "/integration-jobs/job-9/result") {
			t.Errorf("the spooled result was sent to %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"ERROR","receiptIds":[],"openItemId":null}`))
	}))
	t.Cleanup(srv.Close)

	// The next process: its own lease owner, nothing claimed yet.
	replaySpooledIntegrationResults(context.Background(), NewTransport(srv.URL, "tok"))

	if n := sends.Load(); n != 1 {
		t.Fatalf("the spooled result was sent %d times, want once", n)
	}
	if got.ClaimGeneration != "4" || got.LeaseOwner != "owner-of-the-dead-process" || got.ErrorCode != "CHECK_FAILED" {
		t.Fatalf("the next process sent %#v, want the result the earlier one spooled, fence and all", got)
	}
	if spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the result was taken, but the copy spooled for it is still on disk")
	}
}

// A runner that is stopping — a self-update, a SIGTERM — abandons the send it is in rather than
// holding the process open for a control plane that may stay down, and the report waits on disk for
// the process that starts next. This is the half a restart relies on.
func TestAStoppingRunnerLeavesTheResultSpooled(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	ctx, stop := context.WithCancel(context.Background())
	stop()
	deliverIntegrationResult(ctx, NewTransport(srv.URL, "tok"), "job-9", integrationJobResultBody())

	if !spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the runner stopped before the result was taken, so the copy spooled for it must be there")
	}
}

// A control plane that cannot answer for the spooled report yet — a 503, a connection that fails —
// leaves it where it is, for this process to keep offering while it lives and for the next process to
// find if this one stops first.
func TestASpooledIntegrationJobResultSurvivesAControlPlaneThatIsDown(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	if err := spoolIntegrationResult(spooledIntegrationResult{
		JobID:           "job-9",
		ClaimGeneration: "4",
		LeaseOwner:      "owner-of-the-dead-process",
		Result:          integrationJobResultBody(),
	}); err != nil {
		t.Fatalf("spool the result: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"statusCode":503,"message":"this control plane runs no integration queue"}`))
	}))
	t.Cleanup(srv.Close)

	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	replaySpooledIntegrationResults(ctx, NewTransport(srv.URL, "tok"))
	stop()

	if !spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the control plane never took the result, so the copy spooled for it must still be there")
	}
}

// One job can have two claims' reports on this disk at once: an older claim whose report never
// landed, and the new claim that took the job over. They are different files, and an answer that
// retires the old report (STALE_CLAIM, ALREADY_FINAL) must delete only the old file — the new
// claim's report is still owed to the control plane.
func TestAStaleClaimDropsOnlyItsOwnSpooledResult(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)

	oldClaim := spooledIntegrationResult{
		JobID:           "job-9",
		ClaimGeneration: "4",
		LeaseOwner:      "owner-of-the-dead-process",
		Result:          integrationJobResultBody(),
	}
	newClaim := spooledIntegrationResult{
		JobID:           "job-9",
		ClaimGeneration: "5",
		LeaseOwner:      "the-new-claim",
		Result:          integrationJobResultBody(),
	}
	newClaim.Result.ClaimGeneration = "5"
	newClaim.Result.LeaseOwner = "the-new-claim"
	for _, entry := range []spooledIntegrationResult{oldClaim, newClaim} {
		if err := spoolIntegrationResult(entry); err != nil {
			t.Fatalf("spool the claim %s: %v", entry.ClaimGeneration, err)
		}
	}
	if !spooledResultOnDisk(t, "job-9", "4") || !spooledResultOnDisk(t, "job-9", "5") {
		t.Fatal("two claims of one job must rest in two files; one overwrote the other")
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		var body IntegrationJobResultRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode result: %v", err)
		}
		if body.ClaimGeneration == "4" {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"STALE_CLAIM","message":"this job's claim has moved on"}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	replaySpooledIntegrationResults(ctx, NewTransport(srv.URL, "tok"))
	stop()

	if spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the old claim's report was refused for good, but its spooled copy is still on disk")
	}
	if !spooledResultOnDisk(t, "job-9", "5") {
		t.Fatal("the old claim's refusal deleted the new claim's report, which the control plane has not taken")
	}
	if n := sends.Load(); n < 2 {
		t.Fatalf("the control plane was told %d times, want both claims offered", n)
	}
}

// A report written before results were keyed by claim generation rests in the old file name, with
// no generation in it. An upgrade must still find and send it, and drop it under the name it was
// found under.
func TestALegacySpooledResultIsStillSent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	fastIntegrationResultRetry(t)
	dir := filepath.Join(home, "integration-results")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir results: %v", err)
	}
	entry := spooledIntegrationResult{
		JobID:           "job-legacy",
		ClaimGeneration: "4",
		LeaseOwner:      "owner-of-the-dead-process",
		Result:          integrationJobResultBody(),
	}
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal the legacy entry: %v", err)
	}
	legacy := filepath.Join(dir, "job-legacy.json")
	if err := os.WriteFile(legacy, data, 0o600); err != nil {
		t.Fatalf("write the legacy spooled result: %v", err)
	}

	var got IntegrationJobResultRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"ERROR","receiptIds":[],"openItemId":null}`))
	}))
	t.Cleanup(srv.Close)

	replaySpooledIntegrationResults(context.Background(), NewTransport(srv.URL, "tok"))

	if got.ClaimGeneration != "4" || got.LeaseOwner != "owner-of-the-dead-process" {
		t.Fatalf("the legacy report was sent as %#v, want the fence it carries", got)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("the legacy spooled result is still on disk after the control plane took it (%v)", err)
	}
}

// A result that cannot be delivered must not count as the job's work in flight for ever: the
// goroutine holding it is a heartbeat operation, and both the self-update gate and a managed
// runner's idle report read that count. After the in-flight budget the send stops, the count goes
// to zero, and the report waits on disk for the next start.
func TestAnUndeliverableResultStopsCountingAsWorkInFlightAfterItsBudget(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	integrationResultRetry.inFlightBudget = 25 * time.Millisecond

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	var ops countedOps
	ops.Add(1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ops.Done()
		deliverIntegrationResult(context.Background(), NewTransport(srv.URL, "tok"), "job-9", integrationJobResultBody())
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("the result was still counting as work in flight long after its budget ran out")
	}
	if n := ops.inFlight(); n != 0 {
		t.Fatalf("%d heartbeat operation(s) still counted, want 0", n)
	}
	if !spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the result was not delivered, so its spooled copy must stay for the next start")
	}

	// The two gates that read the count: managed idle reporting and the self-update gate.
	pool := newSessionPool(1)
	install := &installRelay{}
	login := &loginRelay{}
	if got := managedWorkloadCounts(pool, &ops, login, install); got.Operations != 0 || !got.idle() {
		t.Fatalf("the managed workload still reports %+v, want idle", got)
	}
	checker := func(context.Context, string) (string, bool) { return "v2", true }
	if remote, ok := updateWhenNoTurnInFlight(checker, pool, func() int { return ops.inFlight() + install.inFlight() }, time.Minute)(context.Background(), "server"); !ok {
		t.Fatal("the self-update gate still waits on the undeliverable result")
	} else if remote != "v2" {
		t.Fatalf("the update check returned %q, want the release it found", remote)
	}
}

// A 401 or 403 is the control plane refusing this runner's credential: no retry of this process can
// change that answer, so the result stops counting as work in flight at once rather than after the
// budget. It stays spooled for the start that runs with a fixed credential.
func TestARefusedCredentialStopsCountingAsWorkInFlightAtOnce(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)

	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"statusCode":401,"message":"invalid runner token"}`))
	}))
	t.Cleanup(srv.Close)

	var ops countedOps
	ops.Add(1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ops.Done()
		deliverIntegrationResult(context.Background(), NewTransport(srv.URL, "tok"), "job-9", integrationJobResultBody())
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a refused credential kept the result counting as work in flight")
	}
	if n := sends.Load(); n != 1 {
		t.Fatalf("the control plane was told %d times, want one: a refused credential is not retried by this process", n)
	}
	if n := ops.inFlight(); n != 0 {
		t.Fatalf("%d heartbeat operation(s) still counted, want 0", n)
	}
	if !spooledResultOnDisk(t, "job-9", "4") {
		t.Fatal("the credential was refused, not the result: its spooled copy must stay for the next start")
	}
}
