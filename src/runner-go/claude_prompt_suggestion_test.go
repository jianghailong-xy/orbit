package main

import (
	"strings"
	"testing"
)

// withClaudeSpawnVersion makes the next spawn's CLI announce `version` for the length of a test.
func withClaudeSpawnVersion(t *testing.T, version string) {
	t.Helper()
	old := claudeSpawnVersion
	claudeSpawnVersion = func() string { return version }
	t.Cleanup(func() { claudeSpawnVersion = old })
}

// The flag is on only when all three say so: the control plane turned it on, the CLI is one it
// was measured on, and the engine talks to Anthropic. A CLI that does not know the flag refuses to
// start, so every doubt about the version leaves it off.
func TestClaudeCommandArgsAskForPromptSuggestionsOnlyWhenOn(t *testing.T) {
	t.Setenv("ANTHROPIC_BASE_URL", "")
	for _, c := range []struct {
		name    string
		on      bool
		version string
		env     map[string]string
		want    bool
	}{
		{name: "turned on, measured CLI", on: true, version: claudePromptSuggestionsFloor, want: true},
		{name: "turned on, newer CLI", on: true, version: "2.2.0", want: true},
		{name: "not turned on", on: false, version: "2.2.0", want: false},
		{name: "older CLI", on: true, version: "2.1.292", want: false},
		{name: "CLI version unreadable", on: true, version: "0.0.0", want: false},
		{name: "configured provider endpoint", on: true, version: "2.2.0",
			env: map[string]string{"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic"}, want: false},
		{name: "Anthropic's own endpoint spelled out", on: true, version: "2.2.0",
			env: map[string]string{"ANTHROPIC_BASE_URL": "https://api.anthropic.com/"}, want: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			withClaudeSpawnVersion(t, c.version)
			job := claudeSpawnJob(t)
			job.Agent.PromptSuggestions = c.on
			job.Agent.Env = c.env
			args := claudeCommandArgs(job, t.TempDir(), true)
			if got := containsArgs(args, []string{"--prompt-suggestions"}); got != c.want {
				t.Fatalf("--prompt-suggestions in argv = %v, want %v (argv %v)", got, c.want, args)
			}
		})
	}
}

// The runner's own environment can point the CLI elsewhere too; a session's env overrides it,
// in both directions, exactly as envWithAgent layers the two.
func TestClaudeTalksToAnthropicReadsTheEnvironmentTheSpawnGets(t *testing.T) {
	t.Setenv("ANTHROPIC_BASE_URL", "https://proxy.example.com")
	if claudeTalksToAnthropic(nil) {
		t.Error("a runner whose own environment points claude at a proxy was read as talking to Anthropic")
	}
	if !claudeTalksToAnthropic(map[string]string{"ANTHROPIC_BASE_URL": ""}) {
		t.Error("a session env that clears the runner's endpoint was read as still using it")
	}
	t.Setenv("ANTHROPIC_BASE_URL", "")
	if !claudeTalksToAnthropic(map[string]string{"OTHER": "x"}) {
		t.Error("no endpoint anywhere was read as a configured one")
	}
}

func TestPromptSuggestionPayloadKeepsOnlyAnOfferableLine(t *testing.T) {
	if p := promptSuggestionPayload(map[string]interface{}{"suggestion": "  run the tests \n"}); p == nil ||
		p["text"] != "run the tests" || p["source"] != "engine" {
		t.Fatalf("payload = %v, want the trimmed text from the engine", p)
	}
	for name, msg := range map[string]map[string]interface{}{
		"empty":      {"suggestion": "   "},
		"missing":    {},
		"not a text": {"suggestion": 42},
		"too long":   {"suggestion": strings.Repeat("长", maxPromptSuggestionRunes+1)},
	} {
		if p := promptSuggestionPayload(msg); p != nil {
			t.Errorf("%s: payload = %v, want nothing filed", name, p)
		}
	}
	if p := promptSuggestionPayload(map[string]interface{}{"suggestion": strings.Repeat("长", maxPromptSuggestionRunes)}); p == nil {
		t.Error("a suggestion exactly at the cap was dropped; the cap counts characters, not bytes")
	}
}

// The ordinary case, through the real session loop: the suggestion arrives after the turn's
// result and is filed against that turn, after its turn_end.
func TestSessionFilesAPromptSuggestionAgainstTheTurnItFollows(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "fixed it"},
			{Emit: "result", Text: "fixed it"},
			{Emit: "prompt_suggestion", Text: "run the tests"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "fix the bug")}, nil)

	got := run.eventsOfType(evPromptSuggestion)
	if len(got) != 1 {
		t.Fatalf("filed %d prompt_suggestion events, want 1: %v", len(got), got)
	}
	if got[0].TurnID != "turn-1" || got[0].Payload["text"] != "run the tests" || got[0].Payload["source"] != "engine" {
		t.Fatalf("filed %+v, want turn-1's suggestion from the engine", got[0])
	}
	turnEnd := run.seqOf(func(e RunEvent) bool { return e.Type == evTurnEnd })
	suggestion := run.seqOf(func(e RunEvent) bool { return e.Type == evPromptSuggestion })
	if turnEnd < 0 || suggestion < turnEnd {
		t.Fatalf("the suggestion (at %d) does not come after the turn's turn_end (at %d)", suggestion, turnEnd)
	}
}

// A suggestion that reaches the runner after the next message was already handed to the engine
// guesses at something that has been said: nothing is filed.
func TestSessionDropsAPromptSuggestionOnceTheNextMessageIsRunning(t *testing.T) {
	second := messageTurn("turn-2", "now the docs")
	second.after = "turn-1"
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "prompt_suggestion", Text: "run the tests"},
			{Emit: "result", Text: "done too"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "fix the bug"), second}, nil)

	if got := run.eventsOfType(evPromptSuggestion); len(got) != 0 {
		t.Fatalf("filed %v while turn-2 was running, want nothing", got)
	}
}

// Nothing is suggested after a turn that failed — its own card is what comes next — nor after one
// the engine started by itself, which no person's message asked for.
func TestSessionFilesNoPromptSuggestionAfterAFailedOrSelfStartedTurn(t *testing.T) {
	t.Run("failed", func(t *testing.T) {
		run := runDeliverySession(t,
			[]fakeStep{
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "result", Text: "boom", IsError: true},
				{Emit: "prompt_suggestion", Text: "try again"},
				{Emit: "eof"},
			},
			[]scriptedTurn{messageTurn("turn-1", "deploy")}, nil)
		if got := run.eventsOfType(evPromptSuggestion); len(got) != 0 {
			t.Fatalf("filed %v after a failed turn, want nothing", got)
		}
	})
	t.Run("self-started", func(t *testing.T) {
		run := runDeliverySession(t,
			[]fakeStep{
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "result", Text: "started the build"},
				{Emit: "assistant", Text: "the background build finished"},
				{Emit: "result", Text: "the background build finished"},
				{Emit: "prompt_suggestion", Text: "ship it"},
				{Emit: "eof"},
			},
			[]scriptedTurn{messageTurn("turn-1", "build it in the background")}, nil)
		if got := run.eventsOfType(evPromptSuggestion); len(got) != 0 {
			t.Fatalf("filed %v after a turn the engine started itself, want nothing", got)
		}
	})
}
