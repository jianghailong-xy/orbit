package main

// An eval run's transcript, in one shape for every engine (docs/agent-contract-eval.md).
//
// The drivers do not read an engine's own protocol into the graders. They hand every frame to the code the runner
// itself turns it into Orbit's run events with — handleMessage for Claude Code's stream-json,
// handleCodexAppNotification for Codex's app-server — and the transcript is built from those events: what the
// session's own record would hold. A tool call is then classified the way the contract reads it: an Orbit
// operation over MCP (mcp__orbit__X on Claude, orbit__X on Codex), the same operation through the `orbit` CLI
// (a shell command naming the runner's absolute executable, or a bare `orbit`, which is a contract breach of its
// own, §2.3), the engine's private plan (Codex's update_plan, Claude's ExitPlanMode or a todo tool), or anything
// else. An Orbit call's answer is read for its receipt (§6.3).

import (
	"encoding/json"
	"strings"
	"sync"
)

// evalEvent is one run event a driver recorded, filed against the eval turn it happened in.
type evalEvent struct {
	Turn    int
	Type    string
	Payload map[string]interface{}
}

// evalRecorder is the emitFn every driver hands the runner's own translation code.
type evalRecorder struct {
	mu     sync.Mutex
	turn   int
	events []evalEvent
}

func (r *evalRecorder) setTurn(turn int) {
	r.mu.Lock()
	r.turn = turn
	r.mu.Unlock()
}

func (r *evalRecorder) emit(eventType string, payload map[string]interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, evalEvent{Turn: r.turn, Type: eventType, Payload: payload})
}

func (r *evalRecorder) snapshot() []evalEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]evalEvent(nil), r.events...)
}

// Step kinds.
const (
	evalStepOrbit       = "orbit"        // an Orbit operation, over MCP or the CLI
	evalStepPrivatePlan = "private_plan" // the engine's own plan or todo tool
	evalStepOther       = "other_tool"   // any other tool call
	evalStepText        = "text"         // assistant text
)

// evalReceiptLite is what the graders need from an Orbit call's answer.
type evalReceiptLite struct {
	Present        bool // the answer was a receipt document
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

// evalStep is one thing the agent did in a turn.
type evalStep struct {
	Kind      string
	Tool      string // the engine's tool name
	Operation string // the catalogue operation an Orbit step is (task_create, …), "" when unknown
	Surface   string // "mcp" or "cli" for an Orbit step
	Input     map[string]interface{}
	Command   string // a shell step's command line
	BareOrbit bool   // the command ran a PATH-resolved `orbit`, not the absolute executable
	// CLIArgs is an Orbit CLI step's words after the executable.
	CLIArgs   []string
	Result    string
	IsError   bool
	Receipt   evalReceiptLite
	PlanItems int // a private plan step's item count
	Text      string
}

// evalTurnLog is one turn's steps, its reply and what the engine reported about it.
type evalTurnLog struct {
	Index int
	// Spec is the scenario turn this log turn belongs to: a follow-up shares its turn's Spec.
	Spec     int
	Prompt   string
	Mode     string
	Before   string // "", "compact" or "resume": what happened to the context before this turn
	FollowUp bool   // the person's canned answer to a question the agent ended its previous turn with
	// Wake is the control plane's turn for owner waits a call handed to a runner-hosted job, which ended
	// (agent_eval_wake_test.go): its words are the wake block, not the person's.
	Wake      bool
	Steps     []evalStep
	Reply     string
	Compacted bool // the engine reported a compaction during or before this turn
	// ResetDone says the harness did what Before asked: the engine compacted, or was stopped and resumed.
	ResetDone bool
	// Telemetry is what production's observer (agent_contract_telemetry.go) summarises the turn as.
	Telemetry *agentContractTurnTelemetry
	Usage     evalUsage
	Error     string
}

// evalUsage is the engine's own accounting of one turn, when it reports one.
type evalUsage struct {
	InputTokens       int `json:"inputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	OutputTokens      int `json:"outputTokens"`
	DurationMs        int `json:"durationMs"`
}

func evalFindReceipt(text string) (evalReceiptLite, bool) {
	r, ok := findContractReceipt(text)
	if !ok {
		return evalReceiptLite{}, false
	}
	return evalReceiptLite{Present: true, OK: r.OK, Outcome: r.Outcome, ID: r.ID, Status: r.Status, Code: r.Code, Retry: r.Retry,
		Approval: r.Approval, StartSessionID: r.StartSessionID, ItemIDs: r.ItemIDs}, true
}

// evalContentText is a tool result's content as text (production's orbitToolResultText).
func evalContentText(content interface{}) string { return orbitToolResultText(content) }

// evalTurnSteps builds one turn's steps from its events, pairing each tool call with its result.
func evalTurnSteps(events []evalEvent, exe string) ([]evalStep, string, bool) {
	var steps []evalStep
	byID := map[string]int{}
	var reply []string
	compacted := false
	for _, ev := range events {
		switch ev.Type {
		case evAssistant:
			if ev.Payload["parentToolUseId"] != nil {
				continue // a sub-agent's text is not this agent's reply
			}
			text := asString(ev.Payload["text"])
			if strings.TrimSpace(text) == "" {
				continue
			}
			steps = append(steps, evalStep{Kind: evalStepText, Text: text})
			reply = append(reply, text)
		case evToolUse:
			name := asString(ev.Payload["name"])
			input := mapValue(ev.Payload["input"])
			if input == nil {
				if raw, ok := ev.Payload["input"].(string); ok {
					_ = json.Unmarshal([]byte(raw), &input)
				}
			}
			step := evalStep{Kind: evalStepOther, Tool: name, Input: input}
			if op := orbitMCPOperation(name); op != "" {
				step.Kind, step.Operation, step.Surface = evalStepOrbit, op, "mcp"
			} else if privatePlanTools[name] {
				step.Kind = evalStepPrivatePlan
				step.PlanItems = privatePlanItems(input)
			} else if name == "Bash" || name == "shell" || name == "exec_command" {
				step.Command = asString(input["command"])
				if args, bare, ok := orbitCLIInvocation(step.Command, exe); ok {
					step.Kind, step.Surface, step.BareOrbit, step.CLIArgs = evalStepOrbit, "cli", bare, args
					step.Operation = orbitCLIOperation(args)
				}
			}
			byID[asString(ev.Payload["id"])] = len(steps)
			steps = append(steps, step)
		case evToolResult:
			i, ok := byID[asString(ev.Payload["toolUseId"])]
			if !ok {
				continue
			}
			step := &steps[i]
			step.Result = evalContentText(ev.Payload["content"])
			step.IsError, _ = ev.Payload["isError"].(bool)
			if step.Kind == evalStepOrbit {
				if receipt, found := evalFindReceipt(step.Result); found {
					step.Receipt = receipt
				} else if strings.HasPrefix(strings.TrimSpace(step.Result), ownerChatLead) {
					step.Receipt = evalReceiptLite{Present: true, Outcome: outcomeChat, Approval: approvalOutcomeChat}
				} else if !step.IsError && step.Result != "" {
					// A read answered with prose or a bare entity document: a read that ran.
					step.Receipt = evalReceiptLite{OK: true, Outcome: outcomeRead}
				}
			}
		case evSystem:
			if asString(ev.Payload["subtype"]) == "compact_boundary" || ev.Payload["compactMetadata"] != nil ||
				asString(ev.Payload["subtype"]) == "compact_summary" || asString(ev.Payload["subtype"]) == "context_compacted" {
				compacted = true
			}
		}
	}
	return steps, strings.Join(reply, "\n\n"), compacted
}

// orbitSteps is a turn's Orbit calls.
func (t evalTurnLog) orbitSteps() []evalStep {
	var out []evalStep
	for _, s := range t.Steps {
		if s.Kind == evalStepOrbit {
			out = append(out, s)
		}
	}
	return out
}

// mutatingAttempts is a turn's Orbit calls of operations that write, answered or not.
func (t evalTurnLog) mutatingAttempts() []evalStep {
	var out []evalStep
	for _, s := range t.orbitSteps() {
		if op := lookupCatalogOperation(s.Operation); op != nil && op.Mutates {
			out = append(out, s)
		}
	}
	return out
}

// toolCalls counts a turn's tool calls of every kind.
func (t evalTurnLog) toolCalls() int {
	n := 0
	for _, s := range t.Steps {
		if s.Kind != evalStepText {
			n++
		}
	}
	return n
}
