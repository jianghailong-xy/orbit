package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// instructionSnapshotShape is one session shape the engine-instruction snapshots are taken for: the switches
// and role facts that decide what Orbit tells an engine, plus how the agent itself is configured.
type instructionSnapshotShape struct {
	name           string
	task           bool // dispatched for a task (TaskID)
	watches        bool
	subagent       bool // a SubAgent's child session (envSubagentRunID)
	workflows      bool
	drive          bool // the Orbit Files drive is mounted
	systemPrompt   bool // the agent has a system prompt and allowed/disallowed tools of its own
	bare           bool // the agent has no prompt of its own at all
	orchestration  bool
	wikiOff        bool
	browser        bool
	scheduledCheck bool
}

// instructionSnapshotShapes is every combination of the four switches that change the text today, each with an
// appended prompt of the agent's own, and the shapes that change one more thing: the drive, a system prompt, no
// prompt at all, and the switches that change only what is served (orchestration, wiki, browser, check-only).
func instructionSnapshotShapes() []instructionSnapshotShape {
	var shapes []instructionSnapshotShape
	for _, task := range []bool{false, true} {
		for _, watches := range []bool{true, false} {
			for _, subagent := range []bool{false, true} {
				for _, workflows := range []bool{true, false} {
					if subagent && !workflows {
						continue // a SubAgent is never offered the workflow tool, so the switch changes nothing for it
					}
					name := map[bool]string{false: "free", true: "task"}[task] +
						map[bool]string{true: "-watch", false: "-nowatch"}[watches] +
						map[bool]string{false: "-toplevel", true: "-subagent"}[subagent] +
						map[bool]string{true: "-workflows", false: "-noworkflows"}[workflows]
					shapes = append(shapes, instructionSnapshotShape{name: name, task: task, watches: watches, subagent: subagent, workflows: workflows})
				}
			}
		}
	}
	return append(shapes,
		instructionSnapshotShape{name: "task-watch-toplevel-workflows-drive", task: true, watches: true, workflows: true, drive: true},
		instructionSnapshotShape{name: "free-watch-toplevel-workflows-systemprompt", watches: true, workflows: true, systemPrompt: true},
		instructionSnapshotShape{name: "task-watch-subagent-workflows-systemprompt", task: true, watches: true, subagent: true, workflows: true, systemPrompt: true},
		instructionSnapshotShape{name: "free-watch-toplevel-workflows-bare", watches: true, workflows: true, bare: true},
		instructionSnapshotShape{name: "task-watch-toplevel-workflows-orchestration-nowiki-browser", task: true, watches: true, workflows: true,
			orchestration: true, wikiOff: true, browser: true},
		instructionSnapshotShape{name: "task-watch-toplevel-workflows-checkonly", task: true, watches: true, workflows: true, scheduledCheck: true},
	)
}

func (shape instructionSnapshotShape) job(t *testing.T) *ClaimedSession {
	t.Helper()
	job := &ClaimedSession{SessionID: "s-snapshot", SessionUUID: "11111111-2222-3333-4444-555555555555",
		WT:    &Worktree{Path: t.TempDir(), RepoDir: t.TempDir(), Branch: "orbit/task-snapshot"},
		Agent: AgentExecConfig{AppendSystemPrompt: "Owner instructions.", Model: "test-model", PermissionMode: "default", Env: map[string]string{}}}
	if shape.task {
		job.TaskID = "task-1"
	}
	job.WatchesDisabled = !shape.watches
	job.WorkflowsDisabled = !shape.workflows
	if shape.subagent {
		job.Agent.Env[envSubagentRunID] = "run-1"
	}
	if shape.systemPrompt {
		job.Agent.SystemPrompt = "Owner system prompt."
		job.Agent.AllowedTools = []string{"Read", "Grep"}
		job.Agent.DisallowedTools = []string{"WebFetch"}
	}
	if shape.bare {
		job.Agent.AppendSystemPrompt = ""
	}
	job.AllowOrchestration = shape.orchestration
	job.WikiDisabled = shape.wikiOff
	job.BrowserEnabled = shape.browser
	job.Agent.ScheduledCheckOnly = shape.scheduledCheck
	return job
}

// instructionSnapshotCarriers is what each engine carrier and `orbit mcp` initialize give a session of this shape,
// read off the runner's own spawn and turn paths (primerCarriers), with the paths that differ per test run
// replaced by fixed names.
func instructionSnapshotCarriers(t *testing.T, shape instructionSnapshotShape) map[string]string {
	t.Helper()
	fakeDriveMount(t, shape.drive)
	// The mount's paragraph names the root it reports in; the fake mount's is a temporary directory, so the snapshot
	// names the root a Pod has (fakeDriveMount puts the real one back).
	driveParentPath = driveRootPath
	job := shape.job(t)
	carriers := primerCarriers(t, job)
	helpAsk, _ := (&mcpServer{helpAsk: true}).handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "initialize"})
	carriers["orbit mcp initialize, help ask"] = helpAsk.Result.(map[string]interface{})["instructions"].(string)
	// A later prompt of a Kimi conversation whose history holds the instructions (kimiInstructionLedger).
	wire := filepath.Join(t.TempDir(), "wire.jsonl")
	held, _ := json.Marshal(map[string]interface{}{"type": "turn.prompt", "agentId": "main",
		"input": []map[string]interface{}{{"type": "text", "text": kimiInstructionsOpen}}})
	if err := os.WriteFile(wire, append(held, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	carriers["kimi, a later prompt"] = fmt.Sprint(prepareKimiPrompt(context.Background(), nil, job, &RunInboxResponse{Content: "hi"}, nil,
		&kimiInstructionLedger{wire: wire}).blocks)
	replacer := strings.NewReplacer(orbitCLIExecutable(), "<orbit-cli>", job.WT.Path, "<checkout>", job.WT.RepoDir, "<repo>")
	for name, text := range carriers {
		carriers[name] = replacer.Replace(text)
	}
	return carriers
}

// TestEngineInstructionSnapshots pins what every engine carrier and `orbit mcp` initialize give every session shape,
// byte for byte, one file per shape under testdata/agent-instructions. A carrier whose text is the same as one
// before it in the file is written as a reference to it. Regenerate with
// ORBIT_UPDATE_INSTRUCTION_SNAPSHOTS=1 go test -run TestEngineInstructionSnapshots . and read the diff.
func TestEngineInstructionSnapshots(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	update := os.Getenv("ORBIT_UPDATE_INSTRUCTION_SNAPSHOTS") == "1"
	dir := filepath.Join("testdata", "agent-instructions")
	seen := map[string]bool{}
	for _, shape := range instructionSnapshotShapes() {
		carriers := instructionSnapshotCarriers(t, shape)
		names := make([]string, 0, len(carriers))
		for name := range carriers {
			names = append(names, name)
		}
		sort.Strings(names)
		var b strings.Builder
		first := map[string]string{}
		for _, name := range names {
			text := carriers[name]
			if earlier, ok := first[text]; ok {
				fmt.Fprintf(&b, "=== %s: same as %s\n", name, earlier)
				continue
			}
			first[text] = name
			fmt.Fprintf(&b, "=== %s (%d bytes)\n%s\n", name, len(text), text)
		}
		path := filepath.Join(dir, shape.name+".txt")
		seen[shape.name+".txt"] = true
		if update {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (regenerate with ORBIT_UPDATE_INSTRUCTION_SNAPSHOTS=1 go test -run TestEngineInstructionSnapshots .)", err)
		}
		if string(got) != b.String() {
			t.Errorf("%s is not what the engines are given now (regenerate with ORBIT_UPDATE_INSTRUCTION_SNAPSHOTS=1 "+
				"go test -run TestEngineInstructionSnapshots ., and read the diff)", path)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !seen[entry.Name()] {
			t.Errorf("%s is a snapshot of no shape this test takes", filepath.Join(dir, entry.Name()))
		}
	}
}
