package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestExecutableAcceptanceAdvertisesExactHardMaxAndSource(t *testing.T) {
	oldSource := sourceSHA
	sourceSHA = strings.Repeat("a", 40)
	t.Cleanup(func() { sourceSHA = oldSource })
	var capability ExecutableAcceptanceCapability
	if err := json.Unmarshal([]byte(executableAcceptanceCapabilityHeaderValue()), &capability); err != nil {
		t.Fatal(err)
	}
	if capability.SchemaRevision != 2 || capability.CapabilityRevision != 2 {
		t.Fatalf("revision = %d/%d", capability.SchemaRevision, capability.CapabilityRevision)
	}
	if capability.HardMaxSeconds < 1200 {
		t.Fatalf("hard max %d cannot admit the watchdog plan", capability.HardMaxSeconds)
	}
	if capability.RunnerSha != sourceSHA {
		t.Fatalf("runner SHA = %q, want %q", capability.RunnerSha, sourceSHA)
	}
}

func TestExecutableAcceptanceShortProcessesProduceTypedFacts(t *testing.T) {
	const nonTimeoutDeadline = 5 * time.Second
	tests := []struct {
		name       string
		command    string
		execDir    string
		deadlineIn time.Duration
		cancelIn   time.Duration
		wantKind   string
		wantExit   *int
	}{
		{name: "exited", command: "exit 7", deadlineIn: nonTimeoutDeadline, wantKind: "EXITED", wantExit: intPtr(7)},
		{name: "timed out", command: "while :; do :; done", deadlineIn: 250 * time.Millisecond, wantKind: "TIMED_OUT"},
		{name: "cancelled", command: "while :; do :; done", deadlineIn: nonTimeoutDeadline, cancelIn: 100 * time.Millisecond, wantKind: "CANCELLED"},
		{name: "signaled", command: "kill -TERM $$", deadlineIn: nonTimeoutDeadline, wantKind: "SIGNALED"},
		{name: "start failed", command: "true", execDir: "/orbit/acceptance/does-not-exist", deadlineIn: nonTimeoutDeadline, wantKind: "START_FAILED"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			execDir := tc.execDir
			if execDir == "" {
				execDir = t.TempDir()
			}
			deadline := time.Now().Add(tc.deadlineIn).UTC()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/executable-acceptance/admission/start") {
					http.Error(w, "wrong path", http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(ExecutableAttemptStartResponse{
					AttemptID:  "00000000-0000-4000-8000-000000000002",
					DeadlineAt: deadline.Format(time.RFC3339Nano), AttemptNumber: 1,
				})
			}))
			defer server.Close()
			transport := &Transport{baseURL: server.URL, token: "test", client: server.Client()}
			plan := &ExecutableAcceptanceDispatchPlan{
				AdmissionID: "admission", EvaluationPlanDigest: strings.Repeat("b", 64),
				CommandDigest: commandSHA256(tc.command), ExpectedExitCode: 0,
				RequestedTimeoutSeconds: int((tc.deadlineIn + time.Second - 1) / time.Second),
				EffectiveTimeoutSeconds: int((tc.deadlineIn + time.Second - 1) / time.Second),
				EffectiveDeadline:       deadline.Format(time.RFC3339Nano),
				RequiredSchemaRevision:  2, RequiredCapabilityRevision: 2,
			}
			var cancelTimer *time.Timer
			emit := func(kind string, _ map[string]interface{}) {
				if kind == evToolUse && tc.cancelIn > 0 && cancelTimer == nil {
					cancelTimer = time.AfterFunc(tc.cancelIn, cancel)
				}
			}
			result, err := runExecutableAcceptance(
				ctx, transport, "session", execDir, tc.command,
				emit, "turn", nil, plan,
			)
			if cancelTimer != nil {
				cancelTimer.Stop()
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != stSucceeded || result.AcceptanceTerminationKind != tc.wantKind {
				t.Fatalf("result = %#v, want typed %s", result, tc.wantKind)
			}
			if !sameOptionalInt(result.AcceptanceActualExitCode, tc.wantExit) {
				t.Fatalf("actual exit = %#v, want %#v", result.AcceptanceActualExitCode, tc.wantExit)
			}
			if result.AcceptanceAttemptID == "" || result.AcceptanceAdmissionID != "admission" {
				t.Fatalf("result lost admission/attempt binding: %#v", result)
			}
		})
	}
}

func TestExecutableAcceptanceCompletedExitOutranksLateDeadline(t *testing.T) {
	cmd := exec.Command("bash", "-lc", "exit 7")
	if err := cmd.Run(); err == nil {
		t.Fatal("command unexpectedly exited zero")
	}
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 7 {
		t.Fatalf("process state = %#v, want concrete exit 7", cmd.ProcessState)
	}

	commandCtx, cancel := context.WithDeadline(context.Background(), time.Unix(0, 0))
	defer cancel()
	<-commandCtx.Done()
	kind, actualExit, signal := classifyExecutableAcceptanceTermination(
		context.Background(), commandCtx, cmd.ProcessState,
	)
	if kind != "EXITED" || !sameOptionalInt(actualExit, intPtr(7)) || signal != "" {
		t.Fatalf("classification = (%q, %#v, %q), want (EXITED, 7, empty)", kind, actualExit, signal)
	}
}

func TestExecutableAcceptanceStreamsLiveOutputWithoutChangingItsTypedFact(t *testing.T) {
	execDir := t.TempDir()
	gate := execDir + "/release"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer func() { _ = os.WriteFile(gate, []byte("release"), 0o644) }()
	deadline := time.Now().Add(5 * time.Second).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ExecutableAttemptStartResponse{
			AttemptID: "00000000-0000-4000-8000-000000000002", DeadlineAt: deadline.Format(time.RFC3339Nano), AttemptNumber: 1,
		})
	}))
	defer server.Close()
	transport := &Transport{baseURL: server.URL, token: "test", client: server.Client()}
	command := "printf acceptance-live; while [ ! -f release ]; do sleep 0.02; done; printf done"
	plan := &ExecutableAcceptanceDispatchPlan{
		AdmissionID: "admission", EvaluationPlanDigest: strings.Repeat("b", 64),
		CommandDigest: commandSHA256(command), ExpectedExitCode: 0,
		RequestedTimeoutSeconds: 5, EffectiveTimeoutSeconds: 5,
		EffectiveDeadline:      deadline.Format(time.RFC3339Nano),
		RequiredSchemaRevision: 2, RequiredCapabilityRevision: 2,
	}

	var mu sync.Mutex
	var kinds []string
	live := make(chan struct{}, 1)
	emit := func(kind string, _ map[string]interface{}) {
		mu.Lock()
		kinds = append(kinds, kind)
		mu.Unlock()
		if kind == evToolOutput {
			select {
			case live <- struct{}{}:
			default:
			}
		}
	}
	type result struct {
		completion TurnCompleteRequest
		err        error
	}
	done := make(chan result, 1)
	go func() {
		completion, err := runExecutableAcceptance(
			ctx, transport, "session", execDir, command, emit, "turn", nil, plan,
		)
		done <- result{completion: completion, err: err}
	}()

	select {
	case <-live:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("acceptance shell produced no live tool_output")
	}
	mu.Lock()
	runningKinds := append([]string(nil), kinds...)
	mu.Unlock()
	for _, kind := range runningKinds {
		if kind == evToolResult {
			t.Fatal("acceptance shell emitted tool_result before its typed process fact existed")
		}
	}
	if err := os.WriteFile(gate, []byte("release"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got result
	select {
	case got = <-done:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("acceptance shell did not finish after release")
	}
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.completion.AcceptanceTerminationKind != "EXITED" ||
		got.completion.AcceptanceActualExitCode == nil || *got.completion.AcceptanceActualExitCode != 0 ||
		got.completion.ShellOutput == nil || *got.completion.ShellOutput != "acceptance-livedone" {
		t.Fatalf("typed acceptance fact changed: %#v", got.completion)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(kinds) < 3 || kinds[0] != evToolUse || kinds[len(kinds)-1] != evToolResult {
		t.Fatalf("acceptance event order = %v", kinds)
	}
}

func TestExecutableAcceptanceKeepsCurrentLiveTailPastDurableCaptureCap(t *testing.T) {
	var output executableOutputBuffer
	prefix := strings.Repeat("p", executableAcceptanceOutputMaxBytes)
	tail := strings.Repeat("t", foregroundShellOutputCap)
	if _, err := output.Write([]byte(prefix + tail)); err != nil {
		t.Fatal(err)
	}
	durable, truncated := output.output()
	if !truncated || len(durable) != executableAcceptanceOutputMaxBytes || string(durable[:16]) != strings.Repeat("p", 16) {
		t.Fatalf("durable acceptance capture = %d bytes, truncated=%v", len(durable), truncated)
	}
	if got := output.snapshot(foregroundShellOutputCap); got != tail {
		t.Fatalf("live tail froze at the durable cap: got %d bytes", len(got))
	}
}

func intPtr(value int) *int { return &value }

func sameOptionalInt(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
