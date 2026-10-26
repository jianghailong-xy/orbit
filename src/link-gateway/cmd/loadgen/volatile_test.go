package main

import (
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

func volatileRunner(t *testing.T, edits float64, active bool) *runner {
	t.Helper()
	g := &loadgen{o: options{volatile: true, volatileEdits: edits}, seed: 1}
	fr := fleetRunner{Runner: "runner-1", Token: "tok", Process: "proc", Sessions: []string{"0190a0b0-0000-7000-8000-000000000001"}}
	if active {
		fr.Active = []activeSession{{ID: "0190a0b0-0000-7000-8000-000000000001"}}
	}
	return newRunner(g, 1, fr)
}

// whole is the kinds a beat's parts carry whole.
func whole(facts []*linkpb.Fact) map[string]bool {
	out := map[string]bool{}
	for _, f := range facts {
		if len(f.GetJson()) > 0 {
			out[f.GetKind()] = true
		}
	}
	return out
}

func TestVolatilePartsMoveAtTheRunnersRatesAndGoWholeOnlyWhenMoved(t *testing.T) {
	r := volatileRunner(t, 0, true)
	start := time.Now()
	first := r.volatileFacts(start)
	if len(whole(first)) != len(first) {
		t.Fatalf("a connection's first beat carries every part whole: %v", whole(first))
	}
	if r.factOf("sessions") == nil {
		t.Fatal("a runner with a running session reports its worktree")
	}
	// Nothing due: every part by digest.
	if moved := whole(r.volatileFacts(start.Add(time.Second))); len(moved) != 0 {
		t.Errorf("a beat with nothing moved sent %v whole", moved)
	}
	// Plan usage: within five minutes for a machine running a session, then every five.
	seen := 0
	for at := start; at.Before(start.Add(16 * time.Minute)); at = at.Add(30 * time.Second) {
		if whole(r.volatileFacts(at))["planUsage"] {
			seen++
		}
	}
	if seen < 3 || seen > 4 {
		t.Errorf("plan usage moved %d times in 16 minutes of a busy machine, want every 5 minutes", seen)
	}
	idle := volatileRunner(t, 0, false)
	idle.volatileFacts(start)
	seen = 0
	for at := start; at.Before(start.Add(21 * time.Minute)); at = at.Add(30 * time.Second) {
		if whole(idle.volatileFacts(at))["planUsage"] {
			seen++
		}
	}
	if seen < 2 || seen > 3 {
		t.Errorf("plan usage moved %d times in 21 minutes of an idle machine, want every 10 minutes", seen)
	}
}

func TestDirectoriesAreScannedAgainOnlyAfterAnAnswerNamesThem(t *testing.T) {
	r := volatileRunner(t, 0, false)
	now := time.Now()
	r.volatileFacts(now)
	r.vol.onAnswer([]byte(`{"cancelSessionIds":[],"maxConcurrent":2,"mergeRequests":[]}`))
	if whole(r.volatileFacts(now))["agentDirProbes"] {
		t.Fatal("a quiet answer asked for a scan")
	}
	r.vol.onAnswer([]byte(`{"cancelSessionIds":[],"agentDirs":[{"agentId":"0190a0b0-0000-7000-8000-0000000000aa","workDir":"/home/u/src/app"}]}`))
	if !whole(r.volatileFacts(now))["agentDirProbes"] {
		t.Fatal("a full answer's directories were not scanned again")
	}
	if whole(r.volatileFacts(now))["agentDirProbes"] {
		t.Error("one answer's directories were scanned twice")
	}
	r.vol.onAnswer([]byte(`{"agentDirs":[{"agentId":"0190a0b0-0000-7000-8000-0000000000aa","workDir":"/home/u/src/app"}]}`))
	if !whole(r.volatileFacts(now))["agentDirProbes"] {
		t.Error("the next full answer's scan found the same free space")
	}
}

func TestAnEditingTurnMovesItsWorktreeOnTheShareOfBeatsAsked(t *testing.T) {
	always := volatileRunner(t, 1, true)
	never := volatileRunner(t, 0, true)
	now := time.Now()
	always.volatileFacts(now)
	never.volatileFacts(now)
	for i := 1; i <= 5; i++ {
		at := now.Add(time.Duration(i) * time.Second)
		if !whole(always.volatileFacts(at))["sessions"] {
			t.Errorf("beat %d of a turn that edits on every beat did not move its worktree", i)
		}
		if whole(never.volatileFacts(at))["sessions"] {
			t.Errorf("beat %d of a turn that edits nothing moved its worktree", i)
		}
	}
}
