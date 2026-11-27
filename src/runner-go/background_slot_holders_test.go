package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// A session whose turn ended but whose runner-hosted job still runs holds a slot of the admission count, and the
// heartbeat names it (backgroundJobSessionIds) so the control plane can show it as running. A watch takes no slot and
// is not named; a job that ended frees its slot and its name; a session with a turn permit is counted by its turn, not
// named again. A full runner takes no claim it cannot start (TestAFullRunnerNeverTakesAndParksAClaim).
func TestTheHeartbeatNamesTheSessionsAJobAloneHoldsASlotFor(t *testing.T) {
	pool := newSessionPool(5)
	registerPoolSession(t, pool, "turn", true)
	ctx, cancel := context.WithCancel(context.Background())
	var tailers []*bgTailer
	tailerFor := func(sessionID string) *bgTailer {
		events := &bgJobEvents{}
		bg := newBgTailer(ctx, events.emit, pool.worktreeHoldsFor(sessionID))
		tailers = append(tailers, bg)
		return bg
	}
	t.Cleanup(func() {
		for _, bg := range tailers {
			for _, job := range bg.listJobs(false) {
				bg.killJob(job.JobID, bgKillTeardownGrace)
			}
			bg.stopAll()
		}
		cancel()
	})
	start := func(bg *bgTailer, kind string) bgJobStatus {
		t.Helper()
		job, err := bg.startJob(bgJobSpec{Command: "exec sleep 300", Kind: kind, Dir: t.TempDir(), ScratchDir: t.TempDir()})
		if err != nil {
			t.Fatalf("a %s job was refused: %v", kind, err)
		}
		return job
	}
	start(tailerFor("turn"), bgKindJob)   // has a turn permit too: counted by it
	start(tailerFor("jobber"), bgKindJob) // no turn: held by its job alone
	start(tailerFor("watcher"), "watch")  // waits only: takes no slot
	endedTailer := tailerFor("ended")
	ended := start(endedTailer, bgKindJob)

	beat := func() HeartbeatRequest {
		t.Helper()
		var sent HeartbeatRequest
		telemetry := newHeartbeatTelemetryProbe(time.Hour, nil)
		if _, _, err := sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, func(r HeartbeatRequest) (*HeartbeatResponse, error) {
			sent = r
			return &HeartbeatResponse{}, nil
		}); err != nil {
			t.Fatal(err)
		}
		return sent
	}

	sent := beat()
	if want := []string{"ended", "jobber"}; !reflect.DeepEqual(sent.BackgroundJobSessionIDs, want) {
		t.Fatalf("backgroundJobSessionIds = %v, want %v", sent.BackgroundJobSessionIDs, want)
	}
	// turn, jobber and ended occupy 3 of 5: the report and admission read one count.
	if sent.IdleCapacity != 2 || pool.admissionIdleCapacity() != 2 {
		t.Fatalf("idle capacity = %d (admission %d), want 2", sent.IdleCapacity, pool.admissionIdleCapacity())
	}

	endedTailer.killJob(ended.JobID, bgKillTeardownGrace)
	awaitCondition(t, 10*time.Second, "the ended job's slot never came back", func() bool {
		return pool.admissionIdleCapacity() == 3
	})
	sent = beat()
	if want := []string{"jobber"}; !reflect.DeepEqual(sent.BackgroundJobSessionIDs, want) {
		t.Fatalf("after the job ended, backgroundJobSessionIds = %v, want %v", sent.BackgroundJobSessionIDs, want)
	}
	if sent.IdleCapacity != 3 {
		t.Fatalf("after the job ended, idle capacity = %d, want 3", sent.IdleCapacity)
	}

	// Draining offers nothing, and the job holder still holds its slot, so it is still named.
	sent = func() HeartbeatRequest {
		var got HeartbeatRequest
		_, _, _ = sendHeartbeatCycle(pool, newHeartbeatTelemetryProbe(time.Hour, nil), HeartbeatRequest{Draining: true},
			func(r HeartbeatRequest) (*HeartbeatResponse, error) { got = r; return &HeartbeatResponse{}, nil })
		return got
	}()
	if sent.IdleCapacity != 0 || !reflect.DeepEqual(sent.BackgroundJobSessionIDs, []string{"jobber"}) {
		t.Fatalf("draining beat: idle %d, holders %v", sent.IdleCapacity, sent.BackgroundJobSessionIDs)
	}
}

// With no job holder the member is left out of the body, as an older runner leaves it out.
func TestAHeartbeatWithNoJobHolderOmitsTheMember(t *testing.T) {
	pool := newSessionPool(2)
	registerPoolSession(t, pool, "turn", true)
	idle, holders := pool.admissionOccupancy()
	if idle != 1 || holders != nil {
		t.Fatalf("occupancy = %d, %v; want 1, none", idle, holders)
	}
	raw, err := json.Marshal(HeartbeatRequest{IdleCapacity: idle, BackgroundJobSessionIDs: holders})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	_ = json.Unmarshal(raw, &body)
	if _, ok := body["backgroundJobSessionIds"]; ok {
		t.Fatalf("the body carries backgroundJobSessionIds with no holder: %v", body)
	}
}

// sleepJobs starts one live runner-hosted job (kind job) for each session named, and stops them all at cleanup. stop
// ends the job of one of them.
func sleepJobs(t *testing.T, pool *sessionPool, sessionIDs ...string) (stop func(sessionID string)) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	tailers := map[string]*bgTailer{}
	t.Cleanup(func() {
		for _, bg := range tailers {
			for _, job := range bg.listJobs(false) {
				bg.killJob(job.JobID, bgKillTeardownGrace)
			}
			bg.stopAll()
		}
		cancel()
	})
	for _, id := range sessionIDs {
		events := &bgJobEvents{}
		bg := newBgTailer(ctx, events.emit, pool.worktreeHoldsFor(id))
		tailers[id] = bg
		if _, err := bg.startJob(bgJobSpec{Command: "exec sleep 300", Kind: bgKindJob, Dir: t.TempDir(), ScratchDir: t.TempDir()}); err != nil {
			t.Fatalf("the job of %s was refused: %v", id, err)
		}
	}
	return func(sessionID string) {
		bg := tailers[sessionID]
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
	}
}

// slotReturns is a control plane taking back the claims a full runner gives back (sessionPool.returnFullSlot).
type slotReturns struct {
	mu     sync.Mutex
	ids    []string
	answer func(sessionID string) (string, bool, error)
}

func (r *slotReturns) install(pool *sessionPool) {
	installFullSlotReturns(pool, func(sessionID string) (string, bool, error) {
		r.mu.Lock()
		r.ids = append(r.ids, sessionID)
		answer := r.answer
		r.mu.Unlock()
		if answer != nil {
			return answer(sessionID)
		}
		return stPending, true, nil
	})
}

func (r *slotReturns) returned() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.ids...)
}

// waitActiveFor runs waitActive for s in the background until the test ends, reporting on started whether it gave s a
// turn.
func waitActiveFor(t *testing.T, pool *sessionPool, s *liveSession) <-chan bool {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	started := make(chan bool, 1)
	go func() { started <- pool.waitActive(s, ctx, context.Background()) }()
	return started
}

func pendingOf(pool *sessionPool, s *liveSession) (pending, active bool) {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	return s.permitPending, s.active
}

// The cdvn0 incident (2026-11-27): maxConcurrent 4, Extra sessions on demand 2, and four parked sessions each with a
// live runner-hosted job and no turn. The runner still asked for claims (burst room was left), the control plane handed
// it an ordinary claim for a fifth session, and that claim sat permitPending for half an hour behind jobs nothing ends.
// Now a full runner says which claims it can still start — a message to one of the job holders, whose own job holds its
// slot, or a Run now claim — and gives back one it is handed anyway, so the session waits queued behind a full runner,
// and is claimed again once a slot is free. The jobs run on untouched, and are all still named.
func TestAFullRunnerNeverTakesAndParksAClaim(t *testing.T) {
	pool := newSessionPool(4)
	burst := 2
	pool.applyConcurrency(4, &burst)
	returns := &slotReturns{}
	returns.install(pool)
	holders := []string{"held-1", "held-2", "held-3", "held-4"}
	for _, id := range holders {
		registerPoolSession(t, pool, id, false) // parked: a supervisor, no turn
	}
	stopJob := sleepJobs(t, pool, holders...)
	queued := registerPoolSession(t, pool, "queued", false)

	idle, named := pool.admissionOccupancy()
	if idle != 0 || !reflect.DeepEqual(named, holders) {
		t.Fatalf("four job holders on four slots: idle %d, backgroundJobSessionIds %v; want 0, %v", idle, named, holders)
	}
	// Handed an ordinary claim for the fifth session anyway (an older or stale control plane): it is given back, not parked.
	if _, ok := pool.activate(poolJob("queued")); !ok {
		t.Fatal("the claim was not installed")
	}
	started := waitActiveFor(t, pool, queued)
	awaitCondition(t, 5*time.Second, "the claim a full runner cannot start sat permitPending: it was accepted and parked", func() bool {
		pending, active := pendingOf(pool, queued)
		return !pending && !active
	})
	if got := returns.returned(); !reflect.DeepEqual(got, []string{"queued"}) {
		t.Fatalf("claims given back = %v, want the fifth session's", got)
	}
	select {
	case <-started:
		t.Fatal("waitActive started a turn on a full runner")
	default:
	}
	// And the runner asks for no such claim to begin with: only the holders' own messages, or a Run now claim.
	if scope, full := pool.claimScope(); !full || !reflect.DeepEqual(scope, holders) {
		t.Fatalf("claim scope = %v (full %v); want only the holders' own messages, %v", scope, full, holders)
	}
	pool.mu.Lock()
	inFlight := pool.turnsInFlightLocked()
	pool.mu.Unlock()
	if _, named := pool.admissionOccupancy(); inFlight != 0 || !reflect.DeepEqual(named, holders) {
		t.Fatalf("after the return: %d turns in flight, holders %v; want none, and every job still named", inFlight, named)
	}

	// A message to a job holder starts: its own job holds the slot its turn takes.
	own, ok := pool.activate(poolJob("held-1"))
	if !ok || !waitActiveWithin(pool, own, 5*time.Second) {
		t.Fatal("a job holder's own message did not start on the slot its job holds")
	}
	parkPoolSession(pool, own)

	// One job ends: a slot is free, the runner asks for any claim again, and the returned session starts.
	stopJob("held-2")
	awaitCondition(t, 10*time.Second, "the slot of the job that ended never came back", func() bool {
		_, full := pool.claimScope()
		return !full && pool.canClaim()
	})
	if _, ok := pool.activate(poolJob("queued")); !ok {
		t.Fatal("the claim for the returned session was not installed")
	}
	select {
	case got := <-started:
		if !got {
			t.Fatal("the returned session did not start once a slot was free")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the returned session did not start once a slot was free")
	}
	if got := returns.returned(); len(got) != 1 {
		t.Fatalf("a claim that could start was given back: %v", got)
	}
}

// A claim taken while a slot was free, then left with none when another session starts a background job before it
// lands, is given back at once. One the control plane will not take back — a message was already handed out under
// it — waits here for its slot, and says why (waiting_for_slot, with the slots the jobs hold), and says so again when
// the slot comes. So does every wait on an older control plane, which takes no return.
func TestAClaimLeftWithNoSlotIsGivenBackOrNamedAsItWaits(t *testing.T) {
	pool := newSessionPool(2)
	returns := &slotReturns{}
	returns.install(pool)
	pool.holdWorktreeForRunnerJob("held-1", "bgj_1", "sleep")
	if !pool.canClaim() {
		t.Fatal("with a slot free the runner asked for no claim")
	}
	pool.holdWorktreeForRunnerJob("held-2", "bgj_2", "sleep") // a job starts before the claim lands
	late := registerPoolSession(t, pool, "late", false)
	if _, ok := pool.activate(poolJob("late")); !ok {
		t.Fatal("the claim was not installed")
	}
	waitActiveFor(t, pool, late)
	awaitCondition(t, 5*time.Second, "the claim left with no slot was not given back", func() bool {
		pending, _ := pendingOf(pool, late)
		return !pending && len(returns.returned()) == 1
	})

	type note struct {
		waiting    bool
		heldByJobs int
	}
	notes := make(chan note, 8)
	for _, c := range []struct {
		name  string
		setup func()
	}{
		{"refused", func() { returns.answer = func(string) (string, bool, error) { return stRunning, false, nil } }},
		{"older server", func() { pool.setCapacityClaims(false) }},
	} {
		name := c.name
		t.Run(name, func(t *testing.T) {
			returns.mu.Lock()
			c.setup()
			returns.mu.Unlock()
			id := "kept-" + strings.ReplaceAll(name, " ", "-")
			kept := registerPoolSession(t, pool, id, false)
			pool.setSlotWaitNotifier(kept, func(waiting bool, heldByJobs int) { notes <- note{waiting, heldByJobs} })
			if _, ok := pool.activate(poolJob(id)); !ok {
				t.Fatal("the claim was not installed")
			}
			started := waitActiveFor(t, pool, kept)
			select {
			case got := <-notes:
				if got != (note{true, 2}) {
					t.Fatalf("announced %+v, want waiting with the 2 sessions whose jobs hold the slots", got)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the claim waiting for a slot was never named")
			}
			pool.releaseWorktreeBackgroundJob("held-2", "bgj_2")
			select {
			case ok := <-started:
				if !ok {
					t.Fatal("the claim did not start once a job ended")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the claim did not start once a job ended")
			}
			if got := <-notes; got.waiting {
				t.Fatalf("the grant was announced as %+v, want the wait's end", got)
			}
			parkPoolSession(pool, kept)
			pool.holdWorktreeForRunnerJob("held-2", "bgj_2", "sleep")
		})
	}
}

// waitActiveWithin is waitActive bounded by d: whether the session's turn got its permit in that time.
func waitActiveWithin(pool *sessionPool, s *liveSession, d time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return pool.waitActive(s, ctx, context.Background())
}
