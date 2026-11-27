package main

// Low-sensitivity telemetry of how an agent uses Orbit, one summary per turn (docs/agent-contract-eval.md
// §Telemetry, contract §12).
//
// Every engine's events pass through the session's emit path (session.go emitThrough), and this observer reads
// them there: which tool calls a turn made, which of them were Orbit operations over MCP or through the `orbit` CLI,
// what each one's receipt said, how much the agent read to discover an operation, and whether the engine kept a
// plan of its own. When the turn ends it hands back one system event,
//
//	{"subtype": "agent_contract_telemetry", "agentContractTelemetry": {…}}
//
// filed just before the turn's turn_end, and only for a turn that touched Orbit or the engine's private plan. The
// summary is counts, catalogue operation names, receipt outcomes and error codes, and the versions the session ran
// under. It never carries an argument's value, a result's text, a reply, the person's words, an id, a path or a
// credential: every string in it is a version constant, a catalogue name or a code that matches a fixed pattern
// (TestAgentContractTelemetryCarriesNoCredentialsOrText). The same observer computes the black-box eval's metrics,
// so the eval reads production's code.
//
// ORBIT_AGENT_CONTRACT_TELEMETRY=off in the runner's environment turns it off; nothing else depends on it.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
)

const (
	agentContractTelemetrySubtype = "agent_contract_telemetry"
	agentContractTelemetryVersion = 1
	agentContractTelemetryEnv     = "ORBIT_AGENT_CONTRACT_TELEMETRY"
	// A turn longer than this is summarised from its first calls; a session holds at most a few open turns.
	agentContractTelemetryMaxSteps = 1000
	agentContractTelemetryMaxTurns = 8
)

// ── Reading a tool call as the contract does (shared with the eval's transcript) ───────────────────────

// orbitMCPOperation reads an engine's tool name as one of Orbit's MCP tools: mcp__orbit__X on Claude Code,
// orbit__X on Codex (server and tool joined, codexToolItemName). "" for any other tool.
func orbitMCPOperation(name string) string {
	for _, prefix := range []string{"mcp__orbit__", "orbit__"} {
		if strings.HasPrefix(name, prefix) {
			return strings.TrimPrefix(name, prefix)
		}
	}
	return ""
}

// privatePlanTools are the engine tools that keep a plan inside the conversation, never in Orbit: Codex's
// update_plan, Claude Code's plan approval and its todo family (which Orbit disallows, builtinTaskTools).
var privatePlanTools = map[string]bool{
	"update_plan": true, "ExitPlanMode": true, "TodoWrite": true, "TaskCreate": true, "TaskUpdate": true,
}

var (
	shellSegmentSplit = regexp.MustCompile(`&&|\|\||[;|\n]`)
	shellEnvAssign    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	planStepLine      = regexp.MustCompile(`^(\d+[.)]\s|#+\s*(Step|Phase)\s*\d+)`)
	telemetryCode     = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)
)

// quotedShellWords splits one simple command into words, honouring single and double quotes.
func quotedShellWords(s string) []string {
	var words []string
	var cur strings.Builder
	quote := rune(0)
	inWord := false
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			inWord = true
		case r == ' ' || r == '\t':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words
}

// orbitCLIInvocation finds the first Orbit CLI invocation in a shell command line: the words after the executable,
// and whether that executable was a PATH-resolved `orbit` rather than exe, the absolute path the runner gave. A
// command handed to a shell (`bash -lc '…'`, `sh -c "…"`, the form Codex reports its commands in) is read inside.
func orbitCLIInvocation(command, exe string) (args []string, bare, found bool) {
	return orbitCLIInvocationDepth(command, exe, 0)
}

var shellNames = map[string]bool{"bash": true, "sh": true, "zsh": true, "dash": true}

func orbitCLIInvocationDepth(command, exe string, depth int) (args []string, bare, found bool) {
	for _, segment := range shellSegmentSplit.Split(command, -1) {
		words := quotedShellWords(strings.TrimSpace(segment))
		for i, w := range words {
			// Env assignments and wrappers may stand in front of the executable; anything else ends the search.
			if shellEnvAssign.MatchString(w) || w == "env" || w == "exec" || w == "time" || w == "command" {
				continue
			}
			if (exe != "" && w == exe) || w == "orbit" {
				return words[i+1:], w == "orbit" && w != exe, true
			}
			if shellNames[filepath.Base(w)] && depth < 2 {
				for j := i + 1; j+1 < len(words); j++ {
					if flag := words[j]; strings.HasPrefix(flag, "-") && strings.Contains(flag, "c") {
						if args, bare, ok := orbitCLIInvocationDepth(words[j+1], exe, depth+1); ok {
							return args, bare, true
						}
						break
					}
				}
			}
			break
		}
	}
	// A shell's own text is split at its operators before it is read, so a wrapped command line is searched whole
	// too: `bash -lc 'cd x && orbit task list'` names Orbit after the `&&` inside the quotes.
	if depth == 0 {
		for _, w := range quotedShellWords(command) {
			if strings.ContainsAny(w, " \t") {
				if args, bare, ok := orbitCLIInvocationDepth(w, exe, depth+1); ok {
					return args, bare, true
				}
			}
		}
	}
	return nil, false, false
}

var cliOperationIndex struct {
	sync.Once
	ops []struct {
		words []string
		tool  string
	}
}

// orbitCLIOperation names the catalogue operation a CLI invocation runs: "guide", "capabilities" and "help" for
// discovery, "" for words no catalogued command starts with.
func orbitCLIOperation(args []string) string {
	var words []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			break
		}
		words = append(words, a)
	}
	if len(words) > 0 {
		switch words[0] {
		case "capabilities", "guide", "help":
			return words[0]
		}
	}
	cliOperationIndex.Do(func() {
		for _, op := range operationCatalog().Ops {
			if op.CLI == nil || len(op.CLI.Argv) < 2 {
				continue
			}
			cliOperationIndex.ops = append(cliOperationIndex.ops, struct {
				words []string
				tool  string
			}{append([]string(nil), op.CLI.Argv[1:]...), op.Tool})
		}
		sort.SliceStable(cliOperationIndex.ops, func(i, j int) bool {
			return len(cliOperationIndex.ops[i].words) > len(cliOperationIndex.ops[j].words)
		})
	})
	for _, op := range cliOperationIndex.ops {
		if len(words) < len(op.words) {
			continue
		}
		match := true
		for i := range op.words {
			if words[i] != op.words[i] {
				match = false
				break
			}
		}
		if match {
			return op.tool
		}
	}
	return ""
}

// orbitToolResultText is a tool result's content as text: a string, the text parts of a content array, or, for a Codex
// MCP result object, its structured content.
func orbitToolResultText(content interface{}) string {
	switch v := content.(type) {
	case string:
		return v
	case []interface{}:
		var b strings.Builder
		for _, part := range v {
			if m := mapValue(part); m != nil {
				if text, ok := m["text"].(string); ok {
					b.WriteString(text)
					continue
				}
			}
			if raw, err := json.Marshal(part); err == nil {
				b.Write(raw)
			}
		}
		return b.String()
	case map[string]interface{}:
		if sc, ok := v["structuredContent"]; ok && sc != nil {
			raw, _ := json.Marshal(sc)
			return string(raw)
		}
		if inner, ok := v["content"]; ok {
			return orbitToolResultText(inner)
		}
		raw, _ := json.Marshal(v)
		return string(raw)
	case nil:
		return ""
	}
	raw, _ := json.Marshal(content)
	return string(raw)
}

// contractReceiptRead is what a receipt says, as far as telemetry and the eval's graders read it.
type contractReceiptRead struct {
	OK             bool
	Outcome        string
	ID             string
	Status         string
	Code           string
	Retry          string
	Approval       string
	StartSessionID string
	ItemIDs        []string
}

// findContractReceipt reads the first receipt document (contract §6.3) in text.
func findContractReceipt(text string) (contractReceiptRead, bool) {
	for start := strings.IndexByte(text, '{'); start >= 0; {
		dec := json.NewDecoder(strings.NewReader(text[start:]))
		var doc map[string]interface{}
		if dec.Decode(&doc) == nil {
			if _, ok := doc["receiptVersion"]; ok {
				return contractReceiptFromDoc(doc), true
			}
		}
		next := strings.IndexByte(text[start+1:], '{')
		if next < 0 {
			break
		}
		start += next + 1
	}
	return contractReceiptRead{}, false
}

func contractReceiptFromDoc(doc map[string]interface{}) contractReceiptRead {
	var r contractReceiptRead
	r.OK, _ = doc["ok"].(bool)
	r.Outcome = asString(doc["outcome"])
	r.ID = asString(doc["id"])
	r.Status = asString(doc["status"])
	if e := mapValue(doc["error"]); e != nil {
		r.Code = asString(e["code"])
		r.Retry = asString(e["retry"])
	}
	if a := mapValue(doc["approval"]); a != nil {
		r.Approval = asString(a["outcome"])
	}
	if s := mapValue(doc["start"]); s != nil {
		r.StartSessionID = asString(s["sessionId"])
	}
	if items, ok := doc["items"].([]interface{}); ok {
		for _, item := range items {
			if id := asString(mapValue(item)["id"]); id != "" {
				r.ItemIDs = append(r.ItemIDs, id)
			}
		}
	}
	return r
}

// privatePlanItems counts the items of a private plan tool's input: its rows, or the numbered steps of the plan
// text Claude Code's ExitPlanMode carries.
func privatePlanItems(input map[string]interface{}) int {
	if rows := planEntries(input); len(rows) > 0 {
		return len(rows)
	}
	n := 0
	for _, line := range strings.Split(asString(input["plan"]), "\n") {
		if planStepLine.MatchString(strings.TrimSpace(line)) {
			n++
		}
	}
	return n
}

// ── The observer ─────────────────────────────────────────────────────────────────────────────────────

// agentContractTurnTelemetry is one turn's summary.
type agentContractTurnTelemetry struct {
	Version       int    `json:"v"`
	Contract      string `json:"contract"`
	Primer        string `json:"primer"`
	Catalog       string `json:"catalog"`
	Engine        string `json:"engine"`
	Mode          string `json:"mode,omitempty"`
	Orchestration bool   `json:"orchestration"`
	ToolCalls     int    `json:"toolCalls"`
	OrbitCalls    int    `json:"orbitCalls"`
	OrbitCallsCLI int    `json:"orbitCallsCli"`
	OrbitWrites   int    `json:"orbitWrites"`
	// FirstOrbitSuccessStep is the 1-based position, among the turn's tool calls, of its first Orbit call that was
	// not discovery (guide, capabilities, help) and whose answer was a success: the steps from the person's words to
	// Orbit doing what they asked.
	FirstOrbitSuccessStep *int `json:"firstOrbitSuccessStep"`
	DiscoveryCalls        int  `json:"discoveryCalls"`
	DiscoveryBytes        int  `json:"discoveryBytes"`
	// InstructionBytes is the Orbit instructions the session's engine was given (the primer and what follows it).
	InstructionBytes int `json:"instructionBytes,omitempty"`
	// InstructionManifestHash is the composite hash of the units sent (instructionManifest.Hash) and
	// InstructionUnits their ids in order: which instructions a turn ran under, not only how many bytes.
	InstructionManifestHash string         `json:"instructionManifestHash,omitempty"`
	InstructionUnits        []string       `json:"instructionUnits,omitempty"`
	Operations              map[string]int `json:"operations,omitempty"`
	Outcomes                map[string]int `json:"outcomes,omitempty"`
	Failures                map[string]int `json:"failures,omitempty"`
	PrivatePlanCalls        int            `json:"privatePlanCalls"`
	PrivatePlanItems        int            `json:"privatePlanItems"`
	BareOrbitCalls          int            `json:"bareOrbitCalls,omitempty"`
}

type telemetryStep struct {
	op      string
	cli     bool
	orbit   bool
	pos     int // the step's 1-based position among the turn's tool calls
	settled bool
}

type telemetryTurn struct {
	sum   agentContractTurnTelemetry
	steps map[string]*telemetryStep // by tool_use id
	n     int
}

// agentContractTelemetry is one session's observer. A nil observer observes nothing.
type agentContractTelemetry struct {
	mu            sync.Mutex
	engine        string
	exe           string
	mode          func() string
	orchestration bool
	instructions  int
	manifest      instructionManifest
	turns         map[string]*telemetryTurn
	order         []string
}

// agentContractTelemetryOn says whether the runner's environment leaves the telemetry on.
func agentContractTelemetryOn() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(agentContractTelemetryEnv))) {
	case "off", "0", "false", "no":
		return false
	}
	return true
}

// newAgentContractTelemetry is the observer for one session's events, or nil when the telemetry is off.
func newAgentContractTelemetry(engine, exe string, mode func() string, orchestration bool, instructionBytes int) *agentContractTelemetry {
	if !agentContractTelemetryOn() {
		return nil
	}
	return &agentContractTelemetry{engine: engine, exe: exe, mode: mode, orchestration: orchestration,
		instructions: instructionBytes, turns: map[string]*telemetryTurn{}}
}

// newSessionAgentContractTelemetry is newAgentContractTelemetry for a session the runner is running.
func newSessionAgentContractTelemetry(job *ClaimedSession) *agentContractTelemetry {
	exe := orbitCLIExecutable()
	// Measured in Claude Code's spelling whatever the engine, as it always has been.
	shape := job.sessionShape(exe)
	instructions := len(compose(shape, claudeCodeProfile).System)
	obs := newAgentContractTelemetry(runtimeProvider(job), exe, func() string {
		if job.liveMode != nil {
			if mode := job.liveMode.current(); mode != "" {
				return mode
			}
		}
		return job.Agent.PermissionMode
	}, job.AllowOrchestration, instructions)
	if obs != nil {
		obs.manifest = composeManifest(shape, claudeCodeProfile)
	}
	return obs
}

func (a *agentContractTelemetry) turn(id string) *telemetryTurn {
	t := a.turns[id]
	if t != nil {
		return t
	}
	if len(a.order) >= agentContractTelemetryMaxTurns {
		delete(a.turns, a.order[0])
		a.order = a.order[1:]
	}
	t = &telemetryTurn{steps: map[string]*telemetryStep{}, sum: agentContractTurnTelemetry{
		Version: agentContractTelemetryVersion, Contract: agentContractVersion, Primer: agentPrimerVersion,
		Catalog: operationCatalogVersion, Engine: a.engine, Orchestration: a.orchestration, InstructionBytes: a.instructions,
		InstructionManifestHash: a.manifest.Hash, InstructionUnits: a.manifest.UnitIDs,
	}}
	a.turns[id] = t
	a.order = append(a.order, id)
	return t
}

func bump(m *map[string]int, key string) {
	if *m == nil {
		*m = map[string]int{}
	}
	(*m)[key]++
}

// observe reads one event of the turn turnID. At the turn's turn_end it answers the payload of the summary event to
// file ahead of it, or nil when the turn touched neither Orbit nor a private plan; every other event answers nil.
func (a *agentContractTelemetry) observe(turnID, eventType string, payload map[string]interface{}) map[string]interface{} {
	if a == nil || payload["parentToolUseId"] != nil {
		return nil // a sub-agent's calls are its own
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	switch eventType {
	case evToolUse:
		t := a.turn(turnID)
		if t.n >= agentContractTelemetryMaxSteps {
			return nil
		}
		t.n++
		t.sum.ToolCalls++
		name := asString(payload["name"])
		step := &telemetryStep{}
		input := mapValue(payload["input"])
		switch {
		case orbitMCPOperation(name) != "":
			step.orbit, step.op = true, orbitMCPOperation(name)
		case privatePlanTools[name]:
			t.sum.PrivatePlanCalls++
			t.sum.PrivatePlanItems += privatePlanItems(input)
		case name == "Bash" || name == "shell" || name == "exec_command":
			if args, bare, ok := orbitCLIInvocation(asString(input["command"]), a.exe); ok {
				step.orbit, step.cli, step.op = true, true, orbitCLIOperation(args)
				if bare {
					t.sum.BareOrbitCalls++
				}
			}
		}
		if step.orbit {
			t.sum.OrbitCalls++
			if step.cli {
				t.sum.OrbitCallsCLI++
			}
			op := step.op
			if lookupCatalogOperation(op) == nil && op != "guide" && op != "capabilities" && op != "help" {
				op = "other"
			}
			step.op = op
			bump(&t.sum.Operations, op)
			if op == "guide" || op == "capabilities" || op == "help" {
				t.sum.DiscoveryCalls++
			}
		}
		step.pos = t.n
		if id := asString(payload["id"]); id != "" {
			t.steps[id] = step
		}
	case evToolResult:
		t := a.turns[turnID]
		if t == nil {
			return nil
		}
		id := asString(payload["toolUseId"])
		step := t.steps[id]
		if step == nil || step.settled || !step.orbit {
			return nil
		}
		step.settled = true
		text := orbitToolResultText(payload["content"])
		isErr, _ := payload["isError"].(bool)
		if step.op == "guide" || step.op == "capabilities" || step.op == "help" {
			t.sum.DiscoveryBytes += len(text)
		}
		outcome, code := "", ""
		if receipt, ok := findContractReceipt(text); ok {
			outcome, code = receipt.Outcome, receipt.Code
		} else if strings.HasPrefix(strings.TrimSpace(text), ownerChatLead) {
			outcome = outcomeChat
		} else if !isErr && strings.TrimSpace(text) != "" {
			outcome = outcomeRead
		} else {
			outcome, code = outcomeFailed, "UNREADABLE_ANSWER"
		}
		if !slices.Contains(receiptOutcomes, outcome) {
			outcome = "other"
		}
		bump(&t.sum.Outcomes, outcome)
		if code != "" {
			if !telemetryCode.MatchString(code) {
				code = "OTHER"
			}
			bump(&t.sum.Failures, code)
		}
		if outcome == outcomeWritten {
			t.sum.OrbitWrites++
		}
		discovery := step.op == "guide" || step.op == "capabilities" || step.op == "help"
		if !discovery && (outcome == outcomeWritten || outcome == outcomeRead || outcome == outcomeDryRun) && t.sum.FirstOrbitSuccessStep == nil {
			pos := step.pos
			t.sum.FirstOrbitSuccessStep = &pos
		}
	case evTurnEnd:
		t := a.turns[turnID]
		delete(a.turns, turnID)
		for i, id := range a.order {
			if id == turnID {
				a.order = append(a.order[:i], a.order[i+1:]...)
				break
			}
		}
		if t == nil || (t.sum.OrbitCalls == 0 && t.sum.PrivatePlanCalls == 0) {
			return nil
		}
		if a.mode != nil {
			t.sum.Mode = a.mode()
			if !slices.Contains(allPermissionModes, t.sum.Mode) {
				t.sum.Mode = ""
			}
		}
		var doc map[string]interface{}
		raw, _ := json.Marshal(t.sum)
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if dec.Decode(&doc) != nil {
			return nil
		}
		return map[string]interface{}{"subtype": agentContractTelemetrySubtype, "agentContractTelemetry": doc}
	}
	return nil
}
