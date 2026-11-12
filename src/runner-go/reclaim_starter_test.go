package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Session ids are UUIDv7, so a greater id is a later session. These are in the order they were made.
const (
	reclaimOldestRunning = "0190a000-0000-7000-8000-000000000001"
	reclaimOldestPending = "0190b000-0000-7000-8000-000000000002"
	reclaimOldestIdle    = "0190c000-0000-7000-8000-000000000003"
	reclaimNewerRunning  = "0193a000-0000-7000-8000-000000000004"
	reclaimNewerPending  = "0193b000-0000-7000-8000-000000000005"
	reclaimNewerIdle     = "0193c000-0000-7000-8000-000000000006"
	reclaimNewestIdle    = "0195c000-0000-7000-8000-000000000007"
)

// The startup reclaim starts the sessions somebody is most likely waiting on first: RUNNING, then
// PENDING, then the idle rest, newest first in each tier. Takeovers keep the ascending id order every
// process agrees on.
func TestReclaimStartsRunningThenPendingThenIdleNewestFirst(t *testing.T) {
	snapshot := []ReclaimSession{
		{SessionID: reclaimOldestIdle, Status: stAwaitingInput},
		{SessionID: reclaimNewerPending, Status: stPending},
		{SessionID: reclaimOldestRunning, Status: stRunning},
		{SessionID: reclaimNewestIdle, Status: stInterrupted},
		{SessionID: reclaimOldestPending, Status: stPending},
		{SessionID: reclaimNewerIdle, Status: stAwaitingInput},
		{SessionID: reclaimNewerRunning, Status: stRunning},
	}
	status := map[string]string{}
	for _, s := range snapshot {
		status[s.SessionID] = s.Status
	}
	var mu sync.Mutex
	var takeovers []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
			_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: snapshot})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			mu.Lock()
			takeovers = append(takeovers, id)
			mu.Unlock()
			// A takeover of a queued turn moves it on: the order goes by the snapshot's status.
			answer := status[id]
			if answer == stPending {
				answer = stRunning
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": answer})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	starts, _, err := reclaimMissingSessions(context.Background(), NewTransport(srv.URL, "token"),
		func() map[string]bool { return map[string]bool{} }, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(starts))
	for _, s := range starts {
		got = append(got, s.job.SessionID)
	}
	want := []string{
		reclaimNewerRunning, reclaimOldestRunning,
		reclaimNewerPending, reclaimOldestPending,
		reclaimNewestIdle, reclaimNewerIdle, reclaimOldestIdle,
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("start order =\n  %v\nwant\n  %v", got, want)
	}
	ascending := []string{
		reclaimOldestRunning, reclaimOldestPending, reclaimOldestIdle,
		reclaimNewerRunning, reclaimNewerPending, reclaimNewerIdle, reclaimNewestIdle,
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(takeovers, ",") != strings.Join(ascending, ",") {
		t.Fatalf("takeover order = %v, want ascending ids %v", takeovers, ascending)
	}
}

// A legacy server's statusless row is RUNNING, and the order does not depend on how the snapshot came.
func TestOrderReclaimedStartsIsDeterministic(t *testing.T) {
	mk := func(id, status string) reclaimedStart {
		return reclaimedStart{job: &ClaimedSession{SessionID: id}, status: status}
	}
	want := "d,b,e,a,f,c"
	for _, in := range [][]reclaimedStart{
		{mk("a", stPending), mk("b", ""), mk("c", stAwaitingInput), mk("d", stRunning), mk("e", stPending), mk("f", stInterrupted)},
		{mk("f", stInterrupted), mk("e", stPending), mk("d", stRunning), mk("c", stAwaitingInput), mk("b", ""), mk("a", stPending)},
	} {
		orderReclaimedStarts(in)
		ids := make([]string, 0, len(in))
		for _, s := range in {
			ids = append(ids, s.job.SessionID)
		}
		if got := strings.Join(ids, ","); got != want {
			t.Fatalf("order = %s, want %s", got, want)
		}
	}
}

// supervisorLedger is the stub startSession's record: how many supervisors each session got, and how
// many starts of one session ever overlapped.
type supervisorLedger struct {
	mu         sync.Mutex
	registered map[string]int
	inFlight   map[string]int
	overlapped []string
	// reclaimStarts counts the starts the reclaim made of each session; reclaimEnded says one ended.
	reclaimStarts map[string]int
	reclaimEnded  map[string]bool
}

// claimStart is the claim loop's part for one claimed session: settle, then startSession. For a session
// the reclaim holds, the reclaim's own start must have ended by then.
func (l *supervisorLedger) claimStart(t *testing.T, starter *reclaimStarter, reclaimed bool, id string, startSession func(*ClaimedSession, bool)) {
	starter.settle(id)
	l.mu.Lock()
	ended := l.reclaimEnded[id]
	l.mu.Unlock()
	if reclaimed && !ended {
		t.Errorf("the claim for %s started before its reclaim start had ended", id)
	}
	startSession(poolJob(id), true)
}

func (l *supervisorLedger) begin(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inFlight[id]++
	if l.inFlight[id] > 1 {
		l.overlapped = append(l.overlapped, id)
	}
}

func (l *supervisorLedger) end(id string, added bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inFlight[id]--
	if added {
		l.registered[id]++
	}
}

// A restart with old sessions whose starts are slow: a new PENDING session is claimed and running while
// they are still being started, a claim for an old session still queued or still starting meets the
// supervisor its reclaim made, no session ever gets two, and each takeover's fence keeps merges out
// until its own session has started.
func TestAClaimRunsWhileTheReclaimStillStartsOlderSessions(t *testing.T) {
	pool := newSessionPool(4)
	ledger := &supervisorLedger{registered: map[string]int{}, inFlight: map[string]int{},
		reclaimStarts: map[string]int{}, reclaimEnded: map[string]bool{}}
	gates := map[string]chan struct{}{}
	for _, id := range []string{reclaimOldestRunning, reclaimOldestIdle, reclaimNewerIdle, reclaimNewestIdle} {
		gates[id] = make(chan struct{})
	}
	var startedMu sync.Mutex
	started := map[string]bool{}
	// startSession, stubbed: slow for the reclaimed sessions (until its gate opens), then the supervisor.
	startSession := func(job *ClaimedSession, initiallyActive bool) {
		ledger.begin(job.SessionID)
		startedMu.Lock()
		started[job.SessionID] = true
		startedMu.Unlock()
		if gate := gates[job.SessionID]; gate != nil {
			<-gate
		}
		_, added := pool.register(job, func() {}, initiallyActive)
		if !added && initiallyActive {
			pool.activate(job)
		}
		ledger.end(job.SessionID, added)
	}
	takenOver := func(id string, status string) reclaimedStart {
		_, endTakeover := pool.beginWorktreeTakeover(id)
		return reclaimedStart{job: poolJob(id), initiallyActive: reclaimInitiallyActive(status), endTakeover: endTakeover, status: status}
	}
	pending := []reclaimedStart{
		takenOver(reclaimOldestRunning, stRunning),
		takenOver(reclaimNewestIdle, stAwaitingInput),
		takenOver(reclaimNewerIdle, stAwaitingInput),
		takenOver(reclaimOldestIdle, stInterrupted),
	}
	orderReclaimedStarts(pending)
	starter := newReclaimStarter(pool, pending, func(p reclaimedStart) {
		ledger.mu.Lock()
		ledger.reclaimStarts[p.job.SessionID]++
		ledger.mu.Unlock()
		startSession(p.job, p.initiallyActive)
		ledger.mu.Lock()
		ledger.reclaimEnded[p.job.SessionID] = true
		ledger.mu.Unlock()
	})
	finishedLogged := make(chan struct{})
	starter.run(2, func() { close(finishedLogged) })

	// Two workers: the RUNNING session and the newest idle one are being started, the rest queued.
	waitUntil(t, func() bool {
		startedMu.Lock()
		defer startedMu.Unlock()
		return started[reclaimOldestRunning] && started[reclaimNewestIdle]
	}, "the two workers never started the first two sessions")
	// The RUNNING one already holds its slot, though it has no supervisor yet.
	if got := pool.admissionIdleCapacity(); got != 3 {
		t.Fatalf("idle capacity while a RUNNING session is being reclaimed = %d, want 3", got)
	}
	// Its checkout is live to a sweep, which does not run before the starts end anyway.
	if !pool.ids()[reclaimOldestIdle] || starter.finished() {
		t.Fatal("a session still being reclaimed reads as an orphan, or the reclaim reads as finished")
	}
	// No merge goes into a checkout whose supervisor is not there yet: the takeover fence still stands.
	if release, _, admitted := pool.beginManualWorktreeOperation(reclaimNewerIdle, nil, 0, false, "merge"); admitted {
		release()
		t.Fatal("a merge was admitted for a session whose reclaimed supervisor has not started")
	}

	// A new PENDING session is claimed: what the claim loop does with it (settle, then startSession).
	newSession := "0196b000-0000-7000-8000-000000000008"
	claimed := make(chan struct{})
	go func() {
		ledger.claimStart(t, starter, false, newSession, startSession)
		close(claimed)
	}()
	select {
	case <-claimed:
	case <-time.After(5 * time.Second):
		t.Fatal("the new session's claim waited for the reclaim of older sessions")
	}
	snap, _ := pool.heartbeatSnapshot()
	if s := snap[newSession].supervisor; s == nil || !pool.isActive(s) {
		t.Fatal("the claimed session is not running")
	}
	for _, id := range []string{reclaimOldestRunning, reclaimNewestIdle, reclaimNewerIdle, reclaimOldestIdle} {
		if snap[id].supervisor != nil {
			t.Fatalf("older session %s had started before the new one ran; the test proves nothing", id)
		}
	}

	// A claim for an old session still queued starts it on the claim loop first, then meets that supervisor.
	close(gates[reclaimNewerIdle])
	ledger.claimStart(t, starter, true, reclaimNewerIdle, startSession)

	// A claim for one a worker is starting waits for that start, and for nothing else.
	waited := make(chan struct{})
	go func() {
		ledger.claimStart(t, starter, true, reclaimNewestIdle, startSession)
		close(waited)
	}()
	select {
	case <-waited:
		t.Fatal("a claim did not wait for the start of the session a worker is reclaiming")
	case <-time.After(100 * time.Millisecond):
	}
	close(gates[reclaimNewestIdle])
	<-waited
	if starter.finished() {
		t.Fatal("the reclaim reads as finished while sessions are still starting")
	}

	close(gates[reclaimOldestRunning])
	close(gates[reclaimOldestIdle])
	starter.wait()
	select {
	case <-finishedLogged:
	case <-time.After(5 * time.Second):
		t.Fatal("the end of the reclaim was never reported")
	}

	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if len(ledger.overlapped) > 0 {
		t.Fatalf("two starts of one session overlapped: %v", ledger.overlapped)
	}
	for _, id := range []string{newSession, reclaimOldestRunning, reclaimNewestIdle, reclaimNewerIdle, reclaimOldestIdle} {
		if ledger.registered[id] != 1 {
			t.Fatalf("session %s got %d supervisors, want exactly 1", id, ledger.registered[id])
		}
	}
	for _, id := range []string{reclaimOldestRunning, reclaimNewestIdle, reclaimNewerIdle, reclaimOldestIdle} {
		if ledger.reclaimStarts[id] != 1 {
			t.Fatalf("the reclaim started %s %d times, want once", id, ledger.reclaimStarts[id])
		}
	}
	if ledger.reclaimStarts[newSession] != 0 {
		t.Fatal("the reclaim started a session it never took over")
	}
	if len(pool.reclaiming) != 0 {
		t.Fatalf("sessions still marked as being reclaimed after every start ended: %v", pool.reclaiming)
	}
	// Every takeover's fence came down with its own start: a cold supervisor's checkout takes a merge again.
	snap, _ = pool.heartbeatSnapshot()
	advertised := snap[reclaimOldestIdle]
	release, receipt, admitted := pool.beginManualWorktreeOperation(reclaimOldestIdle, advertised.supervisor, advertised.permitGeneration, false, "merge")
	if !admitted {
		t.Fatalf("a merge into a started cold session was refused: %s", receipt)
	}
	release()
}

// A reclaim with nothing to start has finished at once, and so has no reclaim at all.
func TestReclaimStarterWithNothingToStartIsFinished(t *testing.T) {
	var none *reclaimStarter
	if !none.finished() {
		t.Fatal("no reclaim reads as unfinished: the sweep would never arm")
	}
	none.settle("x")
	none.wait()
	empty := newReclaimStarter(newSessionPool(1), nil, func(reclaimedStart) { t.Fatal("started nothing") })
	empty.run(reclaimStartWorkers, nil)
	if !empty.finished() {
		t.Fatal("an empty reclaim reads as unfinished")
	}
}

// The run-loop wiring: the startup reclaim's starts go to the starter, the first heartbeat and the claim
// loop do not wait for them, a claim settles its session before taking it over, the sweep arms only once
// they have all ended, and the end is logged with the count and the time it took.
func TestRunLoopStartsTheStartupReclaimInTheBackground(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	loop := strings.Index(body, "\tfor loopCtx.Err() == nil {")
	if loop < 0 {
		t.Fatal("runLoop's claim loop was not found")
	}
	before, inLoop := body[:loop], body[loop:]
	for _, want := range []string{
		"startupStarts = newReclaimStarter(pool, pendingStarts,",
		"startupStarts.run(reclaimStartWorkers,",
		`"startup reclaim finished: %d session(s) in %s (snapshot and takeovers %s)"`,
		"armed: reclaimed && !reclaimSkipped && startupStarts.finished()}",
	} {
		if !strings.Contains(before, want) {
			t.Errorf("runLoop's startup no longer reads: %s", want)
		}
	}
	if strings.Contains(before, "startSession(pending.job, pending.initiallyActive)\n\t\t\tpending.endTakeover()") {
		t.Error("the startup reclaim starts its sessions inline again, holding the claim loop behind all of them")
	}
	arm := strings.Index(inLoop, "if armOnceStarted && startupStarts.finished() {")
	if arm < 0 || !strings.Contains(inLoop[arm:arm+strings.Index(inLoop[arm:], "\n\t\t}\n")], "worktreeGC.armed = true\n\t\t\tpool.endUnclaimedHostlessJobs()") {
		t.Error("the claim loop does not arm the sweep, and end unclaimed jobs, once the startup starts have ended")
	}
	settle := strings.Index(inLoop, "startupStarts.settle(job.SessionID)")
	prepare := strings.Index(inLoop, "endTakeover, prepareErr := prepareTakeover(job)")
	if settle < 0 || prepare < settle || strings.Index(inLoop, "\t\tif job == nil {") > settle {
		t.Error("a claimed session is taken over before its reclaim start has settled")
	}
}

// A merge or commit the heartbeat delivers for a session the reclaim has not started yet is left for a
// later beat, not answered with the takeover fence's refusal: the control plane hands a pending one over
// again on every beat. Once the start has ended, a beat is asked for, and the next delivery runs it
// against the supervisor the start made. One delivered on a request made while the start was still
// running waits too, even if the start has ended by the time the answer comes.
func TestAHeartbeatMergeOrCommitForAReclaimingSessionWaitsForItsStart(t *testing.T) {
	const id = reclaimOldestIdle
	pool := newSessionPool(2)
	gate := make(chan struct{})
	entered := make(chan struct{})
	_, endTakeover := pool.beginWorktreeTakeover(id)
	starter := newReclaimStarter(pool, []reclaimedStart{{job: poolJob(id), endTakeover: endTakeover, status: stAwaitingInput}},
		func(p reclaimedStart) {
			close(entered)
			<-gate
			pool.register(p.job, func() {}, false)
		})
	var deferred reclaimDeferredOps
	beats := make(chan struct{}, 4)
	beatNow := func() { beats <- struct{}{} }
	starter.onStarted = func(sessionID string) { deferred.started(sessionID, beatNow) }
	starter.run(1, nil)
	<-entered

	telemetry := newHeartbeatTelemetryProbe(time.Hour, func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample { return nil })
	var merges, commits int
	merge := MergeCommand{SessionID: id, OperationID: "op-merge", WorkDir: t.TempDir()}
	commit := CommitCommand{SessionID: id, OperationID: "op-commit"}
	// What each of the heartbeat's two loops does with a delivered command (runloop.go).
	deliver := func(supervisors map[string]heartbeatSupervisorSnapshot) (mergeRes, commitRes []string) {
		if !deferred.deferForReclaim(pool, id, "merge", supervisors[id], beatNow) {
			mergeRes = append(mergeRes, heartbeatMerge(pool, merge, supervisors[id], func(MergeCommand) mergeOutcome {
				merges++
				return mergeOutcome{Status: "merged"}
			}).Status)
		}
		if !deferred.deferForReclaim(pool, id, "commit", supervisors[id], beatNow) {
			commitRes = append(commitRes, heartbeatCommit(pool, commit, supervisors[id], func(CommitCommand) commitOutcome {
				commits++
				return commitOutcome{Status: "committed"}
			}).Status)
		}
		return mergeRes, commitRes
	}

	// Delivered while the start is still running: no result of either, nothing run.
	early, _ := pool.heartbeatSnapshot()
	if s := early[id]; !s.reclaiming || s.supervisor != nil {
		t.Fatalf("snapshot of a session still being reclaimed = %+v, want reclaiming with no supervisor", s)
	}
	if m, c := deliver(early); len(m) != 0 || len(c) != 0 || merges != 0 || commits != 0 {
		t.Fatalf("a merge/commit for a session still being reclaimed was answered: merge %v, commit %v", m, c)
	}
	// Nothing reclaiming is advertised as supervised.
	if _, supervised, _, _ := heartbeatSessionSnapshot(pool, telemetry); len(supervised) != 0 {
		t.Fatalf("supervised ids while the start runs = %v, want none", supervised)
	}

	// Another request made now, answered only after the start has ended: still left for later.
	late, _ := pool.heartbeatSnapshot()
	close(gate)
	starter.wait()
	select {
	case <-beats:
	case <-time.After(5 * time.Second):
		t.Fatal("no beat was asked for once the session the merge waited for had started")
	}
	if m, c := deliver(late); len(m) != 0 || len(c) != 0 || merges != 0 || commits != 0 {
		t.Fatalf("an answer to a request made during the start was carried out against it: merge %v, commit %v", m, c)
	}

	// The next delivery runs each, once, against the supervisor the start made.
	now, _ := pool.heartbeatSnapshot()
	if s := now[id]; s.reclaiming || s.supervisor == nil {
		t.Fatalf("snapshot after the start = %+v, want a supervisor and not reclaiming", s)
	}
	m, c := deliver(now)
	if strings.Join(m, ",") != "merged" || strings.Join(c, ",") != "committed" || merges != 1 || commits != 1 {
		t.Fatalf("after the start: merge %v (ran %d), commit %v (ran %d); want each run once", m, merges, c, commits)
	}
	if _, supervised, _, _ := heartbeatSessionSnapshot(pool, telemetry); strings.Join(supervised, ",") != id {
		t.Fatalf("supervised ids after the start = %v, want [%s]", supervised, id)
	}
}

// Both heartbeat loops ask deferForReclaim before they take the operation on, and the starter is wired to it.
func TestRunLoopDefersHeartbeatWorktreeOperationsForReclaimingSessions(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	for _, loop := range []struct{ snapshot, check, busy string }{
		{"snapshot := supervisors[m.SessionID]", `reclaimDeferred.deferForReclaim(pool, m.SessionID, "merge", snapshot, beatNow)`, "busy := mergingNow[m.SessionID]"},
		{"snapshot := supervisors[c.SessionID]", "reclaimDeferred.deferForReclaim(pool, c.SessionID, operation, snapshot, beatNow)", "busy := committingNow[c.SessionID]"},
	} {
		at, check, busy := strings.Index(body, loop.snapshot), strings.Index(body, loop.check), strings.Index(body, loop.busy)
		if at < 0 || check < at || busy < check {
			t.Errorf("the heartbeat takes an operation on before asking whether its session is still being reclaimed: %s", loop.check)
		}
	}
	if !strings.Contains(body, "startupStarts.onStarted = func(id string) { reclaimDeferred.started(id, beatNow) }\n\t\tstartupStarts.run(") {
		t.Error("the starter does not ask for a beat when a session an operation waited for has started")
	}
}
