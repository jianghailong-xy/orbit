package main

// The permission modes, the approval bridge, Orbit's MCP server and the checkout's own .cursor/
// configuration on Cursor CLI (cursor_permissions.go, cursor_mcp.go), run against recordings of the pinned
// CLI replayed by fake_cursor_acp_test.go: P0's, and P5c's own of Orbit's runner on the real CLI
// (testdata/cursor/p5c/, cursor_permissions_real_test.go). The named scenarios here are the ones
// scripts/test-cursor-permissions.mjs runs.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// copyCursorFixture lays out the malicious fixture repository (testdata/cursor/p5c/fixtures/malicious-repo) in work,
// with every hook, server and setup command it holds pointed at markers, where whatever runs one leaves a
// line. A planted node_modules/typescript/lib/tsserver.js — a language server's way in, which the
// repository's own .gitignore keeps out of the fixture — does the same.
func copyCursorFixture(t *testing.T, work, markers string) {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("testdata", "cursor", "p5c", "fixtures", "malicious-repo"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(markers, 0o755); err != nil {
		t.Fatal(err)
	}
	replace := strings.NewReplacer("__MARKERS__", markers, "__WORK__", work)
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		target := filepath.Join(work, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, []byte(replace.Replace(string(data))), info.Mode().Perm())
	})
	if err != nil {
		t.Fatal(err)
	}
	bait := filepath.Join(work, "node_modules", "typescript", "lib")
	if err := os.MkdirAll(bait, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"tsserver.js":   "require('fs').appendFileSync(" + jsString(filepath.Join(markers, "markers.log")) + ", 'repo-tsserver\\n');\n",
		"typescript.js": "require('fs').appendFileSync(" + jsString(filepath.Join(markers, "markers.log")) + ", 'repo-typescript\\n'); module.exports = {};\n",
	} {
		if err := os.WriteFile(filepath.Join(bait, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(work, "node_modules", "typescript", "package.json"),
		[]byte(`{"name":"typescript","version":"5.9.9","main":"lib/typescript.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

func jsString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

// cursorMarkers is what the fixture's markers log holds: one line per thing that ran.
func cursorMarkers(t *testing.T, markers string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(markers, "markers.log"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// cursorAnswersByRequest is what the runner answered each request the replayed CLI sent it, by the
// request's recorded id: the option it selected, or the outcome when it selected none.
func cursorAnswersByRequest(t *testing.T, fake *cursorReplay) map[string][]string {
	t.Helper()
	answers := map[string][]string{}
	for _, line := range fake.received(t) {
		if line.Message["method"] == nil && line.Message["id"] != nil {
			outcome := mapValue(mapValue(line.Message["result"])["outcome"])
			answer := firstNonEmpty(firstString(outcome, "optionId"), firstString(outcome, "outcome"))
			if line.Message["error"] != nil {
				answer = "error"
			}
			answers[rpcIDKey(line.Message["id"])] = append(answers[rpcIDKey(line.Message["id"])], answer)
		}
	}
	return answers
}

// cursorRecordedRequests is the ids of the requests a recording's CLI sends the client, by method, in order.
func cursorRecordedRequests(t *testing.T, recording, method string) []string {
	t.Helper()
	written, err := readFakeCursorJSONL(filepath.Join("testdata", "cursor", recording, "stdout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, msg := range written {
		if asString(msg["method"]) == method && msg["id"] != nil {
			ids = append(ids, rpcIDKey(msg["id"]))
		}
	}
	return ids
}

// cursorOrbitTools is the rule every session is dispatched with (ALWAYS_ALLOWED_TOOLS).
func cursorOrbitTools(agent *AgentExecConfig) { agent.AllowedTools = []string{"mcp__orbit__*"} }

func cursorInMode(mode string) func(*AgentExecConfig) {
	return func(agent *AgentExecConfig) {
		cursorOrbitTools(agent)
		agent.PermissionMode = mode
	}
}

func cursorDecide(status string) func(cursorTestCard) cursorTestDecision {
	return func(cursorTestCard) cursorTestDecision { return cursorTestDecision{Status: status} }
}

func cursorNoticeKinds(run cursorRun) []string {
	var kinds []string
	for _, event := range run.events {
		if kind := asString(event.payload["noticeKind"]); event.typ == evSystem && kind != "" {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// TestCursorPermissionModes holds each declared mode to what it says, on the six permission requests
// P0 recorded in one conversation — `echo …`, `env | sort …`, an MCP call, a web fetch, the same MCP call
// again, and Orbit's own task_get (multi-turn-tools-default/turns) — and refuses the modes Cursor CLI
// cannot be held to before anything starts.
func TestCursorPermissionModes(t *testing.T) {
	const recording = "multi-turn-tools-default/turns"
	// The answer to each request by its recorded id: 0 echo, 1 env | sort, 2 p0probe record, 3 the web
	// fetch, 4 p0probe record again, 5 orbit task_get. `card` is whether it went to a person.
	type want struct {
		answers []string
		cards   []string
		notices []string
	}
	allowAll := []string{cursorAllowOnce, cursorAllowOnce, cursorAllowOnce, cursorAllowOnce, cursorAllowOnce, cursorAllowOnce}
	refuseAll := []string{cursorRejectOnce, cursorRejectOnce, cursorRejectOnce, cursorRejectOnce, cursorRejectOnce, cursorAllowOnce}
	carded := []string{"Bash", "Bash", "mcp__p0probe__record", "WebFetch", "mcp__p0probe__record"}
	cases := []struct {
		name, mode, decision string
		want                 want
	}{
		// Accept Edits: a person answers each request on the card; Orbit's own tool is allowed unasked.
		{"accept-edits/allow", "acceptEdits", "ALLOWED", want{answers: allowAll, cards: carded}},
		{"accept-edits/deny", "acceptEdits", "DENIED", want{answers: refuseAll, cards: carded}},
		// Auto: Orbit allows the two routine commands itself; the MCP calls and the fetch go to the card.
		{"auto/allow", "auto", "ALLOWED", want{answers: allowAll, cards: []string{"mcp__p0probe__record", "WebFetch", "mcp__p0probe__record"}}},
		{"auto/deny", "auto", "DENIED", want{answers: []string{cursorAllowOnce, cursorAllowOnce, cursorRejectOnce, cursorRejectOnce, cursorRejectOnce, cursorAllowOnce},
			cards: []string{"mcp__p0probe__record", "WebFetch", "mcp__p0probe__record"}}},
		// Bypass asks nobody, but when Cursor asks anyway — the team has turned Run Everything off — a
		// person answers each request, as in Accept Edits, told once why.
		{"bypass/team-veto-allow", "bypassPermissions", "ALLOWED", want{answers: allowAll, cards: carded, notices: []string{"cursor-run-everything-off"}}},
		{"bypass/team-veto-deny", "bypassPermissions", "DENIED", want{answers: refuseAll, cards: carded, notices: []string{"cursor-run-everything-off"}}},
		// Plan and Don't Ask refuse every request unasked; Orbit's own tool still runs.
		{"plan/allow", "plan", "ALLOWED", want{answers: refuseAll}},
		{"plan/deny", "plan", "DENIED", want{answers: refuseAll}},
		{"dont-ask/allow", "dontAsk", "ALLOWED", want{answers: refuseAll}},
		{"dont-ask/deny", "dontAsk", "DENIED", want{answers: refuseAll}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			first, then := cursorTurns(cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message"))
			run := runCursorSession(t, cursorRunOptions{recording: recording, first: first, then: then, agent: cursorInMode(tc.mode),
				approve: cursorDecide(tc.decision), script: func(s *fakeCursorACPScript) { s.Modes = true }})
			if run.status != stSucceeded || len(run.completions) != 2 {
				t.Fatalf("run = %s, completions %+v", run.status, run.completions)
			}
			answers := cursorAnswersByRequest(t, run.fake)
			for i, id := range cursorRecordedRequests(t, recording, "session/request_permission") {
				if got := answers[id]; len(got) != 1 || got[0] != tc.want.answers[i] {
					t.Errorf("request %s answered %q, want exactly %q", id, got, tc.want.answers[i])
				}
			}
			var cards []string
			for _, card := range run.cards {
				cards = append(cards, card.ToolName)
			}
			if !cursorJSONEqual(t, cards, tc.want.cards) {
				t.Errorf("cards = %q, want %q", cards, tc.want.cards)
			}
			if notices := cursorNoticeKinds(run); !cursorJSONEqual(t, notices, tc.want.notices) {
				t.Errorf("notices = %q, want %q", notices, tc.want.notices)
			}
			// The session runs in the Cursor mode its permission mode keeps: plan only for Plan.
			var modes []string
			for _, line := range run.fake.requests(t, "session/set_mode") {
				modes = append(modes, firstString(mapValue(line.Message["params"]), "modeId"))
			}
			wantModes := []string(nil)
			if tc.mode == "plan" {
				wantModes = []string{"plan"}
			}
			if !cursorJSONEqual(t, modes, wantModes) {
				t.Errorf("session/set_mode %q, want %q", modes, wantModes)
			}
		})
	}
	t.Run("mode-table", func(t *testing.T) {
		// The runner keeps exactly the modes the control plane admits for Cursor CLI (CURSOR_PERMISSION_MODES).
		enums, err := os.ReadFile(filepath.Join("..", "shared", "src", "enums.ts"))
		if err != nil {
			t.Fatal(err)
		}
		block := regexp.MustCompile(`(?s)export const CURSOR_PERMISSION_MODES: readonly PermissionMode\[\] = \[(.*?)\];`).FindSubmatch(enums)
		if block == nil {
			t.Fatal("shared/src/enums.ts declares no CURSOR_PERMISSION_MODES")
		}
		names := map[string]string{"DEFAULT": "default", "ACCEPT_EDITS": "acceptEdits", "PLAN": "plan", "AUTO": "auto",
			"DONT_ASK": "dontAsk", "BYPASS": "bypassPermissions"}
		shared := map[string]bool{}
		for _, m := range regexp.MustCompile(`PermissionMode\.([A-Z_]+)`).FindAllSubmatch(block[1], -1) {
			shared[names[string(m[1])]] = true
		}
		for _, mode := range allPermissionModes {
			policy, err := cursorPermissionPolicyFor(mode)
			if (err == nil) != shared[mode] {
				t.Errorf("mode %s: the runner keeps it %v, the control plane %v (%v)", mode, err == nil, shared[mode], err)
			}
			if err != nil && !strings.HasPrefix(err.Error(), "CURSOR_PERMISSION_UNSUPPORTED:") {
				t.Errorf("mode %s refused as %q", mode, err)
			}
			if err == nil && (policy.ACPMode == "plan") != (mode == "plan") {
				t.Errorf("mode %s runs Cursor's %s mode", mode, policy.ACPMode)
			}
		}
		if _, err := cursorPermissionPolicyFor("readOnly"); err == nil {
			t.Error("an unknown mode was kept")
		}
	})
	t.Run("launch-flags", func(t *testing.T) {
		for _, mode := range []string{"acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"} {
			useCursorRealHome(t)
			job := &ClaimedSession{SessionID: cursorTestSessionID, Agent: AgentExecConfig{PermissionMode: mode, Env: map[string]string{"CURSOR_API_KEY": cursorTestKey}}}
			spec, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", filepath.Join(runDir(job.SessionID), "cursor"))
			if err != nil {
				t.Fatal(err)
			}
			want := "acp --disable-auto-update --disable-indexing --disable-project-configs"
			if mode == "bypassPermissions" {
				want = "acp --disable-auto-update --disable-indexing --force --disable-project-configs"
			}
			if got := strings.Join(spec.Args, " "); got != want {
				t.Errorf("%s starts `%s`, want `%s`", mode, got, want)
			}
		}
	})
	t.Run("unsupported-mode-refused", func(t *testing.T) {
		for _, mode := range []string{"default", "readOnly"} {
			run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode(mode),
				first: []RunInboxResponse{cursorMessage("turn-1", "first message")}})
			if run.status != stFailed || !run.ended {
				t.Fatalf("%s: run = %s", mode, run.status)
			}
			if _, err := os.Stat(filepath.Join(run.fake.dir, "start.json")); err == nil {
				t.Fatalf("%s: Cursor CLI started", mode)
			}
			errs := run.of("", evError)
			if len(errs) != 1 || !strings.Contains(asString(errs[0]["message"]), "CURSOR_PERMISSION_UNSUPPORTED") {
				t.Fatalf("%s: errors = %v", mode, errs)
			}
		}
	})
	t.Run("denylist-refused", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: func(agent *AgentExecConfig) {
			agent.DisallowedTools = []string{"Bash"}
		}, first: []RunInboxResponse{cursorMessage("turn-1", "first message")}})
		if _, err := os.Stat(filepath.Join(run.fake.dir, "start.json")); err == nil || run.status != stFailed {
			t.Fatalf("run = %s, Cursor CLI started: %v", run.status, err == nil)
		}
		if errs := run.of("", evError); len(errs) != 1 || !strings.Contains(asString(errs[0]["message"]), "CURSOR_TOOL_POLICY_UNSUPPORTED") {
			t.Fatalf("errors = %v", errs)
		}
	})
	t.Run("mode-change", func(t *testing.T) {
		// Into Plan and back keeps the process and moves Cursor's mode; into Bypass needs --force, a new
		// process; a mode Cursor CLI cannot be held to is not taken up.
		reload := func(mode string) RunInboxResponse {
			return RunInboxResponse{TurnID: "reload-" + mode, Kind: "reload", Content: `{"permissionMode":"` + mode + `"}`}
		}
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("acceptEdits"),
			script: func(s *fakeCursorACPScript) { s.Modes = true },
			first:  []RunInboxResponse{reload("plan"), reload("default"), cursorMessage("turn-1", "first message")},
			then: func(n int, _ TurnCompleteRequest) []RunInboxResponse {
				return []RunInboxResponse{reload("bypassPermissions")}
			}})
		var modes []string
		for _, line := range run.fake.requests(t, "session/set_mode") {
			modes = append(modes, firstString(mapValue(line.Message["params"]), "modeId"))
		}
		if !cursorJSONEqual(t, modes, []string{"plan"}) || run.job.Agent.PermissionMode != "bypassPermissions" {
			t.Fatalf("set_mode %q, mode %s", modes, run.job.Agent.PermissionMode)
		}
		if !run.reload || run.status != stCancelled {
			t.Fatalf("moving to Bypass: run = %s, reload %v: want a new process", run.status, run.reload)
		}
		if errs := run.of("", evError); len(errs) != 1 || !strings.Contains(asString(errs[0]["message"]), "CURSOR_PERMISSION_UNSUPPORTED") {
			t.Fatalf("errors = %v", errs)
		}
		// Plan held while it lasted: the turn's requests were refused unasked.
		for id, got := range cursorAnswersByRequest(t, run.fake) {
			if id != "5" && (len(got) != 1 || got[0] != cursorRejectOnce) {
				t.Errorf("request %s answered %q in Plan", id, got)
			}
		}
	})
}

// cursorKillReplay ends the replayed CLI as a crash would, while it waits on the runner (§3.4, §12).
func cursorKillReplay(t *testing.T, fake *cursorReplay) {
	t.Helper()
	cursorSignalReplay(t, fake, syscall.SIGKILL)
}

// cursorSignalReplay sends the replayed CLI sig, whatever it is waiting on: SIGKILL ends it as a crash would,
// SIGTERM has it exit 143 by itself, as the pinned CLI does (§3.4), and SIGUSR1 has it close its connection and
// run on (fake_cursor_acp_test.go).
func cursorSignalReplay(t *testing.T, fake *cursorReplay, sig syscall.Signal) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		data, err := os.ReadFile(filepath.Join(fake.dir, "start.json"))
		var call fakeCursorCall
		if err == nil && json.Unmarshal(data, &call) == nil && call.PID > 0 {
			_ = syscall.Kill(call.PID, sig)
			return
		}
	}
	t.Error("the replayed CLI never started")
}

// TestCursorApprovalInterrupted stops the turn, or loses the CLI's connection, while a request waits on
// Orbit — on a person's card where the mode asks one, on the mode's own answer where it does not — in every
// declared mode: what was asked is answered cancelled (or reaches no CLI at all), a card still open is
// withdrawn, the turn settles once, an answer that comes after reaches nothing, and the call a withdrawn
// permission card was about settles as not run (TestCursorWithdrawnApprovals).
func TestCursorApprovalInterrupted(t *testing.T) {
	type setup struct {
		recording, session, mode string
		// card is the card held open; "" when the mode asks nobody, and the interruption comes at its first refusal.
		card string
		// request is the recorded id of the request the interruption finds waiting.
		request string
	}
	setups := map[string]setup{
		"accept-edits": {recording: "p5c/accept-edits-stop/session", mode: "acceptEdits", card: "Bash", request: "0"},
		"auto":         {recording: "multi-turn-tools-default/turns", mode: "auto", card: "mcp__p0probe__record", request: "2"},
		"bypass":       {recording: "multi-turn-tools-default/turns", mode: "bypassPermissions", card: "Bash", request: "0"},
		"plan":         {recording: "plan-and-ask-modes-concurrent/modes", session: "<UUID_2>", mode: "plan", card: "ExitPlanMode", request: "3"},
		"dont-ask":     {recording: "multi-turn-tools-default/turns", mode: "dontAsk", request: "0"},
	}
	for _, name := range []string{"accept-edits", "auto", "bypass", "plan", "dont-ask"} {
		s := setups[name]
		for _, how := range []string{"stop", "disconnect"} {
			t.Run(name+"/"+how, func(t *testing.T) {
				var fake *cursorReplay
				var mu sync.Mutex
				interrupted := false
				interrupt := func() []RunInboxResponse {
					mu.Lock()
					defer mu.Unlock()
					if interrupted {
						return nil
					}
					interrupted = true
					if how == "disconnect" {
						go cursorKillReplay(t, fake)
						return nil
					}
					return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
				}
				opts := cursorRunOptions{recording: s.recording, session: s.session, agent: cursorInMode(s.mode),
					script: func(script *fakeCursorACPScript) {
						script.Modes, script.CancelEndsPrompt = true, true
						if s.card == "" {
							// Nothing waits on a person here: the replay waits after the refusal instead, so the
							// stop or the crash finds the turn still running.
							script.HoldAfter = s.request
						}
					},
					replay: func(f *cursorReplay) { fake = f },
					approve: func(card cursorTestCard) cursorTestDecision {
						if card.ToolName == s.card {
							return cursorTestDecision{} // open until the runner stops reading it
						}
						return cursorTestDecision{Status: "DENIED"}
					},
					onCard: func(card cursorTestCard) []RunInboxResponse {
						if card.ToolName == s.card {
							return interrupt()
						}
						return nil
					},
					first: []RunInboxResponse{cursorMessage("turn-1", "first message")},
					then: func(int, TurnCompleteRequest) []RunInboxResponse {
						return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
					},
				}
				if s.card == "" {
					opts.onEvent = func(event cursorEvent) []RunInboxResponse {
						if event.typ == evSystem && event.payload["subtype"] == "permission_denied" {
							return interrupt()
						}
						return nil
					}
				}
				run := runCursorSession(t, opts)
				if len(run.completions) != 1 {
					t.Fatalf("completions = %+v, want the turn settled once", run.completions)
				}
				switch how {
				case "stop":
					if run.completions[0].Status != stInterrupted {
						t.Fatalf("stopped turn settled %+v", run.completions[0])
					}
					if cancels := run.fake.received(t); func() int {
						n := 0
						for _, line := range cancels {
							if line.Message["method"] == "session/cancel" {
								n++
							}
						}
						return n
					}() != 1 {
						t.Fatal("Cursor CLI was not told once to cancel the turn")
					}
				case "disconnect":
					if run.completions[0].Status != stFailed || !strings.Contains(run.completions[0].Error, "exited during this turn") {
						t.Fatalf("disconnected turn settled %+v", run.completions[0])
					}
				}
				answers := cursorAnswersByRequest(t, run.fake)
				for id, given := range answers {
					if len(given) != 1 {
						t.Errorf("request %s answered %q, want exactly once", id, given)
					}
					for _, answer := range given {
						if s.card != "" && id == s.request && answer != "cancelled" {
							t.Errorf("the request waiting on the card was answered %q", answer)
						}
					}
				}
				if s.card != "" {
					if how == "stop" && len(answers[s.request]) != 1 {
						t.Errorf("the request waiting on the card was answered %q, want cancelled once", answers[s.request])
					}
					released := false
					for _, card := range run.cards {
						if card.ToolName == s.card {
							released = card.released()
							// A permission request's call was answered cancelled, which Cursor CLI takes as a refusal: not
							// run, saying how the turn ended — not as one Orbit refused: nobody did. The plan Cursor asked
							// to have accepted is no call of that kind, and settles as the turn's end settles a card it cut short.
							want := map[string]string{"stop": cursorStoppedBeforeApproval, "disconnect": cursorEndedBeforeApproval}[how]
							if s.card == "ExitPlanMode" {
								want = cursorUnfinishedTool(run.completions[0].Status)
							}
							if result := cursorCardResult(run, "turn-1", card); result["content"] != want || result["isError"] != true {
								t.Errorf("the withdrawn card's call settled %v, want %q", result, want)
							}
						}
					}
					if !released {
						t.Errorf("the open card was not withdrawn: %+v", run.cards)
					}
				} else if len(run.cards) != 0 {
					t.Errorf("Don't Ask filed cards: %+v", run.cards)
				}
			})
		}
	}
	t.Run("control-plane-lost", func(t *testing.T) {
		// The lease goes to another runner while a person is being asked: the card is withdrawn and nothing
		// more is said to Cursor CLI from here; the turn is the new owner's to settle.
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/accept-edits-stop/session", agent: cursorInMode("acceptEdits"),
			approve: func(cursorTestCard) cursorTestDecision { return cursorTestDecision{} },
			onCard:  func(cursorTestCard) []RunInboxResponse { return []RunInboxResponse{{Kind: cursorLeaseLost}} },
			first:   []RunInboxResponse{cursorMessage("turn-1", "first message")}})
		if run.leaseLost == nil || len(run.completions) != 0 {
			t.Fatalf("lease lost %v, completions %+v", run.leaseLost, run.completions)
		}
		if len(run.cards) != 1 || !run.cards[0].released() {
			t.Fatalf("cards = %+v", run.cards)
		}
		if answers := cursorAnswersByRequest(t, run.fake); len(answers["0"]) > 0 && answers["0"][0] != "cancelled" {
			t.Fatalf("the request was answered %q after the lease was lost", answers["0"])
		}
	})
}

// cursorSettledCard is one card a turn put out: the tool it is, with its input, and the result it settled with.
type cursorSettledCard struct {
	Name    string
	Input   interface{}
	Result  string
	IsError bool
}

// cursorSettledCards is every card a turn put out, in order, each with its one result.
func cursorSettledCards(t *testing.T, run cursorRun, turn string) []cursorSettledCard {
	t.Helper()
	results := map[string][]map[string]interface{}{}
	for _, result := range run.of(turn, evToolResult) {
		results[asString(result["toolUseId"])] = append(results[asString(result["toolUseId"])], result)
	}
	var cards []cursorSettledCard
	for _, use := range run.of(turn, evToolUse) {
		settled := results[asString(use["id"])]
		if len(settled) != 1 {
			t.Fatalf("card %q settled %d times: %v", use["id"], len(settled), settled)
		}
		cards = append(cards, cursorSettledCard{asString(use["name"]), use["input"], asString(settled[0]["content"]), settled[0]["isError"] == true})
	}
	return cards
}

// cursorCardResult is the result the call an approval card was about settled with, nil unless exactly one.
func cursorCardResult(run cursorRun, turn string, card cursorTestCard) map[string]interface{} {
	var found []map[string]interface{}
	for _, result := range run.of(turn, evToolResult) {
		if result["toolUseId"] == card.ToolUseID {
			found = append(found, result)
		}
	}
	if len(found) != 1 {
		return nil
	}
	return found[0]
}

// TestCursorRefusedToolCards holds the transcript to what happened to a call a permission request asked
// about (D-P8-1): Cursor CLI completes a command or an edit Orbit refused with no output at all — P8's
// recording off the wire, and P5c's — which read as a success with nothing to show, so the runner settles
// the card of every call it did not allow, while the turn ran, as not run. An allowed call keeps what
// Cursor reported (exit code, stdout, stderr), an MCP call Cursor reports {rejected:true} for reads as
// before, and a card the turn's end withdrew unanswered settles as not run, saying how the turn ended
// (TestCursorWithdrawnApprovals). A refused call the turn's end overtakes — stopped, the CLI killed, or its
// connection closed, before Cursor completed the call — settles as not run as well: Cursor CLI runs nothing
// before it has the answer (§5.2). An allowed call the turn's end overtakes still settles as P5c settles it:
// it may have run.
func TestCursorRefusedToolCards(t *testing.T) {
	const notRun = "Not run: the tool call was rejected."
	about := func(card cursorTestCard, word string) bool {
		wire, _ := json.Marshal(card.Input)
		return strings.Contains(string(wire), word)
	}
	deny := func(word string) func(cursorTestCard) cursorTestDecision {
		return func(card cursorTestCard) cursorTestDecision {
			if about(card, word) {
				return cursorTestDecision{Status: "DENIED"}
			}
			return cursorTestDecision{Status: "ALLOWED"}
		}
	}
	// completions is the recorded completion of each card, by its id: the update that carries the call's outcome.
	completions := func(t *testing.T, recording string) map[string]map[string]interface{} {
		done := map[string]map[string]interface{}{}
		for _, params := range recordedSessionUpdates(t, recording) {
			if update := mapValue(params["update"]); firstString(update, "status") == "completed" {
				done[firstString(update, "toolCallId")] = update
			}
		}
		return done
	}
	type askedCard struct {
		Name  string
		Input interface{}
	}
	asked := func(run cursorRun) []askedCard {
		var cards []askedCard
		for _, card := range run.cards {
			cards = append(cards, askedCard{card.ToolName, card.Input})
		}
		return cards
	}
	t.Run("p8-shell-rejected", func(t *testing.T) {
		// Accept Edits, two commands on Orbit's card: `git log` allowed, `date -u > notes-when.txt` refused.
		const recording = "p8/key-allow-reject/session"
		first, then := cursorTurns(cursorMessage("turn-1", "two commands"), cursorMessage("turn-2", "what happened to step 2"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("acceptEdits"), first: first, then: then,
			approve: deny("date -u")})
		if run.status != stSucceeded || len(run.completions) != 2 || run.completions[0].Status != stSucceeded || run.completions[1].Status != stSucceeded {
			t.Fatalf("run = %s, completions %+v", run.status, run.completions)
		}
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{"0": {cursorAllowOnce}, "1": {cursorRejectOnce}}) {
			t.Fatalf("requests answered %q", answers)
		}
		if got, want := asked(run), []askedCard{{"Bash", map[string]interface{}{"command": "git log --oneline -1"}},
			{"Bash", map[string]interface{}{"command": "date -u > notes-when.txt"}}}; !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
		// What Cursor CLI sent: the allowed command's exit code, stdout and stderr; for the refused one, nothing.
		done := completions(t, recording)
		allowed, refused := done[run.cards[0].ToolUseID], done[run.cards[1].ToolUseID]
		if out := mapValue(allowed["rawOutput"]); len(out) != 3 || out["exitCode"] != float64(0) || out["stdout"] != "3c93801 init sandbox\n" || out["stderr"] != "" {
			t.Fatalf("the allowed command completed with %v", allowed)
		}
		if refused == nil || refused["rawOutput"] != nil || refused["content"] != nil {
			t.Fatalf("the refused command completed with %v, want no output at all", refused)
		}
		want := []cursorSettledCard{
			{"Bash", map[string]interface{}{"command": "git log --oneline -1"}, "3c93801 init sandbox", false},
			{"Bash", map[string]interface{}{"command": "date -u > notes-when.txt"}, notRun, true},
		}
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
			t.Fatalf("turn 1 cards = %+v, want %+v", got, want)
		}
		if uses := run.of("turn-2", evToolUse); len(uses) != 0 || run.completions[1].Result != "Step 1 printed `3c93801 init sandbox`. Step 2 did not run because the command was rejected." {
			t.Fatalf("turn 2: cards %v, result %q", uses, run.completions[1].Result)
		}
	})
	t.Run("p5c-accept-edits-allow-deny", func(t *testing.T) {
		// Accept Edits: two commands and two writes outside the workspace, each on Orbit's card; the "denied" ones refused.
		const recording = "p5c/accept-edits-allow-deny/session"
		first, then := cursorTurns(cursorMessage("turn-1", "four steps"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("acceptEdits"), first: first, then: then,
			approve: deny("denied")})
		if run.status != stSucceeded || len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("run = %s, completions %+v", run.status, run.completions)
		}
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{
			"0": {cursorAllowOnce}, "1": {cursorRejectOnce}, "2": {cursorAllowOnce}, "3": {cursorRejectOnce}}) {
			t.Fatalf("requests answered %q", answers)
		}
		if got, want := asked(run), []askedCard{
			{"Bash", map[string]interface{}{"command": "touch cmd-allowed.txt"}},
			{"Bash", map[string]interface{}{"command": "touch cmd-denied.txt"}},
			{"Write", map[string]interface{}{"file_path": "<OUTSIDE>/edit-allowed.txt", "content": "allowed\n"}},
			{"Write", map[string]interface{}{"file_path": "<OUTSIDE>/edit-denied.txt", "content": "denied\n"}},
		}; !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
		done := completions(t, recording)
		for i, card := range run.cards {
			completed := done[card.ToolUseID]
			if refused := i%2 == 1; completed == nil || refused != (completed["rawOutput"] == nil && completed["content"] == nil) {
				t.Fatalf("card %d (%s) completed with %v", i, card.ToolName, completed)
			}
		}
		want := []cursorSettledCard{
			{"Bash", map[string]interface{}{"command": "touch cmd-allowed.txt"}, "", false},
			{"Bash", map[string]interface{}{"command": "touch cmd-denied.txt"}, notRun, true},
			{"Write", map[string]interface{}{"file_path": "<OUTSIDE>/edit-allowed.txt", "content": "allowed"}, "", false},
			{"Edit", map[string]interface{}{"file_path": "<OUTSIDE>/edit-denied.txt"}, notRun, true},
		}
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
	})
	t.Run("p5c-dont-ask", func(t *testing.T) {
		// Don't Ask refuses the command unasked; the write inside the workspace asks nothing; Orbit's own tool runs.
		const recording = "p5c/dont-ask/session"
		first, then := cursorTurns(cursorMessage("turn-1", "three steps"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("dontAsk"), first: first, then: then,
			approve: func(card cursorTestCard) cursorTestDecision {
				t.Errorf("Don't Ask filed a card: %+v", card)
				return cursorTestDecision{Status: "DENIED"}
			}})
		if run.status != stSucceeded || len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("run = %s, completions %+v", run.status, run.completions)
		}
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{"0": {cursorRejectOnce}, "1": {cursorAllowOnce}}) {
			t.Fatalf("requests answered %q", answers)
		}
		want := []cursorSettledCard{
			{"Bash", map[string]interface{}{"command": "touch dontask-cmd.txt"}, notRun, true},
			{"Write", map[string]interface{}{"file_path": "<RUN>/work/dontask-edit.txt", "content": "edit"}, "", false},
			{"mcp__orbit__task_get", map[string]interface{}{}, "Done. Cursor CLI does not pass an MCP tool's result on to Orbit.", false},
		}
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
		var notes []string
		for _, event := range run.events {
			if event.typ == evSystem && event.payload["subtype"] == "permission_denied" {
				notes = append(notes, asString(event.payload["name"])+": "+asString(event.payload["reason"]))
			}
		}
		if !cursorJSONEqual(t, notes, []string{"Bash: Don't Ask refuses without asking"}) {
			t.Fatalf("permission notes = %q", notes)
		}
	})
	t.Run("mcp-rejected-unchanged", func(t *testing.T) {
		// P0's conversation answered as P0 answered it: the MCP call refused, which Cursor completes with {rejected:true}.
		const recording = "multi-turn-tools-default/turns"
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, first: first, then: then,
			approve: func(card cursorTestCard) cursorTestDecision {
				if card.ToolName == "mcp__p0probe__record" {
					return cursorTestDecision{Status: "DENIED"}
				}
				return cursorTestDecision{Status: "ALLOWED"}
			}})
		var mcp []cursorTestCard
		for _, card := range run.cards {
			if card.ToolName == "mcp__p0probe__record" {
				mcp = append(mcp, card)
			}
		}
		if len(mcp) != 1 {
			t.Fatalf("cards = %+v", run.cards)
		}
		if completed := completions(t, recording)[mcp[0].ToolUseID]; !cursorJSONEqual(t, completed["rawOutput"], map[string]interface{}{"rejected": true}) {
			t.Fatalf("the refused MCP call completed with %v", completed)
		}
		if result := cursorCardResult(run, "turn-1", mcp[0]); result["content"] != notRun || result["isError"] != true {
			t.Fatalf("the refused MCP call settled %v", result)
		}
		// The same completion of a call no answer of Orbit's refused reads the same; an MCP call that ran, as before.
		var events cursorEvents
		m := newCursorEventMapper(events.emitFor)
		m.bind("s")
		if err := m.begin("turn"); err != nil {
			t.Fatal(err)
		}
		for id, output := range map[string]interface{}{"rejected": map[string]interface{}{"rejected": true}, "ran": map[string]interface{}{"success": true}} {
			for _, update := range []map[string]interface{}{
				{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "other", "title": "p0probe: record", "status": "pending",
					"rawInput": map[string]interface{}{"providerIdentifier": "p0probe", "toolName": "record", "args": map[string]interface{}{}}},
				{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"},
				{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed", "rawOutput": output},
			} {
				m.update(map[string]interface{}{"sessionId": "s", "update": update})
			}
		}
		got := map[string]string{}
		for _, event := range events.snapshot() {
			if event.typ == evToolResult {
				got[asString(event.payload["toolUseId"])] = asString(event.payload["content"]) + fmt.Sprintf(" (isError %v)", event.payload["isError"])
			}
		}
		if want := map[string]string{"rejected": notRun + " (isError true)",
			"ran": "Done. Cursor CLI does not pass an MCP tool's result on to Orbit. (isError false)"}; !cursorJSONEqual(t, got, want) {
			t.Fatalf("results = %q, want %q", got, want)
		}
	})
	// settledBy holds the turn to having settled once, the way end ended it (cursorSettlementOutcome).
	settledBy := func(t *testing.T, run cursorRun, end string) {
		t.Helper()
		if len(run.completions) != 1 {
			t.Fatalf("completions = %+v, want the turn settled once", run.completions)
		}
		got := run.completions[0]
		if !map[string]bool{
			"stop":       got.Status == stInterrupted,
			"disconnect": got.Status == stFailed && strings.Contains(got.Error, "exited during this turn"),
			"eof":        got.Status == stFailed && strings.Contains(got.Error, "connection ended during this turn without an answer"),
		}[end] {
			t.Fatalf("the turn ended by %s settled %+v", end, got)
		}
	}
	// overtaken runs a recording's first turn in Accept Edits, each card decided by approve, and ends it once the
	// runner's answer to the CLI's recorded request hold has reached the CLI, before Cursor CLI reports that call:
	// the replay holds there (HoldAfter). end "stop" has Orbit stop the turn, "disconnect" kills the CLI, and "eof"
	// has it close its connection and run on.
	overtaken := func(t *testing.T, recording, hold, end string, approve func(cursorTestCard) cursorTestDecision) cursorRun {
		t.Helper()
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("acceptEdits"), first: first, then: then,
			approve: approve,
			script: func(script *fakeCursorACPScript) {
				script.HoldAfter, script.CancelEndsPrompt = hold, true
				script.Exit = map[string]string{"disconnect": "SIGKILL", "eof": "close-stdout"}[end]
			},
			onAnswer: func(id string) []RunInboxResponse {
				if end == "stop" && id == hold {
					return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
				}
				return nil
			}})
		settledBy(t, run, end)
		return run
	}
	for _, end := range []string{"stop", "disconnect", "eof"} {
		t.Run("p8-refused-then-"+end, func(t *testing.T) {
			// P8's turn as P8 answered it — `git log` allowed, `date -u > notes-when.txt` refused on Orbit's card —
			// over before Cursor CLI completes the refused command.
			run := overtaken(t, "p8/key-allow-reject/session", "1", end, deny("date -u"))
			if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{"0": {cursorAllowOnce}, "1": {cursorRejectOnce}}) {
				t.Fatalf("requests answered %q", answers)
			}
			want := []cursorSettledCard{
				{"Bash", map[string]interface{}{"command": "git log --oneline -1"}, "3c93801 init sandbox", false},
				{"Bash", map[string]interface{}{"command": "date -u > notes-when.txt"}, notRun, true},
			}
			if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
				t.Fatalf("cards = %+v, want %+v", got, want)
			}
		})
	}
	// P5c's turn as P5c answered it, up to the write outside the workspace: the command refused before it is not
	// run, and the write settles as P5c settles a call the turn's end overtook.
	p5cStopped := []cursorSettledCard{
		{"Bash", map[string]interface{}{"command": "touch cmd-allowed.txt"}, "", false},
		{"Bash", map[string]interface{}{"command": "touch cmd-denied.txt"}, notRun, true},
		{"Edit", map[string]interface{}{"file_path": "<OUTSIDE>/edit-allowed.txt"}, cursorUnfinishedTool(stInterrupted), true},
	}
	t.Run("p5c-allowed-then-stop", func(t *testing.T) {
		// The write allowed on Orbit's card, and the turn stopped before Cursor CLI reports it: it may have run.
		run := overtaken(t, "p5c/accept-edits-allow-deny/session", "2", "stop", deny("denied"))
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{
			"0": {cursorAllowOnce}, "1": {cursorRejectOnce}, "2": {cursorAllowOnce}}) {
			t.Fatalf("requests answered %q", answers)
		}
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, p5cStopped) {
			t.Fatalf("cards = %+v, want %+v", got, p5cStopped)
		}
	})
	t.Run("p5c-withdrawn-then-stop", func(t *testing.T) {
		// The turn stopped while the write is still on Orbit's card: the card is withdrawn, and the request answered
		// cancelled once the turn is over — no refusal of Orbit's, but the write did not run either: it settles as not
		// run, stopped before anybody approved it.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/accept-edits-allow-deny/session", agent: cursorInMode("acceptEdits"),
			first: first, then: then,
			script: func(script *fakeCursorACPScript) { script.CancelEndsPrompt = true },
			approve: func(card cursorTestCard) cursorTestDecision {
				if about(card, "edit-allowed") {
					return cursorTestDecision{} // open until the runner stops reading it
				}
				return deny("denied")(card)
			},
			onCard: func(card cursorTestCard) []RunInboxResponse {
				if about(card, "edit-allowed") {
					return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
				}
				return nil
			}})
		settledBy(t, run, "stop")
		if answers := cursorAnswersByRequest(t, run.fake); !cursorJSONEqual(t, answers, map[string][]string{
			"0": {cursorAllowOnce}, "1": {cursorRejectOnce}, "2": {"cancelled"}}) {
			t.Fatalf("requests answered %q", answers)
		}
		if len(run.cards) != 3 || !run.cards[2].released() {
			t.Fatalf("cards = %+v, want the write's card withdrawn", run.cards)
		}
		want := append(append([]cursorSettledCard(nil), p5cStopped[:2]...),
			cursorSettledCard{"Edit", map[string]interface{}{"file_path": "<OUTSIDE>/edit-allowed.txt"}, cursorStoppedBeforeApproval, true})
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
	})
	t.Run("turn-end-rules", func(t *testing.T) {
		// The mapper alone, one turn per way a turn ends: a call the bridge marked refused that Cursor CLI has not
		// completed settles as not run whatever ended the turn; an unmarked one as P5c settles it.
		for _, end := range []struct {
			result map[string]interface{}
			err    error
		}{
			{map[string]interface{}{"stopReason": "end_turn"}, nil},
			{map[string]interface{}{"stopReason": "cancelled"}, nil},
			{map[string]interface{}{"stopReason": "max_tokens"}, nil},
			{nil, errors.New("Cursor CLI exited during this turn (signal: killed) without answering it.")},
		} {
			var events cursorEvents
			m := newCursorEventMapper(events.emitFor)
			m.bind("s")
			if err := m.begin("turn"); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"refused", "unmarked"} {
				for _, update := range []map[string]interface{}{
					{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "`touch " + id + ".txt`", "status": "pending",
						"rawInput": map[string]interface{}{"command": "touch " + id + ".txt"}},
					{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"},
				} {
					m.update(map[string]interface{}{"sessionId": "s", "update": update})
				}
			}
			m.refuse("turn", "refused")
			request, ok := m.settle("turn", end.result, end.err)
			if !ok {
				t.Fatal("the turn did not settle")
			}
			got := map[string]string{}
			for _, event := range events.snapshot() {
				if event.typ == evToolResult {
					got[asString(event.payload["toolUseId"])] = fmt.Sprintf("%s (isError %v)", event.payload["content"], event.payload["isError"])
				}
			}
			if want := map[string]string{"refused": notRun + " (isError true)", "unmarked": cursorUnfinishedTool(request.Status) + " (isError true)"}; !cursorJSONEqual(t, got, want) {
				t.Fatalf("a turn settled %s: results %q, want %q", request.Status, got, want)
			}
		}
	})
	t.Run("rules", func(t *testing.T) {
		// The bridge and the mapper alone, request by request: the card's id names how the person answers.
		rig := newCursorBridgeRig("acceptEdits", func(ctx context.Context, _ string, _ interface{}, id string) (*ApprovalDecisionResponse, error) {
			switch id {
			case "denied", "denied-yet-output":
				return &ApprovalDecisionResponse{Status: "DENIED"}, nil
			case "unfiled":
				return nil, errors.New("the control plane did not take the card")
			case "held":
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return &ApprovalDecisionResponse{Status: "ALLOWED"}, nil
		})
		if err := rig.mapper.begin("turn"); err != nil {
			t.Fatal(err)
		}
		rig.bridge.begin("turn")
		send := func(update map[string]interface{}) {
			rig.mapper.update(map[string]interface{}{"sessionId": "s", "update": update})
		}
		request := 0
		// ask opens a command's card and asks for it, as Cursor CLI does, offering the options given (Cursor's own
		// three when none), and returns what the request was answered once the answer is out.
		ask := func(id string, options ...[3]string) []string {
			command := "touch " + id + ".txt"
			send(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "`" + command + "`",
				"status": "pending", "rawInput": map[string]interface{}{"command": command}})
			send(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"})
			request++
			rig.bridge.permission(request, cursorPermissionParams(map[string]interface{}{"toolCallId": id, "title": "`" + command + "`",
				"kind": "execute", "status": "pending"}, options...))
			if id == "held" {
				return nil
			}
			return rig.answered(fmt.Sprint(request))
		}
		complete := func(id string, output interface{}) {
			update := map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed"}
			if output != nil {
				update["rawOutput"] = output
			}
			send(update)
		}
		answers := map[string][]string{
			"denied":            ask("denied"),
			"denied-yet-output": ask("denied-yet-output"),
			"unfiled":           ask("unfiled"),
			"unknown-options":   ask("unknown-options", [3]string{"allow-once", "Allow once", "allow_once"}),
			"allowed":           ask("allowed"),
			"allowed-silent":    ask("allowed-silent"),
		}
		// A person refused it, and Cursor CLI completes it with nothing at all.
		complete("denied", nil)
		// Refused, though a replay streams output for it: Orbit's refusal decides.
		complete("denied-yet-output", map[string]interface{}{"exitCode": float64(0), "stdout": "ran\n", "stderr": ""})
		// The card could not be filed, so nobody decided: answered cancelled while the turn runs, which Cursor CLI
		// takes as a refusal — and so are options Orbit does not know.
		complete("unfiled", nil)
		complete("unknown-options", nil)
		// Allowed: what Cursor reported, as before — a command that printed nothing says nothing.
		complete("allowed", map[string]interface{}{"exitCode": float64(0), "stdout": "done\n", "stderr": ""})
		complete("allowed-silent", nil)
		// Still on the card when the turn is stopped: withdrawn, answered cancelled, and not run — the turn was
		// stopped before anybody approved it.
		ask("held")
		rig.bridge.close()
		answers["held"] = rig.answered(fmt.Sprint(request))
		if _, ok := rig.mapper.settle("turn", map[string]interface{}{"stopReason": "cancelled"}, nil); !ok {
			t.Fatal("the turn did not settle")
		}
		if want := map[string][]string{"denied": {cursorRejectOnce}, "denied-yet-output": {cursorRejectOnce}, "unfiled": {"cancelled"},
			"unknown-options": {"cancelled"}, "allowed": {cursorAllowOnce}, "allowed-silent": {cursorAllowOnce}, "held": {"cancelled"}}; !cursorJSONEqual(t, answers, want) {
			t.Fatalf("answers = %q, want %q", answers, want)
		}
		got := map[string]string{}
		for _, event := range rig.events.snapshot() {
			if event.typ == evToolResult {
				got[asString(event.payload["toolUseId"])] = fmt.Sprintf("%s (isError %v)", event.payload["content"], event.payload["isError"])
			}
		}
		want := map[string]string{
			"denied":            notRun + " (isError true)",
			"denied-yet-output": notRun + " (isError true)",
			"unfiled":           notRun + " (isError true)",
			"unknown-options":   notRun + " (isError true)",
			"allowed":           "done (isError false)",
			"allowed-silent":    " (isError false)",
			"held":              cursorStoppedBeforeApproval + " (isError true)",
		}
		if !cursorJSONEqual(t, got, want) {
			t.Fatalf("results:\n%q\nwant:\n%q", got, want)
		}
	})
}

// What a call settles with whose approval card the turn's end withdrew before anybody answered it
// (cursorWithdrawnTool): the turn stopped by Orbit, or ended any other way.
const (
	cursorStoppedBeforeApproval = "Not run: the turn was stopped before this tool call was approved."
	cursorEndedBeforeApproval   = "Not run: the turn ended before this tool call was approved."
)

// cursorRecordedCheck is whether the run P5c recorded passed the check it names (summary.json): what the real
// CLI did, which a replay cannot show.
func cursorRecordedCheck(t *testing.T, scenario, name string) bool {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "cursor", "p5c", scenario, "summary.json"))
	if err != nil {
		t.Fatal(err)
	}
	var summary struct {
		Checks []struct {
			Name string `json:"name"`
			Pass bool   `json:"pass"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}
	for _, check := range summary.Checks {
		if check.Name == name {
			return check.Pass
		}
	}
	t.Fatalf("p5c/%s/summary.json has no check %q", scenario, name)
	return false
}

// TestCursorWithdrawnApprovals holds the transcript to what happened to a call whose approval card nobody had
// answered when its turn ended: the card is withdrawn and the request answered cancelled, which Cursor CLI takes
// as a refusal, so the call did not run — as P5c measured on the real CLI (accept-edits-stop,
// accept-edits-disconnect: the command never ran). It settles isError:true as not run, saying whether Orbit
// stopped the turn or it ended another way. The bridge marks the card as it withdraws it, so the mark is in
// place before the turn settles, however soon that is; a card answered before the withdrawal is not marked,
// and settles as before.
func TestCursorWithdrawnApprovals(t *testing.T) {
	const rejected = "Not run: the tool call was rejected."
	// endWithCardOpen runs a P5c recording's turn in Accept Edits, its one card held open, and once the card is
	// filed ends the turn the way end says: "stop" has Orbit stop it; "disconnect" kills the CLI, as P5c's
	// recording did; "process-exit" has the CLI exit by itself; "eof" has it close its connection and run on.
	endWithCardOpen := func(t *testing.T, scenario, end string) {
		t.Helper()
		recording := "p5c/" + scenario + "/session"
		var fake *cursorReplay
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: recording, agent: cursorInMode("acceptEdits"), first: first, then: then,
			script:  func(script *fakeCursorACPScript) { script.CancelEndsPrompt = true },
			replay:  func(f *cursorReplay) { fake = f },
			approve: func(cursorTestCard) cursorTestDecision { return cursorTestDecision{} }, // open until the runner stops reading it
			onCard: func(cursorTestCard) []RunInboxResponse {
				switch end {
				case "stop":
					return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
				case "disconnect":
					go cursorSignalReplay(t, fake, syscall.SIGKILL)
				case "process-exit":
					go cursorSignalReplay(t, fake, syscall.SIGTERM)
				case "eof":
					go cursorSignalReplay(t, fake, syscall.SIGUSR1)
				}
				return nil
			}})
		if len(run.completions) != 1 {
			t.Fatalf("completions = %+v, want the turn settled once", run.completions)
		}
		if got := run.completions[0]; !map[string]bool{
			"stop":         got.Status == stInterrupted,
			"disconnect":   got.Status == stFailed && strings.Contains(got.Error, "exited during this turn (signal: killed)"),
			"process-exit": got.Status == stFailed && strings.Contains(got.Error, "exited during this turn (exit status 143)"),
			"eof":          got.Status == stFailed && strings.Contains(got.Error, "connection ended during this turn without an answer"),
		}[end] {
			t.Fatalf("the turn ended by %s settled %+v", end, got)
		}
		if len(run.cards) != 1 || !run.cards[0].released() {
			t.Fatalf("cards = %+v, want the one card withdrawn", run.cards)
		}
		// No allow ever reached the CLI: after a stop, the cancelled the withdrawal answers, once; otherwise nothing
		// but that, the CLI being gone.
		answers := cursorAnswersByRequest(t, run.fake)
		if end == "stop" {
			cancels := 0
			for _, line := range run.fake.received(t) {
				if line.Message["method"] == "session/cancel" {
					cancels++
				}
			}
			if !cursorJSONEqual(t, answers, map[string][]string{"0": {"cancelled"}}) || cancels != 1 {
				t.Fatalf("requests answered %q, %d session/cancel: want the request answered cancelled and one cancel", answers, cancels)
			}
		} else if len(answers) > 1 || len(answers["0"]) > 1 || (len(answers["0"]) == 1 && answers["0"][0] != "cancelled") {
			t.Fatalf("requests answered %q after the CLI went away", answers)
		}
		// The CLI never completed the call, and the run P5c recorded found it did not run.
		for _, params := range recordedSessionUpdates(t, recording) {
			if update := mapValue(params["update"]); firstString(update, "toolCallId") == run.cards[0].ToolUseID && firstString(update, "status") == "completed" {
				t.Fatalf("the recording completes the withdrawn call: %v", update)
			}
		}
		if !cursorRecordedCheck(t, scenario, "command-did-not-run") {
			t.Fatalf("P5c's %s run did not find the command unrun", scenario)
		}
		text := cursorEndedBeforeApproval
		if end == "stop" {
			text = cursorStoppedBeforeApproval
		}
		command := map[string]string{"accept-edits-stop": "touch stopped.txt", "accept-edits-disconnect": "touch disconnected.txt"}[scenario]
		want := []cursorSettledCard{{"Bash", map[string]interface{}{"command": command}, text, true}}
		if got := cursorSettledCards(t, run, "turn-1"); !cursorJSONEqual(t, got, want) {
			t.Fatalf("cards = %+v, want %+v", got, want)
		}
	}
	t.Run("accept-edits-stop", func(t *testing.T) { endWithCardOpen(t, "accept-edits-stop", "stop") })
	t.Run("accept-edits-disconnect", func(t *testing.T) { endWithCardOpen(t, "accept-edits-disconnect", "disconnect") })
	// The other ways the CLI can go away with the card open: it exits by itself (SIGTERM, which the pinned CLI
	// exits 143 on, §3.4), or closes its connection and runs on (EOF).
	t.Run("process-exit", func(t *testing.T) { endWithCardOpen(t, "accept-edits-disconnect", "process-exit") })
	t.Run("eof", func(t *testing.T) { endWithCardOpen(t, "accept-edits-disconnect", "eof") })
	t.Run("turn-end-rules", func(t *testing.T) {
		// The mapper alone, one turn per way a turn ends: a call whose card was withdrawn settles as not run, saying
		// whether the turn was stopped — also when Cursor CLI, taking the cancelled answer as a refusal, completes it
		// with nothing before the turn settles. A refused call settles as Orbit's refusal, an unmarked one as P5c
		// settles it.
		for _, end := range []struct {
			result    map[string]interface{}
			err       error
			withdrawn string
		}{
			{map[string]interface{}{"stopReason": "end_turn"}, nil, cursorEndedBeforeApproval},
			{map[string]interface{}{"stopReason": "cancelled"}, nil, cursorStoppedBeforeApproval},
			{map[string]interface{}{"stopReason": "max_tokens"}, nil, cursorEndedBeforeApproval},
			{nil, errors.New("Cursor CLI exited during this turn (signal: killed) without answering it."), cursorEndedBeforeApproval},
			{nil, errors.New("Cursor CLI's connection ended during this turn without an answer, while the process kept running (EOF)."), cursorEndedBeforeApproval},
		} {
			var events cursorEvents
			m := newCursorEventMapper(events.emitFor)
			m.bind("s")
			if err := m.begin("turn"); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"withdrawn", "withdrawn-completed", "refused", "unmarked"} {
				for _, update := range []map[string]interface{}{
					{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "`touch " + id + ".txt`", "status": "pending",
						"rawInput": map[string]interface{}{"command": "touch " + id + ".txt"}},
					{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"},
				} {
					m.update(map[string]interface{}{"sessionId": "s", "update": update})
				}
			}
			m.withdraw("turn", "withdrawn")
			m.withdraw("turn", "withdrawn-completed")
			m.refuse("turn", "refused")
			m.update(map[string]interface{}{"sessionId": "s", "update": map[string]interface{}{"sessionUpdate": "tool_call_update",
				"toolCallId": "withdrawn-completed", "status": "completed"}})
			request, ok := m.settle("turn", end.result, end.err)
			if !ok {
				t.Fatal("the turn did not settle")
			}
			got := map[string][]string{}
			for _, event := range events.snapshot() {
				if event.typ == evToolResult {
					id := asString(event.payload["toolUseId"])
					got[id] = append(got[id], fmt.Sprintf("%s (isError %v)", event.payload["content"], event.payload["isError"]))
				}
			}
			want := map[string][]string{
				"withdrawn":           {end.withdrawn + " (isError true)"},
				"withdrawn-completed": {end.withdrawn + " (isError true)"},
				"refused":             {rejected + " (isError true)"},
				"unmarked":            {cursorUnfinishedTool(request.Status) + " (isError true)"},
			}
			if !cursorJSONEqual(t, got, want) {
				t.Fatalf("a turn settled %s: results %q, want %q", request.Status, got, want)
			}
		}
	})
	t.Run("marked-before-settle", func(t *testing.T) {
		// The bridge and the mapper alone, the turn stopped with one card still open: the withdrawal marks it, so the
		// turn settles it as not run although the request's answer has not gone out yet — here it cannot until the
		// turn has settled — and that answer, when it goes, is cancelled. Cards answered before the stop are not
		// marked by it: the allowed one settles as P5c settles a call the turn cut short, the refused one as refused.
		release := make(chan struct{})
		rig := newCursorBridgeRig("acceptEdits", func(ctx context.Context, _ string, _ interface{}, id string) (*ApprovalDecisionResponse, error) {
			switch id {
			case "held":
				<-ctx.Done()
				<-release
				return nil, ctx.Err()
			case "denied":
				return &ApprovalDecisionResponse{Status: "DENIED"}, nil
			}
			return &ApprovalDecisionResponse{Status: "ALLOWED"}, nil
		})
		if err := rig.mapper.begin("turn"); err != nil {
			t.Fatal(err)
		}
		rig.bridge.begin("turn")
		ask := func(request int, id string) {
			command := "touch " + id + ".txt"
			for _, update := range []map[string]interface{}{
				{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "`" + command + "`", "status": "pending",
					"rawInput": map[string]interface{}{"command": command}},
				{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"},
			} {
				rig.mapper.update(map[string]interface{}{"sessionId": "s", "update": update})
			}
			rig.bridge.permission(request, cursorPermissionParams(map[string]interface{}{"toolCallId": id, "title": "`" + command + "`",
				"kind": "execute", "status": "pending"}))
		}
		ask(1, "allowed")
		ask(2, "denied")
		answers := map[string][]string{"allowed": rig.answered("1"), "denied": rig.answered("2")}
		ask(3, "held")
		rig.bridge.close()
		request, ok := rig.mapper.settle("turn", map[string]interface{}{"stopReason": "cancelled"}, nil)
		if !ok || request.Status != stInterrupted {
			t.Fatalf("the turn settled %+v (%v), want interrupted", request, ok)
		}
		rig.mu.Lock()
		early := len(rig.answers["3"])
		rig.mu.Unlock()
		if early != 0 {
			t.Fatalf("the withdrawn request was answered before the turn settled")
		}
		close(release)
		answers["held"] = rig.answered("3")
		if want := map[string][]string{"allowed": {cursorAllowOnce}, "denied": {cursorRejectOnce}, "held": {"cancelled"}}; !cursorJSONEqual(t, answers, want) {
			t.Fatalf("answers = %q, want %q", answers, want)
		}
		got := map[string]string{}
		for _, event := range rig.events.snapshot() {
			if event.typ == evToolResult {
				got[asString(event.payload["toolUseId"])] = fmt.Sprintf("%s (isError %v)", event.payload["content"], event.payload["isError"])
			}
		}
		want := map[string]string{
			"allowed": cursorUnfinishedTool(stInterrupted) + " (isError true)",
			"denied":  rejected + " (isError true)",
			"held":    cursorStoppedBeforeApproval + " (isError true)",
		}
		if !cursorJSONEqual(t, got, want) {
			t.Fatalf("results:\n%q\nwant:\n%q", got, want)
		}
	})
	t.Run("asked-after-the-stop", func(t *testing.T) {
		// The bridge and the mapper alone: a request that comes once the stop has closed the bridge, before the turn
		// settles — Cursor CLI asked as the stop went out — is answered cancelled with nobody asked, and its call
		// settles as one whose card was withdrawn; so does one the bridge closed under while it was being answered
		// (now) or put on a card (later).
		rig := newCursorBridgeRig("acceptEdits", func(context.Context, string, interface{}, string) (*ApprovalDecisionResponse, error) {
			t.Error("a card was filed after the stop")
			return nil, errors.New("closed")
		})
		if err := rig.mapper.begin("turn"); err != nil {
			t.Fatal(err)
		}
		rig.bridge.begin("turn")
		for _, id := range []string{"asked", "answered", "carded"} {
			command := "touch " + id + ".txt"
			for _, update := range []map[string]interface{}{
				{"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "`" + command + "`", "status": "pending",
					"rawInput": map[string]interface{}{"command": command}},
				{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"},
			} {
				rig.mapper.update(map[string]interface{}{"sessionId": "s", "update": update})
			}
		}
		rig.bridge.close()
		rig.bridge.permission(1, cursorPermissionParams(map[string]interface{}{"toolCallId": "asked", "title": "`touch asked.txt`",
			"kind": "execute", "status": "pending"}))
		rig.bridge.now(2, "answered", cursorSelected(cursorAllowOnce))
		rig.bridge.later(3, "carded", func(context.Context) map[string]interface{} { return cursorSelected(cursorAllowOnce) })
		answers := map[string][]string{}
		for _, id := range []string{"1", "2", "3"} {
			answers[id] = rig.answered(id)
		}
		if want := map[string][]string{"1": {"cancelled"}, "2": {"cancelled"}, "3": {"cancelled"}}; !cursorJSONEqual(t, answers, want) {
			t.Fatalf("answers = %q, want %q", answers, want)
		}
		if _, ok := rig.mapper.settle("turn", map[string]interface{}{"stopReason": "cancelled"}, nil); !ok {
			t.Fatal("the turn did not settle")
		}
		got := map[string]string{}
		for _, event := range rig.events.snapshot() {
			if event.typ == evToolResult {
				got[asString(event.payload["toolUseId"])] = fmt.Sprintf("%s (isError %v)", event.payload["content"], event.payload["isError"])
			}
		}
		notRun := cursorStoppedBeforeApproval + " (isError true)"
		if want := map[string]string{"asked": notRun, "answered": notRun, "carded": notRun}; !cursorJSONEqual(t, got, want) {
			t.Fatalf("results:\n%q\nwant:\n%q", got, want)
		}
	})
}

// cursorBridgeRig drives a permission bridge directly, recording every answer and card, and what its mapper
// put out.
type cursorBridgeRig struct {
	mu      sync.Mutex
	answers map[string][]map[string]interface{}
	cards   []string
	notes   []map[string]interface{}
	events  cursorEvents
	bridge  *cursorPermissionBridge
	mapper  *cursorEventMapper
}

func newCursorBridgeRig(mode string, card cursorApprovalCard) *cursorBridgeRig {
	rig := &cursorBridgeRig{answers: map[string][]map[string]interface{}{}}
	rig.mapper = newCursorEventMapper(rig.events.emitFor)
	rig.mapper.bind("s")
	if card == nil {
		card = func(context.Context, string, interface{}, string) (*ApprovalDecisionResponse, error) {
			return &ApprovalDecisionResponse{Status: "ALLOWED"}, nil
		}
	}
	wrapped := func(ctx context.Context, name string, input interface{}, id string) (*ApprovalDecisionResponse, error) {
		rig.mu.Lock()
		rig.cards = append(rig.cards, name+" "+id)
		rig.mu.Unlock()
		return card(ctx, name, input, id)
	}
	policy, _ := cursorPermissionPolicyFor(mode)
	rig.bridge = newCursorPermissionBridge(policy, rig.mapper.permissionAsk, rig.mapper.refuse, rig.mapper.withdraw, func(ask cursorPermissionAsk) bool {
		return cursorPreApproved(AgentExecConfig{AllowedTools: []string{"mcp__orbit__*"}}, ask)
	}, wrapped, func(_ string, typ string, payload map[string]interface{}) {
		rig.mu.Lock()
		rig.notes = append(rig.notes, payload)
		rig.mu.Unlock()
	}, "/work")
	rig.bridge.reply = func(id interface{}, result map[string]interface{}) {
		rig.mu.Lock()
		rig.answers[rpcIDKey(id)] = append(rig.answers[rpcIDKey(id)], result)
		rig.mu.Unlock()
	}
	return rig
}

func (rig *cursorBridgeRig) answered(id string) []string {
	rig.bridge.wait()
	rig.mu.Lock()
	defer rig.mu.Unlock()
	var out []string
	for _, result := range rig.answers[id] {
		outcome := mapValue(result["outcome"])
		out = append(out, firstNonEmpty(firstString(outcome, "optionId"), firstString(outcome, "outcome")))
	}
	return out
}

func cursorPermissionParams(toolCall map[string]interface{}, options ...[3]string) map[string]interface{} {
	if len(options) == 0 {
		options = [][3]string{{"allow-once", "Allow once", "allow_once"}, {"allow-always", "Allow always", "allow_always"}, {"reject-once", "Reject", "reject_once"}}
	}
	var rows []interface{}
	for _, o := range options {
		rows = append(rows, map[string]interface{}{"optionId": o[0], "name": o[1], "kind": o[2]})
	}
	return map[string]interface{}{"sessionId": "s", "toolCall": toolCall, "options": rows}
}

// TestCursorPermissionBridge holds the bridge to its own rules, request by request.
func TestCursorPermissionBridge(t *testing.T) {
	shell := func(id, command string) map[string]interface{} {
		return map[string]interface{}{"toolCallId": id, "title": "`" + command + "`", "kind": "execute", "status": "pending",
			"content": []interface{}{map[string]interface{}{"type": "content", "content": map[string]interface{}{"type": "text", "text": "Not in allowlist: touch"}}}}
	}
	t.Run("unknown-options-never-allowed", func(t *testing.T) {
		for name, options := range map[string][][3]string{
			// The fallback for an unanswered question offers each answer as an allow_once (6136.index.js@46614).
			"question-fallback": {{"opt-red", "Red", "allow_once"}, {"opt-blue", "Blue", "allow_once"}, {"__ask_question_skip__", "Skip", "reject_once"}},
			"no-allow-once":     {{"allow-always", "Allow always", "allow_always"}, {"reject-once", "Reject", "reject_once"}},
			"no-reject-once":    {{"allow-once", "Allow once", "allow_once"}},
			"kind-mismatch":     {{"allow-once", "Allow once", "reject_once"}, {"reject-once", "Reject", "allow_once"}},
			"one-more-option":   {{"allow-once", "Allow once", "allow_once"}, {"reject-once", "Reject", "reject_once"}, {"allow-forever", "Allow forever", "allow_always"}},
		} {
			rig := newCursorBridgeRig("acceptEdits", nil)
			if err := rig.mapper.begin("turn"); err != nil {
				t.Fatal(err)
			}
			rig.bridge.begin("turn")
			rig.bridge.permission(1, cursorPermissionParams(shell("c1", "touch x"), options...))
			if got := rig.answered("1"); !cursorJSONEqual(t, got, []string{"cancelled"}) || len(rig.cards) != 0 {
				t.Errorf("%s: answered %q with cards %q, want cancelled and no card", name, got, rig.cards)
			}
		}
		// The options Cursor CLI offers are the ones a person's answer is given in.
		rig := newCursorBridgeRig("acceptEdits", nil)
		_ = rig.mapper.begin("turn")
		rig.bridge.begin("turn")
		rig.bridge.permission(1, cursorPermissionParams(shell("c1", "touch x")))
		if got := rig.answered("1"); !cursorJSONEqual(t, got, []string{cursorAllowOnce}) || len(rig.cards) != 1 {
			t.Errorf("known options: answered %q with cards %q", got, rig.cards)
		}
	})
	t.Run("late-answer-has-no-effect", func(t *testing.T) {
		// The person's answer arrives just after the stop: it reaches nothing, and the request is answered
		// cancelled, once.
		release := make(chan struct{})
		rig := newCursorBridgeRig("acceptEdits", func(ctx context.Context, _ string, _ interface{}, _ string) (*ApprovalDecisionResponse, error) {
			<-release
			return &ApprovalDecisionResponse{Status: "ALLOWED"}, nil
		})
		_ = rig.mapper.begin("turn")
		rig.bridge.begin("turn")
		rig.bridge.permission(7, cursorPermissionParams(shell("c7", "touch late.txt")))
		rig.bridge.close()
		close(release)
		if got := rig.answered("7"); !cursorJSONEqual(t, got, []string{"cancelled"}) {
			t.Fatalf("answered %q, want cancelled once", got)
		}
	})
	t.Run("request-outside-a-turn", func(t *testing.T) {
		rig := newCursorBridgeRig("bypassPermissions", nil)
		rig.bridge.permission(1, cursorPermissionParams(shell("c1", "touch x")))
		rig.bridge.question(2, map[string]interface{}{"questions": []interface{}{}})
		rig.bridge.plan(3, map[string]interface{}{"plan": "# plan"})
		rig.bridge.begin("turn")
		rig.bridge.close()
		rig.bridge.permission(4, cursorPermissionParams(shell("c4", "touch y")))
		for _, id := range []string{"1", "2", "3", "4"} {
			if got := rig.answered(id); !cursorJSONEqual(t, got, []string{"cancelled"}) {
				t.Errorf("request %s answered %q with no turn open", id, got)
			}
		}
		if len(rig.cards) != 0 {
			t.Errorf("cards filed with no turn open: %q", rig.cards)
		}
	})
	t.Run("web-fetch-matched-to-its-card", func(t *testing.T) {
		// A fetch's request carries an id of its own (web_fetch_<n>, §5.2): the card it is about is the
		// running turn's open fetch card for the same URL, claimed once.
		rig := newCursorBridgeRig("acceptEdits", nil)
		_ = rig.mapper.begin("turn")
		send := func(update map[string]interface{}) {
			rig.mapper.update(map[string]interface{}{"sessionId": "s", "update": update})
		}
		send(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": "card-fetch", "kind": "fetch", "title": "Web Fetch", "status": "pending", "rawInput": map[string]interface{}{}})
		send(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": "card-fetch", "title": "Web Fetch: https://example.com/", "rawInput": map[string]interface{}{"url": "https://example.com/"}})
		send(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": "card-fetch", "status": "in_progress"})
		rig.bridge.begin("turn")
		fetch := func(id, url string) map[string]interface{} {
			return map[string]interface{}{"toolCallId": id, "title": "Fetch " + url, "kind": "fetch", "status": "pending"}
		}
		rig.bridge.permission(1, cursorPermissionParams(fetch("web_fetch_0", "https://example.com/")))
		rig.bridge.permission(2, cursorPermissionParams(fetch("web_fetch_1", "https://example.com/")))
		rig.bridge.permission(3, cursorPermissionParams(fetch("web_fetch_2", "https://other.example/")))
		rig.bridge.wait()
		// Each card is filed on a goroutine of its own: in no particular order.
		sort.Strings(rig.cards)
		want := []string{"WebFetch card-fetch", "WebFetch turn/web_fetch_1", "WebFetch turn/web_fetch_2"}
		if !cursorJSONEqual(t, rig.cards, want) {
			t.Fatalf("cards = %q, want %q", rig.cards, want)
		}
	})
	t.Run("auto-classifier", func(t *testing.T) {
		const work = "/srv/work"
		for command, routine := range map[string]bool{
			"touch auto.txt":                    true,
			"echo shell-ok > probe-shell.txt":   true,
			"mkdir -p build && go test ./...":   true,
			"git status --short":                true,
			"git add -A && git commit -m 'wip'": true,
			"git push origin main":              false,
			"curl -X POST https://example.com":  false,
			"npm install left-pad":              false,
			"rm -rf build":                      false,
			"cat /etc/passwd":                   false,
			"cat ~/.ssh/id_rsa":                 false,
			"python3 -c 'print(1)'":             false,
			"docker run --rm alpine true":       false,
			"sudo true":                         false,
			"cp out.txt ../elsewhere.txt":       false,
		} {
			if got := cursorAutoAllows(command, work); got != routine {
				t.Errorf("cursorAutoAllows(%q) = %v, want %v", command, got, routine)
			}
		}
		if cursorAutoAllows("touch x", "relative/work") || cursorAutoAllows("   ", work) {
			t.Error("Auto allowed a command it cannot place")
		}
	})
}

// TestCursorOrbitMCP: Orbit's MCP server in every Cursor CLI conversation, with the session's identity.
func TestCursorOrbitMCP(t *testing.T) {
	t.Run("injected-with-session-identity", func(t *testing.T) {
		job := &ClaimedSession{SessionID: cursorTestSessionID, AgentID: "21111111-2222-4333-8444-666666666666",
			TaskID: "71111111-2222-4333-8444-777777777777", SpawnDepth: 1}
		servers, err := cursorMCPServers(job)
		if err != nil {
			t.Fatal(err)
		}
		orbit := mapValue(servers[0])
		env := map[string]string{}
		for _, row := range orbit["env"].([]map[string]string) {
			env[row["name"]] = row["value"]
		}
		self, _ := os.Executable()
		if firstString(orbit, "name") != "orbit" || firstString(orbit, "command") != self || !cursorJSONEqual(t, orbit["args"], []string{"mcp"}) {
			t.Fatalf("orbit server = %v", orbit)
		}
		for key, want := range map[string]string{"ORBIT_SESSION_ID": publicID(job.SessionID), "ORBIT_AGENT_ID": publicID(job.AgentID),
			"ORBIT_TASK_ID": publicID(job.TaskID), envMCPPermissionPrompt: "0", envSpawnDepth: "1", envMCPCallTimeout: "60", envRunnerChild: "1",
			"ORBIT_HOME": machineHome()} {
			if env[key] != want {
				t.Errorf("orbit mcp %s = %q, want %q", key, env[key], want)
			}
		}
		// On session/new and on every session/load (a process keeps no MCP connection, §6).
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/mcp-orbit/session", agent: cursorOrbitTools, first: first, then: then})
		params := mapValue(run.fake.requests(t, "session/new")[0].Message["params"])
		want, _ := cursorMCPServers(run.job)
		if !cursorJSONEqual(t, params["mcpServers"], want) {
			t.Fatalf("session/new mcpServers = %v", params["mcpServers"])
		}
		load := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/load", runtimeSessionID: "<UUID_8>",
			first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
		if servers := mapValue(load.fake.requests(t, "session/load")[0].Message["params"])["mcpServers"].([]interface{}); firstString(mapValue(servers[0]), "name") != "orbit" {
			t.Fatalf("session/load mcpServers = %v", servers)
		}
	})
	t.Run("recorded-call", func(t *testing.T) {
		// The runner on the real CLI, calling Orbit's task_get (P5c): allowed unasked, shown as Orbit's tool,
		// its result said for what ACP carries of it.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/mcp-orbit/session", agent: cursorOrbitTools, first: first, then: then})
		if len(run.cards) != 0 {
			t.Fatalf("Orbit's own tool went to a card: %+v", run.cards)
		}
		for id, given := range cursorAnswersByRequest(t, run.fake) {
			if !cursorJSONEqual(t, given, []string{cursorAllowOnce}) {
				t.Errorf("request %s answered %q", id, given)
			}
		}
		var uses, results []string
		for _, use := range run.of("turn-1", evToolUse) {
			uses = append(uses, asString(use["name"]))
		}
		for _, result := range run.of("turn-1", evToolResult) {
			results = append(results, asString(result["content"]))
		}
		if !cursorJSONEqual(t, uses, []string{"mcp__orbit__task_get"}) || !cursorJSONEqual(t, results, []string{"Done. Cursor CLI does not pass an MCP tool's result on to Orbit."}) {
			t.Fatalf("cards %q, results %q", uses, results)
		}
		if len(run.completions) != 1 || !strings.Contains(run.completions[0].Result, "P5c probe task") {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("agent-servers", func(t *testing.T) {
		mount := func(config map[string]interface{}) ([]interface{}, error) {
			return cursorMCPServers(&ClaimedSession{SessionID: cursorTestSessionID, Agent: AgentExecConfig{McpConfig: config}})
		}
		servers, err := mount(map[string]interface{}{
			"docs":  map[string]interface{}{"command": "/usr/bin/docs-mcp", "args": []interface{}{"--stdio"}, "env": map[string]interface{}{"DOCS_TOKEN": "x"}},
			"orbit": map[string]interface{}{"command": "/tmp/not-orbit"},
		})
		if err != nil || len(servers) != 2 || firstString(mapValue(servers[1]), "name") != "docs" ||
			!cursorJSONEqual(t, mapValue(servers[1])["env"], []map[string]string{{"name": "DOCS_TOKEN", "value": "x"}}) {
			t.Fatalf("servers = %v, %v", servers, err)
		}
		for name, config := range map[string]map[string]interface{}{
			"CURSOR_MCP_UNSUPPORTED": {"remote": map[string]interface{}{"url": "https://mcp.example/sse", "type": "sse"}},
			"CURSOR_MCP_INVALID":     {"relative": map[string]interface{}{"command": "docs-mcp"}},
		} {
			if _, err := mount(config); err == nil || !strings.HasPrefix(err.Error(), name) {
				t.Errorf("%v: err = %v, want %s", config, err, name)
			}
		}
		for _, config := range []map[string]interface{}{
			{"orbit__x": map[string]interface{}{"command": "/usr/bin/x"}},
			{"bad name": map[string]interface{}{"command": "/usr/bin/x"}},
			{"docs": map[string]interface{}{"command": "/usr/bin/x", "env": map[string]interface{}{"ORBIT_SESSION_ID": "other"}}},
			{"docs": map[string]interface{}{"command": "/usr/bin/x", "args": []interface{}{1}}},
		} {
			if _, err := mount(config); err == nil || !strings.HasPrefix(err.Error(), "CURSOR_MCP_INVALID") {
				t.Errorf("%v: err = %v, want CURSOR_MCP_INVALID", config, err)
			}
		}
	})
}

// TestCursorAllowAlways: a person's "always allow" is answered once — Cursor CLI's own allow-always would
// allowlist the whole program — and nothing the CLI could keep of one is anywhere but the session's own
// directory, which Orbit puts back to the CLI's default allowlist every time a process starts.
func TestCursorAllowAlways(t *testing.T) {
	always := func(cursorTestCard) cursorTestDecision {
		return cursorTestDecision{Status: "ALLOWED", RememberRules: []PermissionRule{{ToolName: "Bash", RuleContent: "echo:*"}}}
	}
	t.Run("answered-once", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", agent: cursorInMode("acceptEdits"),
			approve: always, first: first, then: then})
		for id, given := range cursorAnswersByRequest(t, run.fake) {
			if !cursorJSONEqual(t, given, []string{cursorAllowOnce}) {
				t.Errorf("request %s answered %q, want allow-once", id, given)
			}
		}
	})
	t.Run("recorded", func(t *testing.T) {
		// The runner on the real CLI (P5c): the second echo asked again, the session's allowlist unchanged.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/allow-always/session", agent: cursorInMode("acceptEdits"),
			approve: always, first: first, then: then})
		var commands []string
		for _, card := range run.cards {
			commands = append(commands, firstString(mapValue(card.Input), "command"))
		}
		if !cursorJSONEqual(t, commands, []string{"echo first > always-1.txt", "echo second > always-2.txt"}) {
			t.Fatalf("cards = %q", commands)
		}
		for id, given := range cursorAnswersByRequest(t, run.fake) {
			if !cursorJSONEqual(t, given, []string{cursorAllowOnce}) {
				t.Errorf("request %s answered %q, want allow-once", id, given)
			}
		}
		var summary struct {
			Checks []realCheckRecord `json:"checks"`
		}
		data, err := os.ReadFile(filepath.Join("testdata", "cursor", "p5c", "allow-always", "summary.json"))
		if err != nil || json.Unmarshal(data, &summary) != nil {
			t.Fatalf("summary: %v", err)
		}
		for _, check := range summary.Checks {
			if !check.Pass {
				t.Errorf("the real run's check %s failed: %s", check.Name, check.Detail)
			}
		}
	})
	t.Run("landing", func(t *testing.T) {
		useCursorRealHome(t)
		execDir := t.TempDir()
		job := &ClaimedSession{SessionID: cursorTestSessionID, Agent: AgentExecConfig{PermissionMode: "acceptEdits", Env: map[string]string{"CURSOR_API_KEY": cursorTestKey}}}
		dir := filepath.Join(runDir(job.SessionID), "cursor")
		spec, err := prepareCursorLaunch(job, execDir, "/opt/cursor/cursor-agent", dir)
		if err != nil {
			t.Fatal(err)
		}
		// Everything the CLI keeps — allow-always rules included (§5.2) — is the session's own.
		for _, path := range []string{spec.ConfigDir, spec.DataDir, spec.Home} {
			if !strings.HasPrefix(path, dir+string(filepath.Separator)) || strings.HasPrefix(path, execDir) || strings.HasPrefix(path, filepath.Join(userHome(), ".cursor")) {
				t.Errorf("%s is not the session's own directory", path)
			}
		}
		// A rule nobody gave Orbit is gone the next time a process starts.
		config := filepath.Join(spec.ConfigDir, "cli-config.json")
		widened := `{"version":1,"channel":"static","permissions":{"allow":["Shell(ls)","Shell(git)","Mcp(docs:*)"],"deny":[]},` +
			`"approvalMode":"unrestricted","autoAcceptWebSearch":true,"selectedModel":{"modelId":"default","parameters":[]}}`
		if err := os.WriteFile(config, []byte(widened), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := prepareCursorLaunch(job, execDir, "/opt/cursor/cursor-agent", dir); err != nil {
			t.Fatal(err)
		}
		var got map[string]interface{}
		data, _ := os.ReadFile(config)
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if !cursorJSONEqual(t, got["permissions"], map[string]interface{}{"allow": []interface{}{"Shell(ls)"}, "deny": []interface{}{}}) ||
			got["approvalMode"] != "allowlist" || got["autoAcceptWebSearch"] != false || got["selectedModel"] == nil || got["channel"] != "static" {
			t.Fatalf("cli-config.json = %s", data)
		}
		if _, err := os.Lstat(filepath.Join(execDir, ".cursor")); !os.IsNotExist(err) {
			t.Fatalf("the checkout has a .cursor: %v", err)
		}
	})
}

// realCheckRecord is one check of a real run's summary (cursor_permissions_real_test.go).
type realCheckRecord struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail"`
}

// TestCursorExtensionRequests: Cursor CLI's two blocking questions are always answered — no answer leaves
// the turn waiting forever (§4.2) — from a person on Orbit's question or plan card, or refused, and
// cancelled when the turn is stopped while the card is open.
func TestCursorExtensionRequests(t *testing.T) {
	const question = "p5c/synthetic/ask-question/session"
	answerOf := func(t *testing.T, run cursorRun, id string) map[string]interface{} {
		t.Helper()
		var out map[string]interface{}
		for _, line := range run.fake.received(t) {
			if line.Message["method"] == nil && rpcIDKey(line.Message["id"]) == id {
				if out != nil {
					t.Fatalf("request %s answered twice", id)
				}
				out = mapValue(mapValue(line.Message["result"])["outcome"])
			}
		}
		if out == nil {
			t.Fatalf("request %s never answered", id)
		}
		return out
	}
	t.Run("ask-question-answered", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: question, agent: cursorInMode("acceptEdits"), first: first, then: then,
			approve: func(card cursorTestCard) cursorTestDecision {
				return cursorTestDecision{Status: "ALLOWED", Answers: map[string][]string{
					"Which color should the banner use?": {"Blue"},
					"Which sizes should it come in?":     {"Small", "Large", "a size of my own"},
				}}
			}})
		if len(run.cards) != 1 || run.cards[0].ToolName != "AskUserQuestion" || run.cards[0].ToolUseID != "call-<UUID_90>-1\nfc_<UUID_91>_0" {
			t.Fatalf("cards = %+v", run.cards)
		}
		shown := mapValue(run.cards[0].Input)["questions"].([]interface{})
		if len(shown) != 2 || firstString(mapValue(shown[0]), "question") != "Which color should the banner use?" ||
			mapValue(shown[1])["multiSelect"] != true || len(mapValue(shown[0])["options"].([]interface{})) != 2 {
			t.Fatalf("question card = %v", run.cards[0].Input)
		}
		got := answerOf(t, run, "0")
		want := map[string]interface{}{"outcome": "answered", "answers": []interface{}{
			map[string]interface{}{"questionId": "q-color", "selectedOptionIds": []interface{}{"opt-blue"}},
			map[string]interface{}{"questionId": "q-size", "selectedOptionIds": []interface{}{"opt-s", "opt-l"}},
		}}
		if !cursorJSONEqual(t, got, want) {
			t.Fatalf("answered %v, want %v", got, want)
		}
		if len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("ask-question-skipped", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: question, agent: cursorInMode("acceptEdits"), first: first, then: then,
			approve: func(cursorTestCard) cursorTestDecision {
				return cursorTestDecision{Status: "DENIED", Message: "Use green, it is the brand color."}
			}})
		if got := answerOf(t, run, "0"); !cursorJSONEqual(t, got, map[string]interface{}{"outcome": "skipped", "reason": "Use green, it is the brand color."}) {
			t.Fatalf("answered %v", got)
		}
	})
	t.Run("ask-question-dont-ask", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: question, agent: cursorInMode("dontAsk"), first: first, then: then})
		if got := answerOf(t, run, "0"); got["outcome"] != "skipped" || len(run.cards) != 0 {
			t.Fatalf("answered %v with cards %+v", got, run.cards)
		}
	})
	t.Run("ask-question-stop", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: question, agent: cursorInMode("acceptEdits"),
			script:  func(s *fakeCursorACPScript) { s.CancelEndsPrompt = true },
			approve: func(cursorTestCard) cursorTestDecision { return cursorTestDecision{} },
			onCard: func(cursorTestCard) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
			},
			first: []RunInboxResponse{cursorMessage("turn-1", "first message")},
			then: func(int, TurnCompleteRequest) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
			}})
		if got := answerOf(t, run, "0"); got["outcome"] != "cancelled" || len(run.cards) != 1 || !run.cards[0].released() {
			t.Fatalf("answered %v with cards %+v", got, run.cards)
		}
		if len(run.completions) != 1 || run.completions[0].Status != stInterrupted {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	plan := func(t *testing.T, decision cursorTestDecision, stop bool) cursorRun {
		t.Helper()
		opts := cursorRunOptions{recording: "plan-and-ask-modes-concurrent/modes", session: "<UUID_2>", agent: cursorInMode("plan"),
			script: func(s *fakeCursorACPScript) { s.CancelEndsPrompt = true },
			approve: func(card cursorTestCard) cursorTestDecision {
				if card.ToolName != "ExitPlanMode" {
					t.Errorf("Plan filed a card that is not its plan: %+v", card)
				}
				return decision
			},
			first: []RunInboxResponse{cursorMessage("turn-1", "plan the change")},
			then: func(int, TurnCompleteRequest) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
			}}
		if stop {
			opts.onCard = func(cursorTestCard) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
			}
		}
		run := runCursorSession(t, opts)
		if len(run.cards) != 1 || !strings.HasPrefix(asString(mapValue(run.cards[0].Input)["plan"]), "# Add CONTRIBUTING.md") ||
			asString(mapValue(run.cards[0].Input)["name"]) != "Add CONTRIBUTING md" {
			t.Fatalf("plan cards = %+v", run.cards)
		}
		return run
	}
	t.Run("create-plan-accepted", func(t *testing.T) {
		run := plan(t, cursorTestDecision{Status: "ALLOWED"}, false)
		if got := answerOf(t, run, "3"); !cursorJSONEqual(t, got, map[string]interface{}{"outcome": "accepted"}) {
			t.Fatalf("answered %v", got)
		}
	})
	t.Run("create-plan-rejected", func(t *testing.T) {
		run := plan(t, cursorTestDecision{Status: "DENIED", Message: "Keep it to one section."}, false)
		if got := answerOf(t, run, "3"); !cursorJSONEqual(t, got, map[string]interface{}{"outcome": "rejected", "reason": "Keep it to one section."}) {
			t.Fatalf("answered %v", got)
		}
	})
	t.Run("create-plan-stop", func(t *testing.T) {
		run := plan(t, cursorTestDecision{}, true)
		if got := answerOf(t, run, "3"); got["outcome"] != "cancelled" || !run.cards[0].released() {
			t.Fatalf("answered %v, cards %+v", got, run.cards)
		}
		if len(run.completions) != 1 || run.completions[0].Status != stInterrupted {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
}

// TestCursorPlanModeSwitch: the model can switch Cursor out of plan mode itself, which Cursor approves
// asking nobody and announces nowhere but on a switch_mode card — measured in P5c, an edit after the switch
// is written (testdata/cursor/p5c/plan-switch-mode-raw). In Plan, Orbit stops the turn at the card, and
// puts the session back in plan mode before the next prompt.
func TestCursorPlanModeSwitch(t *testing.T) {
	t.Run("recorded", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "switch and write"), cursorMessage("turn-2", "write again"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/plan-switch-mode/session", agent: cursorInMode("plan"),
			script: func(s *fakeCursorACPScript) { s.Modes = true }, first: first, then: then})
		if len(run.completions) != 2 {
			t.Fatalf("completions = %+v", run.completions)
		}
		for _, req := range run.completions {
			if req.Status != stFailed || req.Error != "Cursor CLI switched itself out of Plan mode, so Orbit stopped the turn before anything could run outside Plan." {
				t.Fatalf("turn %s settled %s %q", req.TurnID, req.Status, req.Error)
			}
		}
		// Each turn: plan mode set before the prompt, the turn cancelled at the switch.
		var sent []string
		for _, line := range run.fake.received(t) {
			switch method := asString(line.Message["method"]); method {
			case "session/set_mode":
				sent = append(sent, method+" "+firstString(mapValue(line.Message["params"]), "modeId"))
			case "session/prompt", "session/cancel":
				sent = append(sent, method)
			}
		}
		want := []string{"session/set_mode plan", "session/prompt", "session/cancel", "session/set_mode plan", "session/prompt", "session/cancel"}
		if !cursorJSONEqual(t, sent, want) {
			t.Fatalf("sent %q, want %q", sent, want)
		}
		if kinds := cursorNoticeKinds(run); !cursorJSONEqual(t, kinds, []string{"cursor-plan-mode-left", "cursor-plan-mode-left"}) {
			t.Fatalf("notices = %q", kinds)
		}
		// Measured on the real CLI: with Orbit's stop in the way nothing was written; without it the edit was.
		for scenario, want := range map[string]bool{"plan-switch-mode": false, "plan-switch-mode-raw": true} {
			var summary struct {
				Checks []realCheckRecord      `json:"checks"`
				Facts  map[string]interface{} `json:"facts"`
			}
			data, err := os.ReadFile(filepath.Join("testdata", "cursor", "p5c", scenario, "summary.json"))
			if err != nil || json.Unmarshal(data, &summary) != nil {
				t.Fatalf("%s summary: %v", scenario, err)
			}
			written := summary.Facts["fileWritten"] == true
			for _, check := range summary.Checks {
				if check.Name == "nothing-written-outside-plan" {
					written = !check.Pass
				}
			}
			if written != want {
				t.Errorf("%s: written %v, want %v", scenario, written, want)
			}
		}
	})
}

// TestCursorRepoConfig: the checkout's own .cursor/ configuration cannot get around the session's
// permission mode, and Cursor CLI is not started over configuration it would run unasked (§7).
func TestCursorRepoConfig(t *testing.T) {
	t.Run("malicious-repo-protected", func(t *testing.T) {
		// The runner on the real CLI in the fixture repository, Accept Edits, every card refused (P5c): its
		// .cursor/cli.json allowlist switched off, so the `touch` it allows still asked; nothing it holds ran.
		work := t.TempDir()
		markers := filepath.Join(t.TempDir(), "markers")
		copyCursorFixture(t, work, markers)
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "p5c/malicious-repo/session", agent: cursorInMode("acceptEdits"),
			execDir: work, approve: cursorDecide("DENIED"), first: first, then: then})
		if !strings.Contains(strings.Join(run.fake.started(t).Args, " "), "--disable-project-configs") {
			t.Fatalf("started %q", run.fake.started(t).Args)
		}
		env := envMap(run.fake.started(t).Env)
		if env["DIRENV_DISABLE"] != "1" || env["HOME"] != run.spec.Home || strings.HasPrefix(run.spec.Home, work) {
			t.Fatalf("DIRENV_DISABLE=%q HOME=%q", env["DIRENV_DISABLE"], env["HOME"])
		}
		var commands []string
		for _, card := range run.cards {
			commands = append(commands, firstString(mapValue(card.Input), "command"))
		}
		if !cursorJSONEqual(t, commands, []string{"touch rule-obeyed.txt", "touch repo-allowed.txt"}) {
			t.Fatalf("cards = %q", commands)
		}
		for id, given := range cursorAnswersByRequest(t, run.fake) {
			if !cursorJSONEqual(t, given, []string{cursorRejectOnce}) {
				t.Errorf("request %s answered %q", id, given)
			}
		}
		if got := cursorMarkers(t, markers); len(got) != 0 {
			t.Fatalf("the fixture's configuration ran: %q", got)
		}
		var summary struct {
			Checks []realCheckRecord `json:"checks"`
		}
		data, err := os.ReadFile(filepath.Join("testdata", "cursor", "p5c", "malicious-repo", "summary.json"))
		if err != nil || json.Unmarshal(data, &summary) != nil {
			t.Fatalf("summary: %v", err)
		}
		for _, check := range summary.Checks {
			if !check.Pass {
				t.Errorf("the real run's check %s failed: %s", check.Name, check.Detail)
			}
		}
	})
	t.Run("user-config-refused", func(t *testing.T) {
		// Configuration Cursor CLI would run unasked, in the directories only the session's own CLI reads.
		for _, rel := range []string{
			"home/.cursor/mcp.json", "home/.cursor/hooks.json", "home/.claude/settings.json", "home/.claude/settings.local.json",
			"data/projects/some-slug/mcp-approvals.json", "data/projects/some-slug/.cursor/hooks.json",
			"data/projects/some-slug/.cursor/mcp.json", "data/projects/some-slug/.claude/settings.json",
		} {
			for _, mode := range []string{"acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"} {
				run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", agent: cursorInMode(mode),
					replay: func(f *cursorReplay) {
						path := filepath.Join(runDir(cursorTestSessionID), "cursor", rel)
						if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
							t.Fatal(err)
						}
						// A dangling link counts as the file it names.
						if err := os.Symlink(filepath.Join(t.TempDir(), "gone.json"), path); err != nil {
							t.Fatal(err)
						}
					},
					first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}})
				_, started := os.Stat(filepath.Join(run.fake.dir, "start.json"))
				if mode == "bypassPermissions" {
					// Bypass lets everything run anyway: nothing to hold the session to.
					if started != nil || run.status != stSucceeded {
						t.Errorf("%s in Bypass: run %s, started %v", rel, run.status, started == nil)
					}
					continue
				}
				errs := run.of("", evError)
				if started == nil || run.status != stFailed || len(errs) != 1 ||
					!strings.HasPrefix(asString(errs[0]["message"]), "CURSOR_CONFIG_UNSAFE: refusing to start Cursor CLI: ") ||
					!strings.Contains(asString(errs[0]["message"]), rel) {
					t.Errorf("%s in %s: run %s, started %v, errors %v", rel, mode, run.status, started == nil, errs)
				}
			}
		}
	})
	t.Run("session-config-owned", func(t *testing.T) {
		// The session's cli-config.json is Orbit's where it decides what runs unasked.
		useCursorRealHome(t)
		job := &ClaimedSession{SessionID: cursorTestSessionID, Agent: AgentExecConfig{Env: map[string]string{"CURSOR_API_KEY": cursorTestKey}}}
		dir := filepath.Join(runDir(job.SessionID), "cursor")
		spec, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", dir)
		if err != nil {
			t.Fatal(err)
		}
		var config map[string]interface{}
		data, _ := os.ReadFile(filepath.Join(spec.ConfigDir, "cli-config.json"))
		if err := json.Unmarshal(data, &config); err != nil {
			t.Fatal(err)
		}
		want := map[string]interface{}{"version": float64(1), "channel": "static", "approvalMode": "allowlist", "autoAcceptWebSearch": false,
			"permissions": map[string]interface{}{"allow": []interface{}{"Shell(ls)"}, "deny": []interface{}{}}}
		if !cursorJSONEqual(t, config, want) {
			t.Fatalf("cli-config.json = %s", data)
		}
	})
}

// TestCursorAgentInstructions: Orbit's agent instructions go ahead of a new conversation's first prompt —
// Cursor CLI reads no user-level rules file Orbit could put them in (§7.2) — and only there: a loaded
// conversation has them from its first turn.
func TestCursorAgentInstructions(t *testing.T) {
	agent := func(a *AgentExecConfig) {
		cursorOrbitTools(a)
		a.SystemPrompt = "You are the workspace's agent."
		a.AppendSystemPrompt = "Prefer small commits."
	}
	prompts := func(t *testing.T, run cursorRun) []string {
		t.Helper()
		var texts []string
		for _, line := range run.fake.requests(t, "session/prompt") {
			blocks, _ := mapValue(line.Message["params"])["prompt"].([]interface{})
			texts = append(texts, asString(mapValue(blocks[0])["text"]))
		}
		return texts
	}
	t.Run("first-prompt", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", agent: agent, first: first, then: then})
		texts := prompts(t, run)
		if len(texts) != 2 || texts[0] != cursorFirstPrompt(run.job, "first message") || texts[1] != "second message" {
			t.Fatalf("prompts = %q", texts)
		}
		instructions := cursorAgentInstructions(run.job)
		for _, part := range []string{"You are the workspace's agent.", "Prefer small commits.", "the tools of the `orbit` MCP server"} {
			if !strings.Contains(instructions, part) {
				t.Errorf("instructions lack %q", part)
			}
		}
		if strings.Contains(instructions, "mcp__orbit__") {
			t.Error("instructions name Orbit's tools as Cursor never shows them")
		}
		// The person's message is what the transcript shows, without them.
		if users := run.of("turn-1", evUser); len(users) != 1 || users[0]["text"] != "first message" {
			t.Fatalf("user event = %v", users)
		}
	})
	t.Run("loaded-conversation", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "crash-continue-and-shell-wrapper/continue", runtimeSessionID: "<UUID_1>",
			agent: agent, first: first, then: then})
		texts := prompts(t, run)
		if len(texts) == 0 || strings.Contains(texts[0], "<orbit-agent-instructions>") {
			t.Fatalf("prompts = %q", texts)
		}
	})
}
