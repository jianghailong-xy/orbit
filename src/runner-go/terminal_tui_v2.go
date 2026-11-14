package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// TUI v2 (docs/terminal-session-design.md, landing step 5): what the live area adds to v1 — the '/'
// menu, files attached by pasting their path, the delivery state of a message sent mid-turn, the
// AskUserQuestion card answered by picking options, and the reply drawn as it streams in.

// ---- Slash commands ----

// tuiSlashItem is one entry of the '/' menu.
type tuiSlashItem struct {
	Name        string
	Description string
}

// tuiLocalSlashItems are the TUI's own commands, listed before the engine's.
var tuiLocalSlashItems = []tuiSlashItem{
	{Name: "exit", Description: "Leave the TUI; the session keeps running"},
	{Name: "status", Description: "Show the session's workspace, machine, engine and model"},
}

// tuiSlashSupported mirrors web's supportsRunnerSlashAssets (lib/slashCommands.ts): Codex, OpenCode,
// Antigravity and DeepSeek Harness take slash-prefixed text as an ordinary prompt and have no registry.
func tuiSlashSupported(engine string) bool {
	switch engine {
	case providerCodex, "opencode", "antigravity", providerDsh:
		return false
	}
	return true
}

// tuiSlashItemsFor is the menu for a session on engine: the TUI's own commands, then the commands
// and skills this machine's runner learned from that engine's CLI (slash_registry.go) — the same
// names the runner reports to the app's composer.
func tuiSlashItemsFor(reg *slashRegistry, engine string) []tuiSlashItem {
	items := append([]tuiSlashItem(nil), tuiLocalSlashItems...)
	if reg == nil || !tuiSlashSupported(engine) {
		return items
	}
	provider := engine
	if provider == "" {
		provider = providerClaude
	}
	reg.mu.Lock()
	commands, skills := reg.setsFor(provider)
	names := map[string]string{}
	for n := range commands {
		names[n] = "Command"
	}
	for n := range skills {
		names[n] = "Skill"
	}
	reg.mu.Unlock()
	keys := make([]string, 0, len(names))
	for n := range names {
		if n != "exit" && n != "status" {
			keys = append(keys, n)
		}
	}
	sort.Strings(keys)
	for _, n := range keys {
		items = append(items, tuiSlashItem{Name: n, Description: names[n]})
	}
	return items
}

// tuiSlashToken is the command name being typed: the composer is a single '/word' with no space yet.
func tuiSlashToken(composer string) (string, bool) {
	if !strings.HasPrefix(composer, "/") || strings.ContainsAny(composer, " \t\n") {
		return "", false
	}
	return composer[1:], true
}

// tuiSlashMenuSize is how many matches the menu shows.
const tuiSlashMenuSize = 8

// tuiSlashMatches is the menu for a token: names that start with it first, then names that contain it.
func tuiSlashMatches(items []tuiSlashItem, token string) []tuiSlashItem {
	q := strings.ToLower(token)
	var starts, contains []tuiSlashItem
	for _, it := range items {
		n := strings.ToLower(it.Name)
		switch {
		case strings.HasPrefix(n, q):
			starts = append(starts, it)
		case strings.Contains(n, q):
			contains = append(contains, it)
		}
	}
	out := append(starts, contains...)
	if len(out) > tuiSlashMenuSize {
		out = out[:tuiSlashMenuSize]
	}
	return out
}

// ---- Attachments ----

// tuiMaxUploadBytes is the server's cap on one attachment (attachments.media.ts MAX_UPLOAD_BYTES).
const tuiMaxUploadBytes = 25 * 1024 * 1024

// tuiAttachment is one file attached to the message being written.
type tuiAttachment struct {
	Path string
	Name string
	// ID is what POST /attachments answered; empty while the upload runs.
	ID  string
	Err string
}

// pastedFilePaths reads a paste as the file paths a terminal pastes when a file is dropped on it or
// a path is copied: one or more paths, each maybe quoted, backslash-escaped or a file:// URL. It
// answers them only when every word names an existing regular file, so a paste of prose that merely
// mentions a path stays text.
func pastedFilePaths(paste, cwd string) []string {
	words, ok := splitPastedWords(strings.TrimSpace(paste))
	if !ok || len(words) == 0 {
		return nil
	}
	var paths []string
	for _, w := range words {
		w = strings.TrimPrefix(w, "file://")
		if strings.HasPrefix(w, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				w = filepath.Join(home, w[2:])
			}
		}
		if !filepath.IsAbs(w) {
			w = filepath.Join(cwd, w)
		}
		st, err := os.Stat(w)
		if err != nil || !st.Mode().IsRegular() {
			return nil
		}
		paths = append(paths, w)
	}
	return paths
}

// splitPastedWords splits on unquoted white space, keeping quoted runs and backslash escapes together.
func splitPastedWords(s string) ([]string, bool) {
	var words []string
	var cur strings.Builder
	inWord := false
	var quote rune
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote, inWord = r, true
		case r == '\\' && i < len(s):
			next, n := utf8.DecodeRuneInString(s[i:])
			i += n
			cur.WriteRune(next)
			inWord = true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
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
	if quote != 0 {
		return nil, false
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, true
}

// ---- Steer delivery ----

// tuiSteer is a message this TUI sent while a turn was running, followed until it settles.
type tuiSteer struct {
	clientTurnID string
	turnID       string
	text         string
	delivery     string
	code, reason string
}

// steerStateLabel is the state a steer is in, in the words web's steerDelivery.ts uses
// (docs/interactive-claude-runner-design.md §3a).
func steerStateLabel(delivery string) string {
	switch delivery {
	case "written":
		return "Waiting to be read"
	case "acknowledged":
		return "Read in this turn"
	case "requeued":
		return "Queued for next turn instead"
	case "failed":
		return "Not delivered"
	case "unconfirmed":
		return "Couldn't confirm it was read"
	}
	return "Sending…"
}

// steerSettled says whether nothing will change the state any more.
func steerSettled(delivery string) bool {
	switch delivery {
	case "acknowledged", "requeued", "failed", "unconfirmed":
		return true
	}
	return false
}

// steerFailureExplanation says why a steer did not land, as web's deliveryFailureExplanation does.
func steerFailureExplanation(code, reason string) string {
	switch code {
	case "CURRENT_WORK_TARGET_COMPLETED":
		return "The turn finished before it was read."
	case "CURRENT_WORK_INTERRUPTED":
		return "The turn was interrupted before it was read."
	case "CURRENT_WORK_SESSION_ENDED", "CURRENT_WORK_SESSION_FINALIZED":
		return "The session ended before it was read."
	case "CURRENT_WORK_SESSION_REAPED":
		return "The runner disappeared while it was being delivered."
	case "CURRENT_WORK_RUNTIME_REJECTED":
		return "The engine rejected it."
	}
	return reason
}

// steerLine is how a steer reads in the live area, or in the scrollback once it settles.
func (s tuiSteer) line() string {
	label := steerStateLabel(s.delivery)
	color := tuiGrey
	switch s.delivery {
	case "acknowledged":
		color = tuiGreen
	case "failed", "unconfirmed":
		color = tuiRed
	}
	line := "  ↳ " + tuiGrey + truncateRunes(firstLine(s.text), 60) + tuiReset + "  " + color + label + tuiReset
	if s.delivery == "failed" {
		if why := steerFailureExplanation(s.code, s.reason); why != "" {
			line += tuiGrey + " — " + why + tuiReset
		}
	}
	return line
}

// ---- AskUserQuestion ----

// tuiQuestion is one question of an AskUserQuestion card.
type tuiQuestion struct {
	Question    string
	Header      string
	MultiSelect bool
	Options     []tuiQuestionOption
}

type tuiQuestionOption struct {
	Label       string
	Description string
}

// questions reads the card's input.questions.
func (a tuiApproval) questions() []tuiQuestion {
	list, _ := a.Input["questions"].([]any)
	var out []tuiQuestion
	for _, raw := range list {
		q := tuiMap(raw)
		if q == nil {
			continue
		}
		tq := tuiQuestion{Question: tuiStr(q["question"]), Header: tuiStr(q["header"])}
		tq.MultiSelect, _ = q["multiSelect"].(bool)
		opts, _ := q["options"].([]any)
		for _, o := range opts {
			om := tuiMap(o)
			if l := tuiStr(om["label"]); l != "" {
				tq.Options = append(tq.Options, tuiQuestionOption{Label: l, Description: tuiStr(om["description"])})
			}
		}
		if tq.Question != "" {
			out = append(out, tq)
		}
	}
	return out
}

// tuiQuestionAnswer is the picking in progress on the head AskUserQuestion card.
type tuiQuestionAnswer struct {
	approvalID string
	current    int
	picks      map[int][]int // question index → option indexes, in the order picked
}

func (q *tuiQuestionAnswer) picked(question, option int) bool {
	for _, p := range q.picks[question] {
		if p == option {
			return true
		}
	}
	return false
}

func (q *tuiQuestionAnswer) toggle(question, option int) {
	for i, p := range q.picks[question] {
		if p == option {
			q.picks[question] = append(q.picks[question][:i], q.picks[question][i+1:]...)
			return
		}
	}
	q.picks[question] = append(q.picks[question], option)
}

// answers is the body's answers: each question's text → the picked options' labels, the shape web's
// ApprovalPanel sends (shared dto.ts QuestionAnswers).
func (q *tuiQuestionAnswer) answers(questions []tuiQuestion) map[string][]string {
	out := map[string][]string{}
	for i, question := range questions {
		var labels []string
		for _, o := range q.picks[i] {
			if o < len(question.Options) {
				labels = append(labels, question.Options[o].Label)
			}
		}
		if len(labels) > 0 {
			out[question.Question] = labels
		}
	}
	return out
}

// renderQuestionCard is an AskUserQuestion card: each question with its numbered options, the one
// being answered marked, and the keys that answer it.
func renderQuestionCard(a tuiApproval, qa *tuiQuestionAnswer) []string {
	bar := tuiYellow + "│" + tuiReset + " "
	lines := []string{bar + tuiYellow + "Approval" + tuiReset + "  Answer a question"}
	questions := a.questions()
	current := 0
	if qa != nil && qa.approvalID == a.ID {
		current = qa.current
	}
	for qi, q := range questions {
		head := q.Question
		if q.Header != "" {
			head = q.Header + ": " + head
		}
		marker := "  "
		if qi == current {
			marker = tuiCyan + "› " + tuiReset
		}
		lines = append(lines, bar+marker+tuiBold+head+tuiReset)
		if qi != current {
			if qa != nil && qa.approvalID == a.ID && len(qa.picks[qi]) > 0 {
				lines = append(lines, bar+"    "+tuiGreen+"✓ "+strings.Join(qa.answers(questions)[q.Question], ", ")+tuiReset)
			}
			continue
		}
		for oi, o := range q.Options {
			check := " "
			if qa != nil && qa.approvalID == a.ID && qa.picked(qi, oi) {
				check = tuiGreen + "✓" + tuiReset
			}
			line := fmt.Sprintf("    %s %s[%d]%s %s", check, tuiCyan, oi+1, tuiReset, o.Label)
			if o.Description != "" {
				line += tuiGrey + " — " + truncateRunes(o.Description, 80) + tuiReset
			}
			lines = append(lines, bar+line)
		}
	}
	keys := tuiCyan + "[1-9]" + tuiReset + " Pick"
	if current < len(questions) && questions[current].MultiSelect {
		keys += "   " + tuiCyan + "[enter]" + tuiReset + " Next"
	}
	keys += "   " + tuiCyan + "[n]" + tuiReset + " Decline"
	return append(lines, bar+keys)
}

// ---- Streaming ----

// tuiDraftLines is how many of the newest lines of a streaming reply the live area shows.
const tuiDraftLines = 8

// supersedesDraft mirrors web's supersedesLiveDrafts: the durable reply, or a boundary of the turn,
// replaces the text streamed so far. A steer is written into the running turn and is no boundary.
func supersedesDraft(ev tuiEvent) bool {
	switch ev.Type {
	case "assistant", "turn_end", "interrupt", "error":
		return true
	case "user":
		var p struct {
			Steer bool `json:"steer"`
		}
		_ = json.Unmarshal(ev.Payload, &p)
		return !p.Steer
	case "system":
		var p struct {
			Subtype string `json:"subtype"`
		}
		_ = json.Unmarshal(ev.Payload, &p)
		return p.Subtype == "resumed"
	}
	return false
}

// draftView is the tail of the streaming reply, for the live area.
func draftView(draft string) []string {
	lines := strings.Split(strings.TrimRight(draft, "\n"), "\n")
	if len(lines) > tuiDraftLines {
		lines = lines[len(lines)-tuiDraftLines:]
	}
	return lines
}
