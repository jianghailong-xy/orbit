package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
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
		content, turnID string
		err             error
	}
	tuiDecidedMsg struct {
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
	// Whether a turn is running, for the "Working…" line: the text streaming in is not drawn
	// until each message is whole.
	working bool
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
		} else if msg.turnID != "" {
			m.transcript.ownTurns[msg.turnID] = true
		}
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
		return m.resync()
	case "turn_end", "interrupt", "error":
		m.notice = ""
		m.working = false
	case "user", "assistant", "tool_use", "tool_result", "text_delta", "thinking", "thinking_delta":
		m.working = true
	}
	m.outbox = append(m.outbox, m.transcript.render(ev)...)
	return m.flush()
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
	switch k.Type {
	case tea.KeyCtrlD, tea.KeyCtrlC:
		return m.leave()
	case tea.KeyEsc:
		m.notice = "Interrupting…"
		client, id := m.client, m.sessionID
		return m, func() tea.Msg { return tuiInterruptedMsg{client.interrupt(context.Background(), id)} }
	case tea.KeyEnter:
		text := strings.TrimSpace(string(m.composer))
		if text == "" {
			return m, nil
		}
		if text == "/exit" {
			return m.leave()
		}
		m.composer = nil
		return m, m.send(text)
	case tea.KeyBackspace:
		if n := len(m.composer); n > 0 {
			m.composer = m.composer[:n-1]
		}
		return m, nil
	case tea.KeyCtrlU:
		m.composer = nil
		return m, nil
	case tea.KeySpace:
		m.composer = append(m.composer, ' ')
		return m, nil
	case tea.KeyRunes:
		// With a card waiting and nothing typed, y / a / n answer the card (board-1 marker 4).
		if len(m.composer) == 0 && len(m.approvals) > 0 && !k.Paste && len(k.Runes) == 1 {
			switch k.Runes[0] {
			case 'y', 'a', 'n':
				return m, m.decide(k.Runes[0])
			}
		}
		m.composer = append(m.composer, k.Runes...)
		return m, nil
	}
	return m, nil
}

// leave closes the TUI. It never calls /interrupt: the session keeps running (D9).
func (m *tuiModel) leave() (tea.Model, tea.Cmd) {
	m.left = true
	return m, tea.Quit
}

// send files a message through POST /sessions/:id/turns with a fresh clientTurnId.
func (m *tuiModel) send(text string) tea.Cmd {
	clientTurnID, err := m.newID()
	if err != nil {
		m.notice = "Not sent: " + err.Error()
		return nil
	}
	m.notice = ""
	m.transcript.pendingOwn = append(m.transcript.pendingOwn, text)
	client, id := m.client, m.sessionID
	return func() tea.Msg {
		turnID, err := client.sendTurn(context.Background(), id, clientTurnID, text)
		return tuiSentMsg{content: text, turnID: turnID, err: err}
	}
}

// decide answers the oldest waiting card: y allows once, a allows and remembers, n denies.
func (m *tuiModel) decide(key rune) tea.Cmd {
	a := m.approvals[0]
	body := map[string]any{}
	switch key {
	case 'y':
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
	}
	m.approvals = m.approvals[1:]
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
	for _, a := range m.approvals {
		b.WriteString("\n")
		for _, line := range renderApprovalCard(a) {
			b.WriteString(line + "\n")
		}
	}
	if m.notice != "" {
		b.WriteString(tuiGrey + m.notice + tuiReset + "\n")
	} else if m.working {
		b.WriteString(tuiGrey + "● Working…" + tuiReset + "\n")
	}
	b.WriteString("\n")
	composer := string(m.composer)
	if composer == "" {
		composer = tuiGrey + "Message…" + tuiReset
	}
	b.WriteString(tuiGrey + "› " + tuiReset + composer + "\n")
	hints := "esc interrupt · ctrl-d leave (session keeps running)"
	if len(m.approvals) > 0 {
		hints = "y/a/n answer the card · " + hints
	}
	b.WriteString(tuiGrey + hints + tuiReset)
	return b.String()
}
