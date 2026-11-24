package main

// The wake turn of a handed-off owner wait. An engine that ends tool calls on a deadline of its own (Kimi Code, Cursor,
// DeepSeek Harness: ORBIT_MCP_CALL_TIMEOUT_SECONDS) does not hold a call that waits for the owner: `orbit mcp` hands
// it to a runner-hosted job (handOffOwnerWait, bgJobService.startOwnerWait) and answers "not done yet". What the call
// wrote, such as the id of the task it filed, reaches the agent only when that job exits and Orbit wakes the session
// with its output in a turn of its own. The live eval plays that turn: after a turn, it waits for the owner waits the
// session's job service started to end, and delivers their wakes as the control plane does, in the words of
// apiserver runner-api/background-job-wake.ts buildBackgroundWakeBlock. The turn belongs to the scenario turn it
// follows and is graded with it, as a follow-up is. Claude Code and Codex hold the call inline and start no such job.

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"
)

// evalWakeWait is how long the eval waits, after a turn, for an owner wait to end and send its wake. The eval's owner
// answers a card as it is filed, so the job ends in seconds.
const evalWakeWait = 2 * time.Minute

// evalMaxWakeTurns bounds the wake turns played after one turn: a wake turn may hand off another owner wait.
const evalMaxWakeTurns = 3

func evalIsOwnerWait(kind, description string) bool {
	return kind == bgKindWatch && strings.HasPrefix(description, "Orbit ") && strings.HasSuffix(description, ownerWaitJobDescriptionSuffix)
}

// evalWakeBox keeps the exit wakes of the session's owner waits, which production sends to the control plane
// (bgTailer.wakeSessionVia), until the eval plays them.
type evalWakeBox struct {
	mu    sync.Mutex
	woken map[string]bool
	owed  []bgWake
}

func (b *evalWakeBox) file(wake bgWake) error {
	if wake.Trigger != bgWakeOnExit || !evalIsOwnerWait(wake.Kind, wake.Description) {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.woken == nil {
		b.woken = map[string]bool{}
	}
	if !b.woken[wake.JobID] {
		b.woken[wake.JobID] = true
		b.owed = append(b.owed, wake)
	}
	return nil
}

func (b *evalWakeBox) has(jobID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.woken[jobID]
}

func (b *evalWakeBox) take() []bgWake {
	b.mu.Lock()
	defer b.mu.Unlock()
	owed := b.owed
	b.owed = nil
	return owed
}

// owedOwnerWaitWakes waits until every owner wait the session's job service started has ended and sent its wake, or
// until wait has passed, and hands over the wakes not played yet. A job killed on request sends none (wakeFor).
func (s *evalSession) owedOwnerWaitWakes(wait time.Duration) []bgWake {
	until := time.Now().Add(wait)
	for {
		pending := false
		for _, job := range s.bg.listJobs(true) {
			if evalIsOwnerWait(job.Kind, job.Description) && !s.wakes.has(job.JobID) && (job.Status == bgStatusRunning || job.Reason == "") {
				pending = true
			}
		}
		if !pending || time.Now().After(until) {
			return s.wakes.take()
		}
		select {
		case <-s.ctx.Done():
			return nil
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// playOwnerWaitWakes plays the wake turns the owner waits handed off so far owe the session, as part of scenario turn
// spec. It answers false when a turn could not be played (run.HarnessError says why).
func (s *evalSession) playOwnerWaitWakes(engine evalEngine, spec int, mode string, timeout time.Duration, run *evalRun) bool {
	for i := 0; i < evalMaxWakeTurns; i++ {
		wakes := s.owedOwnerWaitWakes(evalWakeWait)
		if len(wakes) == 0 {
			return true
		}
		log := evalTurnLog{Index: len(s.logs), Spec: spec, Prompt: evalBackgroundWakeBlock(wakes), Mode: mode, Wake: true}
		if !s.runTurn(engine, &log, timeout, run) {
			return false
		}
	}
	return true
}

// evalWakeKilledBecause is the control plane's KILLED_BECAUSE.
var evalWakeKilledBecause = map[string]string{
	bgStoppedByOwnerReason: "the person who owns this session stopped it from the app; you did not stop it, so do not start it again unless they ask",
	"runner_shutdown":      "the runner process hosting it stopped — a restart or a self-update — and the job was killed with it",
	"session_cancelled":    "the session was cancelled, or handed to another runner process, and the job was killed with it",
	bgNotAllowedReason:     "it never ran: this session's permission mode asked the owner first, and they did not allow it; the output says what to do",
}

var evalCRLF = regexp.MustCompile(`\r\n?`)

// evalBackgroundWakeBlock is what a wake turn the control plane opened delivers for wakes: buildBackgroundWakeBlock
// with turnKind "message", which is the only kind an engine that cannot steer a turn is handed.
func evalBackgroundWakeBlock(wakes []bgWake) string {
	lines := []string{"<background-job-wake>",
		"  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:"}
	exited, killed := false, false
	for _, wake := range wakes {
		head := []string{wake.JobID, wake.Kind, wake.Command}
		if wake.Description != "" {
			head = append(head, wake.Description)
		}
		lines = append(lines, "    "+strings.Join(head, "｜"), "      "+evalDescribeWakeTrigger(wake))
		lines = append(lines, fmt.Sprintf("      output %s｜this covers bytes %d–%d", wake.OutputPath, wake.OutputOffset, wake.OutputSize))
		excerpt := strings.TrimRightFunc(evalCRLF.ReplaceAllString(wake.OutputExcerpt, "\n"), unicode.IsSpace)
		if excerpt == "" {
			lines = append(lines, "      (no output)")
		} else {
			lines = append(lines, "      output tail:")
			for _, line := range strings.Split(excerpt, "\n") {
				lines = append(lines, "        "+line)
			}
		}
		exited = exited || wake.Trigger == bgWakeOnExit
		killed = killed || (wake.Status == bgStatusKilled && wake.Reason != bgNotAllowedReason && wake.Reason != bgStoppedByOwnerReason)
	}
	lines = append(lines, "  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.")
	if exited {
		lines = append(lines, "  If the person asked to hear when this was done, tell them with mcp__orbit__notify: a reply here reaches them only when they next look.")
	}
	if killed {
		lines = append(lines, "  A killed job does not come back on its own: to keep waiting, start it again with bg_run.")
	}
	lines = append(lines, "</background-job-wake>")
	return strings.Join(lines, "\n")
}

func evalDescribeWakeTrigger(wake bgWake) string {
	if wake.Trigger == bgWakeOnOutput {
		return "new output｜" + wake.Status
	}
	if wake.Status == bgStatusKilled {
		if wake.Reason == "" {
			return "ended｜killed"
		}
		gloss := ""
		if why, ok := evalWakeKilledBecause[wake.Reason]; ok {
			gloss = " (" + why + ")"
		}
		return "ended｜killed｜reason " + wake.Reason + gloss
	}
	if wake.ExitCode == nil {
		return "ended｜" + wake.Status
	}
	return fmt.Sprintf("ended｜%s｜exit code %d", wake.Status, *wake.ExitCode)
}

// TestAgentEvalWakeBlockSaysWhatTheControlPlaneSays pins the eval's wake turn to production's words: the expected
// text is buildBackgroundWakeBlock's output for the same two wakes (one exit with output, one killed with none).
func TestAgentEvalWakeBlockSaysWhatTheControlPlaneSays(t *testing.T) {
	zero := 0
	command := "{ rm -f '/x/h.json' && orbit mcp; } < '/x/h.json'"
	got := evalBackgroundWakeBlock([]bgWake{
		{JobID: "bgj_a", Trigger: bgWakeOnExit, Kind: bgKindWatch, Command: command, Description: "Orbit task_create" + ownerWaitJobDescriptionSuffix,
			Status: bgStatusCompleted, ExitCode: &zero, OutputPath: "/x/out.log", OutputSize: 42,
			OutputExcerpt: "{\"jsonrpc\":\"2.0\",\"id\":1}\r\nsecond line  \n\n"},
		{JobID: "bgj_b", Trigger: bgWakeOnExit, Kind: bgKindWatch, Command: command, Status: bgStatusKilled, Reason: "session_cancelled",
			OutputPath: "/x/out.log"},
	})
	want := "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_a｜watch｜{ rm -f '/x/h.json' && orbit mcp; } < '/x/h.json'｜Orbit task_create: waiting for the owner's confirmation\n      ended｜completed｜exit code 0\n      output /x/out.log｜this covers bytes 0–42\n      output tail:\n        {\"jsonrpc\":\"2.0\",\"id\":1}\n        second line\n    bgj_b｜watch｜{ rm -f '/x/h.json' && orbit mcp; } < '/x/h.json'\n      ended｜killed｜reason session_cancelled (the session was cancelled, or handed to another runner process, and the job was killed with it)\n      output /x/out.log｜this covers bytes 0–0\n      (no output)\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n  If the person asked to hear when this was done, tell them with mcp__orbit__notify: a reply here reaches them only when they next look.\n  A killed job does not come back on its own: to keep waiting, start it again with bg_run.\n</background-job-wake>"
	if got != want {
		t.Fatalf("the eval's wake block differs from the control plane's:\n got: %q\nwant: %q", got, want)
	}
}

// TestAgentEvalPlaysTheWakeOfAHandedOffOwnerWait drives a session whose `orbit mcp` has a call deadline, as Kimi's
// does: the scripted agent's task_create is handed to a runner-hosted owner wait, and the eval plays the wake turn
// that job's exit owes the session, with the task's id in it, as part of the same scenario turn.
func TestAgentEvalPlaysTheWakeOfAHandedOffOwnerWait(t *testing.T) {
	sc := &evalScenario{ID: "W1-owner-wait-wake", Setup: evalSetup{Owner: evalOwnerApproveAll},
		Turns: []evalTurnSpec{{Mode: "default", Expect: []string{"task_create"}, Prompt: "File it."}}}
	s, err := newEvalSession(sc, providerKimi)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	var woke []string
	agent := &wakeRecordingEngine{
		first: func(s *evalSession) error {
			env := append(s.env(false), envMCPCallTimeout+"=30")
			client, err := startEvalMCPClient(s.ctx, s.exe, env, s.work)
			if err != nil {
				return err
			}
			defer client.close()
			text, isErr, err := client.call("task_create", map[string]interface{}{"title": "Rotate the staging API key",
				"description": "Done when the new key is in the vault and the old one is revoked.", "autoRunWhenReady": false, "completionCriterion": "EVIDENCE_JUDGMENT"})
			if err != nil || isErr || !strings.Contains(text, "Not done yet") {
				return fmt.Errorf("task_create was not handed off: %v %v %s", err, isErr, text)
			}
			return nil
		},
		wake: func(prompt string) { woke = append(woke, prompt) },
	}
	run := s.play(agent, 1, time.Minute)
	if run.HarnessError != "" {
		t.Fatal(run.HarnessError)
	}
	if len(run.Turns) != 2 || !run.Turns[1].Wake || run.Turns[1].Spec != 0 || len(woke) != 1 {
		t.Fatalf("want the turn and one wake turn of the same spec, got %d turns (%d wakes)", len(run.Turns), len(woke))
	}
	created := run.Ledger.agentCreated()
	if len(created) != 1 {
		t.Fatalf("want one task written by the owner wait, got %d", len(created))
	}
	if !strings.HasPrefix(woke[0], "<background-job-wake>") || !strings.Contains(woke[0], "Orbit task_create"+ownerWaitJobDescriptionSuffix) ||
		!strings.Contains(woke[0], created[0].ID) {
		t.Fatalf("the wake turn does not carry the job's output with the task's id %s:\n%s", created[0].ID, woke[0])
	}
}

// wakeRecordingEngine runs first as its first turn and records the words of every wake turn.
type wakeRecordingEngine struct {
	first func(s *evalSession) error
	wake  func(prompt string)
}

func (e *wakeRecordingEngine) identity() (string, string, string, string) {
	return "scripted", "scripted", "", ""
}
func (e *wakeRecordingEngine) start(*evalSession) error { return nil }
func (e *wakeRecordingEngine) turn(s *evalSession, log *evalTurnLog) error {
	if log.Wake {
		e.wake(log.Prompt)
		return nil
	}
	return e.first(s)
}
func (e *wakeRecordingEngine) reset(*evalSession, string) (bool, error) { return false, nil }
func (e *wakeRecordingEngine) stop(*evalSession)                        {}
