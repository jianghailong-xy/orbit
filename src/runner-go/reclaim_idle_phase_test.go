package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// idleFakeServer is a control plane for the startup reclaim's two phases: a reclaim snapshot, and a
// takeover-leases that is deliberately slow and enforces the lease owner CAS the server does (409 when
// expectedLeaseOwner is not the row's owner). It records every takeover in the order it answered, and
// what had answered when the first claim came in.
type idleFakeServer struct {
	mu       sync.Mutex
	snapshot []ReclaimSession
	status   map[string]string
	owner    map[string]string
	delay    time.Duration
	// gate, if set for a session, holds its takeover until closed; entered is closed when one arrives.
	gate    map[string]chan struct{}
	entered map[string]chan struct{}
	// conflict answers every takeover of these sessions 409.
	conflict map[string]bool
	// batch serves POST /runner/sessions/takeover-leases; unset, it answers 404 as a control plane from
	// before it does. batches records the sessions each batch named, in the order they were named.
	batch   bool
	batches [][]string
	// batchRefusals counts the batch takeovers answered 404, singles the single takeovers answered.
	batchRefusals int
	singles       int

	answered  []string
	reclaims  int
	claims    int
	atClaim   []string
	claimSeen chan struct{}
}

func newIdleFakeServer(snapshot []ReclaimSession, delay time.Duration) *idleFakeServer {
	s := &idleFakeServer{snapshot: snapshot, status: map[string]string{}, owner: map[string]string{},
		delay: delay, gate: map[string]chan struct{}{}, entered: map[string]chan struct{}{},
		conflict: map[string]bool{}, claimSeen: make(chan struct{})}
	for _, r := range snapshot {
		s.status[r.SessionID] = r.Status
		s.owner[r.SessionID] = r.LeaseOwner
	}
	return s
}

func (s *idleFakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
		s.mu.Lock()
		s.reclaims++
		rows := make([]ReclaimSession, 0, len(s.snapshot))
		for _, row := range s.snapshot {
			row.LeaseOwner = s.owner[row.SessionID]
			rows = append(rows, row)
		}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: rows})
	case r.Method == http.MethodPost && r.URL.Path == "/api/runner/sessions/takeover-leases":
		s.serveBatch(w, r)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
		parts := strings.Split(r.URL.Path, "/")
		id := parts[len(parts)-2]
		var body struct {
			LeaseOwner         string  `json:"leaseOwner"`
			ExpectedLeaseOwner *string `json:"expectedLeaseOwner"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		gate, entered, conflict := s.gate[id], s.entered[id], s.conflict[id]
		if entered != nil {
			delete(s.entered, id)
		}
		s.mu.Unlock()
		if entered != nil {
			close(entered)
		}
		if gate != nil {
			<-gate
		}
		time.Sleep(s.delay)
		expected := ""
		if body.ExpectedLeaseOwner != nil {
			expected = *body.ExpectedLeaseOwner
		}
		s.mu.Lock()
		if conflict || expected != s.owner[id] {
			s.mu.Unlock()
			http.Error(w, `{"message":"lease owner changed"}`, http.StatusConflict)
			return
		}
		s.owner[id] = body.LeaseOwner
		s.answered = append(s.answered, id)
		s.singles++
		answer := s.status[id]
		if answer == stPending {
			answer = stRunning
		}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": answer})
	case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/claim":
		s.mu.Lock()
		s.claims++
		if s.claims == 1 {
			s.atClaim = append([]string(nil), s.answered...)
			close(s.claimSeen)
		}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{})
	default:
		http.NotFound(w, r)
	}
}

// serveBatch is the batch takeover: every row judged as the single takeover judges it, one request.
func (s *idleFakeServer) serveBatch(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	batch := s.batch
	s.mu.Unlock()
	if !batch {
		s.mu.Lock()
		s.batchRefusals++
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	var body struct {
		LeaseOwner string `json:"leaseOwner"`
		Sessions   []struct {
			SessionID          string  `json:"sessionId"`
			ExpectedLeaseOwner *string `json:"expectedLeaseOwner"`
		} `json:"sessions"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	time.Sleep(s.delay)
	results := make([]map[string]interface{}, 0, len(body.Sessions))
	named := make([]string, 0, len(body.Sessions))
	s.mu.Lock()
	for _, row := range body.Sessions {
		id := row.SessionID
		named = append(named, id)
		expected := ""
		if row.ExpectedLeaseOwner != nil {
			expected = *row.ExpectedLeaseOwner
		}
		if s.conflict[id] || expected != s.owner[id] {
			results = append(results, map[string]interface{}{"sessionId": id,
				"error": map[string]interface{}{"statusCode": 409, "message": "inbox lease owner changed; refresh the session snapshot"}})
			continue
		}
		s.owner[id] = body.LeaseOwner
		s.answered = append(s.answered, id)
		answer := s.status[id]
		if answer == stPending {
			answer = stRunning
		}
		results = append(results, map[string]interface{}{"sessionId": id, "status": answer})
	}
	s.batches = append(s.batches, named)
	s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "results": results})
}

func (s *idleFakeServer) takeoversAnswered() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.answered...)
}

func idleTestID(i int) string {
	return fmt.Sprintf("0190%04x-0000-7000-8000-%012x", i, i)
}

// startupReclaimRig is the startup reclaim as runLoop wires it (runloop.go, from reclaimWaitedOnSessions
// to the takeOverIdle goroutine), with startSession stubbed to register the supervisor.
type startupReclaimRig struct {
	t        *testing.T
	ctx      context.Context
	pool     *sessionPool
	tr       *Transport
	starter  *reclaimStarter
	pending  []reclaimedStart
	idle     []*ClaimedSession
	ledger   *supervisorLedger
	deferred reclaimDeferredOps
	beats    chan struct{}
	idleErr  chan error
}

func (rig *startupReclaimRig) prepare(job *ClaimedSession) (func(), error) {
	return prepareLocalSupervisorTakeover(rig.ctx, rig.pool, job, rig.tr.leaseOwner)
}

// startSession is the stub: one supervisor per session, woken by a later claim.
func (rig *startupReclaimRig) startSession(job *ClaimedSession, initiallyActive bool) {
	rig.ledger.begin(job.SessionID)
	_, added := rig.pool.register(job, func() {}, initiallyActive)
	if !added && initiallyActive {
		rig.pool.activate(job)
	}
	rig.ledger.end(job.SessionID, added)
}

func startStartupReclaim(t *testing.T, srv *httptest.Server, maxConcurrent int) *startupReclaimRig {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rig := &startupReclaimRig{t: t, ctx: ctx, pool: newSessionPool(maxConcurrent), tr: NewTransport(srv.URL, "token"),
		ledger: &supervisorLedger{registered: map[string]int{}, inFlight: map[string]int{},
			reclaimStarts: map[string]int{}, reclaimEnded: map[string]bool{}},
		beats: make(chan struct{}, 1024), idleErr: make(chan error, 1)}
	pending, idle, skipped, err := reclaimWaitedOnSessions(ctx, rig.tr, rig.pool.reclaimStates, rig.prepare)
	if err != nil || skipped {
		t.Fatalf("priority phase: skipped %v, err %v", skipped, err)
	}
	rig.pending, rig.idle = pending, idle
	rig.starter = newReclaimStarter(rig.pool, pending, idle, func(p reclaimedStart) {
		rig.ledger.mu.Lock()
		rig.ledger.reclaimStarts[p.job.SessionID]++
		rig.ledger.mu.Unlock()
		rig.startSession(p.job, p.initiallyActive)
		rig.ledger.mu.Lock()
		rig.ledger.reclaimEnded[p.job.SessionID] = true
		rig.ledger.mu.Unlock()
	})
	rig.starter.onStarted = func(id string) { rig.deferred.started(id, func() { rig.beats <- struct{}{} }) }
	rig.starter.takeover = func(job *ClaimedSession) (func(), string, error) {
		endTakeover, err := rig.prepare(job)
		if err != nil {
			return nil, "", err
		}
		status, err := takeoverClaimedSession(ctx, rig.tr, job)
		if err != nil {
			endTakeover()
			return nil, "", err
		}
		return endTakeover, status, nil
	}
	rig.starter.batchSize = rig.tr.takeoverBatchSize
	rig.starter.takeoverMany = batchIdleTakeover(ctx, rig.tr, rig.prepare)
	rig.starter.run(reclaimStartWorkers, nil)
	go func() {
		rig.idleErr <- rig.starter.takeOverIdle(ctx, func(ctx context.Context) ([]ReclaimSession, error) {
			return reclaimSnapshot(ctx, rig.tr)
		})
	}()
	return rig
}

// claim is the claim loop's part for one claimed session (runloop.go): settle, the lease owner a reclaim
// takeover replaced, the claim's own takeover, then startSession.
func (rig *startupReclaimRig) claim(job *ClaimedSession) error {
	if replaced, tookOver := rig.starter.settle(job.SessionID); tookOver && strings.EqualFold(job.LeaseOwner, replaced) {
		job.LeaseOwner = rig.tr.leaseOwner
	}
	endTakeover, err := rig.prepare(job)
	if err != nil {
		return err
	}
	defer endTakeover()
	status, err := takeoverClaimedSession(rig.ctx, rig.tr, job)
	if err != nil {
		return err
	}
	if reclaimStatusOpen(status) {
		rig.startSession(job, reclaimInitiallyActive(status))
	}
	return nil
}

func (rig *startupReclaimRig) finish() {
	rig.t.Helper()
	select {
	case err := <-rig.idleErr:
		if err != nil {
			rig.t.Fatalf("idle phase: %v", err)
		}
	case <-time.After(60 * time.Second):
		rig.t.Fatal("the idle phase never ended")
	}
	done := make(chan struct{})
	go func() { rig.starter.wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		rig.t.Fatal("the startup reclaim's starts never ended")
	}
}

// Criterion 1: 300 idle sessions and five somebody may be waiting on (three RUNNING, two PENDING), with a
// takeover that takes 10 ms. The claim loop's first claim goes out once the five have answered, while
// the idle takeovers are still being made in the background; each phase takes its rows over in
// ascending id order, every session ends with exactly one supervisor, and nothing the sweep would read
// as an orphan is missing from what it is told is live until the idle phase and every start have ended.
func TestTheFirstClaimGoesOutOnceTheWaitedOnTakeoversHaveAnswered(t *testing.T) {
	var snapshot []ReclaimSession
	priority := map[string]bool{}
	var priorityIDs, idleIDs []string
	for i := 0; i < 305; i++ {
		id := idleTestID(i)
		status := stAwaitingInput
		if i%2 == 1 {
			status = stInterrupted
		}
		switch i {
		case 7, 120, 290:
			status = stRunning
		case 64, 201:
			status = stPending
		}
		if reclaimWaitedOn(status) {
			priority[id] = true
			priorityIDs = append(priorityIDs, id)
		} else {
			idleIDs = append(idleIDs, id)
		}
		snapshot = append(snapshot, ReclaimSession{SessionID: id, Status: status, LeaseOwner: "old-process", Provider: providerClaude})
	}
	// The snapshot comes back in no particular order.
	sort.SliceStable(snapshot, func(i, j int) bool { return snapshot[i].SessionID > snapshot[j].SessionID })
	fake := newIdleFakeServer(snapshot, 10*time.Millisecond)
	srv := httptest.NewServer(fake)
	defer srv.Close()

	began := time.Now()
	rig := startStartupReclaim(t, srv, 8)
	answeredIn := time.Since(began)
	if len(rig.pending) != 5 || len(rig.idle) != 300 {
		t.Fatalf("priority phase handed %d starts and left %d idle, want 5 and 300", len(rig.pending), len(rig.idle))
	}
	for i, job := range rig.idle {
		if job.SessionID != idleIDs[i] {
			t.Fatalf("idle session %d is %s, want %s: the idle phase is not in ascending id order", i, job.SessionID, idleIDs[i])
		}
	}

	// What runLoop does next: the claim loop's first claim.
	var claims linkRequestIDs
	if job, err := rig.tr.claimSession(rig.ctx, &claims); err != nil || job != nil {
		t.Fatalf("first claim = %v, %v", job, err)
	}
	<-fake.claimSeen
	fake.mu.Lock()
	atClaim := append([]string(nil), fake.atClaim...)
	fake.mu.Unlock()
	if len(atClaim) < 5 {
		t.Fatalf("the first claim went out with %d takeovers answered, before the five waited-on ones", len(atClaim))
	}
	for i, id := range atClaim[:5] {
		if id != priorityIDs[i] {
			t.Fatalf("takeover %d answered for %s, want %s: the waited-on sessions go first, in ascending id order", i, id, priorityIDs[i])
		}
	}
	idleAtClaim := len(atClaim) - 5
	if idleAtClaim >= 300 {
		t.Fatal("every idle takeover had answered before the first claim: the claim loop still waited for them")
	}
	if rig.starter.finished() {
		t.Fatal("the startup reclaim reads as finished while idle takeovers are still being made")
	}
	// The sweep (gcWorktrees) is told every idle session is live, taken over yet or not.
	live := rig.pool.ids()
	for _, id := range idleIDs {
		if !live[id] {
			t.Fatalf("idle session %s, not taken over yet, reads as an orphan checkout", id)
		}
	}
	t.Logf("first claim after %s, with %d of 300 idle takeovers answered", answeredIn.Round(time.Millisecond), idleAtClaim)

	rig.finish()
	answered := fake.takeoversAnswered()
	if len(answered) != 305 {
		t.Fatalf("%d takeovers answered, want 305", len(answered))
	}
	for i, id := range answered[5:] {
		if id != idleIDs[i] {
			t.Fatalf("idle takeover %d answered for %s, want %s: not in ascending id order", i, id, idleIDs[i])
		}
	}
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	if len(rig.ledger.overlapped) > 0 {
		t.Fatalf("two starts of one session overlapped: %v", rig.ledger.overlapped)
	}
	for _, r := range snapshot {
		if rig.ledger.registered[r.SessionID] != 1 {
			t.Fatalf("session %s got %d supervisors, want 1", r.SessionID, rig.ledger.registered[r.SessionID])
		}
	}
	if handed, took := rig.starter.idlePhase(); handed != 300 || took <= 0 {
		t.Fatalf("idle phase reports %d sessions in %s, want 300 in some time", handed, took)
	}
	if rig.starter.setAside() || len(rig.pool.reclaiming) != 0 {
		t.Fatalf("set aside %v, still reclaiming %v", rig.starter.setAside(), rig.pool.reclaiming)
	}
}

// Criterion 2: a claim for an idle session whose takeover has not been made yet (the idle phase is held
// on an older one). Before the claim, a heartbeat merge and commit for it are deferred, not answered, and
// it is not advertised as supervised. The claim, answered with the old process as the lease owner, makes
// the takeover and start on the claim loop and then its own takeover, which the lease owner CAS does not
// refuse; the session ends with exactly one supervisor, and the idle phase does not take it over again.
func TestAClaimForAnIdleSessionNotTakenOverYetGetsOneSupervisor(t *testing.T) {
	var snapshot []ReclaimSession
	for i := 0; i < 11; i++ {
		status := stAwaitingInput
		if i == 0 {
			status = stRunning
		}
		snapshot = append(snapshot, ReclaimSession{SessionID: idleTestID(i), Status: status, LeaseOwner: "old-process", Provider: providerClaude})
	}
	held, claimed := idleTestID(1), idleTestID(6)
	fake := newIdleFakeServer(snapshot, 5*time.Millisecond)
	gate, entered := make(chan struct{}), make(chan struct{})
	fake.gate[held], fake.entered[held] = gate, entered
	srv := httptest.NewServer(fake)
	defer srv.Close()

	rig := startStartupReclaim(t, srv, 4)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the idle phase never reached its first takeover")
	}

	// A heartbeat merge and commit for the session, delivered now.
	telemetry := newHeartbeatTelemetryProbe(time.Hour, func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample { return nil })
	snap, _ := rig.pool.heartbeatSnapshot()
	if s := snap[claimed]; !s.reclaiming || s.supervisor != nil {
		t.Fatalf("snapshot of an idle session not taken over yet = %+v, want reclaiming with no supervisor", s)
	}
	beatNow := func() { rig.beats <- struct{}{} }
	ran := 0
	if !rig.deferred.deferForReclaim(rig.pool, claimed, "merge", snap[claimed], beatNow) {
		heartbeatMerge(rig.pool, MergeCommand{SessionID: claimed, OperationID: "op-merge", WorkDir: t.TempDir()}, snap[claimed],
			func(MergeCommand) mergeOutcome { ran++; return mergeOutcome{Status: "merged"} })
		t.Fatal("a merge for an idle session not taken over yet was answered")
	}
	if !rig.deferred.deferForReclaim(rig.pool, claimed, "commit", snap[claimed], beatNow) {
		heartbeatCommit(rig.pool, CommitCommand{SessionID: claimed, OperationID: "op-commit"}, snap[claimed],
			func(CommitCommand) commitOutcome { ran++; return commitOutcome{Status: "committed"} })
		t.Fatal("a commit for an idle session not taken over yet was answered")
	}
	if _, supervised, _, _ := heartbeatSessionSnapshot(rig.pool, telemetry); strings.Contains(strings.Join(supervised, ","), claimed) {
		t.Fatalf("an idle session not taken over yet is advertised as supervised: %v", supervised)
	}

	// The claim, answered before any takeover of the session: it names the old process. The claim moved
	// the row to RUNNING.
	fake.mu.Lock()
	fake.status[claimed] = stRunning
	fake.mu.Unlock()
	job := claimedSessionFromReclaim(snapshot[6])
	job.Reclaimed = false
	if err := rig.claim(job); err != nil {
		t.Fatalf("the claim for an idle session not taken over yet failed: %v", err)
	}
	if answered := fake.takeoversAnswered(); len(answered) < 3 || answered[1] != claimed || answered[2] != claimed {
		t.Fatalf("takeovers answered %v: want the claimed session's reclaim takeover, then its claim's, while the idle phase is held", answered)
	}
	select {
	case <-rig.beats:
	case <-time.After(5 * time.Second):
		t.Fatal("no beat was asked for once the session the deferred merge and commit waited for had started")
	}
	// The next delivery runs against the supervisor that start made.
	snap, _ = rig.pool.heartbeatSnapshot()
	if s := snap[claimed]; s.reclaiming || s.supervisor == nil || !rig.pool.isActive(s.supervisor) {
		t.Fatalf("snapshot after the claim = %+v, want an active supervisor and not reclaiming", s)
	}
	if rig.deferred.deferForReclaim(rig.pool, claimed, "merge", snap[claimed], beatNow) {
		t.Fatal("a merge for the claimed session is still deferred once it has its supervisor")
	}

	close(gate)
	rig.finish()
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	if len(rig.ledger.overlapped) > 0 {
		t.Fatalf("two starts of one session overlapped: %v", rig.ledger.overlapped)
	}
	for _, r := range snapshot {
		if rig.ledger.registered[r.SessionID] != 1 {
			t.Fatalf("session %s got %d supervisors, want exactly 1", r.SessionID, rig.ledger.registered[r.SessionID])
		}
	}
	if rig.ledger.reclaimStarts[claimed] != 1 {
		t.Fatalf("the reclaim started the claimed session %d times, want once", rig.ledger.reclaimStarts[claimed])
	}
	count := 0
	for _, id := range fake.takeoversAnswered() {
		if id == claimed {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("the claimed session was taken over %d times, want twice (its reclaim, its claim)", count)
	}
	if ran != 0 {
		t.Fatal("a deferred operation ran")
	}
}

// A claim for an idle session the idle phase is taking over right now waits for that takeover and its
// start, and meets that supervisor.
func TestAClaimForAnIdleSessionBeingTakenOverWaitsForIt(t *testing.T) {
	snapshot := []ReclaimSession{
		{SessionID: idleTestID(1), Status: stAwaitingInput, LeaseOwner: "old-process", Provider: providerClaude},
		{SessionID: idleTestID(2), Status: stAwaitingInput, LeaseOwner: "old-process", Provider: providerClaude},
	}
	held := idleTestID(1)
	fake := newIdleFakeServer(snapshot, time.Millisecond)
	gate, entered := make(chan struct{}), make(chan struct{})
	fake.gate[held], fake.entered[held] = gate, entered
	srv := httptest.NewServer(fake)
	defer srv.Close()
	rig := startStartupReclaim(t, srv, 4)
	<-entered

	claimed := make(chan error, 1)
	go func() { claimed <- rig.claim(claimedSessionFromReclaim(snapshot[0])) }()
	select {
	case err := <-claimed:
		t.Fatalf("the claim did not wait for the takeover being made (err %v)", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(gate)
	if err := <-claimed; err != nil {
		t.Fatalf("claim: %v", err)
	}
	rig.finish()
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	if rig.ledger.registered[held] != 1 || len(rig.ledger.overlapped) > 0 {
		t.Fatalf("session %s got %d supervisors (overlaps %v), want 1", held, rig.ledger.registered[held], rig.ledger.overlapped)
	}
}

// A 409 in the idle phase is handled as the blocking reclaim handles one: the snapshot is refreshed a
// bounded number of times, then the session is set aside (setAside, which schedules the deferred
// retry), with no supervisor and no longer counted as being reclaimed; the rest are taken over.
func TestAnIdleTakeoverConflictIsSetAsideAfterBoundedRefreshes(t *testing.T) {
	var snapshot []ReclaimSession
	for i := 0; i < 4; i++ {
		snapshot = append(snapshot, ReclaimSession{SessionID: idleTestID(i), Status: stInterrupted, LeaseOwner: "old-process", Provider: providerClaude})
	}
	conflicted := idleTestID(2)
	fake := newIdleFakeServer(snapshot, time.Millisecond)
	fake.conflict[conflicted] = true
	srv := httptest.NewServer(fake)
	defer srv.Close()
	rig := startStartupReclaim(t, srv, 4)
	rig.finish()
	if !rig.starter.setAside() {
		t.Fatal("a session set aside over takeover conflicts does not schedule the deferred retry")
	}
	fake.mu.Lock()
	refreshes := fake.reclaims - 1
	fake.mu.Unlock()
	if refreshes != takeoverConflictLimit-1 {
		t.Fatalf("%d snapshot refreshes, want %d", refreshes, takeoverConflictLimit-1)
	}
	if rig.pool.isReclaiming(conflicted) {
		t.Fatal("a session set aside still reads as being reclaimed")
	}
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	for _, r := range snapshot {
		want := 1
		if r.SessionID == conflicted {
			want = 0
		}
		if rig.ledger.registered[r.SessionID] != want {
			t.Fatalf("session %s got %d supervisors, want %d", r.SessionID, rig.ledger.registered[r.SessionID], want)
		}
	}
	if handed, _ := rig.starter.idlePhase(); handed != 3 {
		t.Fatalf("idle phase handed %d sessions over, want 3", handed)
	}
}

// Criterion 4: the line the startup reclaim ends with reports each phase on its own.
func TestStartupReclaimFinishedLineReportsEachPhase(t *testing.T) {
	got := startupReclaimFinishedLine(3*time.Minute+50628*time.Millisecond, 5, 2750*time.Millisecond, 334, 3*time.Minute+3351*time.Millisecond)
	want := "startup reclaim finished: 339 session(s) in 3m50.628s (priority: 5 session(s), snapshot and takeovers 2.75s; idle: 334 session(s), takeovers 3m3.351s)"
	if got != want {
		t.Fatalf("line = %q\nwant   %q", got, want)
	}
}
