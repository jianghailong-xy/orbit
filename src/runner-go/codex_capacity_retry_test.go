package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// "Selected model is at capacity" is OpenAI turning the request away at admission, for minutes and
// across models. A turn that hits it is replayed in place — same thread, same input — after a
// backoff, and fails only once the replays are spent, with the error it hit. These drive the real
// runCodexAppServerSessionProcess against this test binary posing as `codex app-server`, whose every
// turn/start is answered with the frames the test scripted for that attempt.

const codexCapacityMessage = "Selected model is at capacity. Please try a different model."

func TestIsCodexCapacityErrorMatchesOnlyAtCapacity(t *testing.T) {
	for msg, want := range map[string]bool{
		codexCapacityMessage:                    true,
		"The selected model is AT CAPACITY.":    true,
		"model at capacity, try later":          true,
		"You've hit your usage limit.":          false,
		"capacity exceeded":                     false,
		"stream disconnected before completion": false,
		"":                                      false,
	} {
		if got := isCodexCapacityError(msg); got != want {
			t.Errorf("isCodexCapacityError(%q) = %v, want %v", msg, got, want)
		}
	}
}

func codexCapacityAttempt() []map[string]interface{} {
	return []map[string]interface{}{
		{"method": "error", "params": map[string]interface{}{
			"threadId": "thread-fake-session", "turnId": "turn-fake-session", "willRetry": false,
			"error": map[string]interface{}{"message": codexCapacityMessage},
		}},
		{"method": "turn/completed", "params": map[string]interface{}{
			"threadId": "thread-fake-session",
			"turn": map[string]interface{}{"id": "turn-fake-session", "status": "failed",
				"error": map[string]interface{}{"message": codexCapacityMessage}},
		}},
	}
}

func codexCompletedAttempt(reply string) []map[string]interface{} {
	return []map[string]interface{}{
		{"method": "item/agentMessage/delta", "params": map[string]interface{}{"threadId": "thread-fake-session", "delta": reply}},
		{"method": "turn/completed", "params": map[string]interface{}{
			"threadId": "thread-fake-session",
			"turn":     map[string]interface{}{"id": "turn-fake-session", "status": "completed"},
		}},
	}
}

// runCodexCapacitySession runs one session that is handed one message, and returns how its turn
// was completed and the input of every turn/start the fake received.
func runCodexCapacitySession(t *testing.T, attempts ...[]map[string]interface{}) (TurnCompleteRequest, []string) {
	t.Helper()
	saved := codexCapacityRetryDelays
	codexCapacityRetryDelays = []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond}
	t.Cleanup(func() { codexCapacityRetryDelays = saved })

	fake := newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
	fake.useAsRunnerDefault(t)
	fake.answerSessionsWith(t)
	fake.answerTurnsWith(t, attempts...)

	var served atomic.Bool
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/inbox") && served.CompareAndSwap(false, true) {
			_, _ = w.Write([]byte(`{"turnId":"orbit-turn-1","kind":"message","content":"run the ledger spec"}`))
			return
		}
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(inbox.Close)

	job := &ClaimedSession{
		SessionID: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
		Provider:  providerCodex,
		Agent:     AgentExecConfig{Provider: providerCodex},
	}
	completed := make(chan TurnCompleteRequest, 4)
	ctx, cancel := context.WithCancel(context.Background())
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		runCodexAppServerSessionProcess(ctx, context.Background(), NewTransport(inbox.URL, "runner-token"), job, "", t.TempDir(), t.TempDir(),
			func(string, map[string]interface{}) {}, func(string, string, map[string]interface{}) {}, func(string) {}, false, nil, nil,
			func(req TurnCompleteRequest, _ ...context.Context) error { completed <- req; return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	defer func() {
		cancel()
		select {
		case <-ended:
		case <-time.After(30 * time.Second):
			t.Fatal("the session did not end once cancelled")
		}
	}()

	var got TurnCompleteRequest
	select {
	case got = <-completed:
	case <-ended:
		t.Fatal("the session ended before it completed the turn")
	case <-time.After(30 * time.Second):
		t.Fatal("the turn was never completed")
	}
	// Nothing completes the turn a second time, and nothing starts it again once it is completed.
	time.Sleep(100 * time.Millisecond)
	select {
	case extra := <-completed:
		t.Fatalf("the turn was completed twice: %+v then %+v", got, extra)
	default:
	}
	var inputs []string
	for _, line := range fake.lines(t, "requests.jsonl") {
		var frame map[string]interface{}
		if json.Unmarshal([]byte(line), &frame) != nil || frame["method"] != "turn/start" {
			continue
		}
		params, _ := frame["params"].(map[string]interface{})
		input, _ := json.Marshal(params["input"])
		inputs = append(inputs, string(input))
	}
	return got, inputs
}

func TestCodexTurnAtCapacityFailsWithItsErrorOnlyAfterTheRetriesAreSpent(t *testing.T) {
	attempts := make([][]map[string]interface{}, len(codexCapacityRetryDelays)+1)
	for i := range attempts {
		attempts[i] = codexCapacityAttempt()
	}
	got, inputs := runCodexCapacitySession(t, attempts...)

	if want := len(codexCapacityRetryDelays) + 1; len(inputs) != want {
		t.Fatalf("turn/start sent %d times, want %d (the turn and %d replays)", len(inputs), want, want-1)
	}
	for i, input := range inputs {
		if input != inputs[0] || !strings.Contains(input, "run the ledger spec") {
			t.Fatalf("turn/start %d carried %s, want the turn's own input %s", i+1, input, inputs[0])
		}
	}
	if got.TurnID != "orbit-turn-1" || got.Status != stFailed || got.Error != codexCapacityMessage {
		t.Fatalf("turn completed %+v, want orbit-turn-1 FAILED with the engine's own error", got)
	}
}

func TestCodexTurnAtCapacitySucceedsWhenAReplayGetsThrough(t *testing.T) {
	got, inputs := runCodexCapacitySession(t, codexCapacityAttempt(), codexCompletedAttempt("ledger spec green"))

	if len(inputs) != 2 || inputs[0] != inputs[1] {
		t.Fatalf("turn/start inputs %v, want the same input twice", inputs)
	}
	if got.TurnID != "orbit-turn-1" || got.Status != stSucceeded || got.Error != "" || got.Result != "ledger spec green" {
		t.Fatalf("turn completed %+v, want orbit-turn-1 SUCCEEDED with the replay's reply", got)
	}
}

// A turn that failed for any other reason is not replayed.
func TestCodexTurnFailingOtherwiseIsNotRetried(t *testing.T) {
	failed := []map[string]interface{}{{"method": "turn/completed", "params": map[string]interface{}{
		"threadId": "thread-fake-session",
		"turn": map[string]interface{}{"id": "turn-fake-session", "status": "failed",
			"error": map[string]interface{}{"message": "stream disconnected before completion"}},
	}}}
	got, inputs := runCodexCapacitySession(t, failed, codexCompletedAttempt("unreachable"))

	if len(inputs) != 1 {
		t.Fatalf("turn/start sent %d times, want 1", len(inputs))
	}
	if got.Status != stFailed || got.Error != "stream disconnected before completion" {
		t.Fatalf("turn completed %+v, want FAILED with its own error", got)
	}
}

// While a replay waits out its backoff, the turn is back to not-yet-started: a Stop finalizes it at
// once and wakes the wait, and the Codex turn id the failed attempt was answered with is no address.
func TestCodexCapacityBackoffIsInterruptibleAndForgetsTheFailedAttempt(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{
		orbitTurnID: "orbit-turn-1", codexTurnID: "turn-failed", startSent: true,
		prepared: &codexPreparedTurn{Prompt: "run the ledger spec"},
		result:   codexTurnResult{Status: stFailed, Error: codexCapacityMessage},
	}
	active.fullText.WriteString("half a reply")
	retry, ok := beginCodexCapacityRetry(&mu, &active, codexTurnResult{Status: stFailed}, "thread-1")
	if !ok || retry.attempt != 1 || retry.prepared.Prompt != "run the ledger spec" {
		t.Fatalf("beginCodexCapacityRetry = %+v, %v; want the first replay of the turn's input", retry, ok)
	}
	if active.codexTurnID != "" || active.startSent || active.result.Status != stSucceeded || active.fullText.Len() != 0 {
		t.Fatalf("active turn after the failed attempt = %+v, want it reset to not-yet-started", active)
	}
	if got, _ := markCodexAppTurnStarted(&mu, &active, "orbit-turn-1", "turn-failed"); got != "" || active.codexTurnID != "" {
		t.Fatalf("a late turn id from the failed attempt was recorded: %q", active.codexTurnID)
	}
	if _, beforeStart := requestCodexAppInterrupt(&mu, &active); !beforeStart {
		t.Fatal("an interrupt in the backoff did not finalize the turn before start")
	}
	select {
	case <-retry.wake:
	default:
		t.Fatal("an interrupt in the backoff did not wake the wait")
	}
	if _, ok := beginCodexCapacityRetry(&mu, &active, codexTurnResult{Status: stFailed, Error: codexCapacityMessage}, "thread-1"); ok {
		t.Fatal("an interrupted turn was replayed")
	}
}

// Codex's auto_review approvals reviewer runs on a model of its own, and when that model is at
// capacity the review cannot run: Codex refuses the action ("Automatic approval review failed:
// Selected model is at capacity…") and tells the model not to go on without asking, so the turn
// ends normally with its work undone. The turn is replayed as if it had failed "at capacity"
// itself; the replay has the action reviewed again, so nothing is let through unreviewed.

const codexReviewAtCapacityRationale = "Automatic approval review failed: " + codexCapacityMessage

func codexReviewAttempt(status, rationale, reply string) []map[string]interface{} {
	return append([]map[string]interface{}{
		{"method": "item/autoApprovalReview/completed", "params": map[string]interface{}{
			"threadId": "thread-fake-session", "turnId": "turn-fake-session", "reviewId": "review-1",
			"targetItemId": "exec-1", "startedAtMs": 1, "completedAtMs": 2, "decisionSource": "agent",
			"action": map[string]interface{}{"type": "command", "command": "make field-build"},
			"review": map[string]interface{}{"status": status, "rationale": rationale},
		}},
	}, codexCompletedAttempt(reply)...)
}

func TestCodexTurnWhoseAutoReviewWasAtCapacityIsReplayed(t *testing.T) {
	// The schema does not say which status a reviewer that could not run reports.
	for _, status := range []string{"denied", "timedOut", "aborted"} {
		t.Run(status, func(t *testing.T) {
			got, inputs := runCodexCapacitySession(t,
				codexReviewAttempt(status, codexReviewAtCapacityRationale, "I need approval to run make field-build."),
				codexCompletedAttempt("field-build done"))
			if len(inputs) != 2 || inputs[0] != inputs[1] {
				t.Fatalf("turn/start inputs %v, want the same input twice", inputs)
			}
			if got.Status != stSucceeded || got.Result != "field-build done" {
				t.Fatalf("turn completed %+v, want SUCCEEDED with the replay's reply", got)
			}
		})
	}
}

func TestCodexTurnWhoseAutoReviewStaysAtCapacityEndsAfterTheRetries(t *testing.T) {
	attempts := make([][]map[string]interface{}, len(codexCapacityRetryDelays)+1)
	for i := range attempts {
		attempts[i] = codexReviewAttempt("denied", codexReviewAtCapacityRationale, "I need approval to run make field-build.")
	}
	got, inputs := runCodexCapacitySession(t, attempts...)
	if want := len(codexCapacityRetryDelays) + 1; len(inputs) != want {
		t.Fatalf("turn/start sent %d times, want %d", len(inputs), want)
	}
	if got.Status != stSucceeded || got.Result != "I need approval to run make field-build." {
		t.Fatalf("turn completed %+v, want the last attempt's own ending", got)
	}
}

// A review that ran and decided is the reviewer's answer, whatever it says.
func TestCodexTurnWhoseAutoReviewDecidedIsNotReplayed(t *testing.T) {
	for name, review := range map[string][2]string{
		"a denial":    {"denied", "Deletes files outside the workspace."},
		"an approval": {"approved", "Low risk; the queue is at capacity so the script drains it."},
	} {
		t.Run(name, func(t *testing.T) {
			got, inputs := runCodexCapacitySession(t,
				codexReviewAttempt(review[0], review[1], "done as far as allowed"),
				codexCompletedAttempt("unreachable"))
			if len(inputs) != 1 || got.Result != "done as far as allowed" {
				t.Fatalf("turn/start sent %d times, turn completed %+v; want one attempt", len(inputs), got)
			}
		})
	}
}

// A turn that failed for some other reason keeps that failure even if a review of it was at capacity.
func TestCodexReviewAtCapacityDoesNotReplayATurnThatFailedOtherwise(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{
		orbitTurnID: "orbit-turn-1", startSent: true, reviewAtCapacity: true,
		prepared: &codexPreparedTurn{Prompt: "run the ledger spec"},
	}
	if _, ok := beginCodexCapacityRetry(&mu, &active, codexTurnResult{Status: stFailed, Error: "unauthorized"}, "thread-1"); ok {
		t.Fatal("a turn that failed unauthorized was replayed for its review")
	}
	if _, ok := beginCodexCapacityRetry(&mu, &active, codexTurnResult{Status: stInterrupted}, "thread-1"); ok {
		t.Fatal("an interrupted turn was replayed for its review")
	}
	retry, ok := beginCodexCapacityRetry(&mu, &active, codexTurnResult{Status: stSucceeded}, "thread-1")
	if !ok || !retry.reviewAtCapacity || active.reviewAtCapacity {
		t.Fatalf("beginCodexCapacityRetry = %+v, %v (flag left %v); want a review replay that clears the flag", retry, ok, active.reviewAtCapacity)
	}
}
