package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// A link heartbeat with nothing changed is answered from runner_presence (task O1): HeartbeatAck's reconcile_json is
// the quiet answer src/apiserver/src/runner-api/link-heartbeat.ts writes (quietHeartbeatAnswer), which
// testdata/o1-quiet-answer.json holds to the byte and the apiserver's link-heartbeat.spec.ts holds it to. This runner's
// link mode applies it as any heartbeat answer, so applied, it has to change nothing: the beat is taken (no "heartbeat
// failed"), the directories being scanned stay the ones the last full answer named, the disk floor and max-concurrent
// stay what they are, and no command is handed out, so none runs again.

func quietAnswer(t *testing.T) []byte {
	t.Helper()
	quiet, err := os.ReadFile("testdata/o1-quiet-answer.json")
	if err != nil {
		t.Fatal(err)
	}
	return []byte(strings.TrimSpace(string(quiet)))
}

func TestAQuietLinkAnswerIsATakenBeatThatHandsOutNothing(t *testing.T) {
	r := newLinkWorkRig(t)
	full := []byte(`{"cancelSessionIds":[],"maxConcurrent":4,"minFreeDiskMb":2048,` +
		`"agentDirs":[{"agentId":"workspace-a","workDir":"/srv/app"}],` +
		`"mergeRequests":[{"sessionId":"session-a","operationId":"op-1","leaseOwner":"x","branch":"b","workDir":"/srv/app"}]}`)
	answers := [][]byte{full, quietAnswer(t), quietAnswer(t)}
	beat := 0
	r.g.reconcile = func(*fakeWorkConn, map[string]json.RawMessage) []byte {
		answer := answers[beat]
		beat++
		return answer
	}
	r.useLink(t)

	first, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.AgentDirs) != 1 || len(first.MergeRequests) != 1 {
		t.Fatalf("the full answer was applied as %+v", first)
	}
	for i := 0; i < 2; i++ {
		quiet, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner))
		if err != nil {
			t.Fatalf("a quiet answer failed the beat (the run loop would log heartbeat failed): %v", err)
		}
		if quiet.AgentDirs != nil {
			t.Errorf("a quiet answer named directories, which would scan them again: %+v", quiet.AgentDirs)
		}
		if quiet.MinFreeDiskMb == nil || *quiet.MinFreeDiskMb != 2048 {
			t.Errorf("a quiet answer states the disk floor as %v, want the floor the full answer stated, 2048", quiet.MinFreeDiskMb)
		}
		if quiet.MaxConcurrent != 4 {
			t.Errorf("a quiet answer states max-concurrent %d, want 4", quiet.MaxConcurrent)
		}
		if len(quiet.CancelSessionIDs)+len(quiet.LeaseLostSessionIDs)+len(quiet.MergeRequests)+len(quiet.CommitRequests)+
			len(quiet.ArtifactRequests)+len(quiet.IntegrationJobs)+len(quiet.WikiRepoOps)+len(quiet.CursorKeyChecks) != 0 ||
			quiet.LoginRequest != nil || quiet.AccountRemoveRequest != nil || quiet.CodexAccountRemoveRequest != nil ||
			quiet.InstallRequest != nil || quiet.RepoCleanupRequest != nil || quiet.ClaudeHistoryRequest != nil || quiet.DirProbeRequest != nil ||
			quiet.CodexRateLimitResetRequest != nil || quiet.ManagedSleep != nil || quiet.RefreshModelCatalog || quiet.CheckSelfUpdate {
			t.Errorf("a quiet answer handed something out: %+v", quiet)
		}
	}
}

// What the run loop does with an answer is in runLoop's beat closure, which this tree tests by its source (as
// TestRunLoopBeatsBeforeAManagedInstanceClaims does): each field the quiet answer leaves out or repeats is applied
// so that leaving it out or repeating it changes nothing.
func TestTheRunLoopAppliesAQuietAnswerAsNoChange(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	for _, want := range []struct{ code, why string }{
		{"if resp.AgentDirs != nil {\n\t\t\t\tagentDirs.trigger(resp.AgentDirs)", "directories are scanned again only when an answer names them"},
		{"if resp.MaxConcurrent > 0 {\n\t\t\t\tif prev := pool.maxConcurrent(); prev != resp.MaxConcurrent {", "max-concurrent moves only to a new value"},
		{"if resp.MinFreeDiskMb != nil {\n\t\t\t\tfloorMb = int64(*resp.MinFreeDiskMb)\n\t\t\t}\n\t\t\tdiskFloorMb.Store(floorMb)", "the floor is the one the answer states"},
		{"for _, id := range resp.LeaseLostSessionIDs {", "leases are detached only for the ids an answer names"},
		{"for _, id := range resp.CancelSessionIDs {", "sessions are cancelled only for the ids an answer names"},
	} {
		if !strings.Contains(body, want.code) {
			t.Errorf("runLoop no longer reads: %s\n(%s)", want.code, want.why)
		}
	}
	// And a scan nobody asked for again keeps its last answer: the heartbeat reports the same directories.
	probe := newAgentDirProbe(time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go probe.run(ctx)
	dir := t.TempDir()
	probe.trigger([]AgentDirTarget{{AgentID: "workspace-a", WorkDir: dir}})
	linkWaitFor(t, 5*time.Second, "the scan the full answer asked for", func() bool { return len(probe.snapshot()) == 1 })
	before := probe.snapshot()
	time.Sleep(100 * time.Millisecond)
	if after := probe.snapshot(); len(after) != 1 || after[0].AgentID != before[0].AgentID || after[0].WorkDir != before[0].WorkDir {
		t.Errorf("with no answer naming directories the scan changed: %+v -> %+v", before, after)
	}
}
