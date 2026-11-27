//go:build linux || darwin

package main

import (
	"testing"
)

// A failed Claude turn, through the real supervisor and the fake CLI: its turn-complete carries the classification
// and the admission, and the run's finalize carries the same two; a connection failure is TRANSPORT, never a
// refused credential. A failed turn's terminal acknowledgement ends the run without a finalize, so the control
// plane here answers it with a waiting status, which the supervisor does not take as the end and finalizes FAILED.
func TestClaudeFailedTurnCarriesFailureToTurnCompleteAndFinalize(t *testing.T) {
	for _, c := range []struct {
		name      string
		script    []fakeStep
		kind      string
		admission bool
	}{
		{"refused sign-in, nothing else said", []fakeStep{
			{Await: "user"}, {Emit: "replay_user"}, {Emit: "system_init"},
			{Emit: "assistant", Text: claudeOAuthExpired}, {Emit: "result", Text: claudeOAuthExpired},
		}, failureCredentialRefused, true},
		{"connection failure after a tool call", []fakeStep{
			{Await: "user"}, {Emit: "replay_user"}, {Emit: "system_init"},
			{Emit: "tool_use", ToolUseID: "tu-1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
			{Emit: "assistant", Text: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"},
			{Emit: "result", Text: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"},
		}, failureTransport, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), func(TurnCompleteRequest) string { return stAwaitingInput }, c.script...)
			done := rig.awaitSettled("turn-1")
			if done.Status != stFailed {
				t.Fatalf("turn-1 settled %s, want FAILED", done.Status)
			}
			if done.Failure == nil || done.Failure.Kind != c.kind {
				t.Fatalf("turn-1 failure = %+v, want %s", done.Failure, c.kind)
			}
			if done.Admission == nil || *done.Admission != c.admission {
				t.Fatalf("turn-1 admission = %v, want %v", done.Admission, c.admission)
			}
			rig.awaitEnd()
			finals := rig.finalizes()
			if len(finals) != 1 || finals[0].Status != stFailed {
				t.Fatalf("finalizes = %+v, want one FAILED", finals)
			}
			if finals[0].Failure == nil || finals[0].Failure.Kind != c.kind || finals[0].Admission == nil || *finals[0].Admission != c.admission {
				t.Fatalf("finalize carried %+v / %v, want the failed turn's", finals[0].Failure, finals[0].Admission)
			}
		})
	}
}
