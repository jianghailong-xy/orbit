package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeAgyChild is a stand-in agy for one SubAgent turn: an init on the conversation it was asked to continue (or
// a new one), then for the message a write_to_file step, a reply and a result. It logs its argv.
const fakeAgyChild = `printf '%s\n' "$*" >> "$AGY_FAKE_DIR/argv"
conv=child-conv
prev=""
for a in "$@"; do
  if [ "$prev" = "--conversation" ]; then conv="$a"; fi
  prev="$a"
done
echo '{"event":"init","conversation_id":"'"$conv"'","init":{"cwd":"x","tools":[],"permission_mode":"auto"}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$AGY_FAKE_DIR/stdin"
  echo '{"event":"step_update","step_update":{"conversation_id":"'"$conv"'","step_index":1,"state":"DONE","step_type":"user_input"}}'
  echo '{"event":"step_update","step_update":{"conversation_id":"'"$conv"'","step_index":2,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"'"$PWD"'/notes.txt"}}}}'
  echo '{"event":"step_update","step_update":{"conversation_id":"'"$conv"'","step_index":2,"state":"DONE","step_type":"tool","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"'"$PWD"'/notes.txt"}}}}'
  echo '{"event":"step_update","step_update":{"conversation_id":"'"$conv"'","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Wrote notes.txt.","usage":{"input_tokens":10,"output_tokens":2,"cache_read_tokens":3}}}'
  echo '{"event":"result","result":{"conversation_id":"'"$conv"'","status":"SUCCESS","response":"Wrote notes.txt.","num_turns":1}}'
done`

func TestAntigravityChildRunsOneTurnInTheParentsCwd(t *testing.T) {
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, fakeAgyChild)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())
	fake, cwd, state := t.TempDir(), t.TempDir(), t.TempDir()
	parent := &ClaimedSession{SessionID: "s-parent", Provider: providerAntigravity,
		Agent: AgentExecConfig{Provider: providerAntigravity, PermissionMode: "dontAsk"}}
	exec := AgentExecConfig{Provider: providerAntigravity, PermissionMode: "dontAsk", Env: map[string]string{"AGY_FAKE_DIR": fake}}

	run := func(resume bool, engineSession string) (ExecResult, string, *subagentFileCollector, []string) {
		t.Helper()
		files := newSubagentFileCollector(cwd)
		var kinds []string
		res, conv, err := runAntigravityChild(context.Background(), subagentChild{
			parent: parent, exec: exec, runID: "run1", engineSession: engineSession, resume: resume,
			cwd: cwd, scratch: t.TempDir(), stateDir: state, prompt: "write the notes",
			emit: func(kind string, payload map[string]interface{}) {
				kinds = append(kinds, kind)
				files.note(kind, payload)
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return res, conv, files, kinds
	}

	res, conv, files, kinds := run(false, "")
	if res.Status != stSucceeded || res.Result != "Wrote notes.txt." || conv != "child-conv" {
		t.Fatalf("result = %+v, conversation %q", res, conv)
	}
	if res.Usage == nil || res.Usage.InputTokens != 10 || res.Usage.OutputTokens != 2 || res.Usage.CacheReadInputTokens != 3 {
		t.Fatalf("usage = %+v", res.Usage)
	}
	if !reflect.DeepEqual(files.changed, []string{"notes.txt"}) {
		t.Fatalf("changed = %v (events %v)", files.changed, kinds)
	}
	for _, kind := range kinds {
		if kind == evTurnEnd {
			t.Fatalf("a child emitted the session's turn_end: %v", kinds)
		}
	}
	// The Gemini directory is under the run's state dir, and its `orbit mcp` is told it serves a SubAgent.
	mcp, err := os.ReadFile(filepath.Join(state, "antigravity", "config", "mcp_config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mcp), `"`+envSubagentRunID+`": "run1"`) {
		t.Fatalf("mcp_config.json = %s", mcp)
	}
	if rules, _ := os.ReadFile(filepath.Join(state, "antigravity", "GEMINI.md")); !strings.Contains(string(rules), "You are a SubAgent") {
		t.Fatalf("GEMINI.md lacks the SubAgent preamble: %s", rules)
	}

	// A resume continues the same conversation, in the same Gemini directory.
	res, conv, _, _ = run(true, "child-conv")
	if res.Status != stSucceeded || conv != "child-conv" || strings.Contains(res.Result, "could not find") {
		t.Fatalf("resume = %+v, conversation %q", res, conv)
	}
	argv, _ := os.ReadFile(filepath.Join(fake, "argv"))
	lines := strings.Split(strings.TrimSpace(string(argv)), "\n")
	if len(lines) != 2 || strings.Contains(lines[0], "--conversation") || !strings.Contains(lines[1], "--conversation child-conv") {
		t.Fatalf("argv = %q", lines)
	}
}

func TestAntigravityChildSaysWhenItsConversationIsGone(t *testing.T) {
	bin := t.TempDir()
	writeFakeBin(t, bin, agyExecutable, strings.Replace(fakeAgyChild, `conv="$a"`, `conv=other`, 1))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())
	parent := &ClaimedSession{SessionID: "s-parent", Provider: providerAntigravity}
	res, conv, err := runAntigravityChild(context.Background(), subagentChild{
		parent: parent, exec: AgentExecConfig{PermissionMode: "dontAsk", Env: map[string]string{"AGY_FAKE_DIR": t.TempDir()}},
		runID: "run2", engineSession: "lost-conv", resume: true, cwd: t.TempDir(), scratch: t.TempDir(), prompt: "go on",
		emit: func(string, map[string]interface{}) {},
	})
	if err != nil || conv != "other" || !strings.HasPrefix(res.Result, antigravityConversationLostNote) {
		t.Fatalf("result = %+v, conversation %q, err %v", res, conv, err)
	}
}
