package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A completion of a Claude turn says which engine process its running totals are of and what that
// process started from, so the control plane can book the turn's own share
// (claude_running_totals.go, task 34sjn2yQvNJg1JhQIARvd).

const runningTotalsSession = "11111111-2222-3333-4444-555555555555"

// costStateLine is a `cost-state` record as Claude Code 2.1.318 appends it to a transcript when its
// process exits gracefully: every field the CLI writes, in its order.
func costStateLine(sessionID string, cost float64, model string, input, output, cacheRead, cacheWrite float64) string {
	b, _ := json.Marshal(map[string]interface{}{
		"type": "cost-state", "sessionId": sessionID, "totalCostUSD": cost,
		"totalAPIDuration": 92, "totalAPIDurationWithoutRetries": 88, "totalToolDuration": 4,
		"totalLinesAdded": 0, "totalLinesRemoved": 0, "totalDuration": 12573, "startTime": 1793946692789,
		"modelUsage": map[string]interface{}{model: map[string]interface{}{
			"inputTokens": input, "outputTokens": output, "thinkingTokens": 0,
			"cacheReadInputTokens": cacheRead, "cacheCreationInputTokens": cacheWrite,
			"cacheCreationEphemeral5mInputTokens": 0, "cacheCreationEphemeral1hInputTokens": 0,
			"webSearchRequests": 0, "costUSD": cost,
		}},
		"hasUnknownModelCost": false,
	})
	return string(b)
}

// transcriptUserLine is a transcript's user record holding text: what makes the file a conversation a resume
// reads rather than one the runner rebuilds.
func transcriptUserLine(sessionID, text string) string {
	b, _ := json.Marshal(map[string]interface{}{
		"type": "user", "sessionId": sessionID, "uuid": "u-" + text[:1],
		"message": map[string]interface{}{"role": "user", "content": text},
	})
	return string(b)
}

func writeTranscriptLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func modelCounts(input, output, cacheRead, cacheWrite, cost float64) map[string]interface{} {
	return map[string]interface{}{
		"inputTokens": input, "outputTokens": output, "cacheReadInputTokens": cacheRead,
		"cacheCreationInputTokens": cacheWrite, "costUSD": cost,
	}
}

// What --resume restores is the session's LAST valid record, wherever later turns of processes that
// were killed (and so saved nothing) put it in the file, and whatever else is around it.
func TestLastClaudeCostStateIsWhatResumeRestores(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	huge := strings.Repeat("x", 3*claudeCostStateLineMax)
	writeTranscriptLines(t, path,
		transcriptUserLine(runningTotalsSession, "hello one"),
		costStateLine(runningTotalsSession, 0.017658, "claude-sonnet-5-5", 3009, 39, 90000, 900),
		transcriptUserLine(runningTotalsSession, "hello three"),
		// The record a later graceful exit wrote: this is the one.
		costStateLine(runningTotalsSession, 0.026068, "claude-sonnet-5-5", 4014, 54, 140000, 1400),
		// Turns of a process that was killed after them: nothing saved.
		transcriptUserLine(runningTotalsSession, "hello five"),
		// A tool's output longer than any record, quoting one in its text.
		`{"type":"user","message":{"content":"`+huge+` \"cost-state\""}}`,
		// Another conversation's record, a record the schema refuses, and a line torn mid-write.
		costStateLine("99999999-2222-3333-4444-555555555555", 9, "claude-sonnet-5-5", 1, 1, 1, 1),
		`{"type":"cost-state","sessionId":"`+runningTotalsSession+`","totalCostUSD":-1,"modelUsage":{}}`,
		`{"type":"cost-state","sessionId":"`+runningTotalsSession+`","totalCostUSD":0.5,"modelU`,
	)
	got, found, err := lastClaudeCostState(path, runningTotalsSession)
	if err != nil || !found {
		t.Fatalf("lastClaudeCostState = %v, %v; want the record", found, err)
	}
	if got.CostUsd != 0.026068 {
		t.Fatalf("restored cost %v, want 0.026068: the last valid record of this session", got.CostUsd)
	}
	sonnet, _ := got.ModelUsage["claude-sonnet-5-5"].(map[string]interface{})
	if sonnet["inputTokens"] != 4014.0 || sonnet["cacheReadInputTokens"] != 140000.0 || sonnet["costUSD"] != 0.026068 {
		t.Fatalf("restored model usage %v, want the record's counts", got.ModelUsage)
	}
}

func TestLastClaudeCostStateFindsOneOnTheFirstLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(costStateLine(runningTotalsSession, 0.25, "m", 1, 2, 3, 4)), 0o600); err != nil {
		t.Fatal(err)
	}
	got, found, err := lastClaudeCostState(path, runningTotalsSession)
	if err != nil || !found || got.CostUsd != 0.25 {
		t.Fatalf("lastClaudeCostState = %+v, %v, %v; want the only record, unterminated", got, found, err)
	}
}

// Nothing saved is a start from zero, not an unknown: the CLI restores nothing either.
func TestLastClaudeCostStateWithNothingSaved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeTranscriptLines(t, path, transcriptUserLine(runningTotalsSession, "hello"), `{"type":"last-prompt"}`)
	if _, found, err := lastClaudeCostState(path, runningTotalsSession); found || err != nil {
		t.Fatalf("a transcript with no record: found=%v err=%v", found, err)
	}
	if _, found, err := lastClaudeCostState(filepath.Join(dir, "missing.jsonl"), runningTotalsSession); found || err != nil {
		t.Fatalf("no transcript: found=%v err=%v", found, err)
	}
}

// A new conversation restores nothing; a resume restores what its transcript holds, in the config
// directory the session's own environment names.
func TestClaudeRunningTotalsNameTheProcessAndWhatItRestores(t *testing.T) {
	job := claudeSpawnJob(t)
	config := t.TempDir()
	job.Agent.Env = map[string]string{"CLAUDE_CONFIG_DIR": config}
	execDir := t.TempDir()
	path, err := claudeTranscriptPathIn(config, execDir, job.SessionUUID)
	if err != nil {
		t.Fatal(err)
	}
	writeTranscriptLines(t, path,
		transcriptUserLine(job.SessionUUID, "hello"),
		costStateLine(job.SessionUUID, 0.75, "claude-opus-5-5", 10, 20, 30, 40))

	first := claudeRunningTotals(job, execDir, true)
	if first == nil || first.Process == "" || first.Restored.CostUsd != 0 || len(first.Restored.ModelUsage) != 0 {
		t.Fatalf("a first spawn = %+v, want a process that restores nothing", first)
	}
	resumed := claudeRunningTotals(job, execDir, false)
	if resumed == nil || resumed.Process == "" || resumed.Process == first.Process {
		t.Fatalf("a resume = %+v, want a process of its own", resumed)
	}
	opus, _ := resumed.Restored.ModelUsage["claude-opus-5-5"].(map[string]interface{})
	if resumed.Restored.CostUsd != 0.75 || opus["inputTokens"] != 10.0 || opus["cacheCreationInputTokens"] != 40.0 {
		t.Fatalf("a resume restored %+v, want the transcript's record", resumed.Restored)
	}
	// On the wire, a process that restored nothing still says so: an empty object, not null.
	wire, _ := json.Marshal(TurnCompleteRequest{TurnID: "t", RunningTotals: first})
	if !strings.Contains(string(wire), `"runningTotals":{"process":"`+first.Process+`","restored":{"costUsd":0,"modelUsage":{}}}`) {
		t.Fatalf("wire %s", wire)
	}
}

// Through the real supervisor: the completions of one process carry its id and what it started
// from; a process that replaces it after a warm recycle (SIGKILL, so it saved nothing) carries a
// new id and the record its transcript holds, which is older than the totals reported before it.
func TestClaudeCompletionsCarryTheirProcessRunningTotals(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	cost := func(v float64) *float64 { return &v }
	config := t.TempDir()
	execDir := t.TempDir()
	s := superviseClaudeSessionVia(t, pool, execDir, context.Background(), func(s *supervisedSession, apiURL string) *Transport {
		s.job.Agent.Env["CLAUDE_CONFIG_DIR"] = config
		return NewTransport(apiURL, "runner-token")
	},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "one"},
		fakeStep{Emit: "result", Text: "one", CostUsd: cost(0.10),
			ModelUsage: map[string]interface{}{"claude-opus-5-5": modelCounts(1000, 10, 5000, 100, 0.10)}},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "assistant", Text: "two"},
		fakeStep{Emit: "result", Text: "two", CostUsd: cost(0.25),
			ModelUsage: map[string]interface{}{"claude-opus-5-5": modelCounts(2100, 25, 12000, 300, 0.25)}},
	)
	s.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "again"})
	s.awaitParked("turn-2")
	one, two := s.settledTurn("turn-1"), s.settledTurn("turn-2")
	if one.RunningTotals == nil || two.RunningTotals == nil {
		t.Fatalf("completions without running totals: %+v / %+v", one.RunningTotals, two.RunningTotals)
	}
	if one.RunningTotals.Process != two.RunningTotals.Process {
		t.Fatalf("two turns of one process named two processes: %q, %q", one.RunningTotals.Process, two.RunningTotals.Process)
	}
	if one.RunningTotals.Restored.CostUsd != 0 || len(one.RunningTotals.Restored.ModelUsage) != 0 {
		t.Fatalf("a new conversation restored %+v", one.RunningTotals.Restored)
	}
	if one.CostUsd != 0.10 || two.CostUsd != 0.25 {
		t.Fatalf("costUsd %v, %v: the totals go out as the engine reported them", one.CostUsd, two.CostUsd)
	}
	if got := two.ModelUsage["claude-opus-5-5"]; !reflect.DeepEqual(got, modelCounts(2100, 25, 12000, 300, 0.25)) {
		t.Fatalf("modelUsage %v, want the engine's totals", got)
	}

	// What an earlier graceful exit saved: older than the totals reported since, as after a kill.
	path, err := claudeTranscriptPathIn(config, execDir, s.job.SessionUUID)
	if err != nil {
		t.Fatal(err)
	}
	writeTranscriptLines(t, path,
		transcriptUserLine(s.job.SessionUUID, "start the build"),
		costStateLine(s.job.SessionUUID, 0.07, "claude-opus-5-5", 700, 7, 3000, 70))
	resumeScript, _ := json.Marshal([]fakeStep{
		{Await: "user"},
		{Emit: "replay_user"},
		{Emit: "system_init"},
		{Emit: "assistant", Text: "three"},
		{Emit: "result", Text: "three", CostUsd: cost(0.12),
			ModelUsage: map[string]interface{}{"claude-opus-5-5": modelCounts(1300, 15, 7000, 170, 0.12)}},
	})
	if err := os.WriteFile(filepath.Join(s.fake.rec, "script-resume.json"), resumeScript, 0o644); err != nil {
		t.Fatal(err)
	}

	clock.Advance(warmEngineTTL + time.Second)
	waitUntil(t, func() bool { return !pool.engineResident(s.live) }, "the warm engine was never recycled")
	// The claim the control plane hands a session that has run: it resumes.
	claim := *s.job
	claim.Resume = true
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("the claim could not activate the parked session")
	}
	s.queue(RunInboxResponse{TurnID: "turn-3", Kind: "message", Content: "carry on"})
	s.awaitParked("turn-3")

	spawns := s.fake.Spawns()
	if len(spawns) != 2 || argValue(spawns[1].Argv, "--resume") != s.job.SessionUUID {
		t.Fatalf("%d spawns, the last resuming %q: want a second one resuming the conversation",
			len(spawns), argValue(spawns[len(spawns)-1].Argv, "--resume"))
	}
	three := s.settledTurn("turn-3")
	if three.RunningTotals == nil || three.RunningTotals.Process == "" || three.RunningTotals.Process == one.RunningTotals.Process {
		t.Fatalf("the resumed process's completion = %+v, want an id of its own", three.RunningTotals)
	}
	restored := three.RunningTotals.Restored
	opus, _ := restored.ModelUsage["claude-opus-5-5"].(map[string]interface{})
	if restored.CostUsd != 0.07 || opus["inputTokens"] != 700.0 || opus["costUSD"] != 0.07 {
		t.Fatalf("the resumed process restored %+v, want the transcript's record", restored)
	}
}
