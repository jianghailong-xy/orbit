package main

// The title Cursor CLI gives a conversation, against Orbit's agent instructions ahead of its first prompt
// (D-P8-2). The named scenarios here are the ones scripts/test-cursor-session-title-prefix.mjs runs.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The message P8 opened an untitled Cursor CLI session with, and the title the session was created with:
// the first 80 characters of it (titleFromPrompt), as P8 recorded it at creation.
const (
	cursorP8Message = "Please explain in two sentences what the add() function in calc.py does. Do not run any commands."
	cursorP8Title   = "Please explain in two sentences what the add() function in calc.py does. Do not "
)

// cursorTitleAfter is the session's title once the runner's reports are applied as the control plane
// applies them (SessionsService.applyEngineTitle): each only while the session still carries the title it
// says it replaces.
func cursorTitleAfter(claimed string, reports []SessionNamingRequest) string {
	title := claimed
	for _, report := range reports {
		if report.Replaces == title && strings.TrimSpace(report.Title) != "" {
			title = report.Title
		}
	}
	return title
}

// cursorRecordedTitles is every title a recording's CLI gave its conversation.
func cursorRecordedTitles(t *testing.T, recording string) []string {
	t.Helper()
	var titles []string
	for _, params := range recordedSessionUpdates(t, recording) {
		if update := mapValue(params["update"]); firstString(update, "sessionUpdate") == "session_info_update" {
			titles = append(titles, firstString(update, "title"))
		}
	}
	return titles
}

// cursorLoadedTitleRecording is P0a's conversation loaded in a process of its own
// (crash-continue-and-shell-wrapper/continue) with a session_info_update as its first prompt's stream
// begins. That conversation had been named before its process crashed, so Cursor named nothing there; one
// whose name never came — its process ended before Cursor's naming request answered — is named from the next
// prompt it is sent (6136.index.js maybeAutoNameSession names a conversation that has no name yet), and a
// loaded conversation's prompts carry no instructions of Orbit's.
func cursorLoadedTitleRecording(t *testing.T, title string) string {
	t.Helper()
	recorded := filepath.Join("testdata", "cursor", "crash-continue-and-shell-wrapper", "continue")
	dir := t.TempDir()
	sent, err := os.ReadFile(filepath.Join(recorded, "stdin.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stdin.jsonl"), sent, 0o600); err != nil {
		t.Fatal(err)
	}
	written, err := readFakeCursorJSONL(filepath.Join(recorded, "stdout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	named := map[string]interface{}{"jsonrpc": "2.0", "method": "session/update", "params": map[string]interface{}{
		"sessionId": "<UUID_1>", "update": map[string]interface{}{"sessionUpdate": "session_info_update", "title": title}}}
	var out []byte
	inserted := false
	for _, msg := range written {
		line, err := json.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, append(line, '\n')...)
		// The load's answer: what follows it is the first prompt's stream.
		if msg["method"] == nil && rpcIDKey(msg["id"]) == "2" && !inserted {
			line, _ := json.Marshal(named)
			out = append(out, append(line, '\n')...)
			inserted = true
		}
	}
	if !inserted {
		t.Fatal("the recording has no answer to its session/load")
	}
	if err := os.WriteFile(filepath.Join(dir, "stdout.jsonl"), out, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// cursorPromptTexts is the text of each prompt the runner sent, in order.
func cursorPromptTexts(t *testing.T, run cursorRun) []string {
	t.Helper()
	var texts []string
	for _, line := range run.fake.requests(t, "session/prompt") {
		blocks, _ := mapValue(line.Message["params"])["prompt"].([]interface{})
		if len(blocks) == 0 {
			t.Fatalf("a prompt with no blocks: %v", line.Message)
		}
		texts = append(texts, asString(mapValue(blocks[0])["text"]))
	}
	return texts
}

// TestCursorSessionTitlePrefix: Cursor CLI names a conversation from the first prompt it is sent (§3.2), and
// the first prompt of a conversation the runner opens has Orbit's agent instructions ahead of the person's
// message (P5c), so the name sums up the instructions — "Orbit Agent Instructions" for P8's untitled session,
// "Agent Instructions" for one of P5c's. None of those titles is reported, whatever its words: the session
// keeps the title cut from the person's first message. A conversation a later process loads has no
// instructions ahead of its prompts, and a title Cursor gives it is reported as before, when the claim asks.
func TestCursorSessionTitlePrefix(t *testing.T) {
	// opened checks a run of a conversation opened with session/new on a recording whose CLI named it
	// cursorTitle: its first prompt led with the instructions, and nothing was reported.
	opened := func(t *testing.T, run cursorRun, recording, cursorTitle string) {
		t.Helper()
		if titles := cursorRecordedTitles(t, recording); !reflect.DeepEqual(titles, []string{cursorTitle}) {
			t.Fatalf("the recording named the conversation %q, want %q", titles, cursorTitle)
		}
		if methods := run.methods(t); len(methods) < 2 || methods[1] != "session/new" {
			t.Fatalf("the runner asked %q: the conversation was not opened here", methods)
		}
		if texts := cursorPromptTexts(t, run); len(texts) == 0 || texts[0] != cursorFirstPrompt(run.job, cursorP8Message) {
			t.Fatalf("first prompt = %q, want Orbit's agent instructions ahead of the person's message", texts)
		}
		if len(run.namings) != 0 {
			t.Fatalf("naming = %+v: Cursor CLI's title for a conversation opened with Orbit's instructions was reported", run.namings)
		}
		if title := cursorTitleAfter(run.job.Title, run.namings); title != cursorP8Title {
			t.Fatalf("the session is titled %q, want the title cut from the person's first message, %q", title, cursorP8Title)
		}
	}
	untitled := func(opts cursorRunOptions) cursorRunOptions {
		opts.naming, opts.title = true, cursorP8Title
		if opts.first == nil {
			opts.first, opts.then = cursorTurns(cursorMessage("turn-1", cursorP8Message))
		}
		return opts
	}
	if !strings.HasPrefix(cursorP8Message, cursorP8Title) || len(cursorP8Title) != 80 {
		t.Fatal("P8's title is not the first 80 characters of its message")
	}

	t.Run("orbit-agent-instructions", func(t *testing.T) {
		// What P8's untitled session became, on P5c's recording of Orbit's runner on the real CLI.
		run := runCursorSession(t, untitled(cursorRunOptions{recording: "p5c/mcp-orbit/session", agent: cursorOrbitTools}))
		opened(t, run, "p5c/mcp-orbit/session", "Orbit Agent Instructions")
		if len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("agent-instructions", func(t *testing.T) {
		// The same instructions named in other words, on another of P5c's real sessions: one its person
		// stopped while an approval card was open.
		opts := untitled(cursorRunOptions{recording: "p5c/accept-edits-stop/session", agent: cursorInMode("acceptEdits"),
			script:  func(script *fakeCursorACPScript) { script.Modes, script.CancelEndsPrompt = true, true },
			approve: func(cursorTestCard) cursorTestDecision { return cursorTestDecision{} },
			onCard: func(cursorTestCard) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
			},
			first: []RunInboxResponse{cursorMessage("turn-1", cursorP8Message)},
			then: func(int, TurnCompleteRequest) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
			}})
		run := runCursorSession(t, opts)
		opened(t, run, "p5c/accept-edits-stop/session", "Agent Instructions")
		if len(run.completions) != 1 || run.completions[0].Status != stInterrupted {
			t.Fatalf("completions = %+v, want the stopped turn", run.completions)
		}
	})
	t.Run("any-wording", func(t *testing.T) {
		// A title that reads like a summary of a request is not the person's either: what is withheld is
		// the conversation's title, whatever Cursor CLI calls it.
		run := runCursorSession(t, untitled(cursorRunOptions{recording: "multi-turn-tools-default/turns"}))
		opened(t, run, "multi-turn-tools-default/turns", "Automated Protocol Probe")
	})
	t.Run("late-title", func(t *testing.T) {
		// Cursor CLI's title can arrive after the prompt's answer (§3.2): it is withheld all the same.
		run := runCursorSession(t, untitled(cursorRunOptions{recording: "background-shell-and-commit/background"}))
		opened(t, run, "background-shell-and-commit/background", "Git Attribution Probe")
		if commands, _ := slashReg.extrasFor(providerCursor, nil); len(commands) == 0 {
			t.Fatal("the commands listed after the turn were not learned: the late updates never reached the session")
		}
	})
	t.Run("reopened-conversation", func(t *testing.T) {
		// A conversation that never had a prompt is opened again with session/new (§3.5), and its first prompt
		// leads with the instructions like any other conversation opened here.
		useCursorRealHome(t)
		conversation := filepath.Join(runDir(cursorTestSessionID), "cursor", "config", "acp-sessions", "<UUID_0>")
		if err := os.MkdirAll(conversation, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(conversation, "meta.json"), []byte(`{"schemaVersion":1}`), 0o600); err != nil {
			t.Fatal(err)
		}
		run := runCursorSession(t, untitled(cursorRunOptions{recording: "subagent-and-todos/subagent", sameHome: true, runtimeSessionID: "<UUID_0>"}))
		opened(t, run, "subagent-and-todos/subagent", "Todo And Task")
		if run.job.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("runtime session id = %q, want the conversation opened in place of the unspoken one", run.job.RuntimeSessionID)
		}
	})
	t.Run("loaded-conversation", func(t *testing.T) {
		// Unchanged: a later process loads the conversation, sends the person's message alone, and reports the
		// title Cursor CLI gives it against the claimed one.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: cursorLoadedTitleRecording(t, "Previous Shell Command"), runtimeSessionID: "<UUID_1>",
			naming: true, title: cursorP8Title, first: first, then: then})
		if methods := run.methods(t); len(methods) < 2 || methods[1] != "session/load" {
			t.Fatalf("the runner asked %q, want the conversation loaded", methods)
		}
		if texts := cursorPromptTexts(t, run); !reflect.DeepEqual(texts, []string{"first message"}) {
			t.Fatalf("prompts = %q, want the person's message alone", texts)
		}
		if !reflect.DeepEqual(run.namings, []SessionNamingRequest{{Replaces: cursorP8Title, Title: "Previous Shell Command"}}) {
			t.Fatalf("naming = %+v, want Cursor CLI's title reported once against the claimed one", run.namings)
		}
		if title := cursorTitleAfter(run.job.Title, run.namings); title != "Previous Shell Command" {
			t.Fatalf("the session is titled %q", title)
		}
	})
	t.Run("loaded-conversation-not-asked", func(t *testing.T) {
		// A session titled by a task, a person or DeepSeek is claimed without naming, and its title stands.
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: cursorLoadedTitleRecording(t, "Previous Shell Command"), runtimeSessionID: "<UUID_1>",
			title: "My own name", first: first, then: then})
		if len(run.namings) != 0 {
			t.Fatalf("naming = %+v: a session whose claim asked for no name keeps its title", run.namings)
		}
		if len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
}
