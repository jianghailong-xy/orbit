package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// A session whose turn ended but whose runner-hosted job still runs holds a slot of the admission count, and the
// heartbeat names it (backgroundJobSessionIds) so the control plane can show it as running. A watch takes no slot and
// is not named; a job that ended frees its slot and its name; a session with a turn permit is counted by its turn, not
// named again.
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
