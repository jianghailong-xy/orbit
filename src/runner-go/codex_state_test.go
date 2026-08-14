package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSharedCodexStateIsAbsolutePrivateAndPartitionedByCodexHome(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "relative-orbit-home"))

	first, err := sharedCodexStateForEnv([]string{"HOME=/users/alice"}, root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := sharedCodexStateForEnv([]string{"CODEX_HOME=/users/alice/.codex"}, root)
	if err != nil {
		t.Fatal(err)
	}
	other, err := sharedCodexStateForEnv([]string{"CODEX_HOME=/users/bob/.codex"}, root)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(first.Dir) {
		t.Fatalf("shared state path is relative: %q", first.Dir)
	}
	if first.Dir != second.Dir || first.Partition != second.Partition {
		t.Fatalf("equivalent CODEX_HOME values selected different state: %#v vs %#v", first, second)
	}
	if other.Dir == first.Dir || other.Partition == first.Partition {
		t.Fatalf("different CODEX_HOME values selected the same state: %#v vs %#v", first, other)
	}
	relative, err := sharedCodexStateForEnv([]string{"CODEX_HOME=relative-codex"}, root)
	if err != nil {
		t.Fatal(err)
	}
	wantRelativeHome := filepath.Join(root, "relative-codex")
	if relative.CodexHome != wantRelativeHome {
		t.Fatalf("relative CODEX_HOME = %q, want %q", relative.CodexHome, wantRelativeHome)
	}
	bootstrapEnv := envWithValue([]string{"CODEX_HOME=relative-codex", "HOME=/users/alice"}, "CODEX_HOME", relative.CodexHome)
	if got := envValue(bootstrapEnv, "CODEX_HOME"); got != wantRelativeHome {
		t.Fatalf("bootstrap CODEX_HOME = %q, want %q", got, wantRelativeHome)
	}
	if runtime.GOOS != "windows" {
		for _, dir := range []string{filepath.Dir(first.Dir), first.Dir, other.Dir} {
			info, err := os.Stat(dir)
			if err != nil {
				t.Fatal(err)
			}
			if got := info.Mode().Perm(); got != machineHomePerm {
				t.Fatalf("%s mode = %04o, want %04o", dir, got, machineHomePerm)
			}
		}
	}
}

func TestEnsureSharedCodexStateRejectsFileAndSymlink(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", root)
	partition := codexStatePartition("/users/alice/.codex")
	stateRoot := codexStateRoot()
	if err := os.WriteFile(stateRoot, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureSharedCodexStateDir(partition); err == nil {
		t.Fatal("ordinary file was accepted as codex state root")
	}
	if err := os.Remove(stateRoot); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, stateRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureSharedCodexStateDir(partition); err == nil {
		t.Fatal("symlink was accepted as codex state root")
	}
}

func TestResolveCodexStateKeepsSuccessfulLegacySessionSticky(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	scratch := filepath.Join(root, "run")
	legacy := filepath.Join(scratch, "codex-state")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "state_5.sqlite"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=/users/alice"}
	selected, err := resolveCodexStateDir(scratch, "thread-1", nil, env, root)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Layout != codexStateLayoutLegacy || selected.Shared {
		t.Fatalf("successful legacy session selected %#v", selected)
	}
	want, err := filepath.Abs(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Dir != want {
		t.Fatalf("legacy dir = %q, want %q", selected.Dir, want)
	}
}

func TestResolveCodexStateIgnoresHalfInitializedLegacyDirWithoutRuntime(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	scratch := filepath.Join(root, "run")
	legacy := filepath.Join(scratch, "codex-state")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "state_5.sqlite"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	selected, err := resolveCodexStateDir(scratch, "", nil, []string{"HOME=/users/alice"}, root)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Layout != codexStateLayoutShared || !selected.Shared {
		t.Fatalf("pre-thread failure selected %#v, want shared state", selected)
	}
}

func TestResolveCodexStateMarkerWinsAndCustomProviderStaysLocal(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	scratch := filepath.Join(root, "run")
	partition := codexStatePartition("/users/alice/.codex")
	meta := &sessionMeta{
		CodexStateLayout:    codexStateLayoutShared,
		CodexStatePartition: partition,
		CodexStateHome:      "/users/alice/.codex",
	}
	selected, err := resolveCodexStateDir(scratch, "thread-1", meta, []string{"OPENAI_API_KEY=secret"}, root)
	if err != nil {
		t.Fatal(err)
	}
	if !selected.Shared || selected.Partition != partition {
		t.Fatalf("persisted shared marker did not win: %#v", selected)
	}
	if selected.CodexHome != "/users/alice/.codex" {
		t.Fatalf("persisted shared home did not stay sticky: %#v", selected)
	}

	missingHomeMeta := &sessionMeta{
		CodexStateLayout:    codexStateLayoutShared,
		CodexStatePartition: partition,
	}
	if _, err := resolveCodexStateDir(scratch, "thread-1", missingHomeMeta, []string{"HOME=/users/bob"}, root); err == nil {
		t.Fatal("shared marker without its original home accepted a mismatched current HOME")
	}
	selected, err = resolveCodexStateDir(scratch, "thread-1", missingHomeMeta, []string{"HOME=/users/alice"}, root)
	if err != nil {
		t.Fatalf("compatible pre-home marker failed: %v", err)
	}
	if selected.CodexHome != "/users/alice/.codex" || selected.Partition != partition {
		t.Fatalf("compatible pre-home marker selected %#v", selected)
	}

	customScratch := filepath.Join(root, "custom-run")
	selected, err = resolveCodexStateDir(customScratch, "", nil, []string{"OPENAI_BASE_URL=https://example.test/v1"}, root)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Layout != codexStateLayoutLegacy || selected.Shared {
		t.Fatalf("custom provider selected shared state: %#v", selected)
	}

	// The marker is persisted before app-server spawn, so a failed first spawn may
	// leave no SQLite file. That explicit local choice must still be retryable.
	localMeta := &sessionMeta{CodexStateLayout: codexStateLayoutLegacy}
	selected, err = resolveCodexStateDir(customScratch, "", localMeta, []string{"OPENAI_API_KEY=secret"}, root)
	if err != nil {
		t.Fatalf("pre-thread local retry failed: %v", err)
	}
	if selected.Layout != codexStateLayoutLegacy || selected.Shared {
		t.Fatalf("pre-thread local retry selected %#v", selected)
	}
}

func TestCodexPlanUsageRejectsCustomCredentialState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	for _, env := range [][]string{
		{"HOME=/users/alice", "OPENAI_API_KEY=secret"},
		{"HOME=/users/alice", "OPENAI_BASE_URL=https://example.test/v1"},
	} {
		if _, err := codexPlanUsageStateForEnv(env, root); err == nil {
			t.Fatalf("custom credential env %#v was allowed to use plan-usage shared state", env)
		}
	}
	state, err := codexPlanUsageStateForEnv([]string{"HOME=/users/alice"}, root)
	if err != nil || !state.Shared {
		t.Fatalf("built-in plan usage state = %#v, %v", state, err)
	}
}

func TestSessionMetaPreservesCodexStateLayout(t *testing.T) {
	scratch := t.TempDir()
	job := &ClaimedSession{SessionUUID: "session-1", Provider: providerCodex, Title: "test"}
	partition := codexStatePartition("/users/alice/.codex")
	writeSessionMetaWithCodexState(scratch, job, "/repo", codexStateLayoutShared, partition, "/users/alice/.codex")
	writeSessionMeta(scratch, job, "/repo")
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil {
		t.Fatal("session meta was not written")
	}
	if meta.CodexStateLayout != codexStateLayoutShared || meta.CodexStatePartition != partition {
		t.Fatalf("codex state marker was not preserved: %#v", meta)
	}
	if meta.CodexStateHome != "/users/alice/.codex" {
		t.Fatalf("codex state home was not preserved: %#v", meta)
	}
}

func TestCodexStateInitGateSharesSuccessAndRetriesFailure(t *testing.T) {
	gate := newCodexStateInitGate()
	var calls atomic.Int32
	if err := gate.wait(context.Background(), "success", func() error {
		calls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := gate.wait(context.Background(), "success", func() error {
		calls.Add(1)
		return errors.New("must not run")
	}); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("successful initialization callback count = %d, want 1", got)
	}

	wantErr := errors.New("first attempt failed")
	if err := gate.wait(context.Background(), "retry", func() error {
		calls.Add(1)
		return wantErr
	}); !errors.Is(err, wantErr) {
		t.Fatalf("first failure = %v, want %v", err, wantErr)
	}
	if err := gate.wait(context.Background(), "retry", func() error {
		calls.Add(1)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("callback count after retry = %d, want 3", got)
	}
}

func TestCodexStateInitGateSingleflightsConcurrentWaiters(t *testing.T) {
	gate := newCodexStateInitGate()
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	const waiterCount = 16
	var waiters sync.WaitGroup
	errs := make(chan error, waiterCount)
	for range waiterCount {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			errs <- gate.wait(context.Background(), "shared", func() error {
				if calls.Add(1) == 1 {
					close(started)
				}
				<-release
				return nil
			})
		}()
	}
	<-started
	close(release)
	waiters.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("concurrent bootstrap callback count = %d, want 1", got)
	}
}

func TestRetryableCodexStateInitErrorIsLimitedToBackfillLease(t *testing.T) {
	for _, message := range []string{
		"initialize: timed out waiting for state db backfill at /state",
	} {
		if !retryableCodexStateInitError(errors.New(message)) {
			t.Fatalf("known backfill wait %q was not retryable", message)
		}
	}
	for _, message := range []string{
		"initialize: unsupported protocol",
		"state db backfill already running at /state",
		"state db backfill not complete at /state",
		"permission denied",
		"database disk image is malformed",
		"codex app-server closed",
	} {
		if retryableCodexStateInitError(errors.New(message)) {
			t.Fatalf("permanent initialization failure %q was retryable", message)
		}
	}
}

func TestCodexStderrStateInitFailureIsLimitedToCodexOwnLine(t *testing.T) {
	// The line the runner recorded when a session lost its start to a concurrent one.
	failure := "Error: failed to initialize sqlite state runtime under /root/.orbit/codex-state/b30327ab8049b1dbefb89e92: " +
		"failed to initialize state runtime at /root/.orbit/codex-state/b30327ab8049b1dbefb89e92"
	if !codexStderrIsStateInitFailure(failure) {
		t.Fatal("codex state runtime failure was not recognized on stderr")
	}
	for _, line := range []string{
		"ERROR codex_core: exec rejected by user",
		"WARNING: proceeding, even though we could not create PATH aliases",
		"thread/start failed: unsupported protocol",
		"",
	} {
		if codexStderrIsStateInitFailure(line) {
			t.Fatalf("unrelated stderr %q was read as a state init failure", line)
		}
	}
}

func TestCodexHandshakeRetriesOnlyBoundedStateInitFailures(t *testing.T) {
	if !shouldRetryCodexHandshake(0, true, nil) {
		t.Fatal("first state init failure was not retried")
	}
	if shouldRetryCodexHandshake(codexStateHandshakeRetries, true, nil) {
		t.Fatal("state init failure retried past its attempt budget")
	}
	// A process that died for any other reason, or a handshake budget already spent, is the
	// caller's failure to report rather than something another attempt can fix.
	if shouldRetryCodexHandshake(0, false, nil) {
		t.Fatal("unrelated start failure was retried")
	}
	if shouldRetryCodexHandshake(0, true, context.DeadlineExceeded) {
		t.Fatal("state init failure retried after the handshake budget expired")
	}
}

func TestRetryCodexStateInitializationRetriesOnlyLeaseWaits(t *testing.T) {
	var calls atomic.Int32
	err := retryCodexStateInitialization(context.Background(), time.Millisecond, func(context.Context) error {
		if calls.Add(1) == 1 {
			return errors.New("timed out waiting for state db backfill at /state")
		}
		return nil
	})
	if err != nil || calls.Load() != 2 {
		t.Fatalf("lease retry = (%v, %d calls), want success after 2", err, calls.Load())
	}

	calls.Store(0)
	wantErr := errors.New("database disk image is malformed")
	err = retryCodexStateInitialization(context.Background(), time.Millisecond, func(context.Context) error {
		calls.Add(1)
		return wantErr
	})
	if !errors.Is(err, wantErr) || calls.Load() != 1 {
		t.Fatalf("permanent failure = (%v, %d calls), want immediate %v", err, calls.Load(), wantErr)
	}
}

func TestCodexStateInitWaiterCancellationDoesNotStopBootstrap(t *testing.T) {
	gate := newCodexStateInitGate()
	started := make(chan struct{})
	release := make(chan struct{})
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- gate.wait(firstCtx, "state", func() error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	cancelFirst()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled leader waiter = %v, want context.Canceled", err)
	}

	var followerCallback atomic.Int32
	followerDone := make(chan error, 1)
	go func() {
		followerDone <- gate.wait(context.Background(), "state", func() error {
			followerCallback.Add(1)
			return errors.New("must not become a second bootstrap")
		})
	}()
	close(release)
	if err := <-followerDone; err != nil {
		t.Fatal(err)
	}
	if got := followerCallback.Load(); got != 0 {
		t.Fatalf("follower started %d extra bootstrap(s)", got)
	}
}
