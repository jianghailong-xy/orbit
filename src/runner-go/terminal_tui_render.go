package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// What the Orbit TUI draws (docs/mocks/terminal-session/board-1.png ②): the transcript as lines for
// the terminal's own scrollback, and the approval cards answered with a key. Pure functions of the
// events, so the tests render recorded fixtures through exactly what the TUI prints.

const (
	tuiReset  = "\x1b[0m"
	tuiBold   = "\x1b[1m"
	tuiGrey   = "\x1b[90m"
	tuiRed    = "\x1b[31m"
	tuiGreen  = "\x1b[32m"
	tuiYellow = "\x1b[33m"
	tuiBlue   = "\x1b[34m"
	tuiCyan   = "\x1b[36m"
)

// tuiDiffLines is how many changed lines an edit shows before it folds the rest into "…".
const tuiDiffLines = 6

// tuiSessionInfo is what the status line names: workspace · machine · engine · model · permission mode.
type tuiSessionInfo struct {
	// EngineID is the engine as the server names it ("claude", "kimi"), which picks the slash commands.
	EngineID       string
	Workspace      string
	Machine        string
	Engine         string
	Model          string
	PermissionMode string
}

// parseTUISessionInfo reads GET /sessions/:id.
func parseTUISessionInfo(data []byte) tuiSessionInfo {
	var s struct {
		Engine         string  `json:"engine"`
		Provider       string  `json:"provider"`
		Model          *string `json:"model"`
		PermissionMode *string `json:"permissionMode"`
		Workspace      *struct {
			Name string `json:"name"`
		} `json:"workspace"`
		AssignedRunner *struct {
			Name        string  `json:"name"`
			DisplayName *string `json:"displayName"`
		} `json:"assignedRunner"`
	}
	_ = json.Unmarshal(data, &s)
	info := tuiSessionInfo{}
	if s.Workspace != nil {
		info.Workspace = s.Workspace.Name
	}
	if r := s.AssignedRunner; r != nil {
		info.Machine = r.Name
		if r.DisplayName != nil && strings.TrimSpace(*r.DisplayName) != "" {
			info.Machine = *r.DisplayName
		}
	}
	engine := s.Engine
	if engine == "" {
		engine = s.Provider
	}
	if engine != "" {
		info.EngineID = engine
		info.Engine = engineDisplayName(engine)
	}
	if s.Model != nil {
		info.Model = *s.Model
	}
	if s.PermissionMode != nil {
		info.PermissionMode = *s.PermissionMode
	}
	return info
}

// statusLine is the grey line under the prompt (board-1 marker 1).
func (i tuiSessionInfo) statusLine() string {
	var parts []string
	for _, p := range []string{i.Workspace, i.Machine, i.Engine, i.Model, i.PermissionMode} {
		if strings.TrimSpace(p) != "" {
			parts = append(parts, p)
		}
	}
	return tuiBlue + "◆ Orbit" + tuiReset + " " + tuiGrey + strings.Join(parts, " · ") + tuiReset
}

// tuiTranscript turns events into printed lines. It remembers the tool calls it printed, so a
// result can be told apart from a call it never saw, and which messages this TUI sent.
type tuiTranscript struct {
	lastSeq int64
	// The turns this TUI sent, by the turnId POST /turns answered, and the text of those it sent
	// whose answer has not come back yet: the stream can carry a message before its POST answers.
	ownTurns   map[string]bool
	pendingOwn []string
	// Whether events now arrive live. A message already in the transcript when the TUI opened is
	// history and is drawn without a source; one that arrives while it is open and that this TUI
	// did not send was sent from somewhere else, and says so (board-1 marker 3).
	live bool
}

func newTUITranscript() *tuiTranscript {
	return &tuiTranscript{ownTurns: map[string]bool{}}
}

// render answers the lines one event adds, or none. Events at or below the last seq already
// printed are dropped (a reconnect replays from sinceSeq, but the page and the stream can overlap).
func (t *tuiTranscript) render(ev tuiEvent) []string {
	if ev.Seq > 0 {
		if ev.Seq <= t.lastSeq {
			return nil
		}
		t.lastSeq = ev.Seq
	}
	var p map[string]any
	_ = json.Unmarshal(ev.Payload, &p)
	switch ev.Type {
	case "assistant":
		text := strings.TrimRight(tuiStr(p["text"]), "\n")
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return append([]string{""}, strings.Split(text, "\n")...)
	case "user":
		return t.renderUser(ev, p)
	case "tool_use":
		if tuiStr(p["parentToolUseId"]) != "" {
			return nil // a sub-agent's own calls fold into the call that launched it
		}
		return renderToolUse(tuiStr(p["name"]), tuiMap(p["input"]))
	case "tool_result":
		if b, _ := p["isError"].(bool); b && tuiStr(p["parentToolUseId"]) == "" {
			return []string{"  " + tuiRed + "✗ " + firstLine(tuiResultText(p["content"])) + tuiReset}
		}
		return nil
	case "interrupt":
		return []string{tuiGrey + "Interrupted." + tuiReset}
	case "error":
		return []string{tuiRed + "Error: " + firstLine(tuiStr(p["message"])) + tuiReset}
	case "turn_end":
		switch sub := tuiStr(p["subtype"]); sub {
		case "", "success", "completed":
			return nil
		default:
			return []string{tuiRed + "The turn ended: " + sub + tuiReset}
		}
	}
	return nil
}

func (t *tuiTranscript) renderUser(ev tuiEvent, p map[string]any) []string {
	text := strings.TrimRight(tuiStr(p["text"]), "\n")
	lines := strings.Split(text, "\n")
	source := ""
	if t.live && !t.claimOwn(ev.TurnID, text) {
		source = messageSource(p)
	}
	out := []string{""}
	for i, line := range lines {
		prefix := "  "
		if i == 0 {
			prefix = "› "
		}
		out = append(out, tuiBold+prefix+line+tuiReset)
	}
	if source != "" {
		out[len(out)-1] += "  " + tuiGrey + "· from " + source + tuiReset
	}
	return out
}

// claimOwn says whether a message is one this TUI sent: by its turn, or by the text of a send
// whose answer has not arrived yet (then that text is used up, so a second identical message from
// elsewhere still shows its source).
func (t *tuiTranscript) claimOwn(turnID, text string) bool {
	if turnID != "" && t.ownTurns[turnID] {
		return true
	}
	for i, pending := range t.pendingOwn {
		if strings.TrimSpace(pending) == strings.TrimSpace(text) {
			t.pendingOwn = append(t.pendingOwn[:i], t.pendingOwn[i+1:]...)
			if turnID != "" {
				t.ownTurns[turnID] = true
			}
			return true
		}
	}
	return false
}

// messageSource names where a message not sent from this TUI came from: the client the server
// recorded on the turn (`sentFrom`, apiserver sessions/turn-sender-client.ts). A server older than
// that field records only a Feishu group member (`externalSender`); anything else reads "another
// device".
func messageSource(p map[string]any) string {
	if from := tuiMap(p["sentFrom"]); from != nil {
		if label := sentFromLabel(from); label != "" {
			return label
		}
	}
	if ext := tuiMap(p["externalSender"]); ext != nil {
		name := "Feishu"
		if src := tuiStr(ext["source"]); src != "" && src != "FEISHU" {
			name = strings.ToUpper(src[:1]) + strings.ToLower(src[1:])
		}
		if who := strings.TrimSpace(tuiStr(ext["name"])); who != "" {
			return name + " · " + who
		}
		return name
	}
	return "another device"
}

// sentFromLabel is the label for one `sentFrom` card, or "" for a client this build does not know.
func sentFromLabel(from map[string]any) string {
	switch tuiStr(from["client"]) {
	case "ios":
		if tuiStr(from["device"]) == "ipad" {
			return "iPad"
		}
		return "iPhone"
	case "macos":
		return "Mac"
	case "android":
		return "Android"
	case "web":
		return "web"
	case "terminal":
		if machine := oneLine(tuiStr(from["machineName"])); machine != "" {
			return "terminal on " + machine
		}
		return "a terminal"
	case "feishu":
		if who := oneLine(tuiStr(from["name"])); who != "" {
			return "Feishu · " + who
		}
		return "Feishu"
	case "session":
		if title := oneLine(tuiStr(from["sessionTitle"])); title != "" {
			return "session " + truncateRunes(title, 60)
		}
		return "another session"
	case "runner":
		return "the orbit CLI"
	}
	return ""
}

// oneLine folds a label's whitespace, newlines included, to single spaces.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// renderToolUse is one folded line per call (board-1 marker 2); an edit adds its diff.
func renderToolUse(name string, input map[string]any) []string {
	switch name {
	case "Edit", "Write", "MultiEdit":
		var changes []tuiDiffLine
		switch name {
		case "Edit":
			changes = tuiLineDiff(tuiSplitLines(tuiStr(input["old_string"])), tuiSplitLines(tuiStr(input["new_string"])))
		case "Write":
			changes = tuiLineDiff(nil, tuiSplitLines(tuiStr(input["content"])))
		case "MultiEdit":
			edits, _ := input["edits"].([]any)
			for _, e := range edits {
				em := tuiMap(e)
				changes = append(changes, tuiLineDiff(tuiSplitLines(tuiStr(em["old_string"])), tuiSplitLines(tuiStr(em["new_string"])))...)
			}
		}
		added, removed := 0, 0
		for _, c := range changes {
			if c.added {
				added++
			} else {
				removed++
			}
		}
		head := tuiGrey + "▸ " + name + " " + tuiStr(input["file_path"]) + tuiReset
		if len(changes) > 0 {
			head += "  " + tuiGreen + fmt.Sprintf("+%d", added) + tuiReset + " " + tuiRed + fmt.Sprintf("-%d", removed) + tuiReset
		}
		lines := []string{head}
		for i, c := range changes {
			if i == tuiDiffLines {
				lines = append(lines, "  "+tuiGrey+"│ …"+tuiReset)
				break
			}
			if c.added {
				lines = append(lines, "  "+tuiGrey+"│"+tuiReset+" "+tuiGreen+"+ "+c.text+tuiReset)
			} else {
				lines = append(lines, "  "+tuiGrey+"│"+tuiReset+" "+tuiRed+"- "+c.text+tuiReset)
			}
		}
		return lines
	}
	line := "▸ " + name
	if arg := toolArgument(name, input); arg != "" {
		line += " " + arg
	}
	return []string{tuiGrey + truncateRunes(line, 160) + tuiReset}
}

// toolArgument is the one argument that says what a call does: its file, command, pattern or URL.
func toolArgument(name string, input map[string]any) string {
	for _, key := range []string{"file_path", "command", "pattern", "url", "query", "path", "description", "prompt"} {
		if v := strings.TrimSpace(tuiStr(input[key])); v != "" {
			return firstLine(v)
		}
	}
	return ""
}

// tuiDiffLine is one changed line of an edit.
type tuiDiffLine struct {
	added bool
	text  string
}

// tuiLineDiff is an edit's changed lines in file order, by the longest common run of lines, as
// web's lineDiff counts them. An edit too large to compare line by line counts every line changed.
func tuiLineDiff(old, new []string) []tuiDiffLine {
	var out []tuiDiffLine
	if len(old)*len(new) > 1_000_000 {
		for _, l := range old {
			out = append(out, tuiDiffLine{false, l})
		}
		for _, l := range new {
			out = append(out, tuiDiffLine{true, l})
		}
		return out
	}
	// lcs[i][j] is the longest common run of old[i:] and new[j:].
	lcs := make([][]int, len(old)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(new)+1)
	}
	for i := len(old) - 1; i >= 0; i-- {
		for j := len(new) - 1; j >= 0; j-- {
			if old[i] == new[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	i, j := 0, 0
	for i < len(old) || j < len(new) {
		switch {
		case i < len(old) && j < len(new) && old[i] == new[j]:
			i, j = i+1, j+1
		case i < len(old) && (j == len(new) || lcs[i+1][j] >= lcs[i][j+1]):
			out = append(out, tuiDiffLine{false, old[i]})
			i++
		default:
			out = append(out, tuiDiffLine{true, new[j]})
			j++
		}
	}
	return out
}

func tuiSplitLines(s string) []string {
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// tuiApproval is one pending approval card.
type tuiApproval struct {
	ID       string         `json:"id"`
	ToolName string         `json:"toolName"`
	Input    map[string]any `json:"input"`
}

// approvalTitle is the card's headline and the line under it.
func (a tuiApproval) titleAndDetail() (string, string) {
	switch a.ToolName {
	case "Bash":
		return "Run a command", tuiStr(a.Input["command"])
	case "Edit", "MultiEdit":
		return "Edit a file", tuiStr(a.Input["file_path"])
	case "Write":
		return "Write a file", tuiStr(a.Input["file_path"])
	case "WebFetch":
		return "Fetch a page", tuiStr(a.Input["url"])
	case "AskUserQuestion":
		return "Answer a question", "Answer it in the Orbit app; [n] declines it here."
	}
	detail := toolArgument(a.ToolName, a.Input)
	if detail == "" && len(a.Input) > 0 {
		data, _ := json.Marshal(a.Input)
		detail = string(data)
	}
	return "Use " + a.ToolName, detail
}

// answerable says whether [y] can allow the card here. A question needs its answers picked: by
// number when its questions can be read (terminal_tui_v2.go), else in the app.
func (a tuiApproval) answerable() bool { return a.ToolName != "AskUserQuestion" }

// rememberRules is what [a] Always allow remembers, as web's ApprovalPanel derives it: one rule per
// distinct sub-command of a Bash line ("npm test:*"), the tool itself for any other tool, and none
// for the cards a rule cannot stand for (questions, plans, Orbit's own cards, a shell wrapper).
func (a tuiApproval) rememberRules() []map[string]string {
	switch {
	case a.ToolName == "AskUserQuestion", a.ToolName == "ExitPlanMode", strings.HasPrefix(a.ToolName, "mcp__orbit__"), strings.HasPrefix(a.ToolName, "orbit_"):
		return nil
	case a.ToolName == "Bash":
		var rules []map[string]string
		for _, prefix := range bashRulePrefixes(tuiStr(a.Input["command"])) {
			rules = append(rules, map[string]string{"toolName": "Bash", "ruleContent": prefix + ":*"})
		}
		return rules
	}
	return []map[string]string{{"toolName": a.ToolName}}
}

// bashRulePrefixes is each distinct sub-command's program and, when the next word reads as a
// sub-command, that word too, as web's bashPrefix (shared/src/bashRules.ts) takes them:
// `cd x && npm test -- login` → ["cd x", "npm test"]. A line that runs a shell (`bash -c …`) has
// none: a rule for it would allow anything.
func bashRulePrefixes(command string) []string {
	seen := map[string]bool{}
	var out []string
	for _, seg := range splitShellSegments(command) {
		words := strings.Fields(seg)
		for len(words) > 0 && tuiAssignment.MatchString(words[0]) {
			words = words[1:] // FOO=bar before the program
		}
		if len(words) == 0 {
			continue
		}
		program := words[0]
		switch strings.TrimPrefix(program[strings.LastIndex(program, "/")+1:], "-") {
		case "bash", "sh", "zsh", "dash", "fish", "ksh", "env", "sudo", "eval", "exec", "xargs":
			return nil
		}
		if !tuiProgramWord.MatchString(program) {
			continue
		}
		prefix := program
		if len(words) > 1 && tuiSubcommandWord.MatchString(words[1]) {
			prefix += " " + words[1]
		}
		if !seen[prefix] {
			seen[prefix] = true
			out = append(out, prefix)
		}
	}
	return out
}

var (
	tuiAssignment     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	tuiProgramWord    = regexp.MustCompile(`^[A-Za-z./_-][\w./-]*$`)
	tuiSubcommandWord = regexp.MustCompile(`^[A-Za-z][\w-]*$`)
)

func splitShellSegments(command string) []string {
	r := strings.NewReplacer("&&", "\n", "||", "\n", ";", "\n", "|", "\n")
	return strings.Split(r.Replace(command), "\n")
}

// rememberLabel names what [a] remembers: "npm test", or the tool's name.
func rememberLabel(rules []map[string]string) string {
	var names []string
	for _, r := range rules {
		if c := r["ruleContent"]; c != "" {
			names = append(names, strings.TrimSuffix(c, ":*"))
		} else {
			names = append(names, r["toolName"])
		}
	}
	if len(names) > 4 {
		return strings.Join(names[:4], ", ") + fmt.Sprintf(" +%d", len(names)-4)
	}
	return strings.Join(names, ", ")
}

// renderApprovalCard is the card the keys answer (board-1 marker 4).
func renderApprovalCard(a tuiApproval) []string {
	title, detail := a.titleAndDetail()
	bar := tuiYellow + "│" + tuiReset + " "
	lines := []string{bar + tuiYellow + "Approval" + tuiReset + "  " + title}
	if detail != "" {
		for _, l := range strings.Split(truncateRunes(detail, 600), "\n") {
			lines = append(lines, bar+tuiBold+l+tuiReset)
		}
	}
	var keys []string
	if a.answerable() {
		keys = append(keys, tuiCyan+"[y]"+tuiReset+" Allow once")
		if rules := a.rememberRules(); len(rules) > 0 {
			keys = append(keys, tuiCyan+"[a]"+tuiReset+" Always allow "+rememberLabel(rules))
		}
	}
	keys = append(keys, tuiCyan+"[n]"+tuiReset+" Deny")
	return append(lines, bar+strings.Join(keys, "   "))
}

func tuiStr(v any) string {
	s, _ := v.(string)
	return s
}

func tuiMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func tuiResultText(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		for _, block := range c {
			if t := tuiStr(tuiMap(block)["text"]); t != "" {
				return t
			}
		}
	}
	return "failed"
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
