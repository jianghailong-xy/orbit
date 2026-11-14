package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

// agentPrimerHashes is every primer version that has shipped, with the sha256 of its text. The text
// is what an agent reads first in every session, so it changes only as a new version: a change to a
// word under an old version fails here, and recording a new one is a reviewed line in this map.
var agentPrimerHashes = map[string]string{
	"1.0.0": "41db1d1fd823c5c1d5f640aafdf153736db36a1913a0ae0687fcea4c6e34dbd8",
	// 1.0.1 is 1.0.0 with the first line naming Agent Contract 1.6.0 (P1-02); no rule changed.
	"1.0.1": "a13c679f75188771fbd4f75043844751a25bbcde7fdd2473b497b8f51b1584b9",
}

// The snapshots: the primer exactly as `initialize` sends it, and the four shapes of the instructions
// the runner writes into an engine, so any change to what an agent reads first is a visible diff.
// Regenerate with ORBIT_UPDATE_PRIMER_SNAPSHOTS=1 go test -run TestAgentPrimerSnapshots .
func TestAgentPrimerSnapshots(t *testing.T) {
	const exe = "/usr/local/bin/orbit"
	snapshots := map[string]string{
		"mcp-instructions.txt":                agentPrimer,
		"engine-instructions-free.txt":        orbitCLIInstructions(exe, false, true),
		"engine-instructions-free-nowait.txt": orbitCLIInstructions(exe, false, false),
		"engine-instructions-task.txt":        orbitCLIInstructions(exe, true, true),
		"engine-instructions-task-nowait.txt": orbitCLIInstructions(exe, true, false),
	}
	names := make([]string, 0, len(snapshots))
	for name := range snapshots {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join("testdata", "agent-primer", name)
		want := snapshots[name] + "\n"
		if os.Getenv("ORBIT_UPDATE_PRIMER_SNAPSHOTS") == "1" {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (regenerate with ORBIT_UPDATE_PRIMER_SNAPSHOTS=1 go test -run TestAgentPrimerSnapshots .)", err)
		}
		if string(got) != want {
			t.Errorf("%s is not what an agent is given now (regenerate with ORBIT_UPDATE_PRIMER_SNAPSHOTS=1 "+
				"go test -run TestAgentPrimerSnapshots ., and read the diff)", path)
		}
	}

	sum := sha256.Sum256([]byte(agentPrimer))
	hash := hex.EncodeToString(sum[:])
	pinned, known := agentPrimerHashes[agentPrimerVersion]
	if !known {
		t.Fatalf("primer %s is not recorded in agentPrimerHashes; add it with its hash %s", agentPrimerVersion, hash)
	}
	if pinned != hash {
		t.Errorf("the primer's text changed under version %s (sha256 %s, recorded %q): a new text is a new "+
			"agentPrimerVersion, recorded beside the old one", agentPrimerVersion, hash, pinned)
	}
}

// The budgets the primer is held to, all of them stated in agent_primer.go and codex_appserver.go.
func TestAgentPrimerBudgets(t *testing.T) {
	paragraphs := strings.Split(agentPrimer, "\n\n")
	if paragraphs[0] != agentPrimerLead {
		t.Fatalf("the primer does not open with its lead paragraph: %q", paragraphs[0])
	}
	if n := utf8.RuneCountInString(agentPrimerLead); n > agentPrimerLeadMaxChars {
		t.Errorf("the lead paragraph is %d characters, over its %d-character budget", n, agentPrimerLeadMaxChars)
	}
	if n := len(agentPrimer); n > agentPrimerMaxBytes {
		t.Errorf("the primer is %d bytes, over its %d-byte budget", n, agentPrimerMaxBytes)
	}
	for i := 0; i < len(agentPrimer); i++ {
		if agentPrimer[i] > 127 {
			t.Fatalf("the primer must stay ASCII, as every engine's instructions are; byte %d is %q", i, agentPrimer[i])
		}
	}
	// An executable path longer than any runner's, so a paragraph that names it still fits one value.
	long := "/home/a-long-account-name/.orbit/bin/versions/0.1.999/orbit"
	for _, form := range []struct{ inside, watches bool }{{false, true}, {true, true}, {false, false}, {true, false}} {
		instructions := orbitCLIInstructions(long, form.inside, form.watches)
		if n := len(instructions); n > orbitInstructionsMaxBytes {
			t.Errorf("instructions (inside=%v, watches=%v) are %d bytes, over their %d-byte budget", form.inside, form.watches, n, orbitInstructionsMaxBytes)
		}
		for _, paragraph := range strings.Split(instructions, "\n\n") {
			if len(paragraph) > codexContextValueMaxBytes {
				t.Errorf("a paragraph of %d bytes does not fit one Codex context value (%d): %q", len(paragraph), codexContextValueMaxBytes, paragraph)
			}
		}
		t.Logf("instructions (inside=%v, watches=%v): %d bytes, ~%d tokens; primer %d bytes, ~%d tokens",
			form.inside, form.watches, len(instructions), estimateTokens(instructions), len(agentPrimer), estimateTokens(agentPrimer))
	}
}

// The first 512 characters are all a client may show, and Codex shows fewer (250, as the namespace's line
// in its deferred-tool list), so they hold the selection rules on their own: what is a record and what is
// scratch, which create to use, MCP before the CLI, create versus start, and what a success is. They do not
// lean on anything after them.
func TestAgentPrimerLeadStandsAlone(t *testing.T) {
	head := agentPrimer
	if len(head) > agentPrimerLeadMaxChars {
		head = head[:agentPrimerLeadMaxChars]
	}
	for _, phrase := range []string{
		"Orbit primer " + agentPrimerVersion + " (Agent Contract " + agentContractVersion + ")",
		"durable record", "private scratch",
		"task_create", "task_create_batch", "project_create", "the smaller wins",
		"MCP tools first", "never the CLI to get around a card or a refusal",
		"Create is not start", "autoRunWhenReady defaults to true", "pass false",
		"No returned id, no claim.",
	} {
		if !strings.Contains(head, phrase) {
			t.Errorf("the first %d characters do not say %q:\n%s", agentPrimerLeadMaxChars, phrase, head)
		}
	}
	for _, leaning := range []string{"below", "above", "see ", "as follows"} {
		if strings.Contains(strings.ToLower(agentPrimerLead), leaning) {
			t.Errorf("the lead leans on text around it (%q): %q", leaning, agentPrimerLead)
		}
	}
	if !strings.HasPrefix(agentPrimer[:250], "Orbit primer ") || !strings.Contains(agentPrimer[:250], "durable record") {
		t.Errorf("Codex's 250 characters do not say what Orbit is for: %q", agentPrimer[:250])
	}
}

// The primer is §0 of the Agent Contract made short: each of its ten rules is said, and a rule added to
// §0 is a red here until the primer says it too.
func TestAgentPrimerSaysEveryRuleOfTheContract(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "orbit-agent-contract.md"))
	if err != nil {
		t.Fatal(err)
	}
	section := string(doc)
	start := strings.Index(section, "## 0. One page")
	end := strings.Index(section, "## 1. Object model")
	if start < 0 || end < start {
		t.Fatal("docs/orbit-agent-contract.md has no §0 before §1")
	}
	rules := regexp.MustCompile(`(?m)^(\d+)\. \*\*(.+?)\*\*`).FindAllStringSubmatch(section[start:end], -1)
	said := map[string][]string{
		"1":  {"durable record", "private scratch", "No returned id, no claim."},
		"2":  {"Pick the object by the question it answers", "Task list:", "Session:", "Agent:", "the smaller wins"},
		"3":  {"Use Orbit's MCP tools first", "The Orbit CLI is for pipes, scripts, bulk input"},
		"4":  {"Create is not start", "autoRunWhenReady defaults to true", "pass autoRunWhenReady: false", "startNow: true", "runAt"},
		"5":  {"confirmation card", "writes nothing until they confirm it", "A declined card (APPROVAL_DECLINED) is a refusal", "A chat is not a no", "owner-only decision"},
		"6":  {"Only a structured receipt counts", "ok: true and outcome: written, with the entity's id and status", "`[Fix login redirect](orbit-task:<id>)`"},
		"7":  {"follow its error.retry", "idempotencyKey derived from the work"},
		"8":  {"the same server under the same approvals"},
		"9":  {"Session orchestration switch", "Without session_* tools", "never claim a delegation"},
		"10": {"After compaction or a resume", "never rebuild an id, a status or an approval"},
	}
	if len(rules) != len(said) {
		t.Fatalf("§0 has %d rules and the primer is checked against %d: say the new rule in the primer, then here", len(rules), len(said))
	}
	for _, rule := range rules {
		phrases, ok := said[rule[1]]
		if !ok {
			t.Errorf("§0 rule %s (%s) has no phrase the primer is held to", rule[1], rule[2])
		}
		for _, phrase := range phrases {
			if !strings.Contains(agentPrimer, phrase) {
				t.Errorf("§0 rule %s (%s): the primer does not say %q", rule[1], rule[2], phrase)
			}
		}
	}
}

// What the primer says about a receipt is what contracts/orbit-agent.contract.json's receipt says: the
// outcomes it calls a success are exactly the schema's okOutcomes, every retry rule it lists is the
// schema's and none is missing, the chat it singles out is an outcome there, and the idempotencyKey it
// tells an agent to send is an argument of both creates.
func TestAgentPrimerReadsAReceiptAsTheContractDefinesIt(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Receipt struct {
			Outcomes   []string `json:"outcomes"`
			OKOutcomes []string `json:"okOutcomes"`
			Schema     struct {
				Properties struct {
					Error struct {
						Properties struct {
							Retry struct {
								Enum []string `json:"enum"`
							} `json:"retry"`
						} `json:"properties"`
					} `json:"error"`
				} `json:"properties"`
			} `json:"schema"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	receipt := contract.Receipt
	if got := strings.Join(receipt.OKOutcomes, ","); got != "written,read,dry_run" {
		t.Fatalf("the contract's okOutcomes are %s; the primer says a write is outcome written and read and dry_run wrote nothing", got)
	}
	for _, phrase := range []string{"ok: true and outcome: written", "read and dry_run wrote nothing", "Any other outcome is ok: false", "except on a chat"} {
		if !strings.Contains(agentPrimerReceipts, phrase) {
			t.Errorf("the receipt paragraph does not say %q: %q", phrase, agentPrimerReceipts)
		}
	}
	outcomes := stringSet(receipt.Outcomes)
	for _, named := range []string{"written", "read", "dry_run", "chat"} {
		if !outcomes[named] {
			t.Errorf("the primer names outcome %q, which the contract's receipt does not have (%v)", named, receipt.Outcomes)
		}
	}
	listed := regexp.MustCompile(`follow its error\.retry \(([^)]*)\)`).FindStringSubmatch(agentPrimerReceipts)
	if listed == nil {
		t.Fatalf("the receipt paragraph lists no retry rules: %q", agentPrimerReceipts)
	}
	got := strings.Split(listed[1], ", ")
	want := append([]string(nil), receipt.Schema.Properties.Error.Properties.Retry.Enum...)
	sort.Strings(got)
	sort.Strings(want)
	if len(want) == 0 || strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("the primer lists error.retry %v, the contract's schema %v", got, want)
	}
	for _, tool := range []string{"task_create", "task_create_batch"} {
		found := false
		for _, descriptor := range toolDescriptors(true, true) {
			if descriptor["name"] != tool {
				continue
			}
			schema, _ := descriptor["inputSchema"].(map[string]interface{})
			properties, _ := schema["properties"].(map[string]interface{})
			_, found = properties["idempotencyKey"]
		}
		if !found {
			t.Errorf("the primer tells an agent to key %s with idempotencyKey, which its input schema does not take", tool)
		}
	}
}

// The primer is written from the contract version the contract itself states, in both of its files.
func TestAgentPrimerNamesTheContractVersion(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ContractVersion string `json:"contractVersion"`
		Surfaces        struct {
			MCP struct {
				InitializeInstructions struct {
					PrimerVersion   string `json:"primerVersion"`
					LeadMaxChars    int    `json:"leadMaxChars"`
					PrimerMaxBytes  int    `json:"primerMaxBytes"`
					EngineMaxBytes  int    `json:"engineInstructionsMaxBytes"`
					ContextMaxBytes int    `json:"codexContextValueMaxBytes"`
				} `json:"initializeInstructions"`
			} `json:"mcp"`
		} `json:"surfaces"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.ContractVersion != agentContractVersion {
		t.Errorf("contracts/orbit-agent.contract.json is at %s, the primer names %s", contract.ContractVersion, agentContractVersion)
	}
	got := contract.Surfaces.MCP.InitializeInstructions
	if got.PrimerVersion != agentPrimerVersion || got.LeadMaxChars != agentPrimerLeadMaxChars ||
		got.PrimerMaxBytes != agentPrimerMaxBytes || got.EngineMaxBytes != orbitInstructionsMaxBytes ||
		got.ContextMaxBytes != codexContextValueMaxBytes {
		t.Errorf("the contract's initializeInstructions = %+v, want primer %s with budgets %d/%d/%d/%d", got,
			agentPrimerVersion, agentPrimerLeadMaxChars, agentPrimerMaxBytes, orbitInstructionsMaxBytes, codexContextValueMaxBytes)
	}
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "orbit-agent-contract.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(doc), "frozen at v"+agentContractVersion) {
		t.Errorf("docs/orbit-agent-contract.md does not say it is frozen at v%s", agentContractVersion)
	}
}

// initialize answers with the primer, on the wire, as every MCP client reads it.
func TestMCPInitializeAnswersWithTheVersionedPrimer(t *testing.T) {
	var out bytes.Buffer
	srv := &mcpServer{}
	srv.serve(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`+"\n"), &out)
	var resp struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			Instructions    string `json:"instructions"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("initialize answered %q: %v", out.String(), err)
	}
	if resp.Result.Instructions != agentPrimer {
		t.Fatalf("initialize instructions = %q, want the primer", resp.Result.Instructions)
	}
	if !strings.HasPrefix(resp.Result.Instructions, "Orbit primer "+agentPrimerVersion+" (Agent Contract "+agentContractVersion+").") {
		t.Errorf("the instructions do not open with their version: %q", resp.Result.Instructions[:80])
	}
	if resp.Result.ProtocolVersion != "2025-06-18" || resp.Result.ServerInfo.Name != "orbit" {
		t.Errorf("initialize result = %+v", resp.Result)
	}
	// The primer names no engine's spelling of the tools and no path, so it is true in every client.
	for _, engineOnly := range []string{"mcp__orbit__", "orbit_*", "call_mcp_tool", "/usr/local/bin", "capabilities --json"} {
		if strings.Contains(agentPrimer, engineOnly) {
			t.Errorf("the primer carries %q, which is one engine's or one runner's", engineOnly)
		}
	}
}

// primerCarriers is the instruction text each engine is given for job, read off what the runner builds
// for a spawn or a turn: every carrier, and the second form of each one that has two.
func primerCarriers(t *testing.T, job *ClaimedSession) map[string]string {
	t.Helper()
	exe := orbitCLIExecutable()
	appendPrompt := func(args []string) string {
		for i, arg := range args {
			if arg == "--append-system-prompt" && i+1 < len(args) {
				return args[i+1]
			}
		}
		t.Fatalf("no --append-system-prompt in %v", args)
		return ""
	}
	codexContext := func(job *ClaimedSession, generation uint64) string {
		params := codexTurnParams("thread-1", job, job.WT.Path, t.TempDir(), "turn-1", "hi", nil,
			codexTurnContextOptions{Executable: exe, Mode: codexInstructionsAdditionalContext, Generation: generation})
		context := params["additionalContext"].(map[string]interface{})
		keys := make([]string, 0, len(context))
		for key := range context {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]string, 0, len(keys))
		for _, key := range keys {
			value := context[key].(map[string]interface{})["value"].(string)
			if len(value) > codexContextValueMaxBytes {
				t.Errorf("Codex context value %s is %d bytes, over %d", key, len(value), codexContextValueMaxBytes)
			}
			if !strings.HasPrefix(key, fmt.Sprintf("orbit_%08d_", generation)) {
				t.Errorf("Codex context key %s is not of generation %d", key, generation)
			}
			values = append(values, value)
		}
		return strings.Join(values, "\n\n")
	}
	developerMessage := func() string {
		items := codexInjectedAgentItems(job.instructionAgent(), exe, job.insideRecordedWork(), job.watchesOn())
		return items[0]["content"].([]map[string]interface{})[0]["text"].(string)
	}
	turnInput := func() string {
		params := codexTurnParams("thread-1", job, job.WT.Path, t.TempDir(), "turn-1", "hi", nil,
			codexTurnContextOptions{Executable: exe, Mode: codexInstructionsUserInput})
		return params["input"].([]map[string]interface{})[0]["text"].(string)
	}
	// A thread Codex resumes in a new process: the context rides every turn, so it is there again.
	resumed := *job
	resumed.RuntimeSessionID = "thread-resumed"
	scratch := t.TempDir()
	if _, err := openCodeConfigContent(job, scratch, "orbit-test", nil); err != nil {
		t.Fatal(err)
	}
	openCode, err := os.ReadFile(filepath.Join(scratch, "opencode-instructions.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"claude":                              appendPrompt(claudeCommandArgs(job, t.TempDir(), true)),
		"claude, resumed":                     appendPrompt(claudeCommandArgs(job, t.TempDir(), false)),
		"codex >= 0.135 additional context":   codexContext(job, 0),
		"codex >= 0.135, resumed thread":      codexContext(&resumed, 0),
		"codex >= 0.135, after compaction":    codexContext(job, 1),
		"codex 0.125-0.134 developer message": developerMessage(),
		"codex < 0.125 turn input":            turnInput(),
		"kimi":                                fmt.Sprint(prepareKimiPrompt(context.Background(), nil, job, &RunInboxResponse{Content: "hi"}, nil).blocks),
		"cursor":                              cursorAgentInstructions(job),
		"antigravity":                         antigravityInstructions(job, exe),
		"deepseek harness":                    dshSessionAgentOverlay(job).AppendSystemPrompt,
		"opencode":                            string(openCode),
		"orbit mcp initialize (every engine)": mcpInitializeInstructions(t),
	}
}

func mcpInitializeInstructions(t *testing.T) string {
	t.Helper()
	resp, _ := (&mcpServer{}).handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "initialize"})
	return resp.Result.(map[string]interface{})["instructions"].(string)
}

// Claude, every Codex instruction mode and every other engine are given the primer word for word, and
// keep it across a resume (a new process) and a compaction (a new Codex context generation).
func TestEveryEngineIsGivenTheSamePrimer(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, inside := range []bool{false, true} {
		job := &ClaimedSession{SessionID: "s-primer", SessionUUID: "11111111-2222-3333-4444-555555555555",
			WT:    &Worktree{Path: t.TempDir(), RepoDir: t.TempDir()},
			Agent: AgentExecConfig{AppendSystemPrompt: "Owner instructions.", Model: "test-model", PermissionMode: "default"}}
		if inside {
			job.TaskID = "task-1"
		}
		for carrier, text := range primerCarriers(t, job) {
			if !strings.Contains(text, agentPrimer) {
				t.Errorf("%s (inside recorded work: %v) is not given the primer:\n%s", carrier, inside, text)
			}
			if carrier != "orbit mcp initialize (every engine)" && !strings.Contains(text, "Owner instructions.") {
				t.Errorf("%s lost the agent's own prompt beside the primer", carrier)
			}
		}
	}
}

// After a compaction Codex has dropped the developer messages it held, so each instruction mode puts the
// primer back by its own means before the next turn: a new context generation, a re-injected developer
// message, or the turn input that carries it every time.
func TestCodexPutsThePrimerBackAfterCompaction(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	additional := &codexAppServer{instructionMode: codexInstructionsAdditionalContext}
	_, before := additional.prepareInstructionContext(func() error { return nil })
	additional.markInstructionContextForRefresh()
	_, after := additional.prepareInstructionContext(func() error {
		t.Fatal("additionalContext mode must not inject raw items")
		return nil
	})
	if after == before {
		t.Fatalf("a compaction left the context generation at %d, so Codex keeps the keys it already dropped", after)
	}
	for key := range codexAgentAdditionalContext(AgentExecConfig{}, exe, after, false, true) {
		if strings.HasPrefix(key, fmt.Sprintf("orbit_%08d_", before)) {
			t.Errorf("key %s survives the compaction unchanged", key)
		}
	}

	injected := []string{}
	items := &codexAppServer{instructionMode: codexInstructionsInjectItems}
	items.markInstructionContextForRefresh()
	items.prepareInstructionContext(func() error {
		for _, item := range codexInjectedAgentItems(AgentExecConfig{}, exe, false, true) {
			injected = append(injected, item["content"].([]map[string]interface{})[0]["text"].(string))
		}
		return nil
	})
	if len(injected) != 1 || !strings.Contains(injected[0], agentPrimer) {
		t.Errorf("the developer message re-injected after a compaction = %q, want the primer in it", injected)
	}

	job := &ClaimedSession{Agent: AgentExecConfig{}}
	for turn := 1; turn <= 2; turn++ {
		input := codexTurnParams("thread-1", job, "/repo", "/tmp/up", fmt.Sprintf("turn-%d", turn), "hi", nil,
			codexTurnContextOptions{Executable: exe, Mode: codexInstructionsUserInput})["input"].([]map[string]interface{})
		if !strings.Contains(input[0]["text"].(string), agentPrimer) {
			t.Errorf("turn %d of a Codex before 0.125 does not carry the primer: %#v", turn, input)
		}
	}
}

// The primer comes from the runner, never from the checkout: a repository's CLAUDE.md and AGENTS.md
// neither reach Orbit's instructions nor change them.
func TestThePrimerDoesNotComeFromTheRepository(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	checkout := t.TempDir()
	job := &ClaimedSession{SessionID: "s-repo", SessionUUID: "11111111-2222-3333-4444-555555555555",
		WT:    &Worktree{Path: checkout, RepoDir: checkout},
		Agent: AgentExecConfig{Model: "test-model", PermissionMode: "default"}}
	without := primerCarriers(t, job)
	const sentinel = "REPOSITORY-INSTRUCTIONS-c41e: Orbit tasks are optional here."
	for _, name := range []string{"CLAUDE.md", "AGENTS.md"} {
		if err := os.WriteFile(filepath.Join(checkout, name), []byte(sentinel+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	with := primerCarriers(t, job)
	for carrier, text := range with {
		if strings.Contains(text, "REPOSITORY-INSTRUCTIONS-c41e") {
			t.Errorf("%s carries the repository's own instruction file", carrier)
		}
		if text != without[carrier] {
			t.Errorf("%s changed when the checkout gained a CLAUDE.md and an AGENTS.md", carrier)
		}
		if !strings.Contains(text, agentPrimer) {
			t.Errorf("%s is not given the primer", carrier)
		}
	}
}

// `orbit mcp help` says what the server is today: the runtimes the runner starts it on, the objects its
// tools act on, and the primer it answers initialize with. It is reached the three ways help is, and
// `orbit mcp help` is the help, not a server reading stdin.
func TestOrbitMCPHelpMatchesTheRuntimesAndTheCatalogue(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	help := mcpHelp()
	for _, argv := range [][]string{{"mcp", "help"}, {"mcp", "--help"}, {"mcp", "-h"}, {"help", "mcp"}} {
		var out, errW bytes.Buffer
		if err := runOrbitCLI(argv, strings.NewReader(""), &out, &errW); err != nil {
			t.Fatalf("orbit %s: %v", strings.Join(argv, " "), err)
		}
		if out.String() != help {
			t.Errorf("orbit %s printed %q, want the mcp help", strings.Join(argv, " "), out.String())
		}
	}
	flat := strings.Join(strings.Fields(help), " ")
	for engine := range providerRuntimes {
		if !strings.Contains(flat, engineDisplayName(engine)) {
			t.Errorf("the help does not name %s, which the runner starts this server on", engineDisplayName(engine))
		}
	}
	labels := map[operationObject]string{}
	for _, named := range mcpHelpObjects {
		labels[named.object] = named.label
	}
	served := map[operationObject]bool{}
	for _, op := range operationCatalog().Ops {
		if op.MCP == nil {
			continue
		}
		served[op.Object] = true
		label, ok := labels[op.Object]
		if !ok {
			t.Errorf("%s acts on %q, which the help does not name", op.Tool, op.Object)
			continue
		}
		if !strings.Contains(flat, label) {
			t.Errorf("the help does not list %q", label)
		}
	}
	for object := range labels {
		if !served[object] {
			t.Errorf("the help names %q, which no MCP tool acts on", object)
		}
	}
	// The families contract §8.2 counts as orchestration-gated, and the help names them as such.
	gated := mcpHelpOrchestratedTools(operationCatalog().Ops)
	if want := "agent_*,project_ensure_coordinator,project_send,runner_*,session_*"; strings.Join(gated, ",") != want {
		t.Errorf("the orchestration-gated tools are %v, want %s (contract §8.2)", gated, want)
	}
	if !strings.Contains(flat, englishList(gated)+" are listed only while the account's Session orchestration is on") {
		t.Errorf("the help does not say the orchestration switch gates %v:\n%s", gated, help)
	}
	for _, phrase := range []string{
		"primer " + agentPrimerVersion, "Agent Contract " + agentContractVersion,
		fmt.Sprintf("at most %d characters", agentPrimerMaxBytes), fmt.Sprintf("first %d stand alone", agentPrimerLeadMaxChars),
		"orbit capabilities --json", "ORBIT_SESSION_ID",
	} {
		if !strings.Contains(flat, phrase) {
			t.Errorf("the help does not say %q:\n%s", phrase, help)
		}
	}
	for _, stale := range []string{"Task/TaskList", "a Claude Code session can manage Orbit Tasks", "via --mcp-config"} {
		if strings.Contains(flat, stale) {
			t.Errorf("the help still says %q", stale)
		}
	}
	for _, line := range strings.Split(help, "\n") {
		if utf8.RuneCountInString(line) > 92 {
			t.Errorf("help line over 92 characters: %q", line)
		}
	}
}
