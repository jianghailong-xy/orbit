package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Records as kimi 2.6.0 writes them (2026-11-13), cut to the fields read.
const (
	kimiLostTaskPrompt = `{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"<notification id=\"task:bash-x:lost\">"}],"origin":{"kind":"task","taskId":"bash-x","status":"lost"},"promptId":"task:bash-x:lost","turnId":%d,"trigger":"normal","time":1}` + "\n"
	kimiUserPrompt     = `{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"reply P2RAN"}],"origin":{"kind":"user"},"promptId":"msg_1","turnId":%d,"trigger":"normal","time":1}` + "\n"
	kimiTextPart       = `{"type":"context.append_loop_event","agentId":"main","event":{"type":"content.part","turnId":"%d","step":1,"part":{"type":"text","text":"%s"}},"time":1}` + "\n"
	kimiThinkPart      = `{"type":"context.append_loop_event","agentId":"main","event":{"type":"content.part","turnId":"%d","step":1,"part":{"type":"think","think":"hmm"}},"time":1}` + "\n"
	kimiTurnEndedRec   = `{"type":"turn.ended","agentId":"main","turnId":%d,"reason":"completed","durationMs":5,"time":2}` + "\n"
)

func kimiTestWire(t *testing.T) (home, wire string) {
	t.Helper()
	home = t.TempDir()
	putKimiSession(t, home, kimiTestWorkDir, kimiTestSessionID, time.Now().Add(-time.Hour), kimiTestTurn{"rename the widget", "renamed it"})
	wire, _ = kimiTurnWire(home, kimiTestSessionID)
	if wire == "" {
		t.Fatal("no wire")
	}
	return home, wire
}

func appendWire(t *testing.T, wire, format string, args ...interface{}) {
	t.Helper()
	f, err := os.OpenFile(wire, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	text := format
	if len(args) > 0 {
		text = fmt.Sprintf(format, args...)
	}
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// A turn Kimi opens by itself is read as running until its end is written; a turn a killed process
// left open before this one started is not.
func TestKimiTurnLedgerFollowsTheTurnOpenNow(t *testing.T) {
	home, wire := kimiTestWire(t)
	// The previous process was killed mid-turn: its turn.prompt never gets a turn.ended.
	appendWire(t, wire, kimiUserPrompt, 7)
	turns := newKimiTurnLedger(home, kimiTestSessionID)
	if turns.running() {
		t.Fatal("a turn left open by a previous process reads as running")
	}
	appendWire(t, wire, kimiLostTaskPrompt, 8)
	if !turns.running() {
		t.Fatal("the turn Kimi opened for a lost task does not read as running")
	}
	appendWire(t, wire, kimiTextPart, 8, "checked")
	if !turns.running() {
		t.Fatal("the turn stopped reading as running before its end")
	}
	appendWire(t, wire, kimiTurnEndedRec, 8)
	if turns.running() {
		t.Fatal("an ended turn reads as running")
	}
	var none *kimiTurnLedger
	if none.running() {
		t.Fatal("no ledger reads as running")
	}
}

// A new session's wire does not exist when the process starts: once it appears, all of it is read.
func TestKimiTurnLedgerFindsANewSessionsWire(t *testing.T) {
	home := t.TempDir()
	turns := newKimiTurnLedger(home, "")
	turns.setSession(kimiTestSessionID)
	if turns.running() {
		t.Fatal("no wire reads as running")
	}
	putKimiSession(t, home, kimiTestWorkDir, kimiTestSessionID, time.Now().Add(-time.Hour), kimiTestTurn{"a", "b"})
	wire, _ := kimiTurnWire(home, kimiTestSessionID)
	appendWire(t, wire, kimiLostTaskPrompt, 1)
	if !turns.running() {
		t.Fatal("a turn in a wire that appeared later is not read")
	}
}

// The prompt waits while Kimi runs its own turn, and goes once it ends; a Stop pressed meanwhile
// means it never goes.
func TestKimiPromptWaitsOutAnOwnTurn(t *testing.T) {
	home, wire := kimiTestWire(t)
	turns := newKimiTurnLedger(home, kimiTestSessionID)
	ctx := context.Background()
	done := make(chan struct{})

	if waited, err := waitKimiOwnTurn(ctx, done, make(chan struct{}), turns); err != nil || waited > kimiForeignTurnPoll {
		t.Fatalf("an idle engine held the prompt %v (%v)", waited, err)
	}

	appendWire(t, wire, kimiLostTaskPrompt, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		appendWire(t, wire, kimiTurnEndedRec, 1)
	}()
	if waited, err := waitKimiOwnTurn(ctx, done, make(chan struct{}), turns); err != nil || waited < 250*time.Millisecond {
		t.Fatalf("the prompt went %v into Kimi's own turn (%v)", waited, err)
	}

	appendWire(t, wire, kimiLostTaskPrompt, 2)
	unsent := make(chan struct{})
	go func() {
		time.Sleep(150 * time.Millisecond)
		close(unsent)
	}()
	if _, err := waitKimiOwnTurn(ctx, done, unsent, turns); err != errKimiPromptUnsent {
		t.Fatalf("a Stop while the prompt waited gave %v", err)
	}
	close(done)
	if _, err := waitKimiOwnTurn(ctx, done, make(chan struct{}), turns); err == nil {
		t.Fatal("a closed engine still let the prompt go")
	}
}

// A prompt answered while Kimi ran a turn of its own was queued, not dropped: it runs when that
// turn ends, and its answer — streamed nowhere — is read from its record. Before, this read as a
// turn Kimi never ran, which ended the session and stopped the engine with the prompt still queued
// (session 34tldRMFzXMU1CBLQ1GFZ, 2026-11-13).
func TestKimiQueuedPromptIsFollowedToItsOwnEnd(t *testing.T) {
	home, wire := kimiTestWire(t)
	turns := newKimiTurnLedger(home, kimiTestSessionID)
	appendWire(t, wire, kimiLostTaskPrompt, 1) // opened while resuming, before the prompt was sent
	if !turns.running() {
		t.Fatal("setup: the own turn is not read")
	}
	_, from := kimiTurnWire(home, kimiTestSessionID)
	go func() {
		// Longer than kimiTurnOutcomeWait: the own turn takes as long as it takes.
		time.Sleep(kimiTurnOutcomeWait + 500*time.Millisecond)
		// Kimi opens the queued prompt's turn the moment its own one ends (within 1 ms on 2.6.0):
		// one write, so a loaded machine cannot stretch the gap past what the reading allows.
		appendWire(t, wire, fmt.Sprintf(kimiTextPart, 1, "the task was lost")+fmt.Sprintf(kimiTurnEndedRec, 1)+
			fmt.Sprintf(kimiUserPrompt, 2)+fmt.Sprintf(kimiThinkPart, 2)+fmt.Sprintf(kimiTextPart, 2, "P2RAN")+
			fmt.Sprintf(kimiTurnEndedRec, 2))
	}()
	got := readKimiTurnOutcome(context.Background(), wire, from, turns)
	if got != (kimiTurnOutcome{read: true, ran: true, text: "P2RAN"}) {
		t.Fatalf("a queued prompt is reported as %+v", got)
	}

	// Without a turn of Kimi's own open, a prompt with nothing on the wire is still one never run.
	began := time.Now()
	_, from = kimiTurnWire(home, kimiTestSessionID)
	if got := readKimiTurnOutcome(context.Background(), wire, from, turns); got != (kimiTurnOutcome{read: true}) || time.Since(began) > 2*kimiTurnOutcomeWait {
		t.Fatalf("a prompt never run is reported as %+v after %v", got, time.Since(began))
	}
}

// The turn Kimi opened by itself after the prompt's offset is not the prompt's: its end does not
// answer the prompt.
func TestKimiTurnEndedPassesOverAnOwnTurn(t *testing.T) {
	home, wire := kimiTestWire(t)
	_, from := kimiTurnWire(home, kimiTestSessionID)
	appendWire(t, wire, kimiLostTaskPrompt, 1)
	appendWire(t, wire, kimiTextPart, 1, "lost")
	appendWire(t, wire, kimiTurnEndedRec, 1)
	if rec, ok := kimiTurnEnded(wire, from); ok {
		t.Fatalf("the own turn's end answered the prompt: %+v", rec)
	}
	appendWire(t, wire, kimiUserPrompt, 2)
	appendWire(t, wire, kimiTextPart, 2, "P2")
	appendWire(t, wire, kimiTextPart, 2, "RAN")
	appendWire(t, wire, kimiTurnEndedRec, 2)
	rec, ok := kimiTurnEnded(wire, from)
	if !ok || string(rec.TurnID) != "2" || rec.text != "P2RAN" {
		t.Fatalf("the prompt's own turn read as %+v %v", rec, ok)
	}
}

// Through the real supervisor and a scripted `kimi acp`, the incident itself: the session resumes,
// Kimi opens a turn of its own for a background task its previous process lost, and Orbit's message
// arrives meanwhile. It is answered once, as a success, and the engine is not stopped over it —
// whether the prompt waits the own turn out (as it does) or lands behind it anyway (the moment the
// own turn opens as it is sent: kimiForeignTurnWait 0 sends at once).
func TestKimiMessageBehindAnOwnTurnIsAnswered(t *testing.T) {
	for _, tc := range []struct {
		name string
		wait time.Duration
		text string
	}{
		{"waits the own turn out", kimiForeignTurnWait, "ok"},
		{"lands behind it", 0, "ran after the own turn"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func(prev time.Duration) { kimiForeignTurnWait = prev }(kimiForeignTurnWait)
			kimiForeignTurnWait = tc.wait
			fake := newFakeKimiEngine(t, map[string]interface{}{
				"sessionUpdate": "agent_message_chunk",
				"content":       map[string]interface{}{"type": "text", "text": "ok"},
			}).withOwnTurn(int(kimiTurnOutcomeWait.Milliseconds()) + 1500)
			t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			home, err := os.MkdirTemp("", "ors")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(home) })
			t.Setenv("ORBIT_HOME", home)
			job := &ClaimedSession{
				SessionID:        "sess-kimi-own-turn",
				SessionUUID:      "11111111-2222-3333-4444-555555555558",
				Title:            "a message behind Kimi's own turn",
				Provider:         providerKimi,
				RuntimeSessionID: fakeKimiACPSession,
				Agent: AgentExecConfig{
					Provider: providerKimi,
					Env: map[string]string{
						"KIMI_CODE_HOME":     filepath.Join(t.TempDir(), ".kimi-code"),
						"KIMI_MODEL_NAME":    "test-model",
						"KIMI_MODEL_API_KEY": "test-key",
					},
				},
			}
			api := newRunnerStopControlPlane()
			api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "go"})
			superviseUntilRunnerStop(t, job, true, api)
			awaitCondition(t, 30*time.Second, "turn-1 was never answered", func() bool {
				return api.settled("turn-1")
			})
			if got := fake.prompts(); got != "1" {
				t.Fatalf("prompts sent = %s, want 1", got)
			}
			var done []TurnCompleteRequest
			for _, c := range api.turnCompletions() {
				if c.TurnID == "turn-1" {
					done = append(done, c)
				}
			}
			if len(done) != 1 || done[0].Status != stSucceeded || done[0].Result != tc.text {
				t.Fatalf("turn-1 completions = %+v, want one %s answering %q", done, stSucceeded, tc.text)
			}
		})
	}
}
