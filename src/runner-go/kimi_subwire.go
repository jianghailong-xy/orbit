package main

// Kimi's ACP stream says nothing about what a sub-agent is doing: an Agent or AgentSwarm call
// arrives as one tool_call that spins until its result lands, and the transcript card has an
// empty detail the whole run. Claude's stream carries the same work natively, stamped
// parent_tool_use_id, and both clients fold that into the card that launched it.
//
// Kimi writes the same record to disk as it happens: every agent of a session — the main one and
// each sub-agent — appends to its own agents/<id>/wire.jsonl (context.append_loop_event records
// of tool.call / tool.result / content.part, one JSON object per line). This relay tails those
// wires for the life of the session process and re-emits a sub-agent's calls, results, thinking
// and text as ordinary events stamped with parentToolUseId — the shape the reducers already fold
// under the launching card.
//
// Binding a sub-agent's wire to the call that launched it: the call's transcript id is Kimi's
// ACP composition "<turnId>:<toolCallId>" (kimi's acpToolCallId), rebuilt here from the main
// wire's own tool.call record, and the sub-agent's first turn.prompt carries the call's prompt
// verbatim (behind the git-context wrapper every prompt gets), so the two join without guessing.
// A resume names its agent id in the call's args and binds by directory instead. Nesting
// composes: an Agent call inside a sub-agent's wire registers the same way under the composite
// id its own card was emitted with.
//
// What this deliberately does not do: backfill. A runner (re)start begins every known wire at
// its current end — the processes that wrote the history died with the kimi that owned them, and
// repainting old turns' cards is not this relay's job. Offsets persist across restarts
// (kimi-subwire-relay.json in the session's scratch dir) so a respawn continues a live wire
// instead of re-emitting it.

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	kimiSubRelayPoll = 300 * time.Millisecond
	// How long a sub-agent wire waits at an unclaimed turn.prompt for the launching call's
	// record to show in the main wire. The call is dispatched before the sub-agent exists, so
	// its record leads the prompt causally; a poll that reads past it anyway raced a flush.
	// Past the grace the prompt is stepped over — an unrelayed turn beats a stuck wire.
	kimiSubBindGrace = 30 * time.Second
)

// kimiPendingSpawn is an Agent/AgentSwarm call seen in a wire, waiting for the wires of the
// sub-agents it launched. stampID is the launching card's transcript id — what parentToolUseId
// of the sub-agent's events must say.
type kimiPendingSpawn struct {
	stampID string
	// prompts the call will deliver to its sub-agents, one for Agent, one per item for
	// AgentSwarm (the template with {{item}} filled), each removed as a wire claims it.
	prompts []string
	// Agent/AgentSwarm resumes name the sub-agent's directory directly; no prompt to match.
	resumes map[string]bool
}

// kimiSubTail is one sub-agent wire's read position and the parent stamp of its open turn (""
// between turns — records with no binding belong to a turn this relay never saw start, and are
// history by definition).
type kimiSubTail struct {
	offset  int64
	binding string
	// Set while the wire is held at an unclaimed turn.prompt: the poll that first tried it.
	heldSince time.Time
}

type kimiSubRelay struct {
	agentsDir string
	mainWire  string
	statePath string
	emit      emitFn

	mu      sync.Mutex
	pending []*kimiPendingSpawn
	mainOff int64
	subs    map[string]*kimiSubTail
	dirty   bool
}

// kimiSubRelayState is the persisted form: how far each wire was relayed, and which parent stamp
// each sub-agent's open turn binds to. Pending spawns re-derive from the wires themselves. The
// binding rides along because the wire's turn is still open (no turn.ended was read) and the card
// it hangs on lives server-side: a respawned relay keeps appending the turn's tail to it. A wire
// whose process died mid-turn never grows again, so a stale binding is never used.
type kimiSubRelayState struct {
	Main int64                           `json:"main"`
	Subs map[string]kimiSubTailPersisted `json:"subs"`
}

type kimiSubTailPersisted struct {
	Offset  int64  `json:"offset"`
	Binding string `json:"binding,omitempty"`
}

// startKimiSubRelay runs the relay until ctx (the session process's lifetime) ends. Nil when the
// session's directory is unknown — a session that never ran has no wires, and one Kimi creates
// later is picked up by the first poll.
func startKimiSubRelay(ctx context.Context, sessionDir, scratchDir string, emit emitFn) *kimiSubRelay {
	if sessionDir == "" {
		return nil
	}
	r := newKimiSubRelay(sessionDir, filepath.Join(scratchDir, "kimi-subwire-relay.json"), emit)
	go r.run(ctx)
	return r
}

func newKimiSubRelay(sessionDir, statePath string, emit emitFn) *kimiSubRelay {
	r := &kimiSubRelay{
		agentsDir: filepath.Join(sessionDir, "agents"),
		mainWire:  filepath.Join(sessionDir, "agents", "main", "wire.jsonl"),
		statePath: statePath,
		emit:      emit,
		subs:      map[string]*kimiSubTail{},
	}
	state, err := os.ReadFile(statePath)
	if err == nil {
		var saved kimiSubRelayState
		if json.Unmarshal(state, &saved) == nil {
			r.mainOff = saved.Main
			for name, tail := range saved.Subs {
				r.subs[name] = &kimiSubTail{offset: tail.Offset, binding: tail.Binding}
			}
		}
		return r
	}
	// First sight of this session: begin every wire at its end. The history above it belongs to
	// processes long gone; re-emitting it would paint old cards into the live turn.
	r.mainOff = kimiWireSize(r.mainWire)
	if entries, err := os.ReadDir(r.agentsDir); err == nil {
		for _, e := range entries {
			if e.IsDir() && e.Name() != "main" {
				r.subs[e.Name()] = &kimiSubTail{offset: kimiWireSize(r.wirePath(e.Name()))}
			}
		}
	}
	return r
}

func (r *kimiSubRelay) wirePath(agentID string) string {
	return filepath.Join(r.agentsDir, agentID, "wire.jsonl")
}

func kimiWireSize(path string) int64 {
	if info, err := os.Stat(path); err == nil {
		return info.Size()
	}
	return 0
}

func (r *kimiSubRelay) run(ctx context.Context) {
	tk := time.NewTicker(kimiSubRelayPoll)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			r.poll()
			return
		case <-tk.C:
			r.poll()
		}
	}
}

// stop flushes whatever the wires still hold and saves the read positions. Deferred by the
// caller so it runs before the session's own final event flush.
func (r *kimiSubRelay) stop() {
	if r == nil {
		return
	}
	r.poll()
	r.mu.Lock()
	r.saveLocked()
	r.mu.Unlock()
}

func (r *kimiSubRelay) poll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pollLocked(time.Now())
}

func (r *kimiSubRelay) pollLocked(now time.Time) {
	r.readMainLocked()
	r.scanSubsLocked()
	for name, tail := range r.subs {
		r.readSubLocked(name, tail, now)
	}
	if r.dirty {
		r.saveLocked()
	}
}

// readMainLocked reads the main agent's wire for one thing only: Agent-family calls, the cards
// sub-agent wires bind to. Nothing in it is emitted — ACP already relays the main agent.
func (r *kimiSubRelay) readMainLocked() {
	lines := kimiReadWireLines(r.mainWire, r.mainOff)
	for _, line := range lines {
		r.mainOff = line.end
		r.dirty = true
		rec := line.rec
		if rec["type"] != "context.append_loop_event" {
			continue
		}
		ev := mapValue(rec["event"])
		if ev == nil || firstString(ev, "type") != "tool.call" {
			continue
		}
		name := firstString(ev, "name")
		if name != "Agent" && name != "AgentSwarm" {
			continue
		}
		// The transcript knows this call by its ACP id, turnId:toolCallId — the composition
		// kimi's own ACP layer makes of the same record this is reading.
		stamp := kimiWireTurnID(ev) + ":" + firstString(ev, "toolCallId")
		r.registerSpawnLocked(stamp, name, mapValue(ev["args"]))
	}
}

func (r *kimiSubRelay) registerSpawnLocked(stampID, name string, args map[string]interface{}) {
	spawn := &kimiPendingSpawn{stampID: stampID, resumes: map[string]bool{}}
	switch name {
	case "Agent":
		if p := firstString(args, "prompt"); p != "" {
			spawn.prompts = []string{p}
		}
		if resume := firstString(args, "resume"); resume != "" {
			spawn.resumes[resume] = true
		}
	case "AgentSwarm":
		template := firstString(args, "prompt_template")
		if items, ok := args["items"].([]interface{}); ok {
			for _, item := range items {
				if s, ok := item.(string); ok {
					spawn.prompts = append(spawn.prompts, strings.ReplaceAll(template, "{{item}}", s))
				}
			}
		}
		for agentID := range mapValue(args["resume_agent_ids"]) {
			spawn.resumes[agentID] = true
		}
	}
	r.pending = append(r.pending, spawn)
}

// scanSubsLocked picks up sub-agent directories created since the last poll. A wire that existed
// at process start was opened at its end then; one appearing now starts at 0 — it is new work.
func (r *kimiSubRelay) scanSubsLocked() {
	entries, err := os.ReadDir(r.agentsDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || name == "main" || strings.HasPrefix(name, ".") {
			continue
		}
		if _, known := r.subs[name]; !known {
			r.subs[name] = &kimiSubTail{}
			r.dirty = true
		}
	}
}

func (r *kimiSubRelay) readSubLocked(agentID string, tail *kimiSubTail, now time.Time) {
	for _, line := range kimiReadWireLines(r.wirePath(agentID), tail.offset) {
		rec := line.rec
		switch rec["type"] {
		case "turn.prompt":
			if stamp := r.bindPromptLocked(agentID, kimiWirePromptText(rec)); stamp != "" {
				tail.binding = stamp
				tail.heldSince = time.Time{}
			} else if tail.heldSince.IsZero() {
				tail.heldSince = now
				return // hold the wire at the prompt; the next poll retries from here
			} else if now.Sub(tail.heldSince) < kimiSubBindGrace {
				return
			} else {
				logln("kimi sub-agent", agentID+":", "no Agent call claimed its prompt; its turn is not relayed")
				tail.heldSince = time.Time{}
				tail.binding = ""
			}
		case "context.append_loop_event":
			if tail.binding != "" {
				if ev := mapValue(rec["event"]); ev != nil {
					r.emitLoopEventLocked(agentID, tail.binding, ev)
				}
			}
		case "turn.ended":
			tail.binding = ""
		}
		tail.offset = line.end
		r.dirty = true
	}
}

// bindPromptLocked matches a sub-agent turn's prompt to the call waiting for it. A resume names
// its directory outright; a fresh spawn's prompt is the call's prompt behind the git-context
// wrapper. A prompt no call claims leaves the turn unbound — its records stay on disk, and the
// transcript simply shows the card as it always has.
func (r *kimiSubRelay) bindPromptLocked(agentID, prompt string) string {
	for _, spawn := range r.pending {
		if spawn.resumes[agentID] {
			delete(spawn.resumes, agentID)
			return spawn.stampID
		}
	}
	for _, spawn := range r.pending {
		for i, p := range spawn.prompts {
			if kimiPromptMatches(prompt, p) {
				spawn.prompts = append(spawn.prompts[:i], spawn.prompts[i+1:]...)
				return spawn.stampID
			}
		}
	}
	return ""
}

func (r *kimiSubRelay) emitLoopEventLocked(agentID, binding string, ev map[string]interface{}) {
	withParent := func(p map[string]interface{}) map[string]interface{} {
		p["parentToolUseId"] = binding
		return p
	}
	switch firstString(ev, "type") {
	case "tool.call":
		// Scoped to the agent that made it: the model assigns these ids, and two agents of one
		// session can issue the same one (kimi's own ACP prefix exists for exactly that reason).
		id := agentID + ":" + firstString(ev, "toolCallId")
		name := firstString(ev, "name")
		r.emit(evToolUse, withParent(map[string]interface{}{
			"id": id, "name": name, "input": ev["args"],
		}))
		// A sub-agent's own Agent call: its card now exists inside this one's list, and the
		// grandchild's wire binds to it the same way this one bound to its parent.
		if name == "Agent" || name == "AgentSwarm" {
			r.registerSpawnLocked(id, name, mapValue(ev["args"]))
		}
	case "tool.result":
		id := firstString(ev, "toolCallId")
		if id == "" {
			return
		}
		result := mapValue(ev["result"])
		r.emit(evToolResult, withParent(map[string]interface{}{
			"toolUseId": agentID + ":" + id,
			"content":   kimiWireResultText(result),
			"isError":   result != nil && result["isError"] == true,
		}))
	case "content.part":
		part := mapValue(ev["part"])
		if part == nil || part["hidden"] == true {
			return
		}
		switch firstString(part, "type") {
		case "think":
			if text := firstString(part, "think"); text != "" {
				r.emit(evThinking, withParent(map[string]interface{}{"text": text}))
			}
		case "text":
			if text := firstString(part, "text"); text != "" {
				r.emit(evAssistant, withParent(map[string]interface{}{"text": text}))
			}
		}
	}
}

// kimiWireResultText renders a tool.result record's output the way the ACP path's kimiToolOutput
// does: the string as it stands, content parts joined by their text, anything else as JSON.
func kimiWireResultText(result map[string]interface{}) string {
	if result == nil {
		return ""
	}
	switch out := result["output"].(type) {
	case string:
		return out
	case []interface{}:
		var texts []string
		for _, row := range out {
			if text := kimiContentText(row); text != "" {
				texts = append(texts, text)
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
	}
	if raw := result["output"]; raw != nil {
		if b, err := json.Marshal(raw); err == nil {
			return string(b)
		}
	}
	return ""
}

// kimiWirePromptText is the text a turn.prompt record carries: its text parts joined.
func kimiWirePromptText(rec map[string]interface{}) string {
	var parts []string
	if rows, ok := rec["input"].([]interface{}); ok {
		for _, row := range rows {
			if text := kimiContentText(row); text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// kimiPromptMatches: the prompt a sub-agent's turn received is the call's prompt behind whatever
// wrapper the runtime prepends (the git-context block, a fork's notice) — the call's own words
// are always the tail.
func kimiPromptMatches(received, sent string) bool {
	received = stripKimiGitContext(received)
	return received == sent || strings.HasSuffix(received, "\n"+sent)
}

func stripKimiGitContext(s string) string {
	if !strings.HasPrefix(s, "<git-context>") {
		return s
	}
	end := strings.Index(s, "</git-context>")
	if end < 0 {
		return s
	}
	return strings.TrimLeft(s[end+len("</git-context>"):], "\n")
}

// kimiWireTurnID renders a tool.call record's turnId the way the ACP composition does — it is a
// string in the wire ("0") and a number on the stream (0), and both spell the same digits.
func kimiWireTurnID(ev map[string]interface{}) string {
	switch v := ev["turnId"].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	}
	return ""
}

// kimiWireLine is one complete line of a wire and the byte offset just past it.
type kimiWireLine struct {
	rec map[string]interface{}
	end int64
}

// kimiReadWireLines reads the complete lines of an append-only JSONL file past offset, each with
// its own end so the caller commits position as records are consumed — a record it cannot use
// yet (a sub-agent's unclaimed turn.prompt) stops the read where a later poll retries it. The
// last line goes unread while it lacks its newline: the writer's next append finishes it.
func kimiReadWireLines(path string, offset int64) []kimiWireLine {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return nil
	} else if info.Size() < offset {
		// A smaller file than the offset is a wire this process has never seen (a moved home
		// replaced it): start it over rather than read the middle of a line.
		offset = 0
	}
	if _, err := f.Seek(offset, 0); err != nil {
		return nil
	}
	buf, err := io.ReadAll(f)
	if err != nil || len(buf) == 0 {
		return nil
	}
	var lines []kimiWireLine
	pos := 0
	for pos < len(buf) {
		nl := strings.IndexByte(string(buf[pos:]), '\n')
		if nl < 0 {
			break
		}
		line := strings.TrimSpace(string(buf[pos : pos+nl]))
		end := offset + int64(pos+nl) + 1
		pos += nl + 1
		if line == "" {
			continue
		}
		var rec map[string]interface{}
		if json.Unmarshal([]byte(line), &rec) == nil {
			lines = append(lines, kimiWireLine{rec: rec, end: end})
		}
	}
	return lines
}

func (r *kimiSubRelay) saveLocked() {
	state := kimiSubRelayState{Main: r.mainOff, Subs: map[string]kimiSubTailPersisted{}}
	for name, tail := range r.subs {
		state.Subs[name] = kimiSubTailPersisted{Offset: tail.offset, Binding: tail.binding}
	}
	b, err := json.Marshal(state)
	if err != nil {
		return
	}
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, r.statePath); err == nil {
		r.dirty = false
	}
}
