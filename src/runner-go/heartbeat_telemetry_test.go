package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHeartbeatSnapshotKeepsColdSupervisedButOnlyScansActive(t *testing.T) {
	pool := newSessionPool(3)
	for i := 0; i < 500; i++ {
		registerPoolSession(t, pool, fmt.Sprintf("cold-%03d", i), false)
	}
	for i := 0; i < 3; i++ {
		registerPoolSession(t, pool, fmt.Sprintf("active-%d", i), true)
	}

	cancels, jobs := pool.heartbeatSnapshot()
	if len(cancels) != 503 {
		t.Fatalf("supervised sessions = %d, want all 503 active+cold sessions", len(cancels))
	}
	if len(jobs) != 3 {
		t.Fatalf("telemetry jobs = %d, want only 3 active sessions", len(jobs))
	}
	for _, job := range jobs {
		if !strings.HasPrefix(job.sessionID, "active-") {
			t.Fatalf("cold session leaked into telemetry snapshot: %#v", job)
		}
	}
}

func TestHeartbeatCadenceSurvivesBlockedTelemetryWithManyColdSessions(t *testing.T) {
	pool := newSessionPool(3)
	for i := 0; i < 500; i++ {
		registerPoolSession(t, pool, fmt.Sprintf("cold-%03d", i), false)
	}
	for i := 0; i < 3; i++ {
		registerPoolSession(t, pool, fmt.Sprintf("active-%d", i), true)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	collector := func(ctx context.Context, jobs []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
		if len(jobs) != 3 {
			t.Errorf("collector jobs = %d, want 3 active sessions", len(jobs))
		}
		calls.Add(1)
		current := inFlight.Add(1)
		for {
			maximum := maxInFlight.Load()
			if current <= maximum || maxInFlight.CompareAndSwap(maximum, current) {
				break
			}
		}
		defer inFlight.Add(-1)
		if calls.Load() == 1 {
			close(started)
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return nil
	}
	telemetry := newHeartbeatTelemetryProbe(time.Hour, collector)
	ctx, cancel := context.WithCancel(context.Background())
	go telemetry.run(ctx)

	ticks := make(chan time.Time, 10)
	stop := make(chan struct{})
	posted := make(chan int, 10)
	ticksDone := make(chan struct{})
	go func() {
		defer close(ticksDone)
		runHeartbeatTicks(stop, ticks, func() {
			_, _, _ = sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, func(request HeartbeatRequest) (*HeartbeatResponse, error) {
				posted <- len(request.SupervisedSessionIDs)
				return &HeartbeatResponse{}, nil
			})
		})
	}()
	defer func() {
		cancel()
		close(release)
		close(stop)
		select {
		case <-ticksDone:
		case <-time.After(time.Second):
			t.Error("heartbeat tick loop did not stop during cleanup")
		}
		select {
		case <-telemetry.done:
		case <-time.After(time.Second):
			t.Error("telemetry worker did not stop during cleanup")
		}
	}()

	ticks <- time.Now()
	select {
	case got := <-posted:
		if got != 503 {
			t.Fatalf("first heartbeat supervised %d sessions, want 503", got)
		}
	case <-time.After(time.Second):
		t.Fatal("first heartbeat waited for telemetry")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("telemetry collector did not start")
	}

	for i := 0; i < 9; i++ {
		ticks <- time.Now()
	}
	for i := 0; i < 9; i++ {
		select {
		case got := <-posted:
			if got != 503 {
				t.Fatalf("heartbeat %d supervised %d sessions, want 503", i+2, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("heartbeat %d was blocked by telemetry", i+2)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("blocked collector started %d times, want one single-flight scan", got)
	}
	if got := maxInFlight.Load(); got != 1 {
		t.Fatalf("max concurrent telemetry scans = %d, want 1", got)
	}

}

func TestHeartbeatTelemetryRefreshCoalescesToLatestSnapshot(t *testing.T) {
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondSeen := make(chan string, 1)
	var once sync.Once
	var calls atomic.Int32
	collector := func(ctx context.Context, jobs []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
		call := calls.Add(1)
		if call == 1 {
			once.Do(func() { close(firstStarted) })
			select {
			case <-releaseFirst:
			case <-ctx.Done():
			}
			return nil
		}
		if len(jobs) == 1 {
			select {
			case secondSeen <- jobs[0].sessionID:
			case <-ctx.Done():
			}
		}
		return nil
	}
	telemetry := newHeartbeatTelemetryProbe(time.Hour, collector)
	ctx, cancel := context.WithCancel(context.Background())
	go telemetry.run(ctx)
	defer func() {
		cancel()
		select {
		case <-telemetry.done:
		case <-time.After(time.Second):
			t.Error("telemetry worker did not stop during cleanup")
		}
	}()

	telemetry.trigger([]heartbeatTelemetryTarget{{sessionID: "first", permitGeneration: 1}})
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first telemetry refresh did not start")
	}
	for i := 0; i < 100; i++ {
		telemetry.trigger([]heartbeatTelemetryTarget{{
			sessionID:        fmt.Sprintf("queued-%03d", i),
			permitGeneration: 1,
		}})
	}
	close(releaseFirst)
	select {
	case got := <-secondSeen:
		if got != "queued-099" {
			t.Fatalf("coalesced refresh used %q, want latest queued-099", got)
		}
	case <-time.After(time.Second):
		t.Fatal("coalesced telemetry refresh did not run")
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("collector calls = %d, want first + one coalesced refresh", got)
	}

}

func TestHeartbeatTelemetryDropsParkedCachedSession(t *testing.T) {
	pool := newSessionPool(1)
	session := registerPoolSession(t, pool, "active", true)
	telemetry := newHeartbeatTelemetryProbe(time.Hour, func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
		return nil
	})
	_, activeJobs := pool.heartbeatSnapshot()
	telemetry.state = []heartbeatTelemetrySample{{
		target: activeJobs[0],
		state:  SessionLiveState{SessionID: "active", IsolationStatus: isoWorktree},
	}}

	if got := telemetry.snapshotFor(activeJobs); len(got) != 1 {
		t.Fatalf("active cached states = %d, want 1", len(got))
	}
	parkPoolSession(pool, session)
	_, activeJobs = pool.heartbeatSnapshot()
	if got := telemetry.snapshotFor(activeJobs); len(got) != 0 {
		t.Fatalf("parked cached states = %d, want stale telemetry filtered", len(got))
	}
}

func TestHeartbeatCyclePublishesCompletedTelemetryOnNextTick(t *testing.T) {
	pool := newSessionPool(1)
	registerPoolSession(t, pool, "active", true)
	collector := func(_ context.Context, targets []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
		return []heartbeatTelemetrySample{{
			target: targets[0],
			state: SessionLiveState{
				SessionID:       "active",
				IsolationStatus: isoWorktree,
				WorktreeDirty:   true,
			},
		}}
	}
	telemetry := newHeartbeatTelemetryProbe(time.Hour, collector)
	ctx, cancel := context.WithCancel(context.Background())
	go telemetry.run(ctx)
	defer func() {
		cancel()
		select {
		case <-telemetry.done:
		case <-time.After(time.Second):
			t.Error("telemetry worker did not stop during cleanup")
		}
	}()

	var first HeartbeatRequest
	_, _, err := sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, func(request HeartbeatRequest) (*HeartbeatResponse, error) {
		first = request
		return &HeartbeatResponse{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Sessions) != 0 {
		t.Fatalf("first heartbeat sessions = %#v, want empty cache", first.Sessions)
	}
	deadline := time.Now().Add(time.Second)
	for {
		telemetry.stateMu.RLock()
		ready := len(telemetry.state) == 1
		telemetry.stateMu.RUnlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed telemetry was not cached")
		}
		time.Sleep(time.Millisecond)
	}

	var second HeartbeatRequest
	_, _, err = sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, func(request HeartbeatRequest) (*HeartbeatResponse, error) {
		second = request
		return &HeartbeatResponse{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Sessions) != 1 || second.Sessions[0].SessionID != "active" || !second.Sessions[0].WorktreeDirty {
		t.Fatalf("second heartbeat sessions = %#v, want completed active snapshot", second.Sessions)
	}
}

func TestHeartbeatTelemetryRejectsPriorPermitCache(t *testing.T) {
	pool := newSessionPool(1)
	session := registerPoolSession(t, pool, "active", true)
	_, firstTargets := pool.heartbeatSnapshot()
	telemetry := newHeartbeatTelemetryProbe(time.Hour, nil)
	telemetry.state = []heartbeatTelemetrySample{{
		target: firstTargets[0],
		state:  SessionLiveState{SessionID: "active", IsolationStatus: isoWorktree},
	}}

	parkPoolSession(pool, session)
	replacement := poolJob("active")
	if _, ok := pool.activate(replacement); !ok {
		t.Fatal("failed to activate replacement turn")
	}
	_, currentTargets := pool.heartbeatSnapshot()
	if currentTargets[0].supervisor != firstTargets[0].supervisor {
		t.Fatal("test did not preserve supervisor identity across permits")
	}
	if currentTargets[0].permitGeneration == firstTargets[0].permitGeneration {
		t.Fatal("replacement turn did not advance its permit generation")
	}
	if got := telemetry.snapshotFor(currentTargets); len(got) != 0 {
		t.Fatalf("new permit received %d stale telemetry rows", len(got))
	}
}

func TestBoundedBaseShaCancellationDoesNotMutateWorktree(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var commands []string
	ops := worktreeGitOps{
		ctx: ctx,
		run: func(_ string, args ...string) (string, error) {
			commands = append(commands, strings.Join(args, " "))
			switch {
			case len(args) > 0 && args[0] == "symbolic-ref":
				return "orbit/feature", nil
			case len(args) > 0 && args[0] == "rev-parse":
				return "tip", nil
			case len(args) > 1 && args[0] == "merge-base" && args[1] == "HEAD":
				return "candidate", nil
			case len(args) > 1 && args[0] == "merge-base" && args[1] == "--is-ancestor":
				cancel()
				return "", ctx.Err()
			default:
				return "", nil
			}
		},
		runEnv: func(string, []string, ...string) (string, error) { return "", nil },
	}
	wt := &Worktree{
		Path: "worktree", RepoDir: "repo", Branch: "orbit/feature",
		BaseSha: "persisted", Session: "session",
	}
	if got := ops.freshenBaseSha(wt); got != "persisted" {
		t.Fatalf("bounded base = %q, want persisted after cancellation", got)
	}
	if got := wt.baseSha(); got != "persisted" {
		t.Fatalf("worktree BaseSha mutated to %q after telemetry cancellation", got)
	}
	for _, command := range commands {
		if strings.HasPrefix(command, "update-ref ") {
			t.Fatalf("bounded telemetry mutated the base ref with %q", command)
		}
	}
}

func TestBoundedBaseShaHealingStaysOnTelemetryCopyAndFeedsLaterChecks(t *testing.T) {
	original := &Worktree{
		Path: "worktree", RepoDir: "repo", Branch: "orbit/feature",
		BaseSha: "persisted", Session: "session",
	}
	telemetryWT := original.heartbeatCopy()
	var commands []string
	ops := worktreeGitOps{
		run: func(_ string, args ...string) (string, error) {
			command := strings.Join(args, " ")
			commands = append(commands, command)
			switch {
			case command == "symbolic-ref --short HEAD":
				return "orbit/feature", nil
			case command == "rev-parse refs/heads/orbit/feature":
				return "tip", nil
			case command == "merge-base HEAD orbit/feature":
				return "candidate", nil
			case strings.HasPrefix(command, "merge-base --is-ancestor "):
				return "", nil
			case command == "rev-parse --verify --quiet refs/heads/main":
				return "main", nil
			case command == "rev-list --count candidate..orbit/feature":
				return "1", nil
			default:
				return "", nil
			}
		},
		runEnv: func(string, []string, ...string) (string, error) { return "", nil },
	}

	if got := ops.freshenBaseSha(telemetryWT); got != "candidate" {
		t.Fatalf("healed telemetry base = %q, want candidate", got)
	}
	if got := telemetryWT.baseSha(); got != "candidate" {
		t.Fatalf("telemetry copy retained base %q, want candidate", got)
	}
	if got := original.baseSha(); got != "persisted" {
		t.Fatalf("live worktree base mutated to %q by telemetry", got)
	}
	_ = ops.branchMergedInto(telemetryWT)
	foundHealedMergeCheck := false
	for _, command := range commands {
		if command == "rev-list --count candidate..orbit/feature" {
			foundHealedMergeCheck = true
			break
		}
	}
	if !foundHealedMergeCheck {
		t.Fatalf("later merge check did not use healed telemetry base; commands = %#v", commands)
	}
	for _, command := range commands {
		if strings.HasPrefix(command, "update-ref ") {
			t.Fatalf("bounded telemetry persisted a base ref with %q", command)
		}
	}
}

func TestWorktreeHeartbeatCopySynchronizesBaseSha(t *testing.T) {
	wt := &Worktree{BaseSha: "base-0"}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			wt.setBaseSha(fmt.Sprintf("base-%d", i))
		}
	}()
	for i := 0; i < 1000; i++ {
		if snapshot := wt.heartbeatCopy(); snapshot == nil || snapshot.baseSha() == "" {
			t.Fatal("heartbeat copy returned an empty base")
		}
	}
	<-done
}

func TestCollectHeartbeatTelemetryKillsBlockedGitAtDeadline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-backed fake git is Unix-only")
	}
	binDir := t.TempDir()
	gitPath := filepath.Join(binDir, "git")
	if err := os.WriteFile(gitPath, []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	result := collectHeartbeatSessionStates(ctx, []heartbeatTelemetryTarget{{
		sessionID:        "slow",
		isolationStatus:  isoWorktree,
		worktree:         (&Worktree{Path: binDir, RepoDir: binDir, Branch: "orbit/slow", BaseSha: "base"}).heartbeatCopy(),
		permitGeneration: 1,
	}})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("bounded Git telemetry returned after %s, want <1s", elapsed)
	}
	if len(result) != 0 {
		t.Fatalf("timed-out telemetry returned a partial row: %#v", result)
	}
}

func TestHeartbeatTelemetryDeadlineAndShutdownJoin(t *testing.T) {
	timedOut := make(chan struct{})
	collector := func(ctx context.Context, _ []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
		<-ctx.Done()
		close(timedOut)
		return nil
	}
	telemetry := newHeartbeatTelemetryProbe(20*time.Millisecond, collector)
	ctx, cancel := context.WithCancel(context.Background())
	go telemetry.run(ctx)
	telemetry.trigger([]heartbeatTelemetryTarget{{sessionID: "slow", permitGeneration: 1}})
	select {
	case <-timedOut:
	case <-time.After(time.Second):
		t.Fatal("telemetry batch did not honor its shared deadline")
	}
	cancel()
	done := make(chan struct{})
	go func() {
		telemetry.wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("telemetry worker did not join after shutdown cancellation")
	}
}
