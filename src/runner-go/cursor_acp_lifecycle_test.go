package main

// What P5b adds to the Cursor CLI session driver (cursor_acp.go, cursor_events.go), run against P0
// recordings of the pinned CLI replayed by fake_cursor_acp_test.go: a message that arrives mid-turn
// waits for the next turn and never becomes a second session/prompt; a stop is a session/cancel; a later
// process continues the conversation with session/load and writes none of what it replays; every turn
// settles once — on Cursor's answer, then Orbit's own stop, a crash, a closed connection, a lost lease —
// and is never prompted twice; the failures Cursor reports are classified by their recorded shapes; and
// no turn reads out a context or a cost. The named scenarios here are the ones
// scripts/test-cursor-acp-lifecycle.mjs runs.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// cursorOnce delivers items the first time when holds for an event that goes out, and nothing after.
func cursorOnce(when func(cursorEvent) bool, items ...RunInboxResponse) func(cursorEvent) []RunInboxResponse {
	var once sync.Once
	return func(event cursorEvent) []RunInboxResponse {
		var out []RunInboxResponse
		if when(event) {
			once.Do(func() { out = items })
		}
		return out
	}
}

// cursorToolStarted is a turn's card of the named tool going out.
func cursorToolStarted(turn, name string) func(cursorEvent) bool {
	return func(event cursorEvent) bool {
		return event.turn == turn && event.typ == evToolUse && event.payload["name"] == name
	}
}

// cursorEndAfter ends the session once n turns have completed.
func cursorEndAfter(n int) func(int, TurnCompleteRequest) []RunInboxResponse {
	return func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
		if completed == n {
			return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
		}
		return nil
	}
}

// recordedAnswerLine is where, in a recording as the fake replays it, the answer to the recorded request
// id goes out: a line the runner wrote after that answer carries an Emitted past it.
func recordedAnswerLine(t *testing.T, recording, id string) int {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("testdata", "cursor", recording))
	if err != nil {
		t.Fatal(err)
	}
	_, lines, err := loadFakeCursorReplay(fakeCursorACPScript{Recording: abs})
	if err != nil {
		t.Fatal(err)
	}
	for i, line := range lines {
		if line.answer == id {
			return i
		}
	}
	t.Fatalf("%s answers no request %s", recording, id)
	return -1
}

// receivedIndex is the position, among the lines the runner wrote, of the first with method.
func receivedIndex(lines []fakeCursorReceived, method string, from int) int {
	for i := from; i < len(lines); i++ {
		if asString(lines[i].Message["method"]) == method {
			return i
		}
	}
	return -1
}

// completionsOf is what was reported of one turn.
func (r cursorRun) completionsOf(turn string) []TurnCompleteRequest {
	var out []TurnCompleteRequest
	for _, req := range r.completions {
		if req.TurnID == turn {
			out = append(out, req)
		}
	}
	return out
}

// methods is what the runner asked the CLI, in order.
func (r cursorRun) methods(t *testing.T) []string {
	t.Helper()
	var methods []string
	for _, line := range r.fake.received(t) {
		if method := asString(line.Message["method"]); method != "" && line.Message["id"] != nil {
			methods = append(methods, method)
		}
	}
	return methods
}

// cursorUsageLimitWords is the rule @orbit/shared's isUsageLimitErrorText reads a spent quota by: one of
// its USAGE_LIMIT_ERROR_MARKERS no more than 40 characters into the text.
func cursorUsageLimitWords(text string) bool {
	at := strings.Index(strings.ToLower(strings.TrimSpace(text)), "hit your usage limit")
	return at >= 0 && at <= 40
}

// sessionLedger reads the session's turn ledger as the driver left it.
func sessionLedger(t *testing.T) map[string]cursorTurnRecord {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(runDir(cursorTestSessionID), "cursor", "orbit-turns.json"))
	if err != nil {
		t.Fatal(err)
	}
	var ledger struct {
		Turns map[string]cursorTurnRecord `json:"turns"`
	}
	if err := json.Unmarshal(data, &ledger); err != nil {
		t.Fatal(err)
	}
	return ledger.Turns
}

// A message that arrives while a turn runs waits for the next turn: a session/prompt that reaches Cursor
// while another runs cancels that one (§3.2), so none is ever written while one runs. A steer is refused.
func TestCursorACPMidTurnMessages(t *testing.T) {
	t.Run("queued-to-the-next-turn", func(t *testing.T) {
		// The second message arrives as the first turn's first tool starts, and goes out once that turn
		// has been answered.
		const recording = "multi-turn-tools-default/turns"
		run := runCursorSession(t, cursorRunOptions{recording: recording,
			first:   []RunInboxResponse{cursorMessage("turn-1", "first message")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Read"), cursorMessage("turn-2", "second message")),
			then:    cursorEndAfter(2)})
		if len(run.completions) != 2 || run.completions[0].TurnID != "turn-1" || run.completions[1].TurnID != "turn-2" ||
			run.completions[0].Status != stSucceeded || run.completions[1].Status != stSucceeded {
			t.Fatalf("completions = %+v, want turn-1 then turn-2, each once", run.completions)
		}
		prompts := run.fake.requests(t, "session/prompt")
		if len(prompts) != 2 || prompts[1].Emitted <= recordedAnswerLine(t, recording, "3") {
			t.Fatalf("session/prompt sent %d times; the second must follow the first turn's answer", len(prompts))
		}
		if users := run.of("turn-2", evUser); len(users) != 1 || users[0]["text"] != "second message" {
			t.Fatalf("turn-2 user events = %v", users)
		}
	})
	t.Run("no-second-prompt-while-busy", func(t *testing.T) {
		// The recording's first turn runs `sleep 43` until something cancels it: P0a's client sent a second
		// session/prompt, which Cursor answered by cancelling the first turn. Here a second message arrives
		// while it runs and is held; the person's interrupt ends the first turn; the message is the next.
		const recording = "prompt-while-busy/busy"
		run := runCursorSession(t, cursorRunOptions{recording: recording,
			first: []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Bash"),
				cursorMessage("turn-2", "reply with BANANA"), RunInboxResponse{TurnID: "stop-1", Kind: "interrupt"}),
			then: cursorEndAfter(2)})
		received := run.fake.received(t)
		first := receivedIndex(received, "session/prompt", 0)
		cancel := receivedIndex(received, "session/cancel", 0)
		second := receivedIndex(received, "session/prompt", first+1)
		if first < 0 || cancel < first || second < cancel {
			t.Fatalf("the runner wrote prompt %d, cancel %d, prompt %d: the second prompt must wait for the first turn to end", first, cancel, second)
		}
		if prompts := run.fake.requests(t, "session/prompt"); len(prompts) != 2 || prompts[1].Emitted <= recordedAnswerLine(t, recording, "3") {
			t.Fatalf("session/prompt sent %d times, the second before the first turn was answered", len(prompts))
		}
		one, two := run.completionsOf("turn-1"), run.completionsOf("turn-2")
		if len(one) != 1 || one[0].Status != stInterrupted || len(two) != 1 || two[0].Status != stSucceeded || two[0].Result != "BANANA" {
			t.Fatalf("completions = %+v, want turn-1 interrupted and turn-2 answered BANANA", run.completions)
		}
	})
	t.Run("steer-refused", func(t *testing.T) {
		// A steer that arrives mid-turn is refused as the failed delivery it is; the turn runs on.
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns",
			first: []RunInboxResponse{cursorMessage("turn-1", "first message")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Read"),
				RunInboxResponse{TurnID: "steer-1", Kind: "steer", Content: "and one more thing"}),
			then: cursorEndAfter(2)})
		steer, turn := run.completionsOf("steer-1"), run.completionsOf("turn-1")
		if len(steer) != 1 || steer[0].Status != stFailed || steer[0].Subtype != subtypeSteer || len(turn) != 1 || turn[0].Status != stSucceeded {
			t.Fatalf("completions = %+v, want the steer refused and the turn answered", run.completions)
		}
		if deliveries := run.of("steer-1", evUserDelivery); len(deliveries) != 1 || deliveries[0]["delivery"] != string(deliveryFailed) {
			t.Fatalf("steer delivery = %v", deliveries)
		}
		if prompts := run.fake.requests(t, "session/prompt"); len(prompts) != 1 {
			t.Fatalf("session/prompt sent %d times: the steer must never become one", len(prompts))
		}
	})
}

// A stop is a session/cancel, which Cursor answers `cancelled` (§3.3): the turn settles interrupted, and
// the card it left in progress — Cursor never completes a cancelled one — is closed as an error. The command
// is allowed as P0a allowed it, and the stop comes once that answer has reached the CLI: a stop before it would
// find the request unanswered, and its call not run (TestCursorWithdrawnApprovals).
func TestCursorACPInterrupt(t *testing.T) {
	t.Run("cancel-settles-interrupted", func(t *testing.T) {
		const recording, card = "cancel-mid-tool/cancel", "call-<UUID_1>-0\nfc_p5V65cF-3LYxF7-95870d84-aws_ue1_0"
		run := runCursorSession(t, cursorRunOptions{recording: recording,
			first:   []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
			approve: func(cursorTestCard) cursorTestDecision { return cursorTestDecision{Status: "ALLOWED"} },
			onAnswer: func(id string) []RunInboxResponse {
				if id == "0" {
					return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
				}
				return nil
			},
			then: cursorEndAfter(1)})
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{"0": {cursorAllowOnce}}) {
			t.Fatalf("requests answered %q, want the command allowed once", answers)
		}
		var cancels []fakeCursorReceived
		for _, line := range run.fake.received(t) {
			if line.Message["method"] == "session/cancel" {
				cancels = append(cancels, line)
			}
		}
		if len(cancels) != 1 || !cursorJSONEqual(t, cancels[0].Message, map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
			"params": map[string]interface{}{"sessionId": "<UUID_2>"}}) || cancels[0].Emitted > recordedAnswerLine(t, recording, "3") {
			t.Fatalf("cancels = %v, want one session/cancel for the session, ahead of the cancelled answer", cancels)
		}
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stInterrupted || turn[0].Subtype != "interrupted" {
			t.Fatalf("completions = %+v, want the turn interrupted once", run.completions)
		}
		ends := run.of("turn-1", evTurnEnd)
		if len(ends) != 1 || ends[0]["subtype"] != "interrupted" || ends[0]["stopReason"] != "cancelled" {
			t.Fatalf("turn_end = %v", ends)
		}
		var closed []map[string]interface{}
		for _, result := range run.of("turn-1", evToolResult) {
			if result["toolUseId"] == card {
				closed = append(closed, result)
			}
		}
		if len(closed) != 1 || closed[0]["isError"] != true || !strings.HasPrefix(asString(closed[0]["content"]), "Interrupted:") {
			t.Fatalf("the cancelled card's results = %v, want one error", closed)
		}
		if len(run.of("", evInterrupt)) != 1 {
			t.Fatal("the interrupt was not recorded")
		}
	})
	t.Run("unanswered-cancel-ends-the-process", func(t *testing.T) {
		// A CLI that no longer answers a cancel is ended once the stop's grace runs out: the turn settles
		// interrupted all the same, once, and the process is gone with it.
		previous := cursorStopGrace
		cursorStopGrace = 300 * time.Millisecond
		t.Cleanup(func() { cursorStopGrace = previous })
		run := runCursorSession(t, cursorRunOptions{recording: "cancel-mid-tool/cancel",
			script:  func(s *fakeCursorACPScript) { s.IgnoreCancel = true },
			first:   []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "stop-1", Kind: "interrupt"})})
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stInterrupted || len(run.of("turn-1", evTurnEnd)) != 1 {
			t.Fatalf("completions = %+v, want the turn interrupted once", run.completions)
		}
		if run.status != stFailed || run.ended {
			t.Fatalf("run = (%s, ended=%v): the process is gone, the session is not", run.status, run.ended)
		}
	})
}

// A later process of the session continues its conversation with session/load under the same id
// (§3.5), and writes none of what Cursor replays; a conversation it cannot find is said to be gone,
// never replaced by a new one. A turn an earlier process prompted is never prompted again.
func TestCursorACPResume(t *testing.T) {
	t.Run("load-replays-nothing", func(t *testing.T) {
		// The replay of two turns — the person's messages, the replies, seven cards under replay-<n>-<m>
		// ids — arrives before load's answer, and none of it is the transcript's.
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/load", runtimeSessionID: "<UUID_8>",
			naming: true, first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
		if run.status != stSucceeded || !run.ended {
			t.Fatalf("run = (%s, ended=%v)", run.status, run.ended)
		}
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/load"}) {
			t.Fatalf("the runner asked %q, want initialize and session/load", methods)
		}
		load := run.fake.requests(t, "session/load")[0]
		servers, err := cursorMCPServers(run.job)
		if err != nil {
			t.Fatal(err)
		}
		if !cursorJSONEqual(t, load.Message["params"], map[string]interface{}{"sessionId": "<UUID_8>", "cwd": run.spec.Cwd, "mcpServers": servers}) {
			t.Fatalf("session/load params = %v", load.Message["params"])
		}
		for _, event := range run.events {
			if event.typ != evSystem {
				t.Fatalf("the replay reached the transcript: %s %v", event.typ, event.payload)
			}
		}
		var init map[string]interface{}
		for _, payload := range run.of("", evSystem) {
			if payload["subtype"] == "init" {
				init = payload
			}
		}
		if init == nil || init["sessionId"] != "<UUID_8>" || init["resumed"] != true {
			t.Fatalf("init event = %v, want the same conversation, resumed", init)
		}
		if len(run.namings) != 0 {
			t.Fatalf("naming = %+v: a load names nothing", run.namings)
		}
	})
	t.Run("crash-then-load-continues", func(t *testing.T) {
		// The first process dies mid-turn (SIGKILL); the next continues the conversation, and its answer
		// names the command of the turn the crash cut off: the context came with it.
		useCursorRealHome(t)
		checkout := t.TempDir()
		crashed := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash", sameHome: true, execDir: checkout,
			script: func(s *fakeCursorACPScript) { s.Exit = "SIGKILL" },
			first:  []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}})
		if turn := crashed.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stFailed || crashed.job.RuntimeSessionID != "<UUID_1>" {
			t.Fatalf("first process: completions %+v, runtime id %q", crashed.completions, crashed.job.RuntimeSessionID)
		}
		run := runCursorSession(t, cursorRunOptions{recording: "crash-continue-and-shell-wrapper/continue", sameHome: true, execDir: checkout,
			runtimeSessionID: crashed.job.RuntimeSessionID,
			first:            []RunInboxResponse{cursorMessage("turn-2", "what command did you run?")}, then: cursorEndAfter(1)})
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/load", "session/prompt"}) {
			t.Fatalf("the runner asked %q, want the conversation loaded, then prompted", methods)
		}
		load := run.fake.requests(t, "session/load")[0]
		if params := mapValue(load.Message["params"]); params["sessionId"] != "<UUID_1>" || params["cwd"] != crashed.spec.Cwd {
			t.Fatalf("session/load params = %v, want the crashed conversation in its checkout", params)
		}
		turn := run.completionsOf("turn-2")
		if len(turn) != 1 || turn[0].Status != stSucceeded || turn[0].Result != "`sleep 31 && echo crash-finished > crash.txt`" {
			t.Fatalf("completions = %+v, want the answer that names the crashed turn's command", run.completions)
		}
		for _, event := range run.events {
			text := asString(event.payload["text"])
			if strings.Contains(text, "CRASH-DONE") || strings.Contains(text, "I'll run that command") {
				t.Fatalf("the replay reached the transcript: %s %v", event.typ, event.payload)
			}
		}
		if users := run.of("turn-2", evUser); len(users) != 1 {
			t.Fatalf("user events = %v, want the new turn's alone", users)
		}
	})
	t.Run("redelivered-turn-not-prompted-again", func(t *testing.T) {
		// The lease moves while the first process runs the turn: that process settles nothing it reports.
		// The turn is delivered again to the next process, which finds it prompted — its `sleep 31` may be
		// running still — and settles it interrupted, closing the card it left open, without prompting it.
		useCursorRealHome(t)
		checkout := t.TempDir()
		const card = "call-<UUID_2>-0\nfc_<UUID_3>_0"
		first := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash", sameHome: true, execDir: checkout,
			first:   []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "lease", Kind: cursorLeaseLost})})
		if first.leaseLost == nil || len(first.completions) != 0 || first.status != stFailed || !first.ended {
			t.Fatalf("first process: lease %v, completions %+v, run (%s, %v)", first.leaseLost, first.completions, first.status, first.ended)
		}
		if rec := sessionLedger(t)["turn-1"]; rec.State != cursorTurnPrompted || !reflect.DeepEqual(rec.OpenTools, []string{card}) {
			t.Fatalf("ledger = %+v, want turn-1 prompted with its card open", rec)
		}
		run := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/moved", sameHome: true, execDir: checkout,
			runtimeSessionID: first.job.RuntimeSessionID,
			first:            []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}, then: cursorEndAfter(1)})
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/load"}) {
			t.Fatalf("the runner asked %q: a turn already prompted is never prompted again", methods)
		}
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stInterrupted || !strings.Contains(turn[0].Error, "not sent again") {
			t.Fatalf("completions = %+v, want the turn settled interrupted, once", run.completions)
		}
		results := run.of("turn-1", evToolResult)
		if len(results) != 1 || results[0]["toolUseId"] != card || results[0]["isError"] != true {
			t.Fatalf("tool results = %v, want the card the first process left open closed as an error", results)
		}
		if ends := run.of("turn-1", evTurnEnd); len(ends) != 1 || ends[0]["recovered"] != true {
			t.Fatalf("turn_end = %v", ends)
		}
		if rec := sessionLedger(t)["turn-1"]; rec.State != cursorTurnSettled || rec.Status != stInterrupted {
			t.Fatalf("ledger = %+v, want turn-1 settled", rec)
		}
	})
	t.Run("load-not-found-is-not-replaced", func(t *testing.T) {
		// P0a's session/load of an id the CLI never stored: -32602 `Session "<id>" not found`.
		run := runCursorSession(t, cursorRunOptions{recording: "api-key-session-management/acp", runtimeSessionID: "<UUID_1>"})
		errors := run.of("", evError)
		if run.status != stFailed || !run.ended || len(errors) != 1 {
			t.Fatalf("run = (%s, ended=%v), errors %v", run.status, run.ended, errors)
		}
		message := asString(errors[0]["message"])
		if !strings.Contains(message, `Session "<UUID_1>" not found`) || !strings.Contains(message, "does not start a new conversation") {
			t.Fatalf("error = %q, want the conversation said to be gone", message)
		}
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/load"}) {
			t.Fatalf("the runner asked %q: no new conversation in place of the session's own", methods)
		}
	})
	t.Run("unspoken-conversation-reopens", func(t *testing.T) {
		// A conversation that never had a prompt — the session's turns so far were shell turns — has no
		// store Cursor could load (§3.5): a new one is opened, and the transcript says so.
		useCursorRealHome(t)
		conversation := filepath.Join(runDir(cursorTestSessionID), "cursor", "config", "acp-sessions", "<UUID_0>")
		if err := os.MkdirAll(conversation, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(conversation, "meta.json"), []byte(`{"schemaVersion":1}`), 0o600); err != nil {
			t.Fatal(err)
		}
		run := runCursorSession(t, cursorRunOptions{recording: "subagent-and-todos/subagent", sameHome: true, runtimeSessionID: "<UUID_0>",
			first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
		if methods := run.methods(t); !reflect.DeepEqual(methods, []string{"initialize", "session/new"}) {
			t.Fatalf("the runner asked %q", methods)
		}
		var notice, init map[string]interface{}
		for _, payload := range run.of("", evSystem) {
			switch {
			case payload["noticeKind"] == "cursor-conversation-reopened":
				notice = payload
			case payload["subtype"] == "init":
				init = payload
			}
		}
		if notice == nil || init == nil || init["sessionId"] != "<UUID_7>" || init["resumed"] != false || run.job.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("notice %v, init %v, runtime id %q", notice, init, run.job.RuntimeSessionID)
		}
	})
}

// Each turn settles once, on the first of: Cursor's answer, Orbit's own stop, the process exiting, the
// connection closing, the lease moving (cursorSettlementOutcome). None is prompted twice.
func TestCursorACPSettlement(t *testing.T) {
	t.Run("precedence", func(t *testing.T) {
		endTurn := map[string]interface{}{"stopReason": "end_turn"}
		cancelled := map[string]interface{}{"stopReason": "cancelled"}
		refused := &cursorCallError{code: -32603, text: "Cursor CLI's session/prompt failed (-32603): Internal error"}
		closed := errors.New("Cursor CLI's ACP connection closed: EOF")
		for _, c := range []struct {
			name   string
			end    cursorTurnEnd
			stop   string // the stop reason settled on, or
			failed string // the failure it says
		}{
			{"an answer outranks a stop that crossed it", cursorTurnEnd{result: endTurn, stopped: true}, "end_turn", ""},
			{"a cancelled answer to a stop", cursorTurnEnd{result: cancelled, stopped: true}, "cancelled", ""},
			{"an error answer is no success", cursorTurnEnd{err: refused, stopped: true}, "", "Internal error"},
			{"a stop outranks the exit it caused", cursorTurnEnd{err: closed, stopped: true, exit: "signal: killed", closed: true}, "cancelled", ""},
			{"an exit outranks the closed connection", cursorTurnEnd{err: closed, exit: "signal: killed", closed: true}, "", "exited during this turn (signal: killed)"},
			{"a closed connection with the process running", cursorTurnEnd{err: closed, closed: true}, "", "connection ended during this turn"},
		} {
			result, err := cursorSettlementOutcome(c.end)
			switch {
			case c.stop != "" && (err != nil || firstString(result, "stopReason") != c.stop):
				t.Errorf("%s: settled (%v, %v), want stop reason %s", c.name, result, err, c.stop)
			case c.failed != "" && (err == nil || !strings.Contains(err.Error(), c.failed)):
				t.Errorf("%s: settled (%v, %v), want a failure saying %q", c.name, result, err, c.failed)
			}
			if c.failed != "" && !c.end.answered() && !strings.Contains(err.Error(), "not sent again") {
				t.Errorf("%s: %q does not say the turn was not sent again", c.name, err)
			}
		}
	})
	t.Run("prompt-answer", func(t *testing.T) {
		// Two turns, each answered end_turn: each settles once, its turn_end ahead of its turn-complete.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then})
		for _, turn := range []string{"turn-1", "turn-2"} {
			if completions, ends := run.completionsOf(turn), run.of(turn, evTurnEnd); len(completions) != 1 || completions[0].Status != stSucceeded || len(ends) != 1 {
				t.Fatalf("%s: completions %+v, turn_ends %v, want one of each", turn, completions, ends)
			}
		}
		if rec := sessionLedger(t); rec["turn-1"].State != cursorTurnSettled || rec["turn-2"].State != cursorTurnSettled {
			t.Fatalf("ledger = %+v, want both turns settled", rec)
		}
	})
	t.Run("process-exit", func(t *testing.T) {
		// The CLI is killed mid-turn — no answer, its stdout gone (§12): the turn fails once, saying how the
		// process ended, its open card closed, and it is not prompted again.
		const card = "call-<UUID_2>-0\nfc_<UUID_3>_0"
		run := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash",
			script: func(s *fakeCursorACPScript) { s.Exit = "SIGKILL" },
			first:  []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}})
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stFailed || !strings.Contains(turn[0].Error, "exited during this turn (signal: killed)") ||
			!strings.Contains(turn[0].Error, "not sent again") {
			t.Fatalf("completions = %+v, want the turn failed once on the exit", run.completions)
		}
		if run.status != stFailed || !run.ended || run.reload {
			t.Fatalf("run = (%s, ended=%v, reload=%v)", run.status, run.ended, run.reload)
		}
		results := run.of("turn-1", evToolResult)
		if len(results) != 1 || results[0]["toolUseId"] != card || results[0]["isError"] != true {
			t.Fatalf("tool results = %v, want the open card closed as an error", results)
		}
		if ends := run.of("turn-1", evTurnEnd); len(ends) != 1 || ends[0]["subtype"] != "error" {
			t.Fatalf("turn_end = %v", ends)
		}
		var exited map[string]interface{}
		for _, payload := range run.of("", evSystem) {
			if payload["subtype"] == "process_exited" {
				exited = payload
			}
		}
		if exited == nil || exited["exit"] != "signal: killed" || exited["runtimeSessionId"] != "<UUID_1>" {
			t.Fatalf("process_exited = %v", exited)
		}
		if prompts := run.fake.requests(t, "session/prompt"); len(prompts) != 1 {
			t.Fatalf("session/prompt sent %d times", len(prompts))
		}
	})
	t.Run("eof-without-result", func(t *testing.T) {
		// The CLI closes its connection mid-turn and runs on: the turn fails once on the closed connection.
		run := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash",
			script: func(s *fakeCursorACPScript) { s.Exit = "close-stdout" },
			first:  []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}})
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stFailed || !strings.Contains(turn[0].Error, "connection ended during this turn without an answer") {
			t.Fatalf("completions = %+v, want the turn failed once on the closed connection", run.completions)
		}
		if ends := run.of("turn-1", evTurnEnd); len(ends) != 1 {
			t.Fatalf("turn_end = %v", ends)
		}
	})
	t.Run("lease-loss", func(t *testing.T) {
		// The lease moves mid-turn: this runner ends the process and reports nothing; the ledger leaves the
		// turn prompted, for the runner that holds the lease to settle without prompting it again.
		run := runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash",
			first:   []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
			onEvent: cursorOnce(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "lease", Kind: cursorLeaseLost})})
		if run.leaseLost == nil || len(run.completions) != 0 || run.status != stFailed || !run.ended {
			t.Fatalf("lease %v, completions %+v, run (%s, %v): want nothing reported", run.leaseLost, run.completions, run.status, run.ended)
		}
		if rec := sessionLedger(t)["turn-1"]; rec.State != cursorTurnPrompted || !reflect.DeepEqual(rec.OpenTools, []string{"call-<UUID_2>-0\nfc_<UUID_3>_0"}) {
			t.Fatalf("ledger = %+v, want turn-1 left prompted with its card open", rec)
		}
		for _, typ := range []string{evTurnEnd, evToolResult, evError} {
			if events := run.of("turn-1", typ); len(events) != 0 {
				t.Fatalf("%s events %v went out for a turn this runner no longer holds", typ, events)
			}
		}
		if prompts := run.fake.requests(t, "session/prompt"); len(prompts) != 1 {
			t.Fatalf("session/prompt sent %d times", len(prompts))
		}
	})
}

// The failures Cursor reports, by the shapes P0a recorded (§2.3, §9, §10, §12): what the CLI answers
// session/new, session/load and set_config_option with, and the sentence its prompt handler ends a failed
// turn with (6136.index.js@15087) — none of them a success.
func TestCursorACPErrorClassification(t *testing.T) {
	startError := func(t *testing.T, run cursorRun) string {
		t.Helper()
		errors := run.of("", evError)
		if run.status != stFailed || !run.ended || len(errors) != 1 || len(run.fake.requests(t, "session/prompt")) != 0 {
			t.Fatalf("run = (%s, ended=%v), errors %v: want a failed start that prompted nothing", run.status, run.ended, errors)
		}
		return asString(errors[0]["message"])
	}
	turnFailure := func(t *testing.T, run cursorRun) TurnCompleteRequest {
		t.Helper()
		turn := run.completionsOf("turn-1")
		if len(turn) != 1 || turn[0].Status != stFailed || turn[0].Subtype != "error" {
			t.Fatalf("completions = %+v, want turn-1 failed once", run.completions)
		}
		if errors := run.of("turn-1", evError); len(errors) != 1 || errors[0]["message"] != turn[0].Error {
			t.Fatalf("turn errors = %v, want the failure once", errors)
		}
		return turn[0]
	}
	t.Run("not-signed-in", func(t *testing.T) {
		// signed-out-handshake: session/new answers -32000 "Authentication required".
		run := runCursorSession(t, cursorRunOptions{recording: "signed-out-handshake/acp"})
		if message := startError(t, run); !isAuthError(message) || !strings.Contains(message, "Authentication required") {
			t.Fatalf("error = %q, want a sign-in failure", message)
		}
	})
	t.Run("credential-expired", func(t *testing.T) {
		// failure-shapes-without-prompt: a key Cursor no longer accepts answers session/new -32603 "Failed to
		// initialize session services", and `agent models` says "The provided API key is invalid". The answer
		// is kept on the dispatched key.
		run := runCursorSession(t, cursorRunOptions{recording: "failure-shapes-without-prompt/bogus-key-memory",
			env:    map[string]string{cursorAPIKeyVar: cursorTestKey},
			script: func(s *fakeCursorACPScript) { s.Models = "invalid-key" }})
		if message := startError(t, run); message != cursorAPIKeyInvalidMessage {
			t.Fatalf("error = %q, want %q", message, cursorAPIKeyInvalidMessage)
		}
		if calls := run.fake.models(t); len(calls) != 1 || !calls[0].APIKey {
			t.Fatalf("agent models calls = %+v, want one, with the key", calls)
		}
		if !reflect.DeepEqual(run.keyChecks, []CursorKeyCheckReport{{State: cursorKeyInvalid, KeyFingerprint: cursorKeyFingerprint(cursorTestKey)}}) {
			t.Fatalf("key checks = %+v", run.keyChecks)
		}
	})
	t.Run("usage-limit", func(t *testing.T) {
		// background-shell-and-commit ran into the Free plan's limit: one chunk, "\n\nUpgrade your plan to
		// continue", then end_turn. The turn fails in the words Orbit waits a spent quota out by, and the
		// sentence is nobody's reply.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then})
		turn := turnFailure(t, run)
		if turn.Error != `You've hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."` || !cursorUsageLimitWords(turn.Error) {
			t.Fatalf("error = %q", turn.Error)
		}
		if turn.Result != "" || len(run.of("turn-1", evAssistant)) != 0 || len(run.of("turn-1", evTextDelta)) != 0 {
			t.Fatalf("the sentence went out as a reply: result %q, events %v", turn.Result, run.events)
		}
	})
	t.Run("rate-limit", func(t *testing.T) {
		// Cursor answers a rate limit with the same sentence: the server error behind the recorded sentence
		// was ERROR_RATE_LIMITED_CHANGEABLE, titled "You've hit your usage limit" (P0a's quota-exhausted
		// incident, from the CLI's debug log), which ACP carries only as "Upgrade your plan to continue".
		// It is waited out as a spent quota, not failed as a task's error or taken for a reply.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then})
		turn := turnFailure(t, run)
		if !cursorUsageLimitWords(turn.Error) || isAuthError(turn.Error) || isAPIError(turn.Error) {
			t.Fatalf("error = %q, want the quota's words", turn.Error)
		}
		if end := run.of("turn-1", evTurnEnd); len(end) != 1 || end[0]["stopReason"] != "end_turn" || end[0]["subtype"] != "error" {
			t.Fatalf("turn_end = %v", end)
		}
	})
	t.Run("network-down", func(t *testing.T) {
		// failure-shapes-without-prompt, offline: the same -32603 as an invalid key, and `agent models` says
		// "Failed to reach the Cursor API". No verdict on the key.
		run := runCursorSession(t, cursorRunOptions{recording: "failure-shapes-without-prompt/offline",
			env:    map[string]string{cursorAPIKeyVar: cursorTestKey},
			script: func(s *fakeCursorACPScript) { s.Models = "offline" }})
		message := startError(t, run)
		if !strings.Contains(message, "could not reach the Cursor API") || isAuthError(message) || message == cursorAPIKeyInvalidMessage {
			t.Fatalf("error = %q, want the network named", message)
		}
		if !reflect.DeepEqual(run.keyChecks, []CursorKeyCheckReport{{State: cursorKeyUnreachable, KeyFingerprint: cursorKeyFingerprint(cursorTestKey)}}) {
			t.Fatalf("key checks = %+v", run.keyChecks)
		}
	})
	t.Run("model-unavailable", func(t *testing.T) {
		// api-key-session-management: set_config_option for a model the account is not offered answers
		// -32602 "Invalid model value: no-such-model[]".
		run := runCursorSession(t, cursorRunOptions{recording: "api-key-session-management/acp",
			script: func(s *fakeCursorACPScript) { s.MatchParams = true },
			agent:  func(agent *AgentExecConfig) { agent.Model = "no-such-model[]" }})
		if message := startError(t, run); !strings.HasPrefix(message, "Cursor CLI does not offer the model this session asks for (Invalid model value: no-such-model[])") {
			t.Fatalf("error = %q", message)
		}
	})
	t.Run("content-refused", func(t *testing.T) {
		// provider-refusal-after-crash: the model provider refused the prompt — a sentence and end_turn.
		run := runCursorSession(t, cursorRunOptions{recording: "provider-refusal-after-crash/moved", runtimeSessionID: "<UUID_1>",
			first: []RunInboxResponse{cursorMessage("turn-1", "two steps")}, then: cursorEndAfter(1)})
		turn := turnFailure(t, run)
		if !strings.HasPrefix(turn.Error, "Cursor's model provider refused this request: Request blocked") ||
			cursorUsageLimitWords(turn.Error) || isAuthError(turn.Error) || isAPIError(turn.Error) {
			t.Fatalf("error = %q", turn.Error)
		}
	})
	t.Run("protocol-error-not-success", func(t *testing.T) {
		// api-key-session-management: a prompt answered with a JSON-RPC error (-32603 "Session … not found").
		run := runCursorSession(t, cursorRunOptions{recording: "api-key-session-management/acp",
			first: []RunInboxResponse{cursorMessage("turn-1", "x")}, then: cursorEndAfter(1)})
		if turn := turnFailure(t, run); !strings.Contains(turn.Error, "session/prompt failed (-32603)") || !strings.Contains(turn.Error, "not found") {
			t.Fatalf("error = %q", turn.Error)
		}
	})
	t.Run("turn-failure-sentences", func(t *testing.T) {
		// Every sentence the pinned build's prompt handler ends a failed turn with, after a little text: the
		// turn fails with it, the text before it is the turn's result, and the sentence goes out as nothing.
		for _, c := range []struct{ said, want string }{
			{"Upgrade your plan to continue", "You've hit your usage limit on Cursor."},
			{"Please sign in to continue", "Failed to authenticate: "},
			{"Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.",
				"Failed to authenticate: Cursor rejected this session's credential ([unauthenticated] Backend rejected authentication."},
			{"Add a payment method to continue", `Cursor said: "Add a payment method to continue."`},
			{"Check your settings to continue", `Cursor said: "Check your settings to continue."`},
			{"Request blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt.",
				"Cursor's model provider refused this request: Request blocked"},
			{"Error: ConnectError: [unavailable] read ECONNRESET", "Cursor CLI failed this turn: Error: ConnectError: [unavailable]"},
		} {
			var events cursorEvents
			m := newCursorEventMapper(events.emitFor)
			m.bind("s")
			if err := m.begin("turn"); err != nil {
				t.Fatal(err)
			}
			for _, text := range []string{"Working", " on it.", "\n\n" + c.said} {
				m.update(map[string]interface{}{"sessionId": "s", "update": map[string]interface{}{
					"sessionUpdate": "agent_message_chunk", "content": map[string]interface{}{"type": "text", "text": text}}})
			}
			req, ok := m.settle("turn", map[string]interface{}{"stopReason": "end_turn"}, nil)
			if !ok || req.Status != stFailed || !strings.HasPrefix(req.Error, c.want) || req.Result != "Working on it." {
				t.Errorf("%q: settled %+v, want a failure that begins %q", c.said, req, c.want)
			}
			for _, event := range events.snapshot() {
				if strings.Contains(asString(event.payload["text"]), c.said) {
					t.Errorf("%q went out as %s", c.said, event.typ)
				}
			}
			if strings.HasPrefix(c.want, "Failed to authenticate") != isAuthError(req.Error) {
				t.Errorf("%q: %q and the sign-in card disagree", c.said, req.Error)
			}
		}
		// The same sentence followed by anything, or not opening its own chunk, is the agent's text.
		for name, chunks := range map[string][]string{
			"followed":     {"\n\nUpgrade your plan to continue", " — or wait for the reset."},
			"mid-sentence": {"Cursor says: Upgrade your plan to continue"},
		} {
			var events cursorEvents
			m := newCursorEventMapper(events.emitFor)
			m.bind("s")
			_ = m.begin("turn")
			for _, text := range chunks {
				m.update(map[string]interface{}{"sessionId": "s", "update": map[string]interface{}{
					"sessionUpdate": "agent_message_chunk", "content": map[string]interface{}{"type": "text", "text": text}}})
			}
			req, _ := m.settle("turn", map[string]interface{}{"stopReason": "end_turn"}, nil)
			if req.Status != stSucceeded || !strings.Contains(req.Result, "Upgrade your plan to continue") {
				t.Errorf("%s: settled %+v, want the text as the reply", name, req)
			}
		}
	})
}

// Cursor reports no usage of any kind (§3.2, §4.1): whatever a turn settles on, its turn_end carries no
// context or cost, and its turn-complete says its usage is unknown rather than a measured zero.
func TestCursorACPContextUnavailable(t *testing.T) {
	var runs []cursorRun
	first, then := cursorTurns(cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message"))
	runs = append(runs, runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then}))
	first, then = cursorTurns(cursorMessage("turn-1", "first message"))
	runs = append(runs, runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then}))
	runs = append(runs, runCursorSession(t, cursorRunOptions{recording: "cancel-mid-tool/cancel",
		first:   []RunInboxResponse{cursorMessage("turn-1", "run the sleep")},
		onEvent: cursorOnce(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "stop-1", Kind: "interrupt"}),
		then:    cursorEndAfter(1)}))
	runs = append(runs, runCursorSession(t, cursorRunOptions{recording: "crash-recover-and-move/crash",
		script: func(s *fakeCursorACPScript) { s.Exit = "SIGKILL" },
		first:  []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}}))
	statuses := map[string]bool{}
	for _, run := range runs {
		for _, req := range run.completions {
			statuses[req.Status] = true
			wire, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			var sent map[string]interface{}
			if err := json.Unmarshal(wire, &sent); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"costUsd", "usage", "modelUsage", "contextTokens", "contextWindow"} {
				if _, ok := sent[key]; ok {
					t.Errorf("%s turn-complete %s carries %s: %s", req.Status, req.TurnID, key, wire)
				}
			}
			if !req.UsageUnknown {
				t.Errorf("%s turn-complete %s does not say its usage is unknown", req.Status, req.TurnID)
			}
		}
		ends := 0
		for _, event := range run.events {
			for _, key := range []string{"contextTokens", "contextWindow", "costUsd", "usage"} {
				if _, ok := event.payload[key]; ok {
					t.Errorf("a %s event reads out %s: %v", event.typ, key, event.payload)
				}
			}
			if event.typ == evTurnEnd {
				ends++
			}
		}
		if ends == 0 {
			t.Error("a run settled no turn")
		}
	}
	for _, status := range []string{stSucceeded, stFailed, stInterrupted} {
		if !statuses[status] {
			t.Errorf("no turn settled %s: the runs no longer cover it", status)
		}
	}
}
