package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// A managed runner's own Git work is on its volume before it reports it: a merge and a commit before
// their result goes back on the heartbeat (and before the checkout's gate opens for the next one).
func TestManagedMergeAndCommitAreOnTheVolumeBeforeTheyAreReported(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	t.Setenv("ORBIT_HOME", t.TempDir())
	syncs := recordVolumeSyncs(t)
	const sessionID, branch = "durable-merge", "orbit/durable-merge"
	pool := newSessionPool(1)
	if _, added := pool.register(manualWorktreePoolJob(sessionID, branch), func() {}, false); !added {
		t.Fatal("the session was not registered")
	}
	advertised, _ := pool.heartbeatSnapshot()

	merged := heartbeatMerge(pool,
		MergeCommand{SessionID: sessionID, OperationID: "op-merge", LeaseOwner: "owner", Branch: branch, WorkDir: "/repo"},
		advertised[sessionID],
		func(MergeCommand) mergeOutcome {
			syncs.note("merge")
			return mergeOutcome{Status: "merged", MergedSha: "merged-sha", TargetBranch: "main"}
		})
	committed := heartbeatCommit(pool,
		CommitCommand{SessionID: sessionID, OperationID: "op-commit", LeaseOwner: "owner"},
		advertised[sessionID],
		func(CommitCommand) commitOutcome {
			syncs.note("commit")
			return commitOutcome{Status: "committed"}
		})

	if merged.Status != "merged" || committed.Status != "committed" {
		t.Fatalf("merge %q (%s), commit %q (%s): both should have run", merged.Status, merged.Message, committed.Status, committed.Message)
	}
	if got, want := syncs.steps(), []string{"merge", "sync", "commit", "sync"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want each operation's sync right after it, before its result is returned", got)
	}
	if got := syncs.syncs[0]; len(got) != 2 || got[1] != "/repo" {
		t.Fatalf("the merge's sync named %v, want the volume and the merged repository", got)
	}
}

// An integration job's result is spooled and the volume synced before the first send: the branch the
// job advanced, and the spooled copy, survive a power cut that comes after the control plane heard.
func TestManagedIntegrationResultIsOnTheVolumeBeforeItIsSent(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	t.Setenv("ORBIT_HOME", t.TempDir())
	fastIntegrationResultRetry(t)
	syncs := recordVolumeSyncs(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/integration-jobs/job-9/result") {
			if !spooledResultOnDisk(t, "job-9", "4") {
				t.Error("the result was sent before it was spooled")
			}
			syncs.note("send")
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"ERROR","receiptIds":["r1"],"openItemId":null}`))
	}))
	t.Cleanup(srv.Close)

	deliverIntegrationResult(context.Background(), NewTransport(srv.URL, "tok"), "job-9", integrationJobResultBody())

	if got, want := syncs.steps(), []string{"sync", "send"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want the volume synced before the result is sent", got)
	}
}

// The session's checkout is on the volume before its engine starts: Git fsyncs neither the
// worktree's HEAD nor its metadata nor the files it checks out.
func TestManagedSessionCheckoutIsOnTheVolumeBeforeTheEngineStarts(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	t.Setenv("ORBIT_HOME", t.TempDir())
	syncs := recordVolumeSyncs(t)
	repo := initRepo(t)
	job := &ClaimedSession{SessionID: "sess-durable-checkout", Branch: "orbit/durable-checkout"}

	execDir := setupWorktree(job, repo)
	if syncs.count() != 0 {
		t.Fatalf("synced %d times before the checkout was settled", syncs.count())
	}
	settleSessionCheckout(job, execDir)

	if job.WT == nil || job.IsolationStatus != isoWorktree {
		t.Fatalf("no worktree: isolation %q", job.IsolationStatus)
	}
	if syncs.count() != 1 {
		t.Fatalf("synced %d times, want once, after the checkout was made", syncs.count())
	}
	if got := syncs.syncs[0]; len(got) != 2 || got[1] != execDir {
		t.Fatalf("synced %v, want the volume and the checkout %s", got, execDir)
	}
	if _, err := os.Stat(filepath.Join(execDir, "base.txt")); err != nil {
		t.Fatalf("the checkout is not there: %v", err)
	}
}
