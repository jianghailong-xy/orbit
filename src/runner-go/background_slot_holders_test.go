package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// A session whose turn ended but whose runner-hosted job still runs holds a slot of the admission count, and the
// heartbeat names it (backgroundJobSessionIds) so the control plane can show it as running. Such holders take at most
// every slot but one (backgroundSlotsLocked): the last is a turn's, which TestJobHoldersAloneNeverKeepAClaimedTurnFromStarting
// holds. A watch takes no slot and is not named; a job that ended frees its slot and its name; a session with a turn
// permit is counted by its turn, not named again.
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

// startSleepJobs starts one live runner-hosted job (kind job) for each session named, and stops them all at cleanup.
func startSleepJobs(t *testing.T, pool *sessionPool, sessionIDs ...string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	var tailers []*bgTailer
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
		tailers = append(tailers, bg)
		if _, err := bg.startJob(bgJobSpec{Command: "exec sleep 300", Kind: bgKindJob, Dir: t.TempDir(), ScratchDir: t.TempDir()}); err != nil {
			t.Fatalf("the job of %s was refused: %v", id, err)
		}
	}
}

// waitActiveWithin is waitActive bounded by d: whether the session's turn got its permit in that time.
func waitActiveWithin(pool *sessionPool, s *liveSession, d time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return pool.waitActive(s, ctx, context.Background())
}

// The cdvn0 incident (2026-11-27): maxConcurrent 4, and four parked sessions each with a live runner-hosted job and no
// turn. A claim for a fifth session sat permitPending for half an hour, because every job holder took a slot of the
// turn count and nothing ever frees one: a job is the runner's own child, which no eviction ends. Background-only holders
// may take every slot but one; the last one is a turn's, so the claim starts, and the runner says it has that slot free.
// The holders are all still named, and still hold what they hold against the turns that come after.
func TestJobHoldersAloneNeverKeepAClaimedTurnFromStarting(t *testing.T) {
	pool := newSessionPool(4)
	holders := []string{"held-1", "held-2", "held-3", "held-4"}
	for _, id := range holders {
		registerPoolSession(t, pool, id, false) // parked: a supervisor, no turn
	}
	startSleepJobs(t, pool, holders...)
	registerPoolSession(t, pool, "queued", false)
	registerPoolSession(t, pool, "second", false)

	idle, named := pool.admissionOccupancy()
	if !reflect.DeepEqual(named, holders) {
		t.Fatalf("backgroundJobSessionIds = %v, want %v", named, holders)
	}
	if idle != 1 || !pool.canClaim() {
		t.Errorf("four job holders on four slots: idle capacity %d, canClaim %v; want 1 and true (a slot is a turn's)",
			idle, pool.canClaim())
	}

	s, ok := pool.activate(poolJob("queued"))
	if !ok {
		t.Fatal("the claim was not installed")
	}
	if !waitActiveWithin(pool, s, 5*time.Second) {
		t.Fatal("the claimed turn never started: four background-only holders kept it permitPending")
	}

	// The holders still count against every turn after it: the turn and three of them fill the four slots, so a second
	// claim waits for that turn, not for the jobs, and turns in flight never pass maxConcurrent.
	idle, named = pool.admissionOccupancy()
	if idle != 0 || !reflect.DeepEqual(named, holders) {
		t.Fatalf("with the turn running: idle %d, holders %v; want 0, %v", idle, named, holders)
	}
	second, ok := pool.activate(poolJob("second"))
	if !ok {
		t.Fatal("the second claim was not installed")
	}
	if waitActiveWithin(pool, second, 200*time.Millisecond) {
		t.Fatal("a second turn started on top of a running turn and four job holders on four slots")
	}
	pool.mu.Lock()
	inFlight, pending := pool.turnsInFlightLocked(), second.permitPending
	pool.mu.Unlock()
	if inFlight != 1 || !pending {
		t.Fatalf("turns in flight %d, second permitPending %v; want 1, true", inFlight, pending)
	}
	// Its wait is bounded by the turn ahead of it: once that turn parks, it starts.
	parkPoolSession(pool, s)
	if !waitActiveWithin(pool, second, 5*time.Second) {
		t.Fatal("the second claim did not start once the turn ahead of it parked")
	}
}

// A claim that finds no slot says so once, with the slots background jobs hold of the rest, and says once more when
// the slot comes; with burst room, an ordinary claim still waits there, and only a Run now claim (OverCapacity) goes
// past the limit. A wait the update drain causes is not announced as a slot wait.
func TestAClaimWaitingForASlotIsAnnouncedAndItsGrantToo(t *testing.T) {
	pool := newSessionPool(4)
	burst := 2
	pool.applyConcurrency(4, &burst)
	for _, id := range []string{"held-1", "held-2", "held-3", "held-4"} {
		pool.holdWorktreeForRunnerJob(id, "bgj_"+id, "sleep")
	}
	turn := registerPoolSession(t, pool, "turn", true) // the slot jobs never take
	queued := registerPoolSession(t, pool, "queued", false)

	type note struct {
		waiting    bool
		heldByJobs int
	}
	notes := make(chan note, 8)
	pool.setSlotWaitNotifier(queued, func(waiting bool, heldByJobs int) { notes <- note{waiting, heldByJobs} })
	if !pool.canClaim() {
		t.Fatal("with burst room left the runner stopped claiming")
	}
	if _, ok := pool.activate(poolJob("queued")); !ok {
		t.Fatal("the claim was not installed")
	}
	admitted := make(chan bool, 1)
	go func() { admitted <- waitActiveWithin(pool, queued, 10*time.Second) }()
	select {
	case got := <-notes:
		if got != (note{true, 3}) {
			t.Fatalf("announced %+v, want waiting with the 3 slots the jobs hold", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the claim waiting for a slot was never announced")
	}

	// Run now goes past the limit into the burst room; the ordinary claim keeps waiting.
	over := poolJob("over")
	over.OverCapacity = true
	overSession, _ := pool.register(over, func() {}, true)
	pool.mu.Lock()
	overActive, pending := overSession.active, queued.permitPending
	pool.mu.Unlock()
	if !overActive {
		t.Fatal("a Run now claim with burst room left did not get a permit")
	}
	if !pending {
		t.Fatal("the ordinary claim got a permit past the limit")
	}

	parkPoolSession(pool, turn)
	parkPoolSession(pool, overSession)
	if !<-admitted {
		t.Fatal("the claim did not start once the turns ahead of it parked")
	}
	if got := <-notes; got.waiting {
		t.Fatalf("the grant was announced as %+v, want the wait's end", got)
	}
	select {
	case got := <-notes:
		t.Fatalf("an extra announcement %+v", got)
	default:
	}
}
