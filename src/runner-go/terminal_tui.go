package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The Orbit TUI (docs/terminal-session-design.md, "TUI v1"; board-1 ②, board-2 "Leave and reopen"):
// one session, drawn from the same events the app reads and written through the same routes the
// app writes with. The transcript is printed into the terminal's own scrollback; the live area
// under it holds the pending approval cards, the composer and the key hints.
//
// Leaving (Ctrl-D, Ctrl-C or /exit) only closes this client: the session keeps running on its
// machine (D9), and nothing on the way out calls /interrupt.

// tuiOptions is what a caller hands the TUI: the session and the credential to reach it with.
type tuiOptions struct {
	Server    string
	Token     string
	SessionID string
	// Machine is the name the leave line uses when the session does not name its runner.
	Machine string
	In      io.Reader
	Out     io.Writer
}

// openSessionTUI is the entry point other commands call (bare `orbit`, `orbit resume <id>`): it
// signs this terminal in (or reuses its credential) and opens the TUI on the session.
func openSessionTUI(sessionID string, out io.Writer) error {
	cred, err := ensureTerminalCredential(out)
	if err != nil {
		return err
	}
	return runSessionTUI(tuiOptions{
		Server: cred.ServerURL, Token: cred.Token, SessionID: sessionID,
		Machine: cred.MachineName, In: os.Stdin, Out: out,
	})
}

// tuiPageTail is how much of the transcript the TUI prints when it opens.
const tuiPageTail = 200

// runSessionTUI opens the TUI on one session and returns when the person leaves it.
func runSessionTUI(opts tuiOptions) error {
	client := newTUIClient(opts.Server, opts.Token)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	raw, err := client.session(ctx, opts.SessionID)
	if err != nil {
		return fmt.Errorf("opening session %s: %w", opts.SessionID, err)
	}
	info := parseTUISessionInfo(raw)
	if info.Machine == "" {
		info.Machine = opts.Machine
	}
	events, err := client.eventPage(ctx, opts.SessionID, tuiPageTail)
	if err != nil {
		return fmt.Errorf("reading session %s: %w", opts.SessionID, err)
	}
	approvals, err := client.pendingApprovals(ctx, opts.SessionID)
	if err != nil {
		return fmt.Errorf("reading session %s: %w", opts.SessionID, err)
	}

	m := newTUIModel(client, opts.SessionID, info)
	m.slashItems = tuiSlashItemsFor(slashReg, info.EngineID)
	// The transcript so far goes to the scrollback before the live area is drawn.
	fmt.Fprintln(opts.Out, info.statusLine())
	for _, ev := range events {
		for _, line := range m.transcript.render(ev) {
			fmt.Fprintln(opts.Out, line)
		}
	}
	m.transcript.live = true
	m.setApprovals(approvals)

	p := tea.NewProgram(m, tea.WithInput(opts.In), tea.WithOutput(opts.Out), tea.WithContext(ctx))
	go followSession(ctx, client, opts.SessionID, m.transcript.lastSeq, p.Send)
	final, err := p.Run()
	cancel()
	// A SIGINT from outside the terminal's raw mode leaves too, and like every way out, never
	// interrupts the session.
	interrupted := errors.Is(err, tea.ErrInterrupted)
	if err != nil && !interrupted && !errors.Is(err, tea.ErrProgramKilled) {
		return err
	}
	if fm, ok := final.(*tuiModel); interrupted || ok && fm.left {
		fmt.Fprint(opts.Out, leaveMessage(info.Machine, opts.SessionID))
	}
	return nil
}

// leaveMessage is what the terminal shows after leaving (board-2 "Leave and reopen").
func leaveMessage(machine, sessionID string) string {
	if machine == "" {
		machine = "its machine"
	}
	return tuiBlue + "◆ Orbit" + tuiReset + " Left the session; it keeps running on " + machine + ".\n" +
		"  Reopen: orbit resume " + sessionID + "\n"
}

// followSession follows the SSE stream for as long as ctx lives, reconnecting from the last seq it
// saw. Approval requests are live-only, so each reconnect also re-reads the pending cards.
func followSession(ctx context.Context, client *tuiClient, id string, sinceSeq int64, send func(tea.Msg)) {
	backoff := time.Second
	for first := true; ctx.Err() == nil; first = false {
		if !first {
			send(tuiStreamRestartMsg{})
			if list, err := client.pendingApprovals(ctx, id); err == nil {
				send(tuiApprovalsMsg(list))
			}
		}
		started := time.Now()
		err := client.follow(ctx, id, sinceSeq, func(ev tuiEvent) {
			if ev.Seq > sinceSeq {
				sinceSeq = ev.Seq
			}
			send(tuiEventMsg(ev))
		})
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		send(tuiNoticeMsg(fmt.Sprintf("Reconnecting to the session… (%v)", errOr(err, "the stream ended"))))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, 15*time.Second)
	}
}

func errOr(err error, fallback string) string {
	if err != nil {
		return err.Error()
	}
	return fallback
}

// Messages the model receives besides keys.
type (
	tuiEventMsg     tuiEvent
	tuiApprovalsMsg []json.RawMessage
	tuiNoticeMsg    string
	tuiSentMsg      struct {
		content, clientTurnID string
		answer                tuiTurnAnswer
		err                   error
	}
	tuiUploadedMsg struct {
		path, id string
		err      error
	}
	// tuiStreamRestartMsg says the stream is about to reconnect: a reply streaming in starts over
	// from its whole prefix, so the draft so far is dropped.
	tuiStreamRestartMsg struct{}
	tuiDecidedMsg       struct {
		approvalID string
		err        error
	}
	tuiInterruptedMsg struct{ err error }
	// tuiPrintedMsg says the lines last handed to tea.Println are printed.
	tuiPrintedMsg struct{}
)

// tuiModel is the bubbletea model: the live area and what a key does.
type tuiModel struct {
	client     *tuiClient
	sessionID  string
	info       tuiSessionInfo
	transcript *tuiTranscript
	approvals  []tuiApproval
	// Cards answered here whose decision is on its way, so a re-read does not bring them back.
	deciding map[string]bool
	composer []rune
	notice   string
	// Whether a turn is running, for the "Working…" line, and the reply streaming in so far: drawn
	// in the live area until the whole message arrives and goes to the scrollback.
	working bool
	draft   string
	// The '/' menu: every command this session's engine offers, and the highlighted match.
	slashItems  []tuiSlashItem
	slashCursor int
	// Files pasted into the message being written, uploaded as they are pasted.
	attachments []tuiAttachment
	cwd         string
	// Messages sent mid-turn whose delivery has not settled.
	steers []tuiSteer
	// The picking in progress on an AskUserQuestion card at the head of the queue.
	qa *tuiQuestionAnswer
	// Lines waiting for the scrollback, and whether a print is on its way. bubbletea runs every
	// command on its own goroutine, so two prints in flight could land in either order: one goes
	// at a time, and the next waits for tuiPrintedMsg.
	outbox   []string
	printing bool
	left     bool
	newID    func() (string, error)
}

func newTUIModel(client *tuiClient, sessionID string, info tuiSessionInfo) *tuiModel {
	return &tuiModel{
		client: client, sessionID: sessionID, info: info,
		transcript: newTUITranscript(), deciding: map[string]bool{}, newID: randomUUID,
		slashItems: append([]tuiSlashItem(nil), tuiLocalSlashItems...), cwd: tuiWorkingDir(),
	}
}

func (m *tuiModel) Init() tea.Cmd { return nil }

func (m *tuiModel) setApprovals(list []json.RawMessage) {
	m.approvals = nil
	for _, raw := range list {
		var a tuiApproval
		if json.Unmarshal(raw, &a) == nil && a.ID != "" && !m.deciding[a.ID] {
			m.approvals = append(m.approvals, a)
		}
	}
}

func (m *tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.key(msg)
	case tuiEventMsg:
		return m, m.event(tuiEvent(msg))
	case tuiApprovalsMsg:
		m.setApprovals(msg)
	case tuiNoticeMsg:
		m.notice = string(msg)
	case tuiPrintedMsg:
		m.printing = false
		return m, m.flush()
	case tuiSentMsg:
		if msg.err != nil {
			m.notice = "Not sent: " + msg.err.Error()
			m.dropPending(msg.content)
			m.dropSteer(msg.clientTurnID)
		} else {
			if msg.answer.TurnID != "" {
				m.transcript.ownTurns[msg.answer.TurnID] = true
			}
			m.placed(msg.clientTurnID, msg.answer)
		}
	case tuiUploadedMsg:
		for i := range m.attachments {
			if m.attachments[i].Path == msg.path && m.attachments[i].ID == "" && m.attachments[i].Err == "" {
				if msg.err != nil {
					m.attachments[i].Err = msg.err.Error()
				} else {
					m.attachments[i].ID = msg.id
				}
				break
			}
		}
	case tuiStreamRestartMsg:
		m.draft = ""
	case tuiDecidedMsg:
		delete(m.deciding, msg.approvalID)
		if msg.err != nil {
			m.notice = "The answer did not go through: " + msg.err.Error()
		}
	case tuiInterruptedMsg:
		if msg.err != nil {
			m.notice = "Could not interrupt: " + msg.err.Error()
		}
	}
	return m, nil
}

// event prints what one streamed event adds, and keeps the approval cards in step.
func (m *tuiModel) event(ev tuiEvent) tea.Cmd {
	switch ev.Type {
	case "approval_request":
		var a tuiApproval
		if json.Unmarshal(ev.Payload, &a) == nil && a.ID != "" && !m.hasApproval(a.ID) {
			m.approvals = append(m.approvals, a)
		}
		return nil
	case "approval_resolved":
		var r struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(ev.Payload, &r) == nil {
			m.removeApproval(r.ID)
		}
		return nil
	case "resync":
		m.draft = ""
		return m.resync()
	case "text_delta":
		var p struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(ev.Payload, &p)
		m.draft += p.Text
		m.working = true
		m.transcript.render(ev) // keeps the seq in step; a delta prints nothing
		return nil
	case "user_delivery":
		var p struct {
			TurnID   string `json:"turnId"`
			Delivery string `json:"delivery"`
			Code     string `json:"code"`
			Reason   string `json:"reason"`
		}
		_ = json.Unmarshal(ev.Payload, &p)
		if p.TurnID == "" {
			p.TurnID = ev.TurnID
		}
		m.transcript.render(ev)
		m.steerDelivery(p.TurnID, "", p.Delivery, p.Code, p.Reason)
		return m.flush()
	}
	if supersedesDraft(ev) {
		m.draft = ""
	}
	switch ev.Type {
	case "turn_end", "interrupt", "error":
		m.notice = ""
		m.working = false
	case "user", "assistant", "tool_use", "tool_result", "text_delta", "thinking", "thinking_delta":
		m.working = true
	}
	m.outbox = append(m.outbox, m.transcript.render(ev)...)
	if ev.Type == "user" {
		var p struct {
			Text     string `json:"text"`
			Steer    bool   `json:"steer"`
			Delivery string `json:"delivery"`
		}
		if json.Unmarshal(ev.Payload, &p) == nil && p.Steer {
			m.steerDelivery(ev.TurnID, p.Text, p.Delivery, "", "")
		}
	}
	return m.flush()
}

// placed records where the server put a message: one written into the running turn is followed
// until its delivery settles; any other placement ends the following.
func (m *tuiModel) placed(clientTurnID string, answer tuiTurnAnswer) {
	for i := range m.steers {
		if m.steers[i].clientTurnID != clientTurnID {
			continue
		}
		if answer.Placement != "steer" {
			m.steers = append(m.steers[:i], m.steers[i+1:]...)
			return
		}
		m.steers[i].turnID = answer.TurnID
		return
	}
}

func (m *tuiModel) dropSteer(clientTurnID string) {
	for i := range m.steers {
		if m.steers[i].clientTurnID == clientTurnID {
			m.steers = append(m.steers[:i], m.steers[i+1:]...)
			return
		}
	}
}

// steerDelivery moves a followed steer to the state an event reports. It is found by its turn, or —
// before the send's answer has named the turn — by its text. A settled steer leaves the live area
// with one line in the scrollback saying how it ended; a withdrawn one leaves without a word.
func (m *tuiModel) steerDelivery(turnID, text, delivery, code, reason string) {
	idx := -1
	for i, st := range m.steers {
		if turnID != "" && st.turnID == turnID {
			idx = i
			break
		}
	}
	if idx < 0 && text != "" {
		for i, st := range m.steers {
			if st.turnID == "" && strings.TrimSpace(st.text) == strings.TrimSpace(text) {
				idx = i
				m.steers[i].turnID = turnID
				break
			}
		}
	}
	if idx < 0 || delivery == "" {
		return
	}
	st := &m.steers[idx]
	st.delivery, st.code, st.reason = delivery, code, reason
	if delivery == "withdrawn" {
		m.steers = append(m.steers[:idx], m.steers[idx+1:]...)
		return
	}
	if steerSettled(delivery) {
		m.outbox = append(m.outbox, st.line())
		m.steers = append(m.steers[:idx], m.steers[idx+1:]...)
	}
}

// flush prints what is waiting, unless a print is already on its way. tea.Sequence delivers the
// print before the acknowledgement, and the program handles its messages in the order they come.
func (m *tuiModel) flush() tea.Cmd {
	if m.printing || len(m.outbox) == 0 {
		return nil
	}
	text := strings.Join(m.outbox, "\n")
	m.outbox = nil
	m.printing = true
	return tea.Sequence(tea.Println(text), func() tea.Msg { return tuiPrintedMsg{} })
}

// resync re-reads the tail page when the stream says it cannot catch this window up in place.
func (m *tuiModel) resync() tea.Cmd {
	client, id := m.client, m.sessionID
	return func() tea.Msg {
		events, err := client.eventPage(context.Background(), id, tuiPageTail)
		if err != nil {
			return tuiNoticeMsg("Could not catch up with the session: " + err.Error())
		}
		var batch []tea.Cmd
		for _, ev := range events {
			e := ev
			batch = append(batch, func() tea.Msg { return tuiEventMsg(e) })
		}
		return tea.Sequence(batch...)()
	}
}

func (m *tuiModel) hasApproval(id string) bool {
	for _, a := range m.approvals {
		if a.ID == id {
			return true
		}
	}
	return false
}

func (m *tuiModel) removeApproval(id string) {
	for i, a := range m.approvals {
		if a.ID == id {
			m.approvals = append(m.approvals[:i], m.approvals[i+1:]...)
			return
		}
	}
}

func (m *tuiModel) dropPending(content string) {
	for i, p := range m.transcript.pendingOwn {
		if p == content {
			m.transcript.pendingOwn = append(m.transcript.pendingOwn[:i], m.transcript.pendingOwn[i+1:]...)
			return
		}
	}
}

func (m *tuiModel) key(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	menu := m.slashMenu()
	switch k.Type {
	case tea.KeyCtrlD, tea.KeyCtrlC:
		return m.leave()
	case tea.KeyEsc:
		if len(menu) > 0 {
			m.composer = nil // Esc closes the menu before it interrupts anything
			return m, nil
		}
		m.notice = "Interrupting…"
		client, id := m.client, m.sessionID
		return m, func() tea.Msg { return tuiInterruptedMsg{client.interrupt(context.Background(), id)} }
	case tea.KeyUp, tea.KeyDown:
		if len(menu) > 0 {
			if k.Type == tea.KeyUp {
				m.slashCursor = (m.slashCursor + len(menu) - 1) % len(menu)
			} else {
				m.slashCursor = (m.slashCursor + 1) % len(menu)
			}
		}
		return m, nil
	case tea.KeyTab:
		if len(menu) > 0 {
			m.composer = []rune("/" + menu[m.slashCursor].Name + " ")
			m.slashCursor = 0
		}
		return m, nil
	case tea.KeyEnter:
		if len(menu) > 0 {
			m.composer = []rune("/" + menu[m.slashCursor].Name)
			m.slashCursor = 0
		}
		text := strings.TrimSpace(string(m.composer))
		if text == "" && len(m.attachments) == 0 {
			if a, questions, ok := m.questionHead(); ok && questions[m.qa.current].MultiSelect {
				return m, m.nextQuestion(a, questions)
			}
			return m, nil
		}
		switch text {
		case "/exit":
			return m.leave()
		case "/status":
			m.composer = nil
			m.notice = tuiPlainText(m.info.statusLine())
			return m, nil
		}
		for _, a := range m.attachments {
			if a.ID == "" && a.Err == "" {
				m.notice = "Waiting for " + a.Name + " to upload…"
				return m, nil
			}
		}
		m.composer = nil
		return m, m.send(text)
	case tea.KeyBackspace:
		if n := len(m.composer); n > 0 {
			m.composer = m.composer[:n-1]
			m.slashCursor = 0
		} else if n := len(m.attachments); n > 0 {
			m.attachments = m.attachments[:n-1]
		}
		return m, nil
	case tea.KeyCtrlU:
		m.composer = nil
		return m, nil
	case tea.KeySpace:
		m.composer = append(m.composer, ' ')
		return m, nil
	case tea.KeyRunes:
		if k.Paste {
			if paths := pastedFilePaths(string(k.Runes), m.cwd); len(paths) > 0 {
				return m, m.attach(paths)
			}
		}
		// With a card waiting and nothing typed, keys answer the card (board-1 marker 4): y / a / n,
		// or an option's number on a question.
		if len(m.composer) == 0 && len(m.approvals) > 0 && !k.Paste && len(k.Runes) == 1 {
			r := k.Runes[0]
			if a, questions, ok := m.questionHead(); ok && r >= '1' && r <= '9' {
				return m, m.pick(a, questions, int(r-'1'))
			}
			switch r {
			case 'y', 'a', 'n':
				return m, m.decide(r)
			}
		}
		m.composer = append(m.composer, k.Runes...)
		m.slashCursor = 0
		return m, nil
	}
	return m, nil
}

// slashMenu is the '/' menu's matches while a command name is being typed, or none.
func (m *tuiModel) slashMenu() []tuiSlashItem {
	token, ok := tuiSlashToken(string(m.composer))
	if !ok {
		return nil
	}
	matches := tuiSlashMatches(m.slashItems, token)
	if len(matches) == 1 && matches[0].Name == token {
		return nil // typed out in full: Enter sends it as it stands
	}
	if m.slashCursor >= len(matches) {
		m.slashCursor = 0
	}
	return matches
}

// attach uploads pasted files, each as it is pasted, so the message is ready when Enter is pressed.
func (m *tuiModel) attach(paths []string) tea.Cmd {
	var cmds []tea.Cmd
	for _, path := range paths {
		a := tuiAttachment{Path: path, Name: filepath.Base(path)}
		if st, err := os.Stat(path); err == nil && st.Size() > tuiMaxUploadBytes {
			m.notice = a.Name + " is larger than 25 MB, the most one attachment can be."
			continue
		}
		m.attachments = append(m.attachments, a)
		client, id := m.client, m.sessionID
		cmds = append(cmds, func() tea.Msg {
			uploaded, err := client.upload(context.Background(), id, path)
			return tuiUploadedMsg{path: path, id: uploaded, err: err}
		})
	}
	return tea.Batch(cmds...)
}

func tuiWorkingDir() string {
	dir, _ := os.Getwd()
	return dir
}

// tuiPlainText drops the colour codes from a line the TUI drew.
func tuiPlainText(s string) string {
	for _, c := range []string{tuiReset, tuiBold, tuiGrey, tuiRed, tuiGreen, tuiYellow, tuiBlue, tuiCyan} {
		s = strings.ReplaceAll(s, c, "")
	}
	return s
}

// questionHead is the AskUserQuestion card at the head of the queue, its questions, and the picking
// in progress on it (started here when it is new).
func (m *tuiModel) questionHead() (tuiApproval, []tuiQuestion, bool) {
	if len(m.approvals) == 0 || m.approvals[0].ToolName != "AskUserQuestion" {
		return tuiApproval{}, nil, false
	}
	a := m.approvals[0]
	questions := a.questions()
	if len(questions) == 0 {
		return tuiApproval{}, nil, false
	}
	if m.qa == nil || m.qa.approvalID != a.ID {
		m.qa = &tuiQuestionAnswer{approvalID: a.ID, picks: map[int][]int{}}
	}
	return a, questions, true
}

// pick answers the current question with option i: a single-select question takes it and moves on,
// a multi-select one toggles it and waits for Enter.
func (m *tuiModel) pick(a tuiApproval, questions []tuiQuestion, i int) tea.Cmd {
	q := questions[m.qa.current]
	if i >= len(q.Options) {
		return nil
	}
	if q.MultiSelect {
		m.qa.toggle(m.qa.current, i)
		return nil
	}
	m.qa.picks[m.qa.current] = []int{i}
	return m.nextQuestion(a, questions)
}

// nextQuestion moves to the next question, or sends the answers once every question has one: the
// body web's ApprovalPanel sends, behavior allow with answers keyed by each question's text.
func (m *tuiModel) nextQuestion(a tuiApproval, questions []tuiQuestion) tea.Cmd {
	if len(m.qa.picks[m.qa.current]) == 0 {
		m.notice = "Pick at least one option, or press n to decline."
		return nil
	}
	m.notice = ""
	if m.qa.current+1 < len(questions) {
		m.qa.current++
		return nil
	}
	body := map[string]any{"behavior": "allow", "answers": m.qa.answers(questions)}
	m.qa = nil
	return m.sendDecision(a, body)
}

// leave closes the TUI. It never calls /interrupt: the session keeps running (D9).
func (m *tuiModel) leave() (tea.Model, tea.Cmd) {
	m.left = true
	return m, tea.Quit
}

// send files a message through POST /sessions/:id/turns with a fresh clientTurnId and the
// attachments uploaded for it. One sent while a turn runs is followed until its delivery settles.
func (m *tuiModel) send(text string) tea.Cmd {
	clientTurnID, err := m.newID()
	if err != nil {
		m.notice = "Not sent: " + err.Error()
		return nil
	}
	var ids []string
	for _, a := range m.attachments {
		if a.ID != "" {
			ids = append(ids, a.ID)
		}
	}
	m.attachments = nil
	m.notice = ""
	m.transcript.pendingOwn = append(m.transcript.pendingOwn, text)
	if m.working {
		m.steers = append(m.steers, tuiSteer{clientTurnID: clientTurnID, text: text})
	}
	client, id := m.client, m.sessionID
	return func() tea.Msg {
		answer, err := client.sendTurn(context.Background(), id, clientTurnID, text, ids)
		return tuiSentMsg{content: text, clientTurnID: clientTurnID, answer: answer, err: err}
	}
}

// decide answers the oldest waiting card: y allows once, a allows and remembers, n denies.
func (m *tuiModel) decide(key rune) tea.Cmd {
	a := m.approvals[0]
	body := map[string]any{}
	switch key {
	case 'y':
		if _, _, ok := m.questionHead(); ok {
			m.notice = "Pick an option with its number, or press n to decline."
			return nil
		}
		if !a.answerable() {
			m.notice = "Answer this question in the Orbit app, or press n to decline it."
			return nil
		}
		body["behavior"] = "allow"
	case 'a':
		rules := a.rememberRules()
		if !a.answerable() || len(rules) == 0 {
			m.notice = "This card cannot be always allowed; press y or n."
			return nil
		}
		body["behavior"] = "allow"
		body["rememberRules"] = rules
	case 'n':
		body["behavior"] = "deny"
		m.qa = nil
	}
	return m.sendDecision(a, body)
}

// sendDecision takes the card off the queue and posts its answer.
func (m *tuiModel) sendDecision(a tuiApproval, body map[string]any) tea.Cmd {
	m.removeApproval(a.ID)
	m.deciding[a.ID] = true
	client, id := m.client, m.sessionID
	return func() tea.Msg {
		return tuiDecidedMsg{approvalID: a.ID, err: client.decide(context.Background(), id, a.ID, body)}
	}
}

func (m *tuiModel) View() string {
	if m.left {
		return ""
	}
	var b strings.Builder
	if m.draft != "" {
		b.WriteString("\n")
		for _, line := range draftView(m.draft) {
			b.WriteString(line + "\n")
		}
	}
	for i, a := range m.approvals {
		b.WriteString("\n")
		lines := renderApprovalCard(a)
		if i == 0 {
			if _, _, ok := m.questionHead(); ok {
				lines = renderQuestionCard(a, m.qa)
			}
		}
		for _, line := range lines {
			b.WriteString(line + "\n")
		}
	}
	for _, st := range m.steers {
		b.WriteString(st.line() + "\n")
	}
	if m.notice != "" {
		b.WriteString(tuiGrey + m.notice + tuiReset + "\n")
	} else if m.working {
		b.WriteString(tuiGrey + "● Working…" + tuiReset + "\n")
	}
	b.WriteString("\n")
	if len(m.attachments) > 0 {
		var chips []string
		for _, a := range m.attachments {
			switch {
			case a.Err != "":
				chips = append(chips, tuiRed+"⊘ "+a.Name+" (not uploaded: "+firstLine(a.Err)+")"+tuiReset)
			case a.ID == "":
				chips = append(chips, tuiGrey+"⇡ "+a.Name+" (uploading…)"+tuiReset)
			default:
				chips = append(chips, tuiCyan+"＋ "+a.Name+tuiReset)
			}
		}
		b.WriteString(strings.Join(chips, "  ") + "\n")
	}
	composer := string(m.composer)
	if composer == "" {
		composer = tuiGrey + "Message… (/ for commands, paste a file path to attach it)" + tuiReset
	}
	b.WriteString(tuiGrey + "› " + tuiReset + composer + "\n")
	if menu := m.slashMenu(); len(menu) > 0 {
		for i, it := range menu {
			line := "  /" + it.Name
			if it.Description != "" {
				line += tuiGrey + "  " + it.Description + tuiReset
			}
			if i == m.slashCursor {
				line = tuiCyan + "›" + tuiReset + line[1:]
			}
			b.WriteString(line + "\n")
		}
		b.WriteString(tuiGrey + "↑/↓ choose · tab complete · enter run · esc close" + tuiReset)
		return b.String()
	}
	hints := "esc interrupt · ctrl-d leave (session keeps running)"
	if _, _, ok := m.questionHead(); ok {
		hints = "1-9 pick · n decline · " + hints
	} else if len(m.approvals) > 0 {
		hints = "y/a/n answer the card · " + hints
	}
	b.WriteString(tuiGrey + hints + tuiReset)
	return b.String()
}
