package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
	tests := []struct {
		name       string
		command    string
		execDir    string
		deadlineIn time.Duration
		cancelIn   time.Duration
		wantKind   string
		wantExit   *int
	}{
		{name: "exited", command: "exit 7", deadlineIn: time.Second, wantKind: "EXITED", wantExit: intPtr(7)},
		{name: "timed out", command: "while :; do :; done", deadlineIn: 40 * time.Millisecond, wantKind: "TIMED_OUT"},
		{name: "cancelled", command: "while :; do :; done", deadlineIn: time.Second, cancelIn: 40 * time.Millisecond, wantKind: "CANCELLED"},
		{name: "signaled", command: "kill -TERM $$", deadlineIn: time.Second, wantKind: "SIGNALED"},
		{name: "start failed", command: "true", execDir: "/orbit/acceptance/does-not-exist", deadlineIn: time.Second, wantKind: "START_FAILED"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
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
				RequestedTimeoutSeconds: 1, EffectiveTimeoutSeconds: 1,
				EffectiveDeadline:      deadline.Format(time.RFC3339Nano),
				RequiredSchemaRevision: 2, RequiredCapabilityRevision: 2,
			}
			if tc.cancelIn > 0 {
				time.AfterFunc(tc.cancelIn, cancel)
			}
			execDir := tc.execDir
			if execDir == "" {
				execDir = t.TempDir()
			}
			result, err := runExecutableAcceptance(
				ctx, transport, "session", execDir, tc.command,
				func(string, map[string]interface{}) {}, "turn", nil, plan,
			)
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

func intPtr(value int) *int { return &value }

func sameOptionalInt(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
