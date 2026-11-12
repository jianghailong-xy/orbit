package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The fixtures in testdata/terminal_tui are events in the shapes the runner emits them (claude.go:
// assistant {text}, tool_use {id,name,input}, tool_result {toolUseId,content,isError}; session.go:
// user {text,delivery}, turn_end {subtype,…}) and the server stores and streams them
// (events/page {hasMore,events}; SSE data frames, pings, approval_request at seq 0 from
// realtime.service.ts; sentFrom added to a message by the server that recorded its client, and only
// externalSender on a Feishu member's message from a server older than sentFrom).

const tuiTestSession = "3xK9pQ2mW"

const tuiTestSessionJSON = `{"id":"3xK9pQ2mW","engine":"claude","provider":"claude","model":"claude-opus-5-5",
"permissionMode":"auto","workspace":{"id":"w1","name":"shop-api"},
"assignedRunner":{"id":"r1","name":"workstation","displayName":"dev-laptop"}}`

const tuiTestApprovalJSON = `{"id":"0193f2a0-0000-7000-8000-0000000000a1","sessionId":"3xK9pQ2mW","toolName":"Bash",
"input":{"command":"npm test -- login","description":"Run the login tests"},"status":"PENDING","createdAt":"2026-11-12T09:01:03.000Z"}`

// Every escape sequence bubbletea or the renderer writes, so what is left is the text a person reads.
var tuiTestEscapes = regexp.MustCompile("\x1b(\\[[0-9;?]*[ -/]*[@-~]|\\][^\x07]*\x07|[()][0-9A-B]|[=>78M])")

func tuiPlain(s string) string { return tuiTestEscapes.ReplaceAllString(s, "") }

func tuiPlainLines(lines []string) string {
	var out []string
	for _, l := range lines {
		out = append(out, tuiPlain(l))
	}
	return strings.Join(out, "\n")
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/terminal_tui/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func fixturePage(t *testing.T) []tuiEvent {
	var page struct {
		Events []tuiEvent `json:"events"`
	}
	if err := json.Unmarshal(readFixture(t, "page.json"), &page); err != nil {
		t.Fatal(err)
	}
	return page.Events
}

func fixtureStream(t *testing.T) []tuiEvent {
	var events []tuiEvent
	if err := readSSE(bytes.NewReader(readFixture(t, "stream.sse")), func(ev tuiEvent) { events = append(events, ev) }); err != nil {
		t.Fatal(err)
	}
	return events
}

func TestTUIStatusLineNamesWorkspaceMachineEngineModelMode(t *testing.T) {
	got := tuiPlain(parseTUISessionInfo([]byte(tuiTestSessionJSON)).statusLine())
	want := "◆ Orbit shop-api · dev-laptop · Claude Code · claude-opus-5-5 · auto"
	if got != want {
		t.Fatalf("status line\n got: %q\nwant: %q", got, want)
	}
}

// The recorded page renders as text, one folded line per tool call, and the edit's diff.
func TestTUIRendersRecordedTranscript(t *testing.T) {
	tr := newTUITranscript()
	var lines []string
	for _, ev := range fixturePage(t) {
		lines = append(lines, tr.render(ev)...)
	}
	got := tuiPlainLines(lines)
	want := strings.Join([]string{
		"",
		"› add rate limiting to the /login route",
		"",
		"I'll look at the login handler first.",
		"▸ Read src/routes/login.ts",
		"▸ Edit src/routes/login.ts  +2 -1",
		"  │ + import { rateLimit } from '../lib/rate-limit';",
		"  │ - router.post('/login', handler);",
		"  │ + router.post('/login', rateLimit({ max: 5 }), handler);",
		"▸ Bash npx tsc --noEmit",
		"  ✗ src/lib/rate-limit.ts(3,1): error TS2307",
	}, "\n")
	if got != want {
		t.Fatalf("transcript\n got:\n%s\nwant:\n%s", got, want)
	}
	if tr.lastSeq != 51 {
		t.Fatalf("lastSeq = %d, want 51", tr.lastSeq)
	}
	// A replayed event (the stream and the page overlap) prints nothing twice.
	if again := tr.render(fixturePage(t)[3]); again != nil {
		t.Fatalf("replayed event printed again: %q", again)
	}
}

func TestTUIDiffFoldsPastSixLinesAndCountsWrites(t *testing.T) {
	var content []string
	for i := 1; i <= 9; i++ {
		content = append(content, fmt.Sprintf("line %d", i))
	}
	lines := renderToolUse("Write", map[string]any{"file_path": "a.txt", "content": strings.Join(content, "\n") + "\n"})
	got := tuiPlainLines(lines)
	if !strings.HasPrefix(got, "▸ Write a.txt  +9 -0\n  │ + line 1") || !strings.HasSuffix(got, "  │ + line 6\n  │ …") {
		t.Fatalf("write diff:\n%s", got)
	}
}

// A message that arrives while the TUI is open, and that this TUI did not send, names where it
// came from; one this TUI sent, and history from before it opened, do not.
func TestTUIForeignMessageShowsItsSource(t *testing.T) {
	tr := newTUITranscript()
	var history []string
	for _, ev := range fixturePage(t) {
		history = append(history, tr.render(ev)...)
	}
	if strings.Contains(tuiPlainLines(history), "· from") {
		t.Fatalf("history names a source:\n%s", tuiPlainLines(history))
	}
	tr.live = true
	var streamed []string
	for _, ev := range fixtureStream(t) {
		streamed = append(streamed, tr.render(ev)...)
	}
	got := tuiPlainLines(streamed)
	want := strings.Join([]string{
		"",
		"› also add a test  · from iPhone",
		"",
		"Adding a test for the limit.",
		"",
		"› keep the limit at 5  · from Feishu · Li Wei",
	}, "\n")
	if got != want {
		t.Fatalf("live messages\n got:\n%s\nwant:\n%s", got, want)
	}
	// A message this TUI sent is its own: by its text while POST /turns has not answered…
	tr.pendingOwn = []string{"keep going"}
	if got := tuiPlainLines(tr.render(tuiEvent{Seq: 98, Type: "user", TurnID: "own-1", Payload: json.RawMessage(`{"text":"keep going"}`)})); got != "\n› keep going" {
		t.Fatalf("own message: %q", got)
	}
	// …and by the turn POST /turns answered, whatever its text.
	tr.ownTurns["t-9"] = true
	if got := tuiPlainLines(tr.render(tuiEvent{Seq: 99, Type: "user", TurnID: "t-9", Payload: json.RawMessage(`{"text":"x"}`)})); got != "\n› x" {
		t.Fatalf("own turn by id: %q", got)
	}
}

// Each client the server records on a turn (`sentFrom`, apiserver sessions/turn-sender-client.ts)
// reads as its own label; with no sentFrom — a server older than the field — a Feishu sender still
// reads as Feishu and anything else as "another device".
func TestTUIForeignMessageLabelsEachSenderClient(t *testing.T) {
	cases := []struct {
		payload string
		want    string
	}{
		{`{"client":"ios","device":"iphone"}`, "iPhone"},
		{`{"client":"ios","device":"ipad"}`, "iPad"},
		{`{"client":"ios"}`, "iPhone"},
		{`{"client":"macos"}`, "Mac"},
		{`{"client":"android"}`, "Android"},
		{`{"client":"web"}`, "web"},
		{`{"client":"terminal","machineName":"build-box"}`, "terminal on build-box"},
		{`{"client":"terminal"}`, "a terminal"},
		{`{"client":"feishu","name":"Li Wei"}`, "Feishu · Li Wei"},
		{`{"client":"feishu"}`, "Feishu"},
		{`{"client":"session","sessionTitle":"Fix login\nredirect"}`, "session Fix login redirect"},
		{`{"client":"session"}`, "another session"},
		{`{"client":"runner"}`, "the orbit CLI"},
		// A client this build does not know yet falls back as an absent field does.
		{`{"client":"watch"}`, "another device"},
	}
	for i, c := range cases {
		tr := newTUITranscript()
		tr.live = true
		ev := tuiEvent{Seq: int64(100 + i), Type: "user", TurnID: fmt.Sprintf("t-%d", i),
			Payload: json.RawMessage(`{"text":"also add a test","sentFrom":` + c.payload + `}`)}
		if got, want := tuiPlainLines(tr.render(ev)), "\n› also add a test  · from "+c.want; got != want {
			t.Errorf("sentFrom %s: got %q, want %q", c.payload, got, want)
		}
	}
	for payload, want := range map[string]string{
		`{"text":"also add a test"}`: "another device",
		`{"text":"also add a test","externalSender":{"source":"FEISHU","name":"Li Wei"}}`: "Feishu · Li Wei",
		`{"text":"also add a test","sentFrom":"iPhone"}`:                                  "another device",
	} {
		tr := newTUITranscript()
		tr.live = true
		ev := tuiEvent{Seq: 200, Type: "user", TurnID: "t-old", Payload: json.RawMessage(payload)}
		if got := tuiPlainLines(tr.render(ev)); got != "\n› also add a test  · from "+want {
			t.Errorf("%s: got %q, want %q", payload, got, want)
		}
	}
}

func TestTUIApprovalCard(t *testing.T) {
	var a tuiApproval
	if err := json.Unmarshal([]byte(tuiTestApprovalJSON), &a); err != nil {
		t.Fatal(err)
	}
	got := tuiPlainLines(renderApprovalCard(a))
	want := strings.Join([]string{
		"│ Approval  Run a command",
		"│ npm test -- login",
		"│ [y] Allow once   [a] Always allow npm test   [n] Deny",
	}, "\n")
	if got != want {
		t.Fatalf("card\n got:\n%s\nwant:\n%s", got, want)
	}
	q := tuiApproval{ID: "q", ToolName: "AskUserQuestion", Input: map[string]any{}}
	if got := tuiPlainLines(renderApprovalCard(q)); !strings.HasSuffix(got, "│ [n] Deny") || strings.Contains(got, "[y]") {
		t.Fatalf("question card offers keys it cannot answer:\n%s", got)
	}
}

func TestTUIBashRulePrefixes(t *testing.T) {
	cases := map[string][]string{
		"npm test -- login":            {"npm test"},
		"cd src && git add -A; npm ci": {"cd src", "git add", "npm ci"},
		"FOO=1 go test ./...":          {"go test"},
		"ls -la | grep x":              {"ls", "grep x"},
		"bash -lc 'rm -rf /'":          nil,
	}
	for cmd, want := range cases {
		if got := bashRulePrefixes(cmd); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%q: got %q, want %q", cmd, got, want)
		}
	}
}

// tuiFakeServer is the apiserver as far as the TUI reaches it: it serves the session, its page,
// its pending approvals and the SSE stream, and records every request.
type tuiFakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []string // "METHOD /path"
	bodies   map[string][]map[string]any
	stream   []byte
	sent     chan string
}

func newTUIFakeServer(t *testing.T) *tuiFakeServer {
	f := &tuiFakeServer{bodies: map[string][]map[string]any{}, sent: make(chan string, 16)}
	f.stream = readFixture(t, "stream.sse")
	base := "/api/sessions/" + tuiTestSession
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer orbit_term_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		key := r.Method + " " + r.URL.Path
		var body map[string]any
		if data, _ := io.ReadAll(r.Body); len(data) > 0 {
			_ = json.Unmarshal(data, &body)
		}
		f.mu.Lock()
		f.requests = append(f.requests, key)
		f.bodies[key] = append(f.bodies[key], body)
		f.mu.Unlock()
		switch {
		case key == "GET "+base:
			io.WriteString(w, tuiTestSessionJSON)
		case key == "GET "+base+"/events/page":
			w.Write(readFixture(t, "page.json"))
		case key == "GET "+base+"/approvals":
			io.WriteString(w, "["+tuiTestApprovalJSON+"]")
		case key == "GET "+base+"/events":
			w.Header().Set("Content-Type", "text/event-stream")
			if r.URL.Query().Get("sinceSeq") == "51" {
				w.Write(f.stream)
			}
			w.(http.Flusher).Flush()
			<-r.Context().Done() // the stream stays open until the TUI leaves
		case r.Method == http.MethodPost && key == "POST "+base+"/turns":
			io.WriteString(w, `{"turnId":"0193f2a0-0000-7000-8000-0000000000f1","seq":3,"kind":"message","placement":"accepted"}`)
		default:
			io.WriteString(w, `{}`)
		}
		if r.Method == http.MethodPost {
			f.sent <- key
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *tuiFakeServer) posts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		if strings.HasPrefix(r, "POST ") {
			out = append(out, r)
		}
	}
	return out
}

func (f *tuiFakeServer) body(key string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.bodies[key]
	if len(list) == 0 {
		return nil
	}
	return list[len(list)-1]
}

// run executes a command the way bubbletea would, feeding what it answers back into the model.
func tuiRun(m *tuiModel, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		for _, c := range msg {
			tuiRun(m, c)
		}
	case nil:
	default:
		_, next := m.Update(msg)
		tuiRun(m, next)
	}
}

func tuiPress(m *tuiModel, k tea.KeyMsg) tea.Cmd {
	_, cmd := m.Update(k)
	return cmd
}

func tuiRunes(s string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)} }

func newTestModel(f *tuiFakeServer) *tuiModel {
	m := newTUIModel(newTUIClient(f.URL, "orbit_term_test"), tuiTestSession, parseTUISessionInfo([]byte(tuiTestSessionJSON)))
	m.setApprovals([]json.RawMessage{json.RawMessage(tuiTestApprovalJSON)})
	m.newID = func() (string, error) { return "6f1d2c3b-0000-4000-8000-000000000001", nil }
	return m
}

const tuiTestDecision = "POST /api/sessions/3xK9pQ2mW/approvals/0193f2a0-0000-7000-8000-0000000000a1/decision"

func TestTUIKeysYANAnswerTheCard(t *testing.T) {
	for _, tc := range []struct {
		key  string
		want string
	}{
		{"y", `{"behavior":"allow"}`},
		{"a", `{"behavior":"allow","rememberRules":[{"ruleContent":"npm test:*","toolName":"Bash"}]}`},
		{"n", `{"behavior":"deny"}`},
	} {
		t.Run(tc.key, func(t *testing.T) {
			f := newTUIFakeServer(t)
			m := newTestModel(f)
			tuiRun(m, tuiPress(m, tuiRunes(tc.key)))
			if got := f.posts(); fmt.Sprint(got) != fmt.Sprint([]string{tuiTestDecision}) {
				t.Fatalf("requests: %q", got)
			}
			body, _ := json.Marshal(f.body(tuiTestDecision))
			if string(body) != tc.want {
				t.Fatalf("decision body %s, want %s", body, tc.want)
			}
			if len(m.approvals) != 0 || len(m.composer) != 0 {
				t.Fatalf("card still shown (%d) or key typed into the composer (%q)", len(m.approvals), string(m.composer))
			}
		})
	}
}

// With text in the composer, y / a / n are letters, not answers.
func TestTUIKeysTypeWhenComposerHasText(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	tuiPress(m, tuiRunes("o"))
	tuiRun(m, tuiPress(m, tuiRunes("k")))
	tuiRun(m, tuiPress(m, tuiRunes("y")))
	if string(m.composer) != "oky" || len(f.posts()) != 0 || len(m.approvals) != 1 {
		t.Fatalf("composer %q, posts %q, cards %d", string(m.composer), f.posts(), len(m.approvals))
	}
}

func TestTUIEnterSendsATurnWithClientTurnID(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.approvals = nil
	for _, r := range "also add a test" {
		if r == ' ' {
			tuiPress(m, tea.KeyMsg{Type: tea.KeySpace})
		} else {
			tuiPress(m, tuiRunes(string(r)))
		}
	}
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))
	turns := "POST /api/sessions/3xK9pQ2mW/turns"
	if got := f.posts(); fmt.Sprint(got) != fmt.Sprint([]string{turns}) {
		t.Fatalf("requests: %q", got)
	}
	body := f.body(turns)
	if body["content"] != "also add a test" || body["clientTurnId"] != "6f1d2c3b-0000-4000-8000-000000000001" {
		t.Fatalf("turn body: %v", body)
	}
	if !m.transcript.ownTurns["0193f2a0-0000-7000-8000-0000000000f1"] || len(m.composer) != 0 {
		t.Fatalf("own turn not remembered (%v) or composer not cleared (%q)", m.transcript.ownTurns, string(m.composer))
	}
	// An empty Enter sends nothing.
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))
	if len(f.posts()) != 1 {
		t.Fatalf("empty Enter sent: %q", f.posts())
	}
}

func TestTUIEscInterrupts(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEsc}))
	if got := f.posts(); fmt.Sprint(got) != fmt.Sprint([]string{"POST /api/sessions/3xK9pQ2mW/interrupt"}) {
		t.Fatalf("requests: %q", got)
	}
}

// Ctrl-D, Ctrl-C and /exit leave: the program quits and nothing is sent, /interrupt least of all.
func TestTUILeavingNeverInterrupts(t *testing.T) {
	for name, keys := range map[string][]tea.KeyMsg{
		"ctrl-d": {{Type: tea.KeyCtrlD}},
		"ctrl-c": {{Type: tea.KeyCtrlC}},
		"/exit":  {tuiRunes("/exit"), {Type: tea.KeyEnter}},
	} {
		t.Run(name, func(t *testing.T) {
			f := newTUIFakeServer(t)
			m := newTestModel(f)
			var cmd tea.Cmd
			for _, k := range keys {
				cmd = tuiPress(m, k)
			}
			if cmd == nil {
				t.Fatal("leaving returned no command")
			}
			if _, ok := cmd().(tea.QuitMsg); !ok || !m.left {
				t.Fatalf("leaving did not quit (left=%v)", m.left)
			}
			if got := f.posts(); len(got) != 0 {
				t.Fatalf("leaving sent %q", got)
			}
		})
	}
}

// The whole TUI against the fake server through a real bubbletea program: it prints the status
// line and the transcript, follows the stream (a foreign message names its source), shows the
// approval card, sends what is typed on Enter, interrupts on Esc, and on Ctrl-D leaves with the
// reopen line, having called /interrupt only for the Esc.
func TestTUIProgramEndToEnd(t *testing.T) {
	f := newTUIFakeServer(t)
	inR, inW := io.Pipe()
	var out lockedBuffer
	done := make(chan error, 1)
	go func() {
		done <- runSessionTUI(tuiOptions{Server: f.URL, Token: "orbit_term_test", SessionID: tuiTestSession, Machine: "fallback", In: inR, Out: &out})
	}()
	waitFor(t, "the streamed approval card", func() bool { return strings.Contains(tuiPlain(out.String()), "[a] Always allow npm test") })
	waitFor(t, "the foreign message", func() bool {
		return strings.Contains(tuiPlain(out.String()), "› also add a test  · from iPhone")
	})

	type step struct {
		input string
		post  string
	}
	for _, s := range []step{
		{"hi there\r", "POST /api/sessions/3xK9pQ2mW/turns"},
		{"\x1b", "POST /api/sessions/3xK9pQ2mW/interrupt"},
		{"n", tuiTestDecision},
	} {
		if _, err := io.WriteString(inW, s.input); err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-f.sent:
			if got != s.post {
				t.Fatalf("input %q posted %s, want %s", s.input, got, s.post)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("input %q posted nothing; output:\n%s", s.input, tuiPlain(out.String()))
		}
	}
	io.WriteString(inW, "\x04")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl-D did not leave")
	}
	inW.Close()

	got := tuiPlain(out.String())
	for _, want := range []string{
		"◆ Orbit shop-api · dev-laptop · Claude Code · claude-opus-5-5 · auto",
		"› add rate limiting to the /login route\n",
		"▸ Edit src/routes/login.ts  +2 -1",
		"› keep the limit at 5  · from Feishu · Li Wei",
		"◆ Orbit Left the session; it keeps running on dev-laptop.\n  Reopen: orbit resume 3xK9pQ2mW\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	posts := f.posts()
	interrupts := 0
	for _, p := range posts {
		if strings.HasSuffix(p, "/interrupt") {
			interrupts++
		}
	}
	if interrupts != 1 || len(posts) != 3 {
		t.Fatalf("posts %q: want the send, the Esc's one interrupt and the deny, nothing on leaving", posts)
	}
	if body := f.body("POST /api/sessions/3xK9pQ2mW/turns"); body["content"] != "hi there" || body["clientTurnId"] == "" {
		t.Fatalf("turn body: %v", body)
	}
}

func TestLeaveMessage(t *testing.T) {
	if got := tuiPlain(leaveMessage("dev-laptop", "3xK9pQ2mW")); got != "◆ Orbit Left the session; it keeps running on dev-laptop.\n  Reopen: orbit resume 3xK9pQ2mW\n" {
		t.Fatalf("%q", got)
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
