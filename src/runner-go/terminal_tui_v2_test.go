package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// ---- `orbit resume` dispatch (D8) ----

// `orbit resume <id>` opens the TUI, on the id as the app spells it, and starts no engine CLI.
func TestOrbitResumeWithAnIDOpensTheTUI(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")
	var opened []string
	prev := resumeOpenTUI
	resumeOpenTUI = func(id string, out io.Writer) error { opened = append(opened, id); return nil }
	t.Cleanup(func() { resumeOpenTUI = prev })

	const uuid = "01a113f1-eec1-77dc-b73f-d222d66a53e5"
	cmdResume([]string{uuid})
	cmdResume([]string{publicID(uuid)})
	if want := []string{publicID(uuid), publicID(uuid)}; !reflect.DeepEqual(opened, want) {
		t.Fatalf("opened %q, want %q", opened, want)
	}
}

// `--engine-cli`, wherever it stands, takes the engine CLI path and never the TUI; no id lists.
func TestOrbitResumeEngineCLIFlagAndListKeepTheOldPath(t *testing.T) {
	for _, tc := range []struct {
		args      []string
		engineCLI bool
		rest      []string
	}{
		{[]string{"--engine-cli", "abc"}, true, []string{"abc"}},
		{[]string{"abc", "--engine-cli"}, true, []string{"abc"}},
		{[]string{"abc"}, false, []string{"abc"}},
		{nil, false, nil},
	} {
		engineCLI, rest := resumeArgs(tc.args)
		if engineCLI != tc.engineCLI || !reflect.DeepEqual(rest, tc.rest) {
			t.Errorf("resumeArgs(%q) = %v %q, want %v %q", tc.args, engineCLI, rest, tc.engineCLI, tc.rest)
		}
	}

	configureCLITestRunner(t, "http://127.0.0.1:1")
	prev := resumeOpenTUI
	resumeOpenTUI = func(id string, out io.Writer) error { t.Errorf("the TUI opened on %q", id); return nil }
	t.Cleanup(func() { resumeOpenTUI = prev })
	const id = "5d0c3c0e-1d0f-4c6e-9a7b-2f3e4d5c6b7a"
	if err := os.MkdirAll(runDir(id), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runDir(id), "meta.json"), []byte(`{"provider":"claude","title":"Review"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	out := captureStdout(t, func() { cmdResume(nil) })
	if !strings.Contains(out, "sessions on this machine:") || !strings.Contains(out, id+"  Review") {
		t.Fatalf("orbit resume with no id printed:\n%s", out)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() { data, _ := io.ReadAll(r); done <- string(data) }()
	fn()
	os.Stdout = prev
	w.Close()
	return <-done
}

// The TUI opens on a session of every engine — DeepSeek Harness and Cursor included, which the
// engine CLI path refuses — since it never runs the engine.
func TestTUIOpensOnASessionOfEveryEngine(t *testing.T) {
	for engine, name := range map[string]string{
		"claude": "Claude Code", "codex": "Codex", "kimi": "Kimi Code", "opencode": "OpenCode",
		"antigravity": "Antigravity", "cursor": "Cursor CLI", "dsh": "DeepSeek Harness",
	} {
		t.Run(engine, func(t *testing.T) {
			f := newTUIFakeServer(t)
			f.sessionJSON = strings.Replace(strings.Replace(tuiTestSessionJSON, `"engine":"claude"`, `"engine":"`+engine+`"`, 1),
				`"provider":"claude"`, `"provider":"`+engine+`"`, 1)
			inR, inW := io.Pipe()
			var out lockedBuffer
			done := make(chan error, 1)
			go func() {
				done <- runSessionTUI(tuiOptions{Server: f.URL, Token: "orbit_term_test", SessionID: tuiTestSession, In: inR, Out: &out})
			}()
			waitFor(t, "the transcript", func() bool { return strings.Contains(tuiPlain(out.String()), "› add rate limiting") })
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
			if !strings.Contains(got, "· "+name+" ·") {
				t.Fatalf("status line does not name %s:\n%s", name, got)
			}
		})
	}
}

// ---- Slash commands ----

func TestTUISlashItemsComeFromTheEnginesRegistry(t *testing.T) {
	reg := newSlashRegistry(filepath.Join(t.TempDir(), "slash-registry.json"))
	reg.learnFor(providerClaude, []string{"review", "compact"}, []string{"loop"})
	reg.learnFor(providerKimi, []string{"kimi-init"}, nil)

	names := func(items []tuiSlashItem) []string {
		var out []string
		for _, it := range items {
			out = append(out, it.Name)
		}
		return out
	}
	if got, want := names(tuiSlashItemsFor(reg, "claude")), []string{"exit", "status", "compact", "loop", "review"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("claude items %q, want %q", got, want)
	}
	if got, want := names(tuiSlashItemsFor(reg, "kimi")), []string{"exit", "status", "kimi-init"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("kimi items %q, want %q", got, want)
	}
	for _, engine := range []string{"codex", "opencode", "antigravity", "dsh"} {
		if got := names(tuiSlashItemsFor(reg, engine)); !reflect.DeepEqual(got, []string{"exit", "status"}) {
			t.Fatalf("%s items %q: an engine with no registry offers only the TUI's own", engine, got)
		}
	}
	if got := names(tuiSlashMatches(tuiSlashItemsFor(reg, "claude"), "o")); !reflect.DeepEqual(got, []string{"compact", "loop"}) {
		t.Fatalf("matches for o: %q (none starts with o; those containing it, in order)", got)
	}
}

func TestTUISlashMenuOpensCompletesAndSends(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.approvals = nil
	m.slashItems = append(m.slashItems, tuiSlashItem{Name: "review", Description: "Command"}, tuiSlashItem{Name: "release", Description: "Skill"})

	tuiPress(m, tuiRunes("/"))
	view := tuiPlain(m.View())
	for _, want := range []string{"› /exit  Leave the TUI; the session keeps running", "  /status", "/review  Command", "/release  Skill", "tab complete"} {
		if !strings.Contains(view, want) {
			t.Fatalf("menu lacks %q:\n%s", want, view)
		}
	}
	tuiPress(m, tuiRunes("re"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyDown})
	if view := tuiPlain(m.View()); !strings.Contains(view, "› /release") {
		t.Fatalf("down did not move to release:\n%s", view)
	}
	tuiPress(m, tea.KeyMsg{Type: tea.KeyTab})
	if string(m.composer) != "/release " {
		t.Fatalf("tab completed to %q", string(m.composer))
	}
	tuiPress(m, tuiRunes("v2"))
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))
	if body := f.body("POST /api/sessions/3xK9pQ2mW/turns"); body["content"] != "/release v2" {
		t.Fatalf("turn body %v", body)
	}

	// Enter on the menu runs the highlighted command.
	tuiPress(m, tuiRunes("/rev"))
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))
	if body := f.body("POST /api/sessions/3xK9pQ2mW/turns"); body["content"] != "/review" {
		t.Fatalf("turn body %v", body)
	}

	// The TUI's own: /status draws the status line, /exit leaves; neither reaches the session.
	before := len(f.posts())
	tuiPress(m, tuiRunes("/status"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(m.notice, "shop-api · dev-laptop · Claude Code") {
		t.Fatalf("/status notice %q", m.notice)
	}
	tuiPress(m, tuiRunes("/ex"))
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil || !m.left {
		t.Fatal("/exit did not leave")
	}
	if len(f.posts()) != before {
		t.Fatalf("a local command posted: %q", f.posts()[before:])
	}
}

// A path typed after a slash is prose, not a command: no menu, and it sends as written.
func TestTUISlashMenuLeavesPathsAlone(t *testing.T) {
	m := newTestModel(newTUIFakeServer(t))
	tuiPress(m, tuiRunes("/tmp/build.log"))
	if len(m.slashMenu()) != 0 {
		t.Fatalf("a path opened the menu")
	}
}

// ---- Attachments ----

func TestPastedFilePaths(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "shot.png")
	spaced := filepath.Join(dir, "my notes.txt")
	for _, p := range []string{plain, spaced} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		paste string
		want  []string
	}{
		{plain, []string{plain}},
		{"  " + plain + "\n", []string{plain}},
		{"'" + spaced + "'", []string{spaced}},
		{strings.ReplaceAll(spaced, " ", `\ `), []string{spaced}},
		{"file://" + plain, []string{plain}},
		{plain + " '" + spaced + "'", []string{plain, spaced}},
		{"shot.png", []string{plain}}, // relative to the working directory
		{"look at " + plain, nil},     // prose that mentions a path stays text
		{dir, nil},                    // a directory is not a file
		{filepath.Join(dir, "missing.png"), nil},
		{"'" + plain, nil},
	} {
		if got := pastedFilePaths(tc.paste, dir); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("pastedFilePaths(%q) = %q, want %q", tc.paste, got, tc.want)
		}
	}
}

// A pasted path uploads the file as the apps do — multipart field "file" on POST /attachments scoped
// to the session, typed by its content — and the message sent next carries its id.
func TestTUIPastedPathUploadsAndAttaches(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.approvals = nil
	path := filepath.Join(t.TempDir(), "screen shot.png")
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
	paste := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("'" + path + "'"), Paste: true}
	cmd := tuiPress(m, paste)
	if len(m.composer) != 0 || len(m.attachments) != 1 {
		t.Fatalf("composer %q, attachments %v: the path should attach, not type", string(m.composer), m.attachments)
	}
	if view := tuiPlain(m.View()); !strings.Contains(view, "⇡ screen shot.png (uploading…)") {
		t.Fatalf("view while uploading:\n%s", view)
	}
	// Enter before the upload answers waits for it.
	tuiPress(m, tuiRunes("what is wrong here?"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(m.notice, "Waiting for screen shot.png to upload") || f.body("POST /api/sessions/3xK9pQ2mW/turns") != nil {
		t.Fatalf("sent before the upload finished (notice %q)", m.notice)
	}
	tuiRun(m, cmd)
	if view := tuiPlain(m.View()); !strings.Contains(view, "＋ screen shot.png") {
		t.Fatalf("view after upload:\n%s", view)
	}

	f.mu.Lock()
	raw, ctype, query := f.raw["POST /api/attachments"], f.rawType["POST /api/attachments"], f.query["POST /api/attachments"]
	f.mu.Unlock()
	if query != "sessionId="+tuiTestSession {
		t.Fatalf("upload query %q", query)
	}
	_, params, err := mime.ParseMediaType(ctype)
	if err != nil {
		t.Fatal(err)
	}
	part, err := multipart.NewReader(bytes.NewReader(raw), params["boundary"]).NextPart()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(part)
	if part.FormName() != "file" || part.FileName() != "screen shot.png" || part.Header.Get("Content-Type") != "image/png" || !bytes.Equal(data, png) {
		t.Fatalf("part %q %q %q, %d bytes", part.FormName(), part.FileName(), part.Header.Get("Content-Type"), len(data))
	}

	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))
	body := f.body("POST /api/sessions/3xK9pQ2mW/turns")
	if body["content"] != "what is wrong here?" || !reflect.DeepEqual(body["attachmentIds"], []any{"att-1"}) {
		t.Fatalf("turn body %v", body)
	}
	if len(m.attachments) != 0 {
		t.Fatalf("attachments stayed after sending: %v", m.attachments)
	}
}

func TestTUIBackspaceOnAnEmptyComposerDropsTheLastAttachment(t *testing.T) {
	m := newTestModel(newTUIFakeServer(t))
	m.attachments = []tuiAttachment{{Name: "a.txt", ID: "1"}, {Name: "b.txt", ID: "2"}}
	tuiPress(m, tea.KeyMsg{Type: tea.KeyBackspace})
	if len(m.attachments) != 1 || m.attachments[0].Name != "a.txt" {
		t.Fatalf("attachments %v", m.attachments)
	}
}

// ---- Steer delivery states ----

func TestSteerStateLabels(t *testing.T) {
	for delivery, want := range map[string]string{
		"": "Sending…", "enqueued": "Sending…", "written": "Waiting to be read",
		"acknowledged": "Read in this turn", "failed": "Not delivered",
		"requeued": "Queued for next turn instead", "unconfirmed": "Couldn't confirm it was read",
	} {
		if got := steerStateLabel(delivery); got != want {
			t.Errorf("%q → %q, want %q", delivery, got, want)
		}
	}
}

// A message sent while a turn runs is shown Sending…, then Waiting to be read, and when it settles
// leaves one line in the scrollback: Read in this turn, or Not delivered with the reason.
func TestTUISteerWalksThroughItsDeliveryStates(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.approvals = nil
	m.working = true
	m.printing = true // hold the scrollback in m.outbox so the test can read it
	ids := []string{"c-1", "c-2"}
	m.newID = func() (string, error) { id := ids[0]; ids = ids[1:]; return id, nil }

	steerView := func() string {
		var lines []string
		for _, l := range strings.Split(tuiPlain(m.View()), "\n") {
			if strings.HasPrefix(l, "  ↳") {
				lines = append(lines, l)
			}
		}
		return strings.Join(lines, "\n")
	}

	tuiPress(m, tuiRunes("also cover logout"))
	cmd := tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	if got := steerView(); got != "  ↳ also cover logout  Sending…" {
		t.Fatalf("before the answer: %q", got)
	}
	m.Update(tuiSentMsg{content: "also cover logout", clientTurnID: "c-1", answer: tuiTurnAnswer{TurnID: "t-1", Placement: "steer"}})
	_ = cmd
	m.event(tuiEvent{Seq: 60, Type: "user", TurnID: "t-1", Payload: json.RawMessage(`{"text":"also cover logout","steer":true,"delivery":"written"}`)})
	if got := steerView(); got != "  ↳ also cover logout  Waiting to be read" {
		t.Fatalf("written: %q", got)
	}
	m.event(tuiEvent{Type: "user_delivery", Payload: json.RawMessage(`{"turnId":"t-1","delivery":"acknowledged"}`)})
	if got := steerView(); got != "" {
		t.Fatalf("a settled steer stayed in the live area: %q", got)
	}
	if got := tuiPlainLines(m.outbox); !strings.HasSuffix(got, "  ↳ also cover logout  Read in this turn") {
		t.Fatalf("scrollback:\n%s", got)
	}

	// A second one fails: the reason is said plainly.
	m.outbox = nil
	tuiPress(m, tuiRunes("and the signup page"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	// The stream names the turn before the send's answer does: matched by text.
	m.event(tuiEvent{Seq: 61, Type: "user", TurnID: "t-2", Payload: json.RawMessage(`{"text":"and the signup page","steer":true,"delivery":"enqueued"}`)})
	if got := steerView(); got != "  ↳ and the signup page  Sending…" {
		t.Fatalf("enqueued: %q", got)
	}
	m.event(tuiEvent{Type: "user_delivery", TurnID: "t-2", Payload: json.RawMessage(`{"delivery":"failed","code":"CURRENT_WORK_TARGET_COMPLETED","reason":"the target turn completed"}`)})
	if got := tuiPlainLines(m.outbox); !strings.HasSuffix(got, "  ↳ and the signup page  Not delivered — The turn finished before it was read.") {
		t.Fatalf("scrollback:\n%s", got)
	}
	if len(m.steers) != 0 {
		t.Fatalf("steers left: %v", m.steers)
	}
}

// A message the server queues rather than steers, or one sent while nothing runs, is not followed.
func TestTUIOnlySteersAreFollowed(t *testing.T) {
	m := newTestModel(newTUIFakeServer(t))
	m.approvals = nil
	tuiPress(m, tuiRunes("hello"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	if len(m.steers) != 0 {
		t.Fatalf("an idle send is followed: %v", m.steers)
	}
	m.working = true
	tuiPress(m, tuiRunes("next"))
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	m.Update(tuiSentMsg{content: "next", clientTurnID: "6f1d2c3b-0000-4000-8000-000000000001", answer: tuiTurnAnswer{TurnID: "t-9", Placement: "queued"}})
	if len(m.steers) != 0 {
		t.Fatalf("a queued send is followed: %v", m.steers)
	}
}

// ---- AskUserQuestion ----

const tuiTestQuestionJSON = `{"id":"q-1","sessionId":"3xK9pQ2mW","toolName":"AskUserQuestion","status":"PENDING",
"input":{"questions":[
 {"question":"Which store?","header":"Store","multiSelect":false,"options":[{"label":"Redis","description":"Shared across instances"},{"label":"Memory"}]},
 {"question":"Which routes?","header":"Routes","multiSelect":true,"options":[{"label":"/login"},{"label":"/signup"},{"label":"/reset"}]}]}}`

// A question card is answered by picking: a number takes a single-select option and moves on, toggles
// a multi-select one, Enter moves on, and the last answer sends the body web's ApprovalPanel sends.
func TestTUIAnswersAnAskUserQuestionCard(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.setApprovals([]json.RawMessage{json.RawMessage(tuiTestQuestionJSON), json.RawMessage(tuiTestApprovalJSON)})

	view := tuiPlain(m.View())
	for _, want := range []string{"│ Approval  Answer a question", "│ › Store: Which store?", "[1] Redis — Shared across instances", "[2] Memory",
		"│   Routes: Which routes?", "[1-9] Pick   [n] Decline", "1-9 pick · n decline"} {
		if !strings.Contains(view, want) {
			t.Fatalf("card lacks %q:\n%s", want, view)
		}
	}
	tuiPress(m, tuiRunes("y"))
	if !strings.Contains(m.notice, "Pick an option with its number") {
		t.Fatalf("y on a question: notice %q", m.notice)
	}
	tuiPress(m, tuiRunes("2"))
	view = tuiPlain(m.View())
	if !strings.Contains(view, "✓ Memory") || !strings.Contains(view, "› Routes: Which routes?") || !strings.Contains(view, "[enter] Next") {
		t.Fatalf("after the first pick:\n%s", view)
	}
	// Enter with nothing picked on a multi-select question asks for a pick.
	tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(m.notice, "Pick at least one option") {
		t.Fatalf("notice %q", m.notice)
	}
	tuiPress(m, tuiRunes("3"))
	tuiPress(m, tuiRunes("1"))
	tuiPress(m, tuiRunes("2"))
	tuiPress(m, tuiRunes("2")) // toggled off again
	if view := tuiPlain(m.View()); !strings.Contains(view, "✓ [1] /login") || !strings.Contains(view, "✓ [3] /reset") || strings.Contains(view, "✓ [2]") {
		t.Fatalf("multi-select picks:\n%s", view)
	}
	tuiRun(m, tuiPress(m, tea.KeyMsg{Type: tea.KeyEnter}))

	got := f.body("POST /api/sessions/3xK9pQ2mW/approvals/q-1/decision")
	data, _ := json.Marshal(got)
	if want := `{"answers":{"Which routes?":["/reset","/login"],"Which store?":["Memory"]},"behavior":"allow"}`; string(data) != want {
		t.Fatalf("decision body\n got: %s\nwant: %s", data, want)
	}
	if len(m.approvals) != 1 || m.approvals[0].ID == "q-1" {
		t.Fatalf("the answered card stayed: %v", m.approvals)
	}
	if !strings.Contains(tuiPlain(m.View()), "y/a/n answer the card") {
		t.Fatalf("the Bash card behind it does not take y/a/n:\n%s", tuiPlain(m.View()))
	}
}

func TestTUIDeclinesAQuestionWithN(t *testing.T) {
	f := newTUIFakeServer(t)
	m := newTestModel(f)
	m.setApprovals([]json.RawMessage{json.RawMessage(tuiTestQuestionJSON)})
	tuiPress(m, tuiRunes("1"))
	tuiRun(m, tuiPress(m, tuiRunes("n")))
	data, _ := json.Marshal(f.body("POST /api/sessions/3xK9pQ2mW/approvals/q-1/decision"))
	if string(data) != `{"behavior":"deny"}` {
		t.Fatalf("decision body %s", data)
	}
	if m.qa != nil {
		t.Fatalf("picking state stayed: %+v", m.qa)
	}
}

// ---- Streaming ----

// Text deltas draw in the live area as they arrive; the whole message replaces them in the scrollback.
// A steer written into the turn does not cut the reply off; a reconnect starts the draft over.
func TestTUIStreamsAssistantTextAsItArrives(t *testing.T) {
	m := newTestModel(newTUIFakeServer(t))
	m.approvals = nil
	m.printing = true
	for _, chunk := range []string{"Adding a ", "test for\nthe lim"} {
		data, _ := json.Marshal(map[string]string{"text": chunk})
		m.event(tuiEvent{Type: "text_delta", Payload: data})
	}
	if view := tuiPlain(m.View()); !strings.Contains(view, "Adding a test for\nthe lim\n") {
		t.Fatalf("draft not drawn:\n%s", view)
	}
	if len(m.outbox) != 0 {
		t.Fatalf("a delta reached the scrollback: %q", m.outbox)
	}
	m.event(tuiEvent{Seq: 70, Type: "user", Payload: json.RawMessage(`{"text":"also logout","steer":true}`)})
	if m.draft == "" {
		t.Fatal("a steer cleared the draft")
	}
	m.event(tuiEvent{Seq: 71, Type: "assistant", Payload: json.RawMessage(`{"text":"Adding a test for\nthe limit."}`)})
	if m.draft != "" || strings.Contains(tuiPlain(m.View()), "the lim\n") {
		t.Fatalf("draft stayed after the whole message: %q", m.draft)
	}
	if got := tuiPlainLines(m.outbox); !strings.HasSuffix(got, "Adding a test for\nthe limit.") {
		t.Fatalf("scrollback:\n%s", got)
	}

	m.event(tuiEvent{Type: "text_delta", Payload: json.RawMessage(`{"text":"Half"}`)})
	m.Update(tuiStreamRestartMsg{})
	m.event(tuiEvent{Type: "text_delta", Payload: json.RawMessage(`{"text":"Half a reply"}`)})
	if m.draft != "Half a reply" {
		t.Fatalf("draft after reconnect %q", m.draft)
	}
	lines := draftView(strings.Repeat("x\n", 20) + "last")
	if len(lines) != tuiDraftLines || lines[len(lines)-1] != "last" {
		t.Fatalf("draft view %q", lines)
	}
}

// ---- Engine and model picker ----

const tuiTestRunnersJSON = `[
 {"id":"other","engines":[{"engine":"claude","installed":true,"auth":"yes"}]},
 {"id":"01a113f1-eec1-77dc-b73f-d222d66a53e5","engines":[
  {"engine":"claude","installed":true,"auth":"yes"},
  {"engine":"codex","installed":true,"auth":"no"},
  {"engine":"kimi","installed":false,"auth":"unknown"},
  {"engine":"cursor","installed":true,"installationError":"unsupported platform","auth":"yes"},
  {"engine":"dsh","installed":true,"auth":"unknown"}],
  "modelCatalog":{"claude":[{"value":"claude-sonnet-5-5","label":"Sonnet 5.5","priority":2},{"value":"claude-opus-5-5","label":"Opus 5.5","priority":1}]},
  "runtimeDefaultModels":{"claude":"claude-opus-5-5"}}]`

const tuiTestProvidersJSON = `[
 {"slug":"deepseek","label":"DeepSeek","engines":["dsh","claude","kimi"],"models":[{"value":"deepseek-v4","label":"DeepSeek V4"}],"defaultModel":"deepseek-v4"}]`

func TestEngineOptionsForThisMachine(t *testing.T) {
	options, err := engineOptionsFor([]byte(tuiTestRunnersJSON), []byte(tuiTestProvidersJSON), publicID("01a113f1-eec1-77dc-b73f-d222d66a53e5"))
	if err != nil {
		t.Fatal(err)
	}
	type row struct{ label, engine, provider, def, models string }
	var got []row
	for _, o := range options {
		var models []string
		for _, m := range o.Models {
			models = append(models, m.Value)
		}
		got = append(got, row{o.Label, o.Engine, o.Provider, o.DefaultModel, strings.Join(models, ",")})
	}
	want := []row{
		{"Claude Code", "claude", "claude", "claude-opus-5-5", "claude-opus-5-5,claude-sonnet-5-5"},
		{"DeepSeek Harness · DeepSeek", "dsh", "deepseek", "deepseek-v4", "deepseek-v4"},
		{"Claude Code · DeepSeek", "claude", "deepseek", "deepseek-v4", "deepseek-v4"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("options\n got: %+v\nwant: %+v", got, want)
	}
	if _, err := engineOptionsFor([]byte(tuiTestRunnersJSON), nil, "missing"); err == nil {
		t.Fatal("a runner not in the list gave options")
	}
	if _, err := engineOptionsFor([]byte(`[{"id":"r","engines":[{"engine":"codex","installed":true,"auth":"no"}]}]`), nil, "r"); err == nil ||
		!strings.Contains(err.Error(), "orbit doctor") {
		t.Fatalf("no ready engine: %v", err)
	}
}

func TestEnginePickerKeys(t *testing.T) {
	options, _ := engineOptionsFor([]byte(tuiTestRunnersJSON), []byte(tuiTestProvidersJSON), "01a113f1-eec1-77dc-b73f-d222d66a53e5")
	m := &tuiPickerModel{options: options}
	view := tuiPlain(m.View())
	if !strings.Contains(view, "Engine for the new session\n› Claude Code\n  DeepSeek Harness · DeepSeek\n  Claude Code · DeepSeek") {
		t.Fatalf("engine stage:\n%s", view)
	}
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if view := tuiPlain(m.View()); !strings.Contains(view, "Model for Claude Code\n› Default (claude-opus-5-5)\n  Opus 5.5\n  Sonnet 5.5") {
		t.Fatalf("model stage:\n%s", view)
	}
	m.Update(tea.KeyMsg{Type: tea.KeyEsc}) // back to the engines, on the one picked
	m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m.Update(tuiRunes("j"))
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil {
		t.Fatal("picking a model did not finish")
	}
	if want := (tuiEngineChoice{Engine: "dsh", Provider: "deepseek", Model: "deepseek-v4"}); m.choice == nil || *m.choice != want {
		t.Fatalf("choice %+v, want %+v", m.choice, want)
	}

	// Default sends no model; Esc on the engines cancels.
	m = &tuiPickerModel{options: options}
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	body := map[string]any{}
	m.choice.applyTo(body)
	if !reflect.DeepEqual(body, map[string]any{"engine": "claude", "provider": "claude"}) {
		t.Fatalf("default body %v", body)
	}
	m = &tuiPickerModel{options: options}
	m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if !m.canceled || m.choice != nil {
		t.Fatal("esc did not cancel")
	}
}

// The picker as a program in front of POST /sessions: what is picked travels as the app sends it.
func TestCreateSessionWithPickerPostsTheChoice(t *testing.T) {
	f := newTUIFakeServer(t)
	f.runnersJSON, f.providersJSON = tuiTestRunnersJSON, tuiTestProvidersJSON
	in := strings.NewReader("\rjj\r") // Claude Code, then the third model row: Sonnet 5.5
	var out lockedBuffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	body := map[string]any{"prompt": "hi", "workspaceId": "w1", "assignedRunnerId": "01a113f1-eec1-77dc-b73f-d222d66a53e5"}
	id, err := createSessionWithPicker(ctx, newTUIClient(f.URL, "orbit_term_test"), "01a113f1-eec1-77dc-b73f-d222d66a53e5", body, in, &out)
	if err != nil {
		t.Fatalf("%v; output:\n%s", err, tuiPlain(out.String()))
	}
	if id != "new-session-1" {
		t.Fatalf("id %q", id)
	}
	got := f.body("POST /api/sessions")
	want := map[string]any{"prompt": "hi", "workspaceId": "w1", "assignedRunnerId": "01a113f1-eec1-77dc-b73f-d222d66a53e5",
		"engine": "claude", "provider": "claude", "model": "claude-sonnet-5-5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("POST /sessions body\n got: %v\nwant: %v", got, want)
	}
}
