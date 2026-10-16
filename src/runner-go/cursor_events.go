package main

// Cursor CLI's ACP stream as Orbit's transcript (docs/cursor-runtime-contract.md §4.1, §16.4).
//
// Text and thinking arrive token by token, with no message id. Each chunk goes out as a live delta,
// and a stretch of one kind is closed into its durable assistant or thinking event when the stream
// moves on — to the other kind, a tool, or the end of the turn — the shape Kimi's ACP chunks get
// (kimi_acp.go).
//
// A tool card arrives generic and is filled in: `tool_call` can say no more than "Edit File" or
// "MCP: tool" over an empty rawInput, then `tool_call_update`s complete the title and the input, mark
// it in_progress, and complete it. So a card goes out once its input is whole — at in_progress, and an
// edit at its completion, the only update that carries the change it made — under the name and input
// of the Orbit tool it is (cursorToolCall). There is no `failed` status: the outcome is read from
// rawOutput (cursorToolResult).
//
// A sub-agent's own updates arrive under the sub-agent's session id, which subagent_spawned binds to
// the Task card that launched it: they go out stamped with that card's id (parentToolUseId, which the
// clients nest by), as durable blocks only.
//
// The title (session_info_update) and the slash commands (available_commands_update) describe the
// session rather than a turn, and can arrive after the turn they came with has ended (§3.2): neither
// joins a turn. Cursor reports no usage of any kind (§4.1), so nothing here reads out a context or a cost.

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// cursorStretch is the text or thinking an agent is in the middle of, not yet closed into its block.
type cursorStretch struct {
	event string // evAssistant or evThinking; "" while nothing is open
	text  strings.Builder
}

// cursorTool is one tool card of a turn, as its updates have filled it in so far.
type cursorTool struct {
	id, kind, title string
	rawInput        map[string]interface{}
	rawOutput       interface{}
	content         []interface{}
	// session is the agent that runs the tool; parent is the Task card that agent nests under, "" for
	// the session's own agent.
	session, parent string
	// subagent is the kind of sub-agent a Task card launched, once subagent_spawned names it.
	subagent      string
	emitted, done bool
}

type cursorTurn struct {
	id      string
	main    cursorStretch
	replies []string // the closed text stretches of the session's own agent: the turn's result
	tools   map[string]*cursorTool
	order   []string
	agents  map[string]*cursorStretch // each sub-agent's open stretch, by its session id
	spawned []string                  // the sub-agents' session ids, in the order they started
	plans   int
}

type cursorEventMapper struct {
	mu        sync.Mutex
	sessionID string
	emitFor   emitTurnFn
	active    *cursorTurn
	settled   map[string]bool
	// retired holds the tool ids of settled turns: an update naming one belongs to no turn.
	retired map[string]bool
	// subagents binds each sub-agent of the running turn to the card that launched it, by session id.
	subagents map[string]string
	title     string
	// onTitle receives each new title Cursor gives the session, onCommands the slash commands it
	// lists. Both are called without the mapper's lock, from the reader: neither may block.
	onTitle    func(title string)
	onCommands func(names []string)
}

func newCursorEventMapper(emitFor emitTurnFn) *cursorEventMapper {
	return &cursorEventMapper{emitFor: emitFor, settled: map[string]bool{}, retired: map[string]bool{},
		subagents: map[string]string{}}
}

// bind names the session this mapper's updates belong to: session/new's answer, applied by the
// reader before it reads the next line, which can already be one of that session's updates.
func (m *cursorEventMapper) bind(sessionID string) {
	m.mu.Lock()
	m.sessionID = sessionID
	m.mu.Unlock()
}

func (m *cursorEventMapper) begin(turnID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case turnID == "":
		return fmt.Errorf("cursor turn id is empty")
	case m.active != nil:
		return fmt.Errorf("cursor turn %s is still active", m.active.id)
	case m.settled[turnID]:
		return fmt.Errorf("cursor turn %s has already settled", turnID)
	}
	m.active = &cursorTurn{id: turnID, tools: map[string]*cursorTool{}, agents: map[string]*cursorStretch{}}
	return nil
}

// update applies one session/update notification.
func (m *cursorEventMapper) update(params map[string]interface{}) {
	update := mapValue(params["update"])
	session := firstString(params, "sessionId")
	kind := firstString(update, "sessionUpdate")
	m.mu.Lock()
	own := session != "" && session == m.sessionID
	if !own && m.subagents[session] == "" {
		m.mu.Unlock()
		return // neither this session's nor one of its sub-agents'
	}
	switch kind {
	case "session_info_update":
		title := strings.TrimSpace(firstString(update, "title"))
		report := m.onTitle
		if !own || title == "" || title == m.title {
			report = nil
		} else {
			m.title = title
		}
		m.mu.Unlock()
		if report != nil {
			report(title)
		}
		return
	case "available_commands_update":
		var names []string
		rows, _ := update["availableCommands"].([]interface{})
		for _, row := range rows {
			if name := strings.TrimSpace(firstString(mapValue(row), "name")); name != "" {
				names = append(names, name)
			}
		}
		report := m.onCommands
		m.mu.Unlock()
		if own && report != nil && len(names) > 0 {
			report(names)
		}
		return
	}
	defer m.mu.Unlock()
	turn := m.active
	if turn == nil {
		return // no turn is running, so this belongs to none
	}
	switch kind {
	case "agent_message_chunk", "agent_thought_chunk":
		m.chunk(turn, session, kind, update)
	case "tool_call", "tool_call_update":
		m.tool(turn, session, update)
	case "plan":
		m.plan(turn, session, update)
	case "subagent_spawned":
		m.spawn(turn, update)
	case "subagent_state_update":
		// The sub-agent has stopped: what it was saying is all it will say.
		m.flushAgent(turn, firstString(update, "subagentSessionId"))
	default:
		// user_message_chunk is a session/load replay of Orbit's own prompt; a mode change has no
		// transcript form; config_option_update and usage_update are never sent (§4.1).
		logUnhandledStreamKind("cursor", kind, "user_message_chunk", "current_mode_update", "config_option_update", "usage_update")
	}
}

func (m *cursorEventMapper) chunk(turn *cursorTurn, session, kind string, update map[string]interface{}) {
	content := mapValue(update["content"])
	text := firstString(content, "text")
	if firstString(content, "type") != "text" || text == "" {
		return
	}
	event, delta := evAssistant, evTextDelta
	if kind == "agent_thought_chunk" {
		event, delta = evThinking, evThinkingDelta
	}
	if session != m.sessionID {
		stretch := turn.agents[session]
		if stretch == nil {
			stretch = &cursorStretch{}
			turn.agents[session] = stretch
		}
		if stretch.event != event {
			m.flushAgent(turn, session)
			stretch.event = event
		}
		stretch.text.WriteString(text)
		return
	}
	if turn.main.event != event {
		m.flushMain(turn)
		turn.main.event = event
	}
	turn.main.text.WriteString(text)
	m.emitFor(turn.id, delta, map[string]interface{}{"text": text})
}

// flushMain closes the session's own agent's open stretch into its block.
func (m *cursorEventMapper) flushMain(turn *cursorTurn) {
	event, text := turn.main.event, strings.TrimSpace(turn.main.text.String())
	turn.main.event = ""
	turn.main.text.Reset()
	if text == "" {
		return
	}
	if event == evAssistant {
		turn.replies = append(turn.replies, text)
	}
	m.emitFor(turn.id, event, map[string]interface{}{"text": text})
}

// flushAgent closes a sub-agent's open stretch into its block, under the card that launched it.
func (m *cursorEventMapper) flushAgent(turn *cursorTurn, session string) {
	stretch := turn.agents[session]
	parent := m.subagents[session]
	if stretch == nil || parent == "" {
		return
	}
	event, text := stretch.event, strings.TrimSpace(stretch.text.String())
	stretch.event = ""
	stretch.text.Reset()
	if text == "" {
		return
	}
	m.emitParent(turn, parent)
	m.emitFor(turn.id, event, map[string]interface{}{"text": text, "parentToolUseId": parent})
}

func (m *cursorEventMapper) tool(turn *cursorTurn, session string, update map[string]interface{}) {
	id := firstString(update, "toolCallId")
	if id == "" || m.retired[id] {
		return
	}
	tool := turn.tools[id]
	if tool == nil {
		tool = &cursorTool{id: id, session: session, parent: m.subagents[session]}
		turn.tools[id] = tool
		turn.order = append(turn.order, id)
	}
	if tool.done {
		return
	}
	if title := firstString(update, "title"); title != "" {
		tool.title = title
	}
	if kind := firstString(update, "kind"); kind != "" {
		tool.kind = kind
	}
	if input := mapValue(update["rawInput"]); input != nil {
		tool.rawInput = input
	}
	if output := update["rawOutput"]; output != nil {
		tool.rawOutput = output
	}
	if content, _ := update["content"].([]interface{}); len(content) > 0 {
		tool.content = content
	}
	switch firstString(update, "status") {
	case "in_progress":
		if tool.kind != "edit" {
			m.emitToolUse(turn, tool)
		}
	case "completed", "failed":
		m.emitToolUse(turn, tool)
		content, isError := cursorToolResult(tool)
		m.emitToolResult(turn, tool, content, isError)
	}
}

func (m *cursorEventMapper) emitToolUse(turn *cursorTurn, tool *cursorTool) {
	if tool.emitted {
		return
	}
	tool.emitted = true
	if tool.parent == "" {
		m.flushMain(turn)
	} else {
		m.flushAgent(turn, tool.session)
		m.emitParent(turn, tool.parent)
	}
	name, input, extra := cursorToolCall(tool)
	payload := map[string]interface{}{"id": tool.id, "name": name, "input": input}
	for key, value := range extra {
		payload[key] = value
	}
	if tool.parent != "" {
		payload["parentToolUseId"] = tool.parent
	}
	m.emitFor(turn.id, evToolUse, payload)
}

// emitParent puts out the card a sub-agent's events nest under, before the first of them.
func (m *cursorEventMapper) emitParent(turn *cursorTurn, parent string) {
	if tool := turn.tools[parent]; tool != nil {
		m.emitToolUse(turn, tool)
	}
}

func (m *cursorEventMapper) emitToolResult(turn *cursorTurn, tool *cursorTool, content string, isError bool) {
	tool.done = true
	payload := map[string]interface{}{"toolUseId": tool.id, "content": content, "isError": isError}
	if tool.parent != "" {
		payload["parentToolUseId"] = tool.parent
	}
	m.emitFor(turn.id, evToolResult, payload)
}

// plan is Cursor's plan update, a checklist that replaces the last one (§4.1): a card of its own each
// time, as Kimi's are (kimi_acp.go), named after the turn so no two in a session share an id.
func (m *cursorEventMapper) plan(turn *cursorTurn, session string, update map[string]interface{}) {
	rows := planEntries(update)
	if len(rows) == 0 {
		return
	}
	parent := m.subagents[session]
	if parent == "" {
		m.flushMain(turn)
	} else {
		m.flushAgent(turn, session)
		m.emitParent(turn, parent)
	}
	turn.plans++
	id := fmt.Sprintf("cursor-plan-%s-%d", turn.id, turn.plans)
	use := map[string]interface{}{"id": id, "name": "plan", "input": map[string]interface{}{"entries": rows}}
	result := map[string]interface{}{"toolUseId": id, "content": planChecklist(rows), "isError": false}
	if parent != "" {
		use["parentToolUseId"], result["parentToolUseId"] = parent, parent
	}
	m.emitFor(turn.id, evToolUse, use)
	m.emitFor(turn.id, evToolResult, result)
}

// spawn binds a sub-agent's session to the card that launched it (§4.1: _meta.cursor.toolCallId).
func (m *cursorEventMapper) spawn(turn *cursorTurn, update map[string]interface{}) {
	child := firstString(update, "subagentSessionId")
	card := firstString(mapValue(mapValue(update["_meta"])["cursor"]), "toolCallId")
	if child == "" || card == "" || child == m.sessionID {
		return
	}
	if m.subagents[child] == "" {
		turn.spawned = append(turn.spawned, child)
	}
	m.subagents[child] = card
	if tool := turn.tools[card]; tool != nil && !tool.emitted {
		tool.subagent = firstString(update, "name")
	}
}

// settle closes the turn once: what is still open is put out, every card left without a result gets
// one, and the turn ends with a single turn_end. The reader has applied every update that preceded the
// prompt's answer before that answer reached the session loop, so nothing of this turn is still in flight.
func (m *cursorEventMapper) settle(turnID string, result map[string]interface{}, err error) (TurnCompleteRequest, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	turn := m.active
	if turn == nil || turn.id != turnID {
		return TurnCompleteRequest{}, false
	}
	m.flushMain(turn)
	for _, session := range turn.spawned {
		m.flushAgent(turn, session)
	}
	request := TurnCompleteRequest{TurnID: turnID, Status: stSucceeded, Subtype: "completed", NumTurns: 1,
		Result: strings.Join(turn.replies, "\n\n"), RuntimeSessionID: m.sessionID}
	stop := firstString(result, "stopReason")
	switch {
	case err != nil:
		request.Status, request.Subtype, request.Error = stFailed, "error", err.Error()
	case stop == "end_turn":
	case stop == "cancelled":
		request.Status, request.Subtype = stInterrupted, "interrupted"
	default:
		request.Status, request.Subtype = stFailed, "error"
		request.Error = fmt.Sprintf("Cursor CLI ended the turn with a stop reason Orbit does not know: %q", stop)
	}
	for _, id := range turn.order {
		tool := turn.tools[id]
		if !tool.done {
			// A cancelled card is never completed (§3.3), and nothing more comes for any once the turn is over.
			m.emitToolUse(turn, tool)
			m.emitToolResult(turn, tool, cursorUnfinishedTool(request.Status), true)
		}
		m.retired[id] = true
	}
	if request.Error != "" {
		m.emitFor(turnID, evError, map[string]interface{}{"message": request.Error})
	}
	end := map[string]interface{}{"subtype": request.Subtype, "numTurns": 1}
	if stop != "" && err == nil {
		end["stopReason"] = stop
	}
	m.emitFor(turnID, evTurnEnd, end)
	m.active = nil
	m.settled[turnID] = true
	m.subagents = map[string]string{}
	return request, true
}

func cursorUnfinishedTool(status string) string {
	if status == stInterrupted {
		return "Interrupted: the turn was stopped before this tool finished; it may have run in part."
	}
	return "Cursor CLI ended the turn before this tool reported a result; it may have run."
}

// cursorToolCall names a card after the Orbit tool it is, with that tool's input, the way the clients
// draw a Read, a Bash or an Edit (§4.1). A tool the contract has not measured keeps Cursor's own title
// and input.
func cursorToolCall(tool *cursorTool) (string, interface{}, map[string]interface{}) {
	in := tool.rawInput
	switch firstString(in, "_toolName") {
	case "updateTodos":
		return "TodoWrite", map[string]interface{}{"todos": cursorTodos(in["todos"])}, nil
	case "task":
		input := map[string]interface{}{"description": firstString(in, "description"), "prompt": firstString(in, "prompt")}
		if tool.subagent != "" {
			input["subagent_type"] = tool.subagent
		}
		return "Task", input, nil
	case "createPlan":
		// The plan Cursor asks the client to accept (cursor/create_plan): Orbit's plan card.
		return "ExitPlanMode", map[string]interface{}{"plan": firstString(in, "plan")}, nil
	}
	switch tool.kind {
	case "read":
		return "Read", map[string]interface{}{"file_path": firstString(in, "path")}, nil
	case "execute":
		return "Bash", map[string]interface{}{"command": firstString(in, "command")}, nil
	case "edit":
		name, input := cursorEditCall(tool)
		return name, input, nil
	case "fetch":
		return "WebFetch", map[string]interface{}{"url": firstString(in, "url")}, nil
	}
	if server, name := firstString(in, "providerIdentifier"), firstString(in, "toolName"); server != "" && name != "" {
		args := in["args"]
		if args == nil {
			args = map[string]interface{}{}
		}
		// mcp__<server>__<tool>, the spelling Orbit's other runtimes use, with the parts kept so a
		// server's own tool name is never reparsed.
		return "mcp__" + server + "__" + name, args, map[string]interface{}{"mcpServer": server, "mcpTool": name}
	}
	name := firstNonEmpty(strings.TrimSpace(tool.title), tool.kind, "tool")
	if in == nil {
		return name, map[string]interface{}{}, nil
	}
	return name, in, nil
}

// cursorEditCall is an edit card as the change it made, from the diff its completion carries. A new
// file's diff is not ACP's own shape: oldText is "-- /dev/null" and newText opens with a "++ b/<path>"
// line (§4.1), which is no part of what was written.
func cursorEditCall(tool *cursorTool) (string, map[string]interface{}) {
	path := firstString(tool.rawInput, "path")
	for _, block := range tool.content {
		diff := mapValue(block)
		if firstString(diff, "type") != "diff" {
			continue
		}
		path = firstNonEmpty(firstString(diff, "path"), path)
		oldText, newText := asString(diff["oldText"]), asString(diff["newText"])
		if diff["oldText"] == nil || oldText == "-- /dev/null" {
			if strings.HasPrefix(newText, "++ b/") {
				_, newText, _ = strings.Cut(newText, "\n")
			}
			return "Write", map[string]interface{}{"file_path": path, "content": newText}
		}
		return "Edit", map[string]interface{}{"file_path": path, "old_string": oldText, "new_string": newText}
	}
	return "Edit", map[string]interface{}{"file_path": path}
}

// cursorTodos is a todo list in the statuses Orbit's checklist reads: Cursor's TODO_STATUS_IN_PROGRESS
// is in_progress.
func cursorTodos(value interface{}) []interface{} {
	rows, _ := value.([]interface{})
	todos := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		todo := mapValue(row)
		if todo == nil {
			continue
		}
		status := strings.ToLower(strings.TrimPrefix(firstString(todo, "status"), "TODO_STATUS_"))
		todos = append(todos, map[string]interface{}{"content": firstString(todo, "content"), "status": status})
	}
	return todos
}

// cursorToolResult is a completed card's outcome. Cursor has no failed status (§4.1): a refusal, an
// error or a non-zero exit code is read from rawOutput.
func cursorToolResult(tool *cursorTool) (string, bool) {
	out := mapValue(tool.rawOutput)
	if out["rejected"] == true {
		return "Not run: the tool call was rejected.", true
	}
	if failure := out["error"]; failure != nil && failure != false {
		if text := asString(failure); text != "" {
			return text, true
		}
		if text := firstString(mapValue(failure), "message"); text != "" {
			return text, true
		}
		wire, _ := json.Marshal(failure)
		return string(wire), true
	}
	if _, ok := out["exitCode"]; ok {
		var lines []string
		for _, stream := range []string{"stdout", "stderr"} {
			if text := strings.TrimRight(firstString(out, stream), "\n"); text != "" {
				lines = append(lines, text)
			}
		}
		code := toInt(out["exitCode"])
		if code != 0 {
			lines = append(lines, fmt.Sprintf("Exit code %d", code))
		}
		return strings.Join(lines, "\n"), code != 0
	}
	if text, ok := out["content"].(string); ok {
		return text, false
	}
	var texts []string
	for _, block := range tool.content {
		if text := kimiContentText(mapValue(block)["content"]); text != "" {
			texts = append(texts, text)
		}
	}
	if len(texts) > 0 {
		return strings.Join(texts, "\n"), false
	}
	if text, ok := tool.rawOutput.(string); ok {
		return text, false
	}
	if tool.rawOutput != nil {
		if wire, err := json.Marshal(tool.rawOutput); err == nil {
			return string(wire), false
		}
	}
	return "", false
}
