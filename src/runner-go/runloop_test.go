package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestRuntimeModelRefreshCadence(t *testing.T) {
	if got := time.Duration(runtimeDefaultRefreshHeartbeatTicks) * heartbeatInterval; got != 5*time.Minute {
		t.Fatalf("runtime default refresh cadence = %s, want 5m", got)
	}
	if got := time.Duration(modelCatalogRefreshHeartbeatTicks) * heartbeatInterval; got != time.Hour {
		t.Fatalf("model catalog refresh cadence = %s, want 1h", got)
	}
}

func TestWaitForRunLoopStopUpdate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Millisecond,
		func(_ context.Context, server string) (string, bool) {
			if server != "https://control.example" {
				t.Errorf("server = %q", server)
			}
			return "0.1.81", true
		})
	if reason != runLoopStopUpdate || remote != "0.1.81" {
		t.Fatalf("stop = %v, %q; want update, 0.1.81", reason, remote)
	}
}

func TestWaitForRunLoopStopSignalDoesNotRequestUpdate(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	checks := 0
	reason, remote := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Hour,
		func(context.Context, string) (string, bool) {
			checks++
			return "99.0.0", true
		})
	if reason != runLoopStopSignal || remote != "" {
		t.Fatalf("stop = %v, %q; want signal", reason, remote)
	}
	if checks != 0 {
		t.Fatalf("update checker called %d time(s) after SIGTERM, want 0", checks)
	}
}

func TestWaitForRunLoopStopSignalWinsDuringUpdateCheck(t *testing.T) {
	signals := make(chan os.Signal, 1)
	checkStarted := make(chan struct{})
	finishCheck := make(chan struct{})
	result := make(chan runLoopStopReason, 1)
	go func() {
		reason, _ := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Millisecond,
			func(context.Context, string) (string, bool) {
				close(checkStarted)
				<-finishCheck
				return "0.1.81", true
			})
		result <- reason
	}()

	select {
	case <-checkStarted:
	case <-time.After(time.Second):
		t.Fatal("update check did not start")
	}
	signals <- syscall.SIGTERM
	close(finishCheck)
	select {
	case reason := <-result:
		if reason != runLoopStopSignal {
			t.Fatalf("stop = %v, want SIGTERM to win over update", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("waitForRunLoopStop did not return")
	}
}

func TestWaitForRunLoopStopContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour, nil)
	if reason != runLoopStopNone || remote != "" {
		t.Fatalf("stop = %v, %q; want context cancellation", reason, remote)
	}
}

func TestRestartForUpdateYieldsToSignalReceivedWhileDraining(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	if restartForUpdate(true, false, signals) {
		t.Fatal("restartForUpdate = true with pending SIGTERM, want normal exit")
	}
	if restartForUpdate(false, false, nil) {
		t.Fatal("restartForUpdate = true without update request")
	}
	if restartForUpdate(true, true, nil) {
		t.Fatal("restartForUpdate = true after drain timeout")
	}
}

func TestSelfUpdateSupervisorReexecsInsteadOfReusingStoppedRunLoop(t *testing.T) {
	var events []string
	superviseSelfUpdates("https://control.example",
		func(server string) { events = append(events, "update:"+server) },
		func() bool {
			events = append(events, "loop")
			return true
		},
		func() error {
			events = append(events, "reexec")
			return nil
		})
	want := []string{
		"update:https://control.example", "loop", "update:https://control.example", "reexec",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events = %#v, want %#v", events, want)
	}
}

func TestCarryOverModelCatalog(t *testing.T) {
	prev := &ModelCatalog{
		Codex:    []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol", ContextWindow: 372_000}},
		Claude:   []ModelInfo{{Value: "claude-opus-5", Label: "Opus 5"}},
		OpenCode: []ModelInfo{{Value: "opencode/big-pickle", Label: "opencode · Big Pickle"}},
	}

	// Claude refreshed, `codex debug models` failed → keep the last good Codex list rather than
	// heartbeating a catalog that blanks it (which would drop the clients to a default window).
	merged := carryOverModelCatalog(prev, &ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-6", Label: "Opus 6"}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 372_000 {
		t.Fatalf("Codex = %#v, want the previous list carried over", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-6" {
		t.Fatalf("Claude = %#v, want this round's list", merged.Claude)
	}
	if len(merged.OpenCode) != 1 || merged.OpenCode[0].Value != "opencode/big-pickle" {
		t.Fatalf("OpenCode = %#v, want the previous list carried over", merged.OpenCode)
	}

	// A fresh Codex list always wins — carrying over must never pin a stale window.
	merged = carryOverModelCatalog(prev, &ModelCatalog{
		Codex: []ModelInfo{{Value: "gpt-5.7", Label: "GPT-5.7", ContextWindow: 512_000}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 512_000 {
		t.Fatalf("Codex = %#v, want this round's list", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-5" {
		t.Fatalf("Claude = %#v, want the previous list carried over", merged.Claude)
	}

	// First refresh after startup has nothing to carry over.
	first := &ModelCatalog{Codex: []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol"}}}
	if got := carryOverModelCatalog(nil, first); got != first {
		t.Fatalf("carryOverModelCatalog(nil, first) = %#v, want first unchanged", got)
	}
}

func TestReclaimStatusOpenRejectsTerminalAndUnknownRows(t *testing.T) {
	for _, tc := range []struct {
		status string
		open   bool
	}{
		{"", true}, // legacy reclaim responses contained RUNNING rows only
		{stPending, true},
		{stRunning, true},
		{stAwaitingInput, true},
		{stInterrupted, true},
		{stSucceeded, false},
		{stFailed, false},
		{stCancelled, false},
		{"FUTURE_TERMINAL", false},
	} {
		if got := reclaimStatusOpen(tc.status); got != tc.open {
			t.Errorf("reclaimStatusOpen(%q) = %v, want %v", tc.status, got, tc.open)
		}
	}
}

func TestReclaimMissingSessionsUsesStableTakeoverOrder(t *testing.T) {
	var mu sync.Mutex
	var takeoverOrder []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
			_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: []ReclaimSession{
				{SessionID: "b", Status: stAwaitingInput},
				{SessionID: "a", Status: stRunning},
				{SessionID: "c", Status: stInterrupted},
			}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			mu.Lock()
			takeoverOrder = append(takeoverOrder, id)
			mu.Unlock()
			status := stAwaitingInput
			if id == "a" {
				status = stRunning
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": status})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	starts, err := reclaimMissingSessions(context.Background(), NewTransport(srv.URL, "token"), func() map[string]bool {
		return map[string]bool{}
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	gotOrder := append([]string(nil), takeoverOrder...)
	mu.Unlock()
	if strings.Join(gotOrder, ",") != "a,b,c" {
		t.Fatalf("takeover order = %v, want [a b c]", gotOrder)
	}
	if len(starts) != 3 || starts[0].job.SessionID != "a" || !starts[0].initiallyActive {
		t.Fatalf("reclaimed starts = %#v", starts)
	}
}

func TestAmbiguousClaimCanBeRecoveredFromAuthoritativeReclaim(t *testing.T) {
	var claimCommitted atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/claim":
			claimCommitted.Store(true)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close() // commit happened, but the runner never received the session id
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
			if !claimCommitted.Load() {
				t.Error("reclaim happened before the simulated claim commit")
			}
			_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: []ReclaimSession{{
				SessionID: "claimed-after-eof", Status: stRunning,
			}}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stRunning})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	transport := NewTransport(srv.URL, "token")
	if job, err := transport.claimSession(context.Background()); err == nil || job != nil {
		t.Fatalf("ambiguous claim = (%#v, %v), want a response-loss error", job, err)
	}
	pool := newSessionPool(1)
	if _, added := pool.register(poolJob("claimed-after-eof"), func() {}, true); !added {
		t.Fatal("failed to register the predecessor active supervisor")
	}
	starts, err := reclaimMissingSessions(context.Background(), transport, pool.reclaimStates, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(starts) != 1 || starts[0].job.SessionID != "claimed-after-eof" || !starts[0].initiallyActive {
		t.Fatalf("recovered starts = %#v", starts)
	}
	for _, start := range starts {
		if _, ok := pool.activate(start.job); !ok {
			t.Fatalf("recovered known supervisor %s was not activated", start.job.SessionID)
		}
	}
	if got := pool.activeCount(); got != 1 {
		t.Fatalf("active permits after response-loss recovery = %d, want 1", got)
	}
}

func TestPrepareLocalSupervisorTakeoverWaitsForPredecessorCleanup(t *testing.T) {
	pool := newSessionPool(1)
	oldJob := poolJob("revived")
	oldJob.LeaseOwner = "11111111-1111-4111-8111-111111111111"
	live, added := pool.register(oldJob, func() {}, false)
	if !added {
		t.Fatal("failed to register predecessor supervisor")
	}

	detachCalled := make(chan struct{})
	releaseCleanup := make(chan struct{})
	if alreadyDetaching := pool.installDetach(live, func() {
		close(detachCalled)
		go func() {
			<-releaseCleanup
			pool.finish(live)
		}()
	}); alreadyDetaching {
		t.Fatal("fresh supervisor was already detaching")
	}

	revived := poolJob("revived")
	revived.LeaseOwner = "22222222-2222-4222-8222-222222222222"
	prepared := make(chan error, 1)
	go func() {
		prepared <- prepareLocalSupervisorTakeover(
			context.Background(),
			pool,
			revived,
			"33333333-3333-4333-8333-333333333333",
		)
	}()

	select {
	case <-detachCalled:
	case <-time.After(time.Second):
		t.Fatal("predecessor supervisor was not detached")
	}
	select {
	case err := <-prepared:
		t.Fatalf("takeover preparation returned before cleanup: %v", err)
	default:
	}
	close(releaseCleanup)
	if err := <-prepared; err != nil {
		t.Fatalf("takeover preparation: %v", err)
	}
	if got := pool.count(); got != 0 {
		t.Fatalf("pool count after predecessor cleanup = %d, want 0", got)
	}
}

func TestPrepareLocalSupervisorTakeoverKeepsMatchingOwnerSupervisor(t *testing.T) {
	pool := newSessionPool(1)
	job := poolJob("warm")
	job.LeaseOwner = "11111111-1111-4111-8111-111111111111"
	live, added := pool.register(job, func() {}, false)
	if !added {
		t.Fatal("failed to register warm supervisor")
	}
	if err := prepareLocalSupervisorTakeover(context.Background(), pool, job, job.LeaseOwner); err != nil {
		t.Fatal(err)
	}
	if pool.isDetaching(live) {
		t.Fatal("matching owner supervisor was detached")
	}
	pool.finish(live)
}

func TestPrepareLocalSupervisorTakeoverWaitsForHeartbeatDetachedColdCleanup(t *testing.T) {
	pool := newSessionPool(1)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	live, added := pool.register(poolJob("revived"), cancelSession, false)
	if !added {
		t.Fatal("cold predecessor was not registered")
	}

	cleanupStarted := make(chan struct{})
	allowCleanup := make(chan struct{})
	wrapperDone := make(chan struct{})
	go func() {
		defer close(wrapperDone)
		if pool.waitActive(live, sessionCtx, context.Background()) {
			t.Error("heartbeat-detached cold predecessor became active")
			return
		}
		if !pool.isDetaching(live) {
			t.Error("heartbeat lease loss did not take the no-finalize path")
			return
		}
		close(cleanupStarted)
		<-allowCleanup
		pool.finish(live)
	}()

	if _, detached := pool.detachExpectedForTakeover(live); !detached {
		t.Fatal("heartbeat did not detach the cold predecessor")
	}
	select {
	case <-cleanupStarted:
	case <-time.After(time.Second):
		t.Fatal("cold predecessor did not enter deferred cleanup")
	}

	prepared := make(chan error, 1)
	go func() {
		prepared <- prepareLocalSupervisorTakeover(
			context.Background(),
			pool,
			&ClaimedSession{SessionID: "revived", LeaseOwner: "rotated-owner"},
			"process-owner",
		)
	}()
	select {
	case err := <-prepared:
		t.Fatalf("takeover crossed heartbeat-detached cleanup early: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(allowCleanup)
	select {
	case err := <-prepared:
		if err != nil {
			t.Fatalf("prepare takeover after cold cleanup: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("takeover did not resume after heartbeat-detached cleanup")
	}
	select {
	case <-wrapperDone:
	case <-time.After(time.Second):
		t.Fatal("cold predecessor wrapper did not finish")
	}
}

func TestPrepareLocalSupervisorTakeoverWaitsForTerminalMergeWithoutSupervisor(t *testing.T) {
	pool := newSessionPool(1)
	release, admitted := pool.beginHeartbeatWorktreeOperation(
		"completed", nil, 0, false,
	)
	if !admitted {
		t.Fatal("terminal merge without a supervisor was not admitted")
	}

	prepared := make(chan error, 1)
	go func() {
		prepared <- prepareLocalSupervisorTakeover(
			context.Background(),
			pool,
			&ClaimedSession{SessionID: "completed", LeaseOwner: "new-owner"},
			"process-owner",
		)
	}()
	waitForWorktreeFence(t, pool, "completed")
	select {
	case err := <-prepared:
		t.Fatalf("takeover crossed a terminal merge before it completed: %v", err)
	default:
	}

	release()
	select {
	case err := <-prepared:
		if err != nil {
			t.Fatalf("takeover preparation after terminal merge: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("takeover did not resume after terminal merge completed")
	}
	if nextRelease, ok := pool.beginHeartbeatWorktreeOperation(
		"completed", nil, 0, false,
	); ok {
		nextRelease()
		t.Fatal("takeover fence reopened before a replacement supervisor was installed")
	}
}

func TestManualWorktreeCommandAllowed(t *testing.T) {
	const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	tests := []struct {
		name         string
		operationID  string
		leaseOwner   string
		processOwner string
		want         bool
	}{
		{name: "legacy fieldless command", want: true},
		{name: "matching owner", operationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", leaseOwner: owner, processOwner: owner, want: true},
		{name: "matching owner case insensitive", operationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", leaseOwner: owner, processOwner: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", want: true},
		{name: "missing operation", leaseOwner: owner, processOwner: owner},
		{name: "missing owner", operationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", processOwner: owner},
		{name: "owner mismatch", operationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", leaseOwner: owner, processOwner: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := manualWorktreeCommandAllowed(tc.operationID, tc.leaseOwner, tc.processOwner); got != tc.want {
				t.Fatalf("manualWorktreeCommandAllowed(%q, %q, %q) = %v, want %v",
					tc.operationID, tc.leaseOwner, tc.processOwner, got, tc.want)
			}
		})
	}
}

type recordedManualWorktreeReceipt struct {
	path string
	body map[string]interface{}
}

func manualWorktreeReceiptTransport(
	t *testing.T,
	leaseOwner string,
) (*Transport, <-chan recordedManualWorktreeReceipt) {
	t.Helper()
	receipts := make(chan recordedManualWorktreeReceipt, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode manual worktree receipt: %v", err)
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		receipts <- recordedManualWorktreeReceipt{path: r.URL.Path, body: body}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	transport := NewTransport(server.URL, "token")
	transport.leaseOwner = leaseOwner
	return transport, receipts
}

func assertManualWorktreeErrorReceipt(
	t *testing.T,
	receipts <-chan recordedManualWorktreeReceipt,
	wantPath, operationID, leaseOwner string,
) {
	t.Helper()
	select {
	case got := <-receipts:
		if got.path != wantPath {
			t.Fatalf("receipt path = %q, want %q", got.path, wantPath)
		}
		if got.body["operationId"] != operationID || got.body["leaseOwner"] != leaseOwner {
			t.Fatalf("receipt fence = (%#v, %#v), want (%q, %q); body = %#v",
				got.body["operationId"], got.body["leaseOwner"], operationID, leaseOwner, got.body)
		}
		if got.body["status"] != "error" {
			t.Fatalf("receipt status = %#v, want error; body = %#v", got.body["status"], got.body)
		}
		if message, _ := got.body["message"].(string); message == "" {
			t.Fatalf("receipt omitted superseded reason: %#v", got.body)
		}
	case <-time.After(time.Second):
		t.Fatal("admission rejection was silently dropped without a result receipt")
	}
}

func TestTerminalLeaseLossMergeAdmissionRejectPostsExactErrorReceipt(t *testing.T) {
	const (
		sessionID   = "terminal-merge"
		operationID = "11111111-1111-4111-8111-111111111111"
		leaseOwner  = "22222222-2222-4222-8222-222222222222"
	)
	pool := newSessionPool(1)
	live, added := pool.register(manualWorktreePoolJob(sessionID, "orbit/terminal-merge"), func() {}, false)
	if !added {
		t.Fatal("failed to register terminal predecessor")
	}
	supervisors, _ := pool.heartbeatSnapshot()
	response := HeartbeatResponse{
		LeaseLostSessionIDs: []string{sessionID},
		MergeRequests: []MergeCommand{{
			SessionID: sessionID, OperationID: operationID, LeaseOwner: leaseOwner,
			Branch: "orbit/terminal-merge", WorkDir: "must-not-run",
		}},
	}

	// Mirror the ordering of one heartbeat response: ownership loss closes local
	// admission before its exact terminal merge command is dispatched.
	for _, id := range response.LeaseLostSessionIDs {
		snapshot := supervisors[id]
		if _, detached := pool.detachExpectedForTakeover(snapshot.supervisor); !detached {
			t.Fatal("terminal predecessor was not detached")
		}
	}
	command := response.MergeRequests[0]
	snapshot := supervisors[command.SessionID]
	if release, admitted := pool.beginHeartbeatWorktreeOperation(
		command.SessionID,
		snapshot.supervisor,
		snapshot.permitGeneration,
		false,
	); admitted {
		release()
		t.Fatal("terminal merge crossed the lease-loss admission fence")
	}

	transport, receipts := manualWorktreeReceiptTransport(t, leaseOwner)
	if err := transport.mergeResult(command.SessionID, MergeResultRequest{
		OperationID: command.OperationID,
		LeaseOwner:  command.LeaseOwner,
		Status:      "error",
		Message:     "merge was superseded before local execution",
	}); err != nil {
		t.Fatalf("post rejected merge receipt: %v", err)
	}
	assertManualWorktreeErrorReceipt(
		t,
		receipts,
		"/api/runner/sessions/"+sessionID+"/merge-result",
		operationID,
		leaseOwner,
	)
	pool.finish(live)
}

func TestCommitAdmissionRejectPostsExactErrorReceipt(t *testing.T) {
	const leaseOwner = "33333333-3333-4333-8333-333333333333"
	tests := []struct {
		name      string
		sessionID string
		advance   func(*testing.T, *sessionPool, *liveSession)
	}{
		{
			name:      "stale heartbeat permit",
			sessionID: "stale-commit",
			advance: func(t *testing.T, pool *sessionPool, live *liveSession) {
				t.Helper()
				oldPermit := pool.permitGeneration(live)
				pool.park(live, oldPermit)
				if _, ok := pool.activate(manualWorktreePoolJob(live.id, "orbit/"+live.id)); !ok {
					t.Fatal("failed to activate replacement permit")
				}
				newPermit := pool.permitGeneration(live)
				if newPermit == oldPermit {
					t.Fatal("replacement did not advance permit generation")
				}
				pool.park(live, newPermit)
			},
		},
		{
			name:      "session remains active",
			sessionID: "active-commit",
			advance:   func(*testing.T, *sessionPool, *liveSession) {},
		},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			operationID := fmt.Sprintf("44444444-4444-4444-8444-44444444444%d", i)
			branch := "orbit/" + tc.sessionID
			pool := newSessionPool(1)
			live, added := pool.register(manualWorktreePoolJob(tc.sessionID, branch), func() {}, true)
			if !added {
				t.Fatal("failed to register commit session")
			}
			supervisors, _ := pool.heartbeatSnapshot()
			tc.advance(t, pool, live)
			command := CommitCommand{
				SessionID: tc.sessionID, OperationID: operationID,
				LeaseOwner: leaseOwner, Branch: branch,
			}
			snapshot := supervisors[command.SessionID]
			if release, admitted := pool.beginHeartbeatWorktreeOperation(
				command.SessionID,
				snapshot.supervisor,
				snapshot.permitGeneration,
				true,
			); admitted {
				release()
				t.Fatal("commit crossed its local admission fence")
			}

			transport, receipts := manualWorktreeReceiptTransport(t, leaseOwner)
			if err := transport.commitResult(command.SessionID, CommitResultRequest{
				OperationID: command.OperationID,
				LeaseOwner:  command.LeaseOwner,
				Status:      "error",
				Message:     "commit was superseded before local execution",
			}); err != nil {
				t.Fatalf("post rejected commit receipt: %v", err)
			}
			assertManualWorktreeErrorReceipt(
				t,
				receipts,
				"/api/runner/sessions/"+tc.sessionID+"/commit-result",
				operationID,
				leaseOwner,
			)
			pool.finish(live)
		})
	}
}
