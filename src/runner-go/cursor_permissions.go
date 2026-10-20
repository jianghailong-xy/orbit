package main

// Orbit's permission modes on Cursor CLI, and the answers to the requests Cursor CLI sends the client
// while a turn runs (docs/cursor-runtime-contract.md §4.2, §5, §16.5).
//
// What a mode can hold Cursor CLI 2026.10.14-941492e to, as measured: a write inside the workspace never
// asks, in any mode; a command off its allowlist (only `ls` is on it), an MCP tool, a web fetch or search,
// and a write outside the workspace send session/request_permission, which waits for its answer with no
// timeout (§5.2). So each mode is a launch (cursorPermissionArgs), a Cursor session mode, and a way of
// answering those requests:
//
//   - Accept Edits: a person answers each one on Orbit's approval card;
//   - Auto: Orbit allows a routine command itself (cursorAutoAllows) and puts the rest on the card;
//   - Plan: Cursor's own plan mode, which keeps its edit tool from writing, and every request refused unasked;
//   - Don't Ask: every request refused unasked, while a write inside the workspace still happens;
//   - Bypass: `--force`, under which nothing asks — unless the account's team has turned Run Everything
//     off, when Cursor CLI asks anyway (§5.3): a person then answers on the card, as in Accept Edits.
//
// Default, which would ask before an edit, cannot be had (D6), and is refused with any other mode.
//
// A call to Orbit's own MCP server is allowed unasked in every mode: the control plane gives every session
// that rule (ALWAYS_ALLOWED_TOOLS, mcp__orbit__*). A person's "always allow" is the control plane's standing
// grant on the workspace, which answers a later card of the same kind itself (permission-rules.ts). Cursor
// CLI's own allow-always is never chosen: it allowlists the whole program a command starts with — `git
// status` allowed always lets `git push` run unasked (6136.index.js@58262, persistAllowlistEntry) — which
// is wider than what the person approved, and it would stay in the CLI's config whatever the mode.
//
// Cursor CLI's two blocking questions go to a person the same way: cursor/create_plan, the plan Cursor
// asks to have accepted, as Orbit's plan card, and cursor/ask_question as its question card (§4.2).
//
// Every request is answered exactly once. One that offers options Orbit does not know is answered
// cancelled, never with a guess: an option is not chosen by its kind alone, since the fallback for an
// unanswered question offers each answer as an allow_once (6136.index.js@46614). A request that arrives
// while no turn is open, and every card still open when the turn is stopped, its process is lost or it
// settles, is answered cancelled, under the same lock as any allow: a person's answer that comes after
// reaches nothing.
//
// A request answered with anything but an allow while its turn runs — refused by a person or by the mode,
// cancelled because nobody could decide it, refused because Orbit could not tell what was asked — marks the
// card it is about before the answer goes out: Cursor CLI completes a command or an edit it was refused with
// no output at all (P8's and P5c's recordings), which would read as a success with nothing to show, so the
// card settles as not run (cursor_events.go). A card withdrawn unanswered because the turn ended is marked
// too, as withdrawn, when it is withdrawn: its request is answered cancelled whatever a person still says,
// which Cursor CLI takes as a refusal — P5c's accept-edits-stop and accept-edits-disconnect: the command never
// ran — and the turn's settlement, which can come before that answer goes out, settles it as not run. So is
// the card of a permission request that comes once the turn is ending, answered cancelled with nobody asked.

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

// How a mode answers a permission request no rule pre-approved.
const (
	cursorAnswerAsk    = "ask"    // Orbit's approval card
	cursorAnswerReview = "review" // Orbit allows a routine command itself; the rest go to the card
	cursorAnswerRefuse = "refuse" // refused unasked
)

// cursorPermissionPolicy is what one Orbit permission mode is on Cursor CLI.
type cursorPermissionPolicy struct {
	Mode string
	// ACPMode is the Cursor session mode the session runs in: agent, or plan.
	ACPMode string
	// Answer is how a permission request no rule pre-approved is answered.
	Answer string
	// Questions reach a person on a card; without, Cursor CLI is told they were skipped.
	Questions bool
	// Plans reach a person on the plan card; without, Cursor CLI is told the plan was rejected.
	Plans bool
}

// cursorPermissionPolicyFor is the policy of a permission mode, or why Cursor CLI cannot be held to it. An
// unset mode is the one the control plane gives a Cursor CLI session nobody named one for
// (CURSOR_DEFAULT_PERMISSION_MODE, Accept Edits).
func cursorPermissionPolicyFor(mode string) (cursorPermissionPolicy, error) {
	switch mode {
	case "acceptEdits", "":
		return cursorPermissionPolicy{Mode: "acceptEdits", ACPMode: "agent", Answer: cursorAnswerAsk, Questions: true, Plans: true}, nil
	case "auto":
		return cursorPermissionPolicy{Mode: mode, ACPMode: "agent", Answer: cursorAnswerReview, Questions: true, Plans: true}, nil
	case "plan":
		return cursorPermissionPolicy{Mode: mode, ACPMode: "plan", Answer: cursorAnswerRefuse, Questions: true, Plans: true}, nil
	case "dontAsk":
		return cursorPermissionPolicy{Mode: mode, ACPMode: "agent", Answer: cursorAnswerRefuse}, nil
	case "bypassPermissions":
		return cursorPermissionPolicy{Mode: mode, ACPMode: "agent", Answer: cursorAnswerAsk, Questions: true, Plans: true}, nil
	}
	return cursorPermissionPolicy{}, fmt.Errorf("CURSOR_PERMISSION_UNSUPPORTED: Cursor CLI cannot be held to permission mode %q; "+
		"use Accept Edits, Plan, Auto, Don't Ask or Bypass", mode)
}

// cursorToolPolicyError refuses a denylist Cursor CLI cannot be held to: it reads files and writes inside
// the workspace without asking, so a disallowed tool could run before anything saw it.
func cursorToolPolicyError(agent AgentExecConfig) error {
	for _, rule := range agent.DisallowedTools {
		if strings.TrimSpace(rule) != "" {
			return fmt.Errorf("CURSOR_TOOL_POLICY_UNSUPPORTED: Cursor CLI cannot enforce disallowedTools (%s): it reads and edits files "+
				"without asking; remove the denylist or use another runtime", rule)
		}
	}
	return nil
}

// The options Cursor CLI offers on every permission request (§5.2), by id with the kind each must have.
const (
	cursorAllowOnce   = "allow-once"
	cursorAllowAlways = "allow-always"
	cursorRejectOnce  = "reject-once"
)

var cursorPermissionOptionKinds = map[string]string{
	cursorAllowOnce:   "allow_once",
	cursorAllowAlways: "allow_always",
	cursorRejectOnce:  "reject_once",
}

// cursorKnownOptions is whether a request offers the options Orbit knows and nothing else: allow-once and
// reject-once, and allow-always beside them, each of its own kind.
func cursorKnownOptions(value interface{}) bool {
	rows, _ := value.([]interface{})
	offered := map[string]bool{}
	for _, row := range rows {
		option := mapValue(row)
		id := firstString(option, "optionId")
		if kind, known := cursorPermissionOptionKinds[id]; !known || firstString(option, "kind") != kind || offered[id] {
			return false
		}
		offered[id] = true
	}
	return offered[cursorAllowOnce] && offered[cursorRejectOnce]
}

func cursorSelected(optionID string) map[string]interface{} {
	return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "selected", "optionId": optionID}}
}

// cursorCancelled answers any of the three requests when nobody decided: Cursor CLI reads it as a refusal
// ("Cancelled", "User cancelled": 6136.index.js@56902, @46614, @51505).
func cursorCancelled() map[string]interface{} {
	return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "cancelled"}}
}

// cursorPermissionAsk is one thing Cursor CLI asks to do, as the Orbit tool it is.
type cursorPermissionAsk struct {
	TurnID string
	// ToolUseID names the card on the turn's transcript the approval is about, unique in the session.
	ToolUseID string
	Name      string // Bash, Write, Edit, Read, WebFetch, WebSearch, mcp__<server>__<tool>, …
	Input     interface{}
}

// cursorApprovalCard files one card and waits for its answer (bridgeCursorCard).
type cursorApprovalCard func(ctx context.Context, toolName string, input interface{}, toolUseID string) (*ApprovalDecisionResponse, error)

// cursorPendingAnswer is a request whose answer waits on a person's card: how to withdraw the card, and the
// tool card the request is about ("" for a question or a plan).
type cursorPendingAnswer struct {
	cancel context.CancelFunc
	card   string
}

// cursorPermissionBridge answers what Cursor CLI asks the client while a turn runs.
type cursorPermissionBridge struct {
	mu      sync.Mutex
	open    bool
	turnID  string
	next    int
	pending map[int]cursorPendingAnswer
	wg      sync.WaitGroup
	// bypassNoted: the notice that Bypass is asking anyway went out in this process.
	bypassNoted bool
	// mode is the policy requests are answered for, set by the session loop (setPolicy): a reload can move
	// the session between modes that keep the process.
	mode cursorPermissionPolicy

	// ask is what a request's tool call is, from the card the turn already shows (cursorEventMapper);
	// refused marks a card of the turn as a call that was not allowed (cursorEventMapper.refuse), withdrawn
	// as one whose approval card the turn's end withdrew unanswered (cursorEventMapper.withdraw).
	ask         func(toolCall map[string]interface{}) (cursorPermissionAsk, bool)
	refused     func(turnID, toolUseID string)
	withdrawn   func(turnID, toolUseID string)
	preApproved func(ask cursorPermissionAsk) bool
	card        cursorApprovalCard
	reply       func(id interface{}, result map[string]interface{})
	emit        emitTurnFn
	// workspace is the session's checkout, the one place a routine command in Auto may touch.
	workspace string
}

func newCursorPermissionBridge(policy cursorPermissionPolicy, ask func(map[string]interface{}) (cursorPermissionAsk, bool),
	refused, withdrawn func(turnID, toolUseID string), preApproved func(cursorPermissionAsk) bool, card cursorApprovalCard,
	emit emitTurnFn, workspace string) *cursorPermissionBridge {
	return &cursorPermissionBridge{pending: map[int]cursorPendingAnswer{}, mode: policy, ask: ask, refused: refused,
		withdrawn: withdrawn, preApproved: preApproved, card: card, emit: emit, workspace: workspace}
}

// policy is the policy requests are answered for now.
func (b *cursorPermissionBridge) policy() cursorPermissionPolicy {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.mode
}

// setPolicy answers every request from here on for policy.
func (b *cursorPermissionBridge) setPolicy(policy cursorPermissionPolicy) {
	b.mu.Lock()
	b.mode = policy
	b.mu.Unlock()
}

// begin opens the bridge for the turn whose prompt is about to be written.
func (b *cursorPermissionBridge) begin(turnID string) {
	b.mu.Lock()
	b.open, b.turnID = true, turnID
	b.mu.Unlock()
}

// close answers nothing but cancelled from here on, and withdraws every card still open: the turn was
// stopped, its process is gone, or it settled. The tool card a withdrawn permission request is about is
// marked here, before the turn's settlement can read it, rather than when the cancelled answer goes out.
func (b *cursorPermissionBridge) close() {
	b.mu.Lock()
	b.open = false
	for key, waiting := range b.pending {
		waiting.cancel()
		if waiting.card != "" {
			b.withdrawn(b.turnID, waiting.card)
		}
		delete(b.pending, key)
	}
	b.mu.Unlock()
}

// wait returns once every card's answer has been sent.
func (b *cursorPermissionBridge) wait() { b.wg.Wait() }

func (b *cursorPermissionBridge) current() (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.open, b.turnID
}

// now answers on the spot, with result while the turn is open and cancelled once it is not. card is the tool
// card a permission request is about; "" for a question or a plan.
func (b *cursorPermissionBridge) now(id interface{}, card string, result map[string]interface{}) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.open {
		b.answerClosed(id, card)
		return false
	}
	b.mark(card, result)
	b.reply(id, result)
	return true
}

// answerClosed answers a request that came once the bridge had closed: cancelled, nobody asked. The tool card
// a permission request is about is marked as withdrawn, as close marks one still open: the turn is ending, and
// the call will not run. Under the lock.
func (b *cursorPermissionBridge) answerClosed(id interface{}, card string) {
	if card != "" {
		b.withdrawn(b.turnID, card)
	}
	b.reply(id, cursorCancelled())
}

// later answers once decide has, on a goroutine of its own, so the reader never waits on a person; with
// cancelled if decide gives no answer or the bridge closed first.
func (b *cursorPermissionBridge) later(id interface{}, card string, decide func(ctx context.Context) map[string]interface{}) {
	ctx, cancel := context.WithCancel(context.Background())
	b.mu.Lock()
	if !b.open {
		b.answerClosed(id, card)
		b.mu.Unlock()
		cancel()
		return
	}
	b.next++
	key := b.next
	b.pending[key] = cursorPendingAnswer{cancel: cancel, card: card}
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		result := decide(ctx)
		b.mu.Lock()
		defer b.mu.Unlock()
		withdrawn := ctx.Err() != nil || !b.open // stopped, settled or disconnected while the card was open
		if result == nil || withdrawn {
			result = cursorCancelled()
		}
		if !withdrawn { // a withdrawn card was marked when close withdrew it
			b.mark(card, result)
		}
		delete(b.pending, key)
		cancel()
		b.reply(id, result)
	}()
}

// mark tells the card a permission request was about that the answer about to go out, while its turn runs,
// allows nothing: Cursor CLI will not run the call. Under the lock.
func (b *cursorPermissionBridge) mark(card string, result map[string]interface{}) {
	if card != "" && firstString(mapValue(result["outcome"]), "optionId") != cursorAllowOnce {
		b.refused(b.turnID, card)
	}
}

func (b *cursorPermissionBridge) note(turnID, subtype, toolUseID, name, reason string) {
	b.emit(turnID, evSystem, map[string]interface{}{"subtype": subtype, "provider": providerCursor,
		"toolUseId": toolUseID, "name": name, "reason": reason})
}

// permission answers a session/request_permission: from the rule that pre-approves it, from the mode, or
// from a person on Orbit's card.
func (b *cursorPermissionBridge) permission(id interface{}, params map[string]interface{}) {
	toolCall := mapValue(params["toolCall"])
	open, turnID := b.current()
	if !open {
		// Nobody is asked once the turn is ending, and the card the request is about is the turn's all the same.
		ask, _ := b.ask(toolCall)
		b.mu.Lock()
		b.answerClosed(id, ask.ToolUseID)
		b.mu.Unlock()
		return
	}
	if !cursorKnownOptions(params["options"]) {
		b.note(turnID, "permission_denied", firstString(toolCall, "toolCallId"), firstString(toolCall, "title"),
			"Cursor CLI offered approval options Orbit does not know")
		b.now(id, firstString(toolCall, "toolCallId"), cursorCancelled())
		return
	}
	ask, known := b.ask(toolCall)
	if !known {
		b.note(turnID, "permission_denied", firstString(toolCall, "toolCallId"), firstString(toolCall, "title"),
			"Orbit could not tell what Cursor CLI asked to run")
		b.now(id, firstNonEmpty(ask.ToolUseID, firstString(toolCall, "toolCallId")), cursorSelected(cursorRejectOnce))
		return
	}
	policy := b.policy()
	switch {
	case b.preApproved(ask):
		b.now(id, ask.ToolUseID, cursorSelected(cursorAllowOnce))
	case policy.Answer == cursorAnswerRefuse:
		if b.now(id, ask.ToolUseID, cursorSelected(cursorRejectOnce)) {
			b.note(ask.TurnID, "permission_denied", ask.ToolUseID, ask.Name, cursorModeName(policy.Mode)+" refuses without asking")
		}
	case policy.Answer == cursorAnswerReview && ask.Name == "Bash" && cursorAutoAllows(firstString(mapValue(ask.Input), "command"), b.workspace):
		if b.now(id, ask.ToolUseID, cursorSelected(cursorAllowOnce)) {
			b.note(ask.TurnID, "permission_auto_allowed", ask.ToolUseID, ask.Name, "Auto allows a routine command in the workspace")
		}
	default:
		if policy.Mode == "bypassPermissions" {
			b.noteBypass(ask.TurnID)
		}
		b.later(id, ask.ToolUseID, func(ctx context.Context) map[string]interface{} {
			decision, err := b.card(ctx, ask.Name, ask.Input, ask.ToolUseID)
			if err != nil {
				return nil
			}
			switch decision.Status {
			case "ALLOWED":
				// Once, even for "always": the standing grant answers the next card of its kind.
				return cursorSelected(cursorAllowOnce)
			case "DENIED":
				return cursorSelected(cursorRejectOnce)
			}
			return nil
		})
	}
}

// noteBypass says once per process why a session in Bypass is being asked at all.
func (b *cursorPermissionBridge) noteBypass(turnID string) {
	b.mu.Lock()
	noted := b.bypassNoted
	b.bypassNoted = true
	b.mu.Unlock()
	if !noted {
		b.emit(turnID, evSystem, map[string]interface{}{"noticeKind": "cursor-run-everything-off", "provider": providerCursor,
			"notice": "Cursor CLI asked for approval although this session runs in Bypass. It does that when the Cursor team has turned " +
				"Run Everything off, so Orbit asks you about each request instead."})
	}
}

// question answers a cursor/ask_question from a person on Orbit's question card: the options they picked,
// by the ids Cursor gave them, or skipped — with what they wrote instead, when they did (§4.2).
func (b *cursorPermissionBridge) question(id interface{}, params map[string]interface{}) {
	open, turnID := b.current()
	if !open {
		b.reply(id, cursorCancelled())
		return
	}
	type option struct{ id, label string }
	type question struct {
		id, prompt string
		options    []option
	}
	var questions []question
	var shown []interface{}
	rows, _ := params["questions"].([]interface{})
	for _, row := range rows {
		q := mapValue(row)
		asked := question{id: firstString(q, "id"), prompt: strings.TrimSpace(firstString(q, "prompt"))}
		var labels []interface{}
		options, _ := q["options"].([]interface{})
		for _, raw := range options {
			o := mapValue(raw)
			if label := strings.TrimSpace(firstString(o, "label")); label != "" && firstString(o, "id") != "" {
				asked.options = append(asked.options, option{firstString(o, "id"), label})
				labels = append(labels, map[string]interface{}{"label": label})
			}
		}
		if asked.id == "" || asked.prompt == "" || len(asked.options) == 0 {
			continue
		}
		questions = append(questions, asked)
		item := map[string]interface{}{"question": asked.prompt, "options": labels, "multiSelect": asBool(q["allowMultiple"])}
		if title := strings.TrimSpace(firstString(params, "title")); title != "" && len(rows) == 1 {
			item["header"] = title
		}
		shown = append(shown, item)
	}
	skipped := func(reason string) map[string]interface{} {
		return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "skipped", "reason": reason}}
	}
	toolUseID := firstNonEmpty(firstString(params, "toolCallId"), fmt.Sprintf("%s:ask_question:%v", turnID, id))
	switch {
	case len(questions) == 0:
		b.note(turnID, "question_skipped", toolUseID, "AskUserQuestion", "Cursor CLI asked no question Orbit could show")
		b.now(id, "", skipped("Orbit could not show these questions to the user."))
		return
	case !b.policy().Questions:
		if b.now(id, "", skipped("Nobody is asked in this session (Don't Ask).")) {
			b.note(turnID, "question_skipped", toolUseID, "AskUserQuestion", "Don't Ask asks nobody")
		}
		return
	}
	b.later(id, "", func(ctx context.Context) map[string]interface{} {
		decision, err := b.card(ctx, "AskUserQuestion", map[string]interface{}{"questions": shown}, toolUseID)
		if err != nil {
			return nil
		}
		if decision.Status != "ALLOWED" {
			if decision.Status != "DENIED" {
				return nil
			}
			return skipped(firstNonEmpty(strings.TrimSpace(decision.Message), "The user skipped the questions."))
		}
		var answers []interface{}
		for _, q := range questions {
			picked := map[string]bool{}
			for _, label := range decision.Answers[q.prompt] {
				picked[strings.TrimSpace(label)] = true
			}
			var ids []interface{}
			for _, o := range q.options {
				if picked[o.label] {
					ids = append(ids, o.id)
				}
			}
			if len(ids) > 0 {
				answers = append(answers, map[string]interface{}{"questionId": q.id, "selectedOptionIds": ids})
			}
		}
		if len(answers) == 0 {
			return skipped("The user answered with none of the options offered.")
		}
		return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "answered", "answers": answers}}
	})
}

// plan answers a cursor/create_plan from a person on Orbit's plan card: accepted, which leaves the plan
// with Cursor CLI to keep under its own (the session's) HOME, or rejected with what they said (§4.2).
func (b *cursorPermissionBridge) plan(id interface{}, params map[string]interface{}) {
	open, turnID := b.current()
	if !open {
		b.reply(id, cursorCancelled())
		return
	}
	rejected := func(reason string) map[string]interface{} {
		return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "rejected", "reason": reason}}
	}
	toolUseID := firstNonEmpty(firstString(params, "toolCallId"), fmt.Sprintf("%s:create_plan:%v", turnID, id))
	if !b.policy().Plans {
		if b.now(id, "", rejected("Nobody reviews plans in this session (Don't Ask).")) {
			b.note(turnID, "plan_rejected", toolUseID, "ExitPlanMode", "Don't Ask asks nobody")
		}
		return
	}
	text := strings.TrimSpace(firstString(params, "plan"))
	if text == "" {
		text = strings.TrimSpace(firstString(params, "overview"))
	}
	input := map[string]interface{}{"plan": text}
	if name := strings.TrimSpace(firstString(params, "name")); name != "" {
		input["name"] = name
	}
	b.later(id, "", func(ctx context.Context) map[string]interface{} {
		decision, err := b.card(ctx, "ExitPlanMode", input, toolUseID)
		if err != nil {
			return nil
		}
		switch decision.Status {
		case "ALLOWED":
			return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "accepted"}}
		case "DENIED":
			return rejected(firstNonEmpty(strings.TrimSpace(decision.Message), "The user rejected the plan."))
		}
		return nil
	})
}

// bridgeCursorCard files a card on the control plane and waits for a person's answer, for as long as it
// takes or until ctx ends (awaitApprovalDecision).
func bridgeCursorCard(t *Transport, sessionID string) cursorApprovalCard {
	return func(ctx context.Context, toolName string, input interface{}, toolUseID string) (*ApprovalDecisionResponse, error) {
		approvalID, err := t.createApproval(ctx, sessionID, map[string]interface{}{"toolName": toolName, "input": input, "toolUseId": toolUseID})
		if err != nil {
			return nil, err
		}
		return awaitApprovalDecision(ctx, t, sessionID, approvalID)
	}
}

// cursorPreApproved is whether a rule the session was dispatched with allows the call unasked: Orbit's own
// MCP tools (mcp__orbit__*), on the conservative terms kimiToolMatchesRule reads a rule — never a shell
// command by its prefix.
func cursorPreApproved(agent AgentExecConfig, ask cursorPermissionAsk) bool {
	for _, rule := range agent.AllowedTools {
		if kimiToolMatchesRule(rule, ask.Name, ask.Input) {
			return true
		}
	}
	return false
}

// cursorAutoAllows is whether Auto lets a command run without a person: a command Cursor CLI asked about
// runs with no sandbox at all, so only one that is routine by Codex's Auto rules (codexAutoApproval: no
// push, fetch, install, remote shell, inline interpreter, secret file or recursive delete), that acts on
// no other system (dshToolGateMatch), starts no container, and names no path outside the workspace and
// the temporary directories (dshCommandStaysInWorkspace). Anything this cannot read goes to a person.
func cursorAutoAllows(command, workspace string) bool {
	command = strings.TrimSpace(command)
	if command == "" || !filepath.IsAbs(workspace) {
		return false
	}
	allowed, decided := codexAutoApproval(codexApprovalRequest{}, map[string]interface{}{"command": command, "cwd": workspace},
		codexAutoApprovalContext{workspaceRoots: []string{workspace}})
	return allowed && decided && dshToolGateMatch(command) == "" && !dshContainerCommand.MatchString(command) &&
		dshCommandStaysInWorkspace(command, workspace, workspace)
}

func cursorModeName(mode string) string {
	switch mode {
	case "plan":
		return "Plan"
	case "dontAsk":
		return "Don't Ask"
	case "auto":
		return "Auto"
	case "bypassPermissions":
		return "Bypass"
	}
	return "Accept Edits"
}
