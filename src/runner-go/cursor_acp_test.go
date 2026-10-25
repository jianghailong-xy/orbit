package main

// The Cursor CLI session driver (cursor_acp.go, cursor_events.go) run against P0 recordings of the
// pinned CLI, replayed by the fake in fake_cursor_acp_test.go. The named scenarios here are the ones
// scripts/test-cursor-acp-driver.mjs runs.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// cursorTestSessionID is shaped like an Orbit session id, as the session's Cursor directory requires.
const cursorTestSessionID = "31111111-2222-4333-8444-666666666666"

type cursorEvent struct {
	turn, typ string
	payload   map[string]interface{}
}

type cursorEvents struct {
	mu     sync.Mutex
	events []cursorEvent
}

func (e *cursorEvents) emitFor(turn, typ string, payload map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, cursorEvent{turn, typ, payload})
}

func (e *cursorEvents) snapshot() []cursorEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]cursorEvent(nil), e.events...)
}

type cursorRunOptions struct {
	recording, session string // the recorded process replayed; the one session of a recording of two
	// script adjusts how the recording is replayed: how the CLI ends, what `agent models` says.
	script func(*fakeCursorACPScript)
	// replay is handed the recorded CLI before the session starts on it.
	replay func(*cursorReplay)
	// first is delivered at once; then is asked, after each turn-complete, what to deliver next.
	first []RunInboxResponse
	then  func(completed int, last TurnCompleteRequest) []RunInboxResponse
	// stopEngine and stopRunner end, at the first event each holds for, the session's engine context —
	// as a session cancel or an idle recycle ends it — and the runner's shutdown context.
	stopEngine, stopRunner func(event cursorEvent) bool
	// onEvent is asked, as each event goes out, what to deliver next: a message, a steer or an interrupt
	// that arrives while a turn runs. It is called from more than one goroutine.
	onEvent func(event cursorEvent) []RunInboxResponse
	env     map[string]string // the session's agent environment; a Cursor API key when nil
	agent   func(*AgentExecConfig)
	// naming is whether the claim asks the engine to name the session (session_naming.go).
	naming bool
	// title is the title the claim carries; "Cursor test session" when empty.
	title string
	// runtimeSessionID is a conversation the session has already had.
	runtimeSessionID string
	blobs            map[string]string // attachments the control plane serves, by id
	// sameHome runs in the HOME and ORBIT_HOME the test already set up, and execDir in the checkout it
	// names: a later process of the session finds what an earlier one left.
	sameHome bool
	execDir  string
	// scratch is the session's scratch directory, which keeps its record (meta.json): a claim writes the
	// record there before the session's engine starts, as runInteractiveSession does. A new one when empty,
	// and nothing written before the engine.
	scratch string
	// approve decides each approval card the session files, in the order filed; nil denies every one.
	approve func(card cursorTestCard) cursorTestDecision
	// onCard hears each card as it is filed, and says what to deliver next.
	onCard func(card cursorTestCard) []RunInboxResponse
	// onAnswer hears each answer the runner sent the replayed CLI to a request of the CLI's own, by the
	// request's recorded id, once the CLI has read it, and says what to deliver next.
	onAnswer func(id string) []RunInboxResponse
	// executable runs the session on this Cursor CLI instead of a replay (cursor_permissions_real_test.go);
	// serve answers the control-plane requests the stub does not know, reporting whether it did.
	executable string
	serve      func(w http.ResponseWriter, r *http.Request) bool
	// timeout bounds the whole session; 60 s when zero.
	timeout time.Duration
	// onServer is told the stub control plane's address before the session starts.
	onServer func(url string)
	// taskID is the task the session runs for.
	taskID string
	// sessionID is the session's id; cursorTestSessionID when empty. Sessions run side by side need ids of
	// their own, and with them directories and stub control planes of their own.
	sessionID string
	// keepSlashRegistry runs the session on the slash registry the test already gave itself
	// (useCursorSlashRegistry) rather than one of its own: sessions run side by side share one.
	keepSlashRegistry bool
}

// cursorTestCard is one approval card a session filed with the stub control plane.
type cursorTestCard struct {
	ID        string
	ToolName  string
	ToolUseID string
	Input     interface{}
	// Withdrawn: the runner stopped reading the card while it was still open (its poll's context ended).
	Withdrawn bool
	// Polls is how many reads of the card reached the stub.
	Polls int
}

// released is whether the runner no longer reads a card nobody answered: its read was cut off, or it never
// read it at all. (One it still read would hold the stub's Close, and with it the test, until the deadline.)
func (c cursorTestCard) released() bool { return c.Withdrawn || c.Polls == 0 }

// cursorTestDecision is how the stub control plane answers a card: Status ALLOWED or DENIED, with what a
// question card or a refusal carries; "" holds the card open until the runner stops reading it.
type cursorTestDecision struct {
	Status        string
	Message       string
	Answers       map[string][]string
	RememberRules []PermissionRule
}

// cursorLeaseLost delivered to a session makes the control plane answer its next inbox poll as the
// lease's new owner would have it answered: 409.
const cursorLeaseLost = "test-lease-lost"

type cursorRun struct {
	status        string
	ended, reload bool
	job           *ClaimedSession
	spec          CursorLaunchSpec
	scratch       string
	fake          *cursorReplay
	events        []cursorEvent
	completions   []TurnCompleteRequest
	namings       []SessionNamingRequest
	keyChecks     []CursorKeyCheckReport
	leaseLost     error // what onLeaseLost was told, after a cursorLeaseLost
	cards         []cursorTestCard
}

// useCursorSlashRegistry gives the test a slash registry of its own: the package's is the runner
// user's, under the real ~/.orbit.
func useCursorSlashRegistry(t *testing.T) {
	t.Helper()
	previous := slashReg
	slashReg = newSlashRegistry(filepath.Join(t.TempDir(), "slash-registry.json"))
	t.Cleanup(func() { slashReg = previous })
}

// cursorTurns delivers each turn once the one before it has settled, then ends the session.
func cursorTurns(turns ...RunInboxResponse) ([]RunInboxResponse, func(int, TurnCompleteRequest) []RunInboxResponse) {
	return turns[:1], func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
		if completed < len(turns) {
			return turns[completed : completed+1]
		}
		return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
	}
}

func cursorMessage(turnID, content string) RunInboxResponse {
	return RunInboxResponse{TurnID: turnID, Kind: "message", Content: content}
}

// cursorFirstPrompt is the text of a new conversation's first prompt: Orbit's agent instructions ahead
// of what the turn says (cursorAgentInstructions).
func cursorFirstPrompt(job *ClaimedSession, text string) string {
	return "<orbit-agent-instructions>\n" + cursorAgentInstructions(job) + "\n</orbit-agent-instructions>\n\n" + text
}

// runCursorSession runs one Orbit session on the recorded CLI against a stub control plane, with the
// launch the runner prepares for it and the replay as its executable.
func runCursorSession(t *testing.T, opts cursorRunOptions) cursorRun {
	t.Helper()
	if !opts.sameHome {
		useCursorRealHome(t)
	}
	if !opts.keepSlashRegistry {
		useCursorSlashRegistry(t)
	}
	sessionID := opts.sessionID
	if sessionID == "" {
		sessionID = cursorTestSessionID
	}
	timeout := opts.timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var fake *cursorReplay
	executable := opts.executable
	if executable == "" {
		script := fakeCursorACPScript{Recording: opts.recording, Session: opts.session}
		if opts.script != nil {
			opts.script(&script)
		}
		fake = newCursorReplayScript(t, script)
		if opts.replay != nil {
			opts.replay(fake)
		}
		executable = fake.shim
	}
	env := opts.env
	if env == nil {
		env = map[string]string{"CURSOR_API_KEY": cursorTestKey}
	}
	title := opts.title
	if title == "" {
		title = "Cursor test session"
	}
	job := &ClaimedSession{SessionID: sessionID, Provider: providerCursor, Title: title, TaskID: opts.taskID,
		RuntimeSessionID: opts.runtimeSessionID, Agent: AgentExecConfig{Provider: providerCursor, Env: env}}
	if opts.naming {
		job.Naming = &SessionNamingJob{Description: "the session's opening request"}
	}
	if opts.agent != nil {
		opts.agent(&job.Agent)
	}
	execDir := opts.execDir
	if execDir == "" {
		execDir = t.TempDir()
	}
	spec, err := prepareCursorLaunch(job, execDir, executable, filepath.Join(runDir(job.SessionID), "cursor"))
	if err != nil {
		t.Fatal(err)
	}
	run := cursorRun{job: job, spec: spec, scratch: opts.scratch, fake: fake}
	if run.scratch == "" {
		run.scratch = t.TempDir()
	} else {
		if err := os.MkdirAll(run.scratch, 0o755); err != nil {
			t.Fatal(err)
		}
		writeSessionMeta(run.scratch, job, execDir)
	}
	var mu sync.Mutex
	leaseMoved := false // a cursorLeaseLost was answered
	inbox := make(chan RunInboxResponse, 16)
	for _, item := range opts.first {
		inbox <- item
	}
	prefix := "/api/runner/sessions/" + sessionID + "/"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == prefix+"inbox":
			select {
			case item := <-inbox:
				if item.Kind == cursorLeaseLost {
					mu.Lock()
					leaseMoved = true
					mu.Unlock()
					http.Error(w, `{"code":"LEASE_NOT_OWNED"}`, http.StatusConflict)
					return
				}
				_ = json.NewEncoder(w).Encode(item)
			case <-r.Context().Done():
			}
		case r.Method == http.MethodPost && r.URL.Path == prefix+"cursor-key-check":
			var check CursorKeyCheckReport
			if err := json.NewDecoder(r.Body).Decode(&check); err != nil {
				t.Errorf("key check report: %v", err)
			}
			mu.Lock()
			run.keyChecks = append(run.keyChecks, check)
			mu.Unlock()
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, prefix+"attachments/"):
			_, _ = w.Write([]byte(opts.blobs[strings.TrimPrefix(r.URL.Path, prefix+"attachments/")]))
		case r.Method == http.MethodPost && r.URL.Path == prefix+"approvals":
			var card cursorTestCard
			var body struct {
				ToolName  string      `json:"toolName"`
				Input     interface{} `json:"input"`
				ToolUseID string      `json:"toolUseId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("approval request: %v", err)
			}
			mu.Lock()
			card = cursorTestCard{ID: fmt.Sprintf("approval-%d", len(run.cards)+1), ToolName: body.ToolName, ToolUseID: body.ToolUseID, Input: body.Input}
			run.cards = append(run.cards, card)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"id": card.ID, "status": "PENDING"})
			if opts.onCard != nil {
				for _, next := range opts.onCard(card) {
					inbox <- next
				}
			}
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, prefix+"approvals/"):
			id := strings.TrimPrefix(r.URL.Path, prefix+"approvals/")
			mu.Lock()
			index := -1
			for i := range run.cards {
				if run.cards[i].ID == id {
					index = i
				}
			}
			var card cursorTestCard
			if index >= 0 {
				run.cards[index].Polls++
				card = run.cards[index]
			}
			mu.Unlock()
			if index < 0 {
				http.NotFound(w, r)
				return
			}
			decision := cursorTestDecision{Status: "DENIED"}
			if opts.approve != nil {
				decision = opts.approve(card)
			}
			if decision.Status == "" {
				<-r.Context().Done()
				mu.Lock()
				run.cards[index].Withdrawn = true
				mu.Unlock()
				return
			}
			_ = json.NewEncoder(w).Encode(ApprovalDecisionResponse{ID: id, Status: decision.Status, Message: decision.Message,
				Answers: decision.Answers, RememberRules: decision.RememberRules})
		case r.Method == http.MethodPost && r.URL.Path == prefix+"naming":
			var naming SessionNamingRequest
			if err := json.NewDecoder(r.Body).Decode(&naming); err != nil {
				t.Errorf("naming request: %v", err)
			}
			mu.Lock()
			run.namings = append(run.namings, naming)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"applied":true}`))
		default:
			if opts.serve != nil && opts.serve(w, r) {
				return
			}
			t.Errorf("unexpected control-plane request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	if opts.onServer != nil {
		opts.onServer(server.URL)
	}
	var events cursorEvents
	complete := func(req TurnCompleteRequest, _ ...context.Context) error {
		mu.Lock()
		run.completions = append(run.completions, req)
		completed := len(run.completions)
		mu.Unlock()
		events.emitFor(req.TurnID, "completion", map[string]interface{}{"status": req.Status})
		if opts.then != nil {
			for _, next := range opts.then(completed, req) {
				inbox <- next
			}
		}
		return nil
	}
	engineCtx, stopEngine := context.WithCancel(ctx)
	defer stopEngine()
	shutdownCtx, stopRunner := context.WithCancel(context.Background())
	defer stopRunner()
	emitFor := func(turn, typ string, payload map[string]interface{}) {
		events.emitFor(turn, typ, payload)
		event := cursorEvent{turn, typ, payload}
		if opts.stopEngine != nil && opts.stopEngine(event) {
			stopEngine()
		}
		if opts.stopRunner != nil && opts.stopRunner(event) {
			stopRunner()
		}
		if opts.onEvent != nil {
			for _, next := range opts.onEvent(event) {
				inbox <- next
			}
		}
	}
	if opts.onAnswer != nil {
		// The replayed CLI notes each line it reads in received.jsonl as it reads it.
		go func() {
			heard := map[string]bool{}
			for ctx.Err() == nil {
				data, _ := os.ReadFile(filepath.Join(fake.dir, "received.jsonl"))
				for _, line := range strings.Split(string(data), "\n") {
					var received fakeCursorReceived
					if json.Unmarshal([]byte(line), &received) != nil || received.Message["method"] != nil || received.Message["id"] == nil {
						continue
					}
					if id := rpcIDKey(received.Message["id"]); !heard[id] {
						heard[id] = true
						for _, next := range opts.onAnswer(id) {
							select {
							case inbox <- next:
							case <-ctx.Done():
							}
						}
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
		}()
	}
	status, ended, reload := providerRuntimeFor(runtimeProvider(job)).run(sessionProcessArgs{
		ctx: engineCtx, shutdownCtx: shutdownCtx, t: NewTransport(server.URL, "synthetic-runner-token"),
		job: job, execDir: execDir, scratchDir: run.scratch, cursorLaunchSpec: &spec,
		emit:    func(typ string, payload map[string]interface{}) { emitFor("", typ, payload) },
		emitFor: emitFor, setTurn: func(string) {}, completeTurn: complete,
		waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost: func(err error) {
			mu.Lock()
			run.leaseLost = err
			mu.Unlock()
		},
	})
	mu.Lock()
	if run.leaseLost != nil && !leaseMoved {
		t.Errorf("the session lost its lease: %v", run.leaseLost)
	}
	mu.Unlock()
	if ctx.Err() != nil {
		t.Fatalf("the session did not finish on its own: %v", ctx.Err())
	}
	run.status, run.ended, run.reload = status, ended, reload
	run.events = events.snapshot()
	return run
}

// of is the payloads of the events of one type a turn has, in order ("" for the session's own).
func (r cursorRun) of(turn, typ string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, event := range r.events {
		if event.turn == turn && event.typ == typ {
			out = append(out, event.payload)
		}
	}
	return out
}

// recordedSessionUpdates is what a recording streamed, as session/update payloads, in order.
func recordedSessionUpdates(t *testing.T, recording string) []map[string]interface{} {
	t.Helper()
	written, err := readFakeCursorJSONL(filepath.Join("testdata", "cursor", recording, "stdout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var updates []map[string]interface{}
	for _, msg := range written {
		if msg["method"] == "session/update" {
			updates = append(updates, mapValue(msg["params"]))
		}
	}
	return updates
}

func cursorJSONEqual(t *testing.T, got, want interface{}) bool {
	t.Helper()
	a, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	return string(a) == string(b)
}

// The CLI starts from the session's launch — on the key the workspace brings, a runner signed out — is
// initialized with the handshake the contract settled on, and opens its conversation with session/new in
// the session's checkout: no authenticate, no flag naming a model, and nothing else before the first prompt.
func TestCursorACPInitializeAndNewSession(t *testing.T) {
	t.Run("handshake", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then})
		if run.status != stSucceeded || !run.ended || run.reload {
			t.Fatalf("run = (%s, ended=%v, reload=%v), want an ended success", run.status, run.ended, run.reload)
		}
		started := run.fake.started(t)
		if !reflect.DeepEqual(started.Args, []string{"acp", "--disable-auto-update", "--disable-indexing", "--disable-project-configs"}) || started.Dir != run.spec.Cwd {
			t.Fatalf("Cursor CLI started as %q in %s, want `acp` with the launch's flags in %s", started.Args, started.Dir, run.spec.Cwd)
		}
		env := envMap(started.Env)
		for key, want := range map[string]string{"CURSOR_API_KEY": cursorTestKey, "AGENT_CLI_CREDENTIAL_STORE": "memory",
			"HOME": run.spec.Home, "CURSOR_CONFIG_DIR": run.spec.ConfigDir, "CURSOR_DATA_DIR": run.spec.DataDir} {
			if env[key] != want {
				t.Errorf("Cursor CLI's %s = %q, want %q", key, env[key], want)
			}
		}
		if _, ok := env["CURSOR_AUTH_TOKEN"]; ok {
			t.Error("a session on an API key also carried a login token")
		}
		var methods []string
		for _, line := range run.fake.received(t) {
			if method := asString(line.Message["method"]); method != "" {
				methods = append(methods, method)
			}
		}
		if want := []string{"initialize", "session/new", "session/prompt"}; !reflect.DeepEqual(methods, want) {
			t.Fatalf("the runner sent %q, want %q", methods, want)
		}
		initialize := run.fake.requests(t, "initialize")[0]
		if !cursorJSONEqual(t, initialize.Message["params"], cursorInitializeParams()) {
			t.Fatalf("initialize params = %v, want the contract's %v", initialize.Message["params"], cursorInitializeParams())
		}
		params := mapValue(initialize.Message["params"])
		capabilities := mapValue(params["clientCapabilities"])
		meta := mapValue(capabilities["_meta"])
		if toInt(params["protocolVersion"]) != 1 || capabilities["terminal"] != false || meta["subagents"] != true || meta["parameterizedModelPicker"] != true ||
			!cursorJSONEqual(t, capabilities["fs"], map[string]bool{"readTextFile": false, "writeTextFile": false}) {
			t.Fatalf("initialize does not declare what the contract settled on: %v", params)
		}
		open := run.fake.requests(t, "session/new")[0]
		if open.Emitted < 1 {
			t.Fatal("session/new was sent before initialize was answered")
		}
		servers, err := cursorMCPServers(run.job)
		if err != nil {
			t.Fatal(err)
		}
		if !cursorJSONEqual(t, open.Message["params"], map[string]interface{}{"cwd": run.spec.Cwd, "mcpServers": servers}) {
			t.Fatalf("session/new params = %v, want the session's checkout and Orbit's MCP server", open.Message["params"])
		}
		inits := run.of("", evSystem)
		var init map[string]interface{}
		for _, payload := range inits {
			if payload["subtype"] == "init" {
				init = payload
			}
		}
		if init == nil || init["sessionId"] != "<UUID_1>" || init["provider"] != providerCursor || init["cliVersion"] != cursorSupportedVersion {
			t.Fatalf("init event = %v, want the session id session/new returned", init)
		}
		// The recording's one turn ran into the account's usage limit, which settles it failed
		// (TestCursorACPErrorClassification): it settles once all the same.
		if len(run.completions) != 1 || run.completions[0].TurnID != "turn-1" {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("dispatched-key", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then,
			env: map[string]string{cursorAPIKeyVar: cursorTestKey, "CURSOR_API_KEY": "key_from-the-workspace"}})
		env := envMap(run.fake.started(t).Env)
		if env["CURSOR_API_KEY"] != cursorTestKey {
			t.Fatal("the session's CLI does not run on the key Orbit dispatched")
		}
		if _, ok := env[cursorAPIKeyVar]; ok {
			t.Fatal("the dispatch variable reached the CLI")
		}
		if run.status != stSucceeded || len(run.completions) != 1 {
			t.Fatalf("run = %s, completions %+v", run.status, run.completions)
		}
	})
	t.Run("default-account-login", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		var token string
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then,
			env: map[string]string{}, agent: func(*AgentExecConfig) {
				token = cursorTestToken(t, time.Now().Add(time.Hour))
				signInCursorDefault(t, token)
			}})
		env := envMap(run.fake.started(t).Env)
		if env["CURSOR_AUTH_TOKEN"] != token || env["AGENT_CLI_CREDENTIAL_STORE"] != "memory" {
			t.Fatalf("a session without a key of its own did not run on the Default account's login: %v", env)
		}
		if _, ok := env["CURSOR_API_KEY"]; ok {
			t.Fatal("a session on the Default account carried an API key")
		}
		if run.status != stSucceeded || len(run.completions) != 1 {
			t.Fatalf("run = %s, completions %+v", run.status, run.completions)
		}
	})
	t.Run("signed-out", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", env: map[string]string{}})
		errors := run.of("", evError)
		if run.status != stFailed || !run.ended || len(errors) != 1 || !isAuthError(asString(errors[0]["message"])) {
			t.Fatalf("run = (%s, ended=%v), errors %v: want a failed end that asks for a sign-in", run.status, run.ended, errors)
		}
		if _, err := os.Stat(filepath.Join(run.fake.dir, "start.json")); err == nil {
			t.Fatal("Cursor CLI was started for a session with no credential")
		}
	})
	t.Run("model-and-effort", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: "parameterized-model-picker/acp",
			first: []RunInboxResponse{{TurnID: "end-session", Kind: "end"}},
			agent: func(agent *AgentExecConfig) { agent.Model, agent.Effort = "claude-opus-5-5", "high" }})
		if run.status != stSucceeded || !run.ended {
			t.Fatalf("run = (%s, ended=%v)", run.status, run.ended)
		}
		var selections []interface{}
		for _, line := range run.fake.requests(t, "session/set_config_option") {
			params := mapValue(line.Message["params"])
			selections = append(selections, map[string]interface{}{"configId": params["configId"], "value": params["value"], "sessionId": params["sessionId"]})
		}
		want := []interface{}{
			map[string]interface{}{"configId": "model", "value": "claude-opus-5-5", "sessionId": "<UUID_1>"},
			map[string]interface{}{"configId": "effort", "value": "high", "sessionId": "<UUID_1>"},
		}
		if !cursorJSONEqual(t, selections, want) {
			t.Fatalf("set_config_option = %v, want the model, then the effort it lists", selections)
		}
	})
}

// Every kind of update the recordings hold reaches the transcript as the Orbit event it is.
func TestCursorACPEventMapping(t *testing.T) {
	t.Run("text-and-thinking", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then})
		var wantText, wantThought strings.Builder
		for _, params := range recordedSessionUpdates(t, "multi-turn-tools-default/turns") {
			update := mapValue(params["update"])
			text := firstString(mapValue(update["content"]), "text")
			switch firstString(update, "sessionUpdate") {
			case "agent_message_chunk":
				wantText.WriteString(text)
			case "agent_thought_chunk":
				wantThought.WriteString(text)
			}
			if strings.Contains(text, "TANGERINE; 1 ok") {
				break // the first turn's answer; the second turn was never prompted
			}
		}
		var gotText, gotThought strings.Builder
		for _, payload := range run.of("turn-1", evTextDelta) {
			gotText.WriteString(asString(payload["text"]))
		}
		for _, payload := range run.of("turn-1", evThinkingDelta) {
			gotThought.WriteString(asString(payload["text"]))
		}
		if gotText.String() != wantText.String() {
			t.Fatalf("text deltas = %q, want the turn's chunks as streamed: %q", gotText.String(), wantText.String())
		}
		if gotThought.Len() == 0 || gotThought.String() != wantThought.String() {
			t.Fatalf("thinking deltas = %q, want the turn's thought chunks as streamed: %q", gotThought.String(), wantThought.String())
		}
		// Each stretch closes into one durable block where the stream moved on.
		var blocks []string
		for _, event := range run.events {
			if event.turn != "turn-1" {
				continue
			}
			switch event.typ {
			case evThinking, evAssistant:
				blocks = append(blocks, event.typ+": "+asString(event.payload["text"]))
			case evToolUse:
				blocks = append(blocks, "tool: "+asString(event.payload["name"]))
			}
		}
		if len(blocks) < 4 || blocks[0] != "thinking: Beginning the automated protocol probe. First step: read README.md." ||
			blocks[1] != "assistant: Starting the protocol probe: step 1 — reading README.md." || blocks[2] != "tool: Read" ||
			blocks[len(blocks)-1] != "assistant: TANGERINE; 1 ok, 2 ok, 3 ok, 4 ok, 5 ok, 6 rejected, 7 ok" {
			t.Fatalf("durable blocks = %q", blocks)
		}
		wantResult := "Starting the protocol probe: step 1 — reading README.md.\n\n" +
			"Step 6: inspecting the p0probe `record` tool schema, then calling it.\n\n" +
			"Step 6 was rejected. Step 7: fetching https://example.com/.\n\n" +
			"TANGERINE; 1 ok, 2 ok, 3 ok, 4 ok, 5 ok, 6 rejected, 7 ok"
		if len(run.completions) != 1 || run.completions[0].Result != wantResult {
			t.Fatalf("result = %q, want the turn's replies %q", run.completions[0].Result, wantResult)
		}
	})
	t.Run("tools", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then})
		uses, results := run.of("turn-1", evToolUse), run.of("turn-1", evToolResult)
		if len(uses) != 7 || len(results) != 7 {
			t.Fatalf("tool_use %d, tool_result %d: want the turn's seven cards, each with one result", len(uses), len(results))
		}
		// Every card goes out once, ahead of its one result.
		seen := map[string]int{}
		for _, event := range run.events {
			switch event.typ {
			case evToolUse:
				if seen[asString(event.payload["id"])] != 0 {
					t.Fatalf("card %q went out twice or after its result", event.payload["id"])
				}
				seen[asString(event.payload["id"])] = 1
			case evToolResult:
				if seen[asString(event.payload["toolUseId"])] != 1 {
					t.Fatalf("result for %q without its card, or twice", event.payload["toolUseId"])
				}
				seen[asString(event.payload["toolUseId"])] = 2
			}
		}
		// The approvals Cursor asked for each went to Orbit's card, about the card the turn shows, and were
		// answered with what the person decided (cursor_permissions.go): refused here, once each.
		answered := 0
		for _, line := range run.fake.received(t) {
			if line.Message["method"] == nil && line.Message["id"] != nil {
				answered++
				if outcome := mapValue(mapValue(line.Message["result"])["outcome"]); outcome["optionId"] != cursorRejectOnce {
					t.Fatalf("an approval was answered %v", line.Message)
				}
			}
		}
		if answered != 4 {
			t.Fatalf("answered %d of the turn's four approval requests", answered)
		}
		var names []string
		for _, card := range run.cards {
			names = append(names, card.ToolName)
			if seen[card.ToolUseID] != 2 {
				t.Errorf("card %s is about %q, which is no card of the turn", card.ToolName, card.ToolUseID)
			}
		}
		if want := []string{"Bash", "Bash", "mcp__p0probe__record", "WebFetch"}; !reflect.DeepEqual(names, want) {
			t.Fatalf("cards = %q, want %q", names, want)
		}
	})
	t.Run("plan", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "plan the change"))
		run := runCursorSession(t, cursorRunOptions{recording: "plan-and-ask-modes-concurrent/modes", session: "<UUID_2>", first: first, then: then,
			approve: func(card cursorTestCard) cursorTestDecision {
				if card.ToolName == "ExitPlanMode" {
					return cursorTestDecision{Status: "ALLOWED"}
				}
				return cursorTestDecision{Status: "DENIED"}
			}})
		var plan, card map[string]interface{}
		var planResult, cardResult map[string]interface{}
		for _, use := range run.of("turn-1", evToolUse) {
			switch use["name"] {
			case "plan":
				plan = use
			case "ExitPlanMode":
				card = use
			}
		}
		for _, result := range run.of("turn-1", evToolResult) {
			switch result["toolUseId"] {
			case plan["id"]:
				planResult = result
			case card["id"]:
				cardResult = result
			}
		}
		if plan == nil || !cursorJSONEqual(t, plan["input"], map[string]interface{}{"entries": []interface{}{
			map[string]interface{}{"content": "Add CONTRIBUTING md", "priority": "high", "status": "pending"}}}) ||
			planResult["content"] != "- [ ] Add CONTRIBUTING md" {
			t.Fatalf("plan card = %v, result %v", plan, planResult)
		}
		if card == nil || !strings.HasPrefix(asString(mapValue(card["input"])["plan"]), "# Add CONTRIBUTING.md\n\n1. Create") ||
			cardResult["isError"] != false || !strings.HasPrefix(asString(cardResult["content"]), "Plan saved to file://") {
			t.Fatalf("create-plan card = %v, result %v", card, cardResult)
		}
		var planAnswer map[string]interface{}
		for _, line := range run.fake.received(t) {
			if rpcIDKey(line.Message["id"]) == "3" && line.Message["method"] == nil {
				planAnswer = mapValue(mapValue(line.Message["result"])["outcome"])
			}
		}
		if planAnswer["outcome"] != "accepted" {
			t.Fatalf("cursor/create_plan answered %v, want accepted", planAnswer)
		}
		// Accepted on Orbit's plan card, about the plan's own card.
		var plans []cursorTestCard
		for _, c := range run.cards {
			if c.ToolName == "ExitPlanMode" {
				plans = append(plans, c)
			}
		}
		if len(plans) != 1 || plans[0].ToolUseID != card["id"] ||
			!strings.HasPrefix(asString(mapValue(plans[0].Input)["plan"]), "# Add CONTRIBUTING.md") {
			t.Fatalf("plan cards = %+v", plans)
		}
		if len(run.completions) != 1 || run.completions[0].Status != stSucceeded {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("subagent", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "todos and a subagent"))
		run := runCursorSession(t, cursorRunOptions{recording: "subagent-and-todos/subagent", first: first, then: then})
		const task = "call-<UUID_1>-1\nfc_<UUID_2>_1"
		var nested []string
		taskSeen, taskDone := false, false
		for _, event := range run.events {
			if event.turn != "turn-1" {
				continue
			}
			p := event.payload
			switch {
			case event.typ == evToolUse && p["id"] == task:
				taskSeen = true
				if p["name"] != "Task" || !cursorJSONEqual(t, p["input"], map[string]interface{}{"description": "Read README first line",
					"prompt":        "Read the file README.md in the workspace at <RUN>/work/README.md and return ONLY its first line (the exact text of line 1, nothing else).",
					"subagent_type": "generalPurpose"}) || p["parentToolUseId"] != nil {
					t.Fatalf("Task card = %v", p)
				}
			case event.typ == evToolResult && p["toolUseId"] == task:
				taskDone = true
			case p["parentToolUseId"] == task:
				if !taskSeen || taskDone {
					t.Fatalf("a sub-agent event went out outside its Task card: %v", p)
				}
				label := event.typ
				if event.typ == evToolUse {
					label += " " + asString(p["name"]) + " " + asString(mapValue(p["input"])["file_path"])
				} else if text := firstNonEmpty(asString(p["text"]), asString(p["content"])); text != "" {
					label += " " + text
				}
				nested = append(nested, label)
			}
			if (event.typ == evTextDelta || event.typ == evThinkingDelta) && strings.Contains(asString(p["text"]), "extract its first line") {
				t.Fatal("a sub-agent's text went out as the session's own live text")
			}
		}
		want := []string{
			"thinking Reading the README.md file to extract its first line.",
			"tool_use Read <RUN>/work/README.md",
			"tool_result # probe repo",
			"thinking I will read the first line of the README.md file.",
			"assistant # probe repo",
		}
		if !reflect.DeepEqual(nested, want) || !taskDone {
			t.Fatalf("under the Task card: %q (card closed: %v), want %q", nested, taskDone, want)
		}
		var todos []interface{}
		for _, use := range run.of("turn-1", evToolUse) {
			if use["name"] == "TodoWrite" {
				todos = append(todos, mapValue(use["input"])["todos"])
			}
		}
		wantTodos := []interface{}{
			[]interface{}{map[string]interface{}{"content": "read README", "status": "in_progress"}, map[string]interface{}{"content": "report first line", "status": "pending"}},
			[]interface{}{map[string]interface{}{"content": "read README", "status": "completed"}, map[string]interface{}{"content": "report first line", "status": "completed"}},
		}
		if !cursorJSONEqual(t, todos, wantTodos) {
			t.Fatalf("todo cards = %v, want %v", todos, wantTodos)
		}
		// cursor/update_todos and cursor/task are requests, and each is answered.
		answers := map[string]interface{}{}
		for _, line := range run.fake.received(t) {
			if line.Message["method"] == nil && line.Message["id"] != nil {
				answers[rpcIDKey(line.Message["id"])] = line.Message["result"]
			}
		}
		if !cursorJSONEqual(t, answers, map[string]interface{}{"0": map[string]interface{}{}, "1": map[string]interface{}{}, "2": map[string]interface{}{}}) {
			t.Fatalf("the CLI's requests were answered %v", answers)
		}
		if len(run.completions) != 1 || run.completions[0].Result !=
			"I'll create the todo list and start one subagent to read the first line of README.md.\n\n"+
				"Marking both todos complete, then replying with only the first line.\n\n# probe repo" {
			t.Fatalf("completions = %+v: the result is the session's own agent's replies, never a sub-agent's", run.completions)
		}
	})
	t.Run("title", func(t *testing.T) {
		// A conversation a later process loads, whose prompts are the person's own. One opened here leads with
		// Orbit's agent instructions, and its title is never reported (TestCursorSessionTitlePrefix).
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: cursorLoadedTitleRecording(t, "Previous Shell Command"), runtimeSessionID: "<UUID_1>",
			first: first, then: then, naming: true})
		if !reflect.DeepEqual(run.namings, []SessionNamingRequest{{Replaces: "Cursor test session", Title: "Previous Shell Command"}}) {
			t.Fatalf("naming = %+v, want Cursor's title reported once against the claimed one", run.namings)
		}
	})
	t.Run("title-not-asked-for", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then})
		if len(run.namings) != 0 {
			t.Fatalf("naming = %+v: a session whose claim asked for no name keeps its title", run.namings)
		}
	})
	t.Run("slash-commands", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then})
		commands, skills := slashReg.extrasFor(providerCursor, nil)
		got := map[string]bool{}
		for _, command := range commands {
			if command.Provider != providerCursor || command.Type != "command" {
				t.Fatalf("command %+v is not tagged as Cursor CLI's", command)
			}
			got[command.Name] = true
		}
		for _, name := range []string{"copy-request-id", "multi-model-review", "simplify", "worktree"} {
			if !got[name] {
				t.Errorf("Cursor CLI's /%s was not learned: %v", name, commands)
			}
		}
		if len(skills) != 0 {
			t.Fatalf("skills = %+v", skills)
		}
		if !slashReg.emptyFor(providerClaude) || !slashReg.emptyFor(providerKimi) {
			t.Fatal("Cursor CLI's commands reached another engine's registry")
		}
		heartbeat, _ := slashAssetsForHeartbeat(nil)
		reported := 0
		for _, command := range heartbeat {
			if command.Provider == providerCursor {
				reported++
			}
		}
		if reported != len(commands) {
			t.Fatalf("the heartbeat carries %d of Cursor CLI's %d commands", reported, len(commands))
		}
	})
}

// Cards are named and filled in as the Orbit tools they are, from what the recordings stream.
func TestCursorACPToolNameNormalization(t *testing.T) {
	t.Run("recorded", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		// Each card answered as P0 answered it, so what Cursor streamed for it is what that answer got: only the
		// MCP call refused (a call Orbit refuses settles as not run, whatever the recording streams).
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: first, then: then,
			approve: func(card cursorTestCard) cursorTestDecision {
				if card.ToolName == "mcp__p0probe__record" {
					return cursorTestDecision{Status: "DENIED"}
				}
				return cursorTestDecision{Status: "ALLOWED"}
			}})
		results := map[string]map[string]interface{}{}
		for _, result := range run.of("turn-1", evToolResult) {
			results[asString(result["toolUseId"])] = result
		}
		type card struct {
			Name    string
			Input   interface{}
			Result  string
			IsError bool
		}
		var got []card
		for _, use := range run.of("turn-1", evToolUse) {
			result := results[asString(use["id"])]
			got = append(got, card{asString(use["name"]), use["input"], asString(result["content"]), result["isError"] == true})
			if use["name"] == "mcp__p0probe__record" && (use["mcpServer"] != "p0probe" || use["mcpTool"] != "record") {
				t.Errorf("MCP card does not keep its server and tool apart: %v", use)
			}
		}
		want := []card{
			{"Read", map[string]interface{}{"file_path": "<RUN>/work/README.md"}, "# probe repo\nThe secret word in this README is TANGERINE.\n", false},
			{"Bash", map[string]interface{}{"command": "ls -la"}, "total 16\ndrwxr-xr-x 3 root root 4096 Oct 17 01:27 .\ndrwxr-xr-x 4 root root 4096 Oct 17 01:27 ..\ndrwxr-xr-x 8 root root 4096 Oct 17 01:27 .git\n-rw-r--r-- 1 root root   58 Oct 17 01:27 README.md", false},
			{"Write", map[string]interface{}{"file_path": "<RUN>/work/probe-write.txt", "content": "written"}, "", false},
			{"Bash", map[string]interface{}{"command": "echo shell-ok > probe-shell.txt"}, "", false},
			{"Bash", map[string]interface{}{"command": "env | sort > env-dump.txt"}, "", false},
			{"mcp__p0probe__record", map[string]interface{}{"marker": "turn1"}, "Not run: the tool call was rejected.", true},
			{"WebFetch", map[string]interface{}{"url": "https://example.com/"}, `{"success":true}`, false},
		}
		if len(got) != len(want) || !cursorJSONEqual(t, got, want) {
			gotJSON, _ := json.MarshalIndent(got, "", " ")
			t.Fatalf("cards = %s", gotJSON)
		}
	})
	t.Run("rules", func(t *testing.T) {
		var events cursorEvents
		m := newCursorEventMapper(events.emitFor)
		m.bind("s")
		if err := m.begin("turn"); err != nil {
			t.Fatal(err)
		}
		send := func(update map[string]interface{}) {
			m.update(map[string]interface{}{"sessionId": "s", "update": update})
		}
		tool := func(id, kind, title string, input map[string]interface{}, done map[string]interface{}) {
			send(map[string]interface{}{"sessionUpdate": "tool_call", "toolCallId": id, "kind": kind, "title": title, "status": "pending", "rawInput": input})
			send(map[string]interface{}{"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress"})
			done["sessionUpdate"], done["toolCallId"], done["status"] = "tool_call_update", id, "completed"
			send(done)
		}
		tool("edit", "edit", "Edit `/w/a.go`", map[string]interface{}{"path": "/w/a.go"}, map[string]interface{}{
			"content": []interface{}{map[string]interface{}{"type": "diff", "path": "/w/a.go", "oldText": "a := 1\n", "newText": "a := 2\n"}}})
		tool("fail", "execute", "`false`", map[string]interface{}{"command": "make test"}, map[string]interface{}{
			"rawOutput": map[string]interface{}{"exitCode": float64(2), "stdout": "FAIL\n", "stderr": "make: *** [test] Error 2\n"}})
		tool("broken", "fetch", "Web Fetch: https://x.invalid/", map[string]interface{}{"url": "https://x.invalid/"}, map[string]interface{}{
			"rawOutput": map[string]interface{}{"error": "getaddrinfo ENOTFOUND x.invalid"}})
		tool("other", "search", "Grep: TODO", map[string]interface{}{"pattern": "TODO"}, map[string]interface{}{})
		if _, ok := m.settle("turn", map[string]interface{}{"stopReason": "end_turn"}, nil); !ok {
			t.Fatal("the turn did not settle")
		}
		var got []string
		for _, event := range events.snapshot() {
			wire, _ := json.Marshal(event.payload)
			switch event.typ {
			case evToolUse, evToolResult:
				got = append(got, event.typ+" "+string(wire))
			}
		}
		want := []string{
			`tool_use {"id":"edit","input":{"file_path":"/w/a.go","new_string":"a := 2\n","old_string":"a := 1\n"},"name":"Edit"}`,
			`tool_result {"content":"","isError":false,"toolUseId":"edit"}`,
			`tool_use {"id":"fail","input":{"command":"make test"},"name":"Bash"}`,
			`tool_result {"content":"FAIL\nmake: *** [test] Error 2\nExit code 2","isError":true,"toolUseId":"fail"}`,
			`tool_use {"id":"broken","input":{"url":"https://x.invalid/"},"name":"WebFetch"}`,
			`tool_result {"content":"getaddrinfo ENOTFOUND x.invalid","isError":true,"toolUseId":"broken"}`,
			`tool_use {"id":"other","input":{"pattern":"TODO"},"name":"Grep: TODO"}`,
			`tool_result {"content":"","isError":false,"toolUseId":"other"}`,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("cards:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
	})
}

// Two turns of one conversation each settle exactly once, in order, with everything each streamed
// attributed to it; a turn delivered again is the one already settled, and a title or command list
// arriving after a turn's answer opens no turn.
func TestCursorACPTwoTurnsSettleOnce(t *testing.T) {
	t.Run("two-turns", func(t *testing.T) {
		turn1, turn2 := cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message")
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns", first: []RunInboxResponse{turn1},
			then: func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
				if completed == 1 {
					return []RunInboxResponse{turn1, turn2} // turn-1 delivered again after it settled
				}
				return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
			}})
		if run.status != stSucceeded || !run.ended {
			t.Fatalf("run = (%s, ended=%v)", run.status, run.ended)
		}
		if len(run.completions) != 2 || run.completions[0].TurnID != "turn-1" || run.completions[1].TurnID != "turn-2" {
			t.Fatalf("completions = %+v, want turn-1 then turn-2, once each", run.completions)
		}
		for i, req := range run.completions {
			if req.Status != stSucceeded || req.Subtype != "completed" || req.NumTurns != 1 || req.RuntimeSessionID != "<UUID_8>" {
				t.Errorf("completion %d = %+v", i, req)
			}
			// Cursor measures no usage: the turn says so instead of claiming a measured $0.
			if !req.UsageUnknown || req.CostUsd != 0 || req.Usage != nil {
				t.Errorf("completion %d claims a usage: %+v", i, req)
			}
		}
		if !strings.HasSuffix(run.completions[1].Result, "TANGERINE; 1 ok, 2 ok, 3 ok") {
			t.Fatalf("turn-2 result = %q", run.completions[1].Result)
		}
		for _, turn := range []string{"turn-1", "turn-2"} {
			ends := run.of(turn, evTurnEnd)
			if len(ends) != 1 || ends[0]["subtype"] != "completed" || ends[0]["stopReason"] != "end_turn" {
				t.Fatalf("%s turn_end = %v, want exactly one", turn, ends)
			}
			for _, key := range []string{"contextTokens", "contextWindow", "costUsd"} {
				if _, ok := ends[0][key]; ok {
					t.Errorf("%s turn_end reads out %s, which Cursor never reports", turn, key)
				}
			}
			if users := run.of(turn, evUser); len(users) != 1 {
				t.Fatalf("%s user events = %v", turn, users)
			}
		}
		// Each turn holds its own cards, every one closed, and its turn_end comes before its turn-complete.
		for turn, cards := range map[string]int{"turn-1": 7, "turn-2": 3} {
			if uses, results := len(run.of(turn, evToolUse)), len(run.of(turn, evToolResult)); uses != cards || results != cards {
				t.Errorf("%s: %d cards, %d results, want %d of each", turn, uses, results, cards)
			}
		}
		end, completion := -1, -1
		for i, event := range run.events {
			if event.turn == "turn-1" && event.typ == evTurnEnd {
				end = i
			}
			if event.turn == "turn-1" && event.typ == "completion" {
				completion = i
			}
			if event.turn == "turn-1" && completion >= 0 && i > completion {
				t.Fatalf("turn-1 had an event after it settled: %v", event)
			}
		}
		if end < 0 || completion < end {
			t.Fatal("turn-1's turn_end does not precede its turn-complete")
		}
		// One prompt per turn, the second written only once the first had been answered.
		prompts := run.fake.requests(t, "session/prompt")
		if len(prompts) != 2 {
			t.Fatalf("session/prompt sent %d times, want once per turn", len(prompts))
		}
		recording, _ := filepath.Abs(filepath.Join("testdata", "cursor", "multi-turn-tools-default", "turns"))
		_, lines, err := loadFakeCursorReplay(fakeCursorACPScript{Recording: recording})
		if err != nil {
			t.Fatal(err)
		}
		firstAnswer := -1
		for i, line := range lines {
			if line.answer == "3" {
				firstAnswer = i
			}
		}
		if firstAnswer < 0 || prompts[1].Emitted <= firstAnswer {
			t.Fatalf("the second prompt was written after %d recorded lines, before the first prompt's answer (line %d)", prompts[1].Emitted, firstAnswer)
		}
		for _, prompt := range prompts {
			if firstString(mapValue(prompt.Message["params"]), "sessionId") != "<UUID_8>" {
				t.Fatalf("a prompt went to another session: %v", prompt.Message)
			}
		}
	})
	t.Run("second-message-waits-for-the-first-turn", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: "multi-turn-tools-default/turns",
			first: []RunInboxResponse{cursorMessage("turn-1", "first message"), cursorMessage("turn-2", "second message")},
			then: func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
				if completed == 2 {
					return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
				}
				return nil
			}})
		if len(run.completions) != 2 || run.completions[0].TurnID != "turn-1" || run.completions[1].TurnID != "turn-2" {
			t.Fatalf("completions = %+v, want turn-1 then turn-2", run.completions)
		}
		prompts := run.fake.requests(t, "session/prompt")
		recording, _ := filepath.Abs(filepath.Join("testdata", "cursor", "multi-turn-tools-default", "turns"))
		_, lines, err := loadFakeCursorReplay(fakeCursorACPScript{Recording: recording})
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range lines {
			if line.answer == "3" && (len(prompts) != 2 || prompts[1].Emitted <= i) {
				t.Fatalf("the second message was prompted while the first turn ran (%d prompts)", len(prompts))
			}
		}
		for turn, cards := range map[string]int{"turn-1": 7, "turn-2": 3} {
			if uses := len(run.of(turn, evToolUse)); uses != cards || len(run.of(turn, evTurnEnd)) != 1 {
				t.Errorf("%s: %d cards, %d turn_ends", turn, uses, len(run.of(turn, evTurnEnd)))
			}
		}
	})
	t.Run("late-session-updates", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "first message"))
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then, naming: true})
		if len(run.completions) != 1 || len(run.of("turn-1", evTurnEnd)) != 1 {
			t.Fatalf("completions %+v, turn_ends %v: want one of each", run.completions, run.of("turn-1", evTurnEnd))
		}
		// The title and the commands arrived after the prompt's answer. The title names a conversation opened
		// with Orbit's agent instructions, so it is not reported (TestCursorSessionTitlePrefix/late-title).
		if len(run.namings) != 0 {
			t.Fatalf("naming = %+v", run.namings)
		}
		if commands, _ := slashReg.extrasFor(providerCursor, nil); len(commands) == 0 {
			t.Fatal("the commands listed after the turn were not learned")
		}
		for _, event := range run.events {
			if event.turn != "turn-1" && event.turn != "" && event.turn != "end-session" {
				t.Fatalf("an event of no turn of this session's: %+v", event)
			}
		}
	})
}

// The id session/new returns is the session's runtime session id, kept where Orbit and the next run
// read it; a session that has one is never opened afresh in its place.
func TestCursorACPRuntimeSessionIDPersisted(t *testing.T) {
	t.Run("persisted", func(t *testing.T) {
		first, then := cursorTurns(cursorMessage("turn-1", "todos and a subagent"))
		run := runCursorSession(t, cursorRunOptions{recording: "subagent-and-todos/subagent", first: first, then: then})
		if run.job.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("job.RuntimeSessionID = %q", run.job.RuntimeSessionID)
		}
		meta := readSessionMeta(filepath.Join(run.scratch, "meta.json"))
		if meta == nil || meta.Provider != providerCursor || meta.RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("meta.json = %+v, want the runtime session id", meta)
		}
		var init map[string]interface{}
		for _, payload := range run.of("", evSystem) {
			if payload["subtype"] == "init" {
				init = payload
			}
		}
		if init == nil || init["sessionId"] != "<UUID_7>" {
			t.Fatalf("init event = %v: the control plane keeps the id from it", init)
		}
		if len(run.completions) != 1 || run.completions[0].RuntimeSessionID != "<UUID_7>" {
			t.Fatalf("completions = %+v", run.completions)
		}
	})
	t.Run("never-replaced-by-a-new-session", func(t *testing.T) {
		// A conversation the CLI cannot find (the recording's session/load of an id it never stored) ends the
		// session's start; it is never replaced by session/new.
		run := runCursorSession(t, cursorRunOptions{recording: "api-key-session-management/acp", runtimeSessionID: "<UUID_1>"})
		errors := run.of("", evError)
		if run.status != stFailed || !run.ended || len(errors) != 1 || !strings.HasPrefix(asString(errors[0]["message"]), "Cursor CLI has no conversation <UUID_1>") {
			t.Fatalf("run = (%s, ended=%v), errors %v", run.status, run.ended, errors)
		}
		if opened := run.fake.requests(t, "session/new"); len(opened) != 0 {
			t.Fatal("a new conversation was opened in place of the session's own")
		}
		if run.job.RuntimeSessionID != "<UUID_1>" {
			t.Fatalf("the runtime session id became %q", run.job.RuntimeSessionID)
		}
	})
}

// Cursor CLI is driven over JSON-RPC and takes nothing mid-turn: the runtime table says so, nothing
// declares a steer for it, and a steer that reaches its loop anyway is refused rather than written.
func TestCursorACPProviderRuntimeDeclaresNoSteer(t *testing.T) {
	t.Run("table", func(t *testing.T) {
		rt, ok := providerRuntimes[providerCursor]
		if !ok || rt.transport != transportJSONRPC || rt.steersMidTurn || rt.steerCapability != "" || rt.run == nil {
			t.Fatalf("providerRuntimes[cursor] = %+v (present %v), want a json-rpc driver that steers nothing", rt, ok)
		}
		if runtimeProvider(&ClaimedSession{Provider: providerCursor}) != providerCursor {
			t.Fatal("a Cursor CLI session does not resolve to its own runtime")
		}
		for _, capability := range declaredSteerCapabilities() {
			if strings.Contains(capability, providerCursor) {
				t.Fatalf("a steer capability is declared for Cursor CLI: %q", capability)
			}
		}
	})
	t.Run("steer-refused", func(t *testing.T) {
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background",
			first: []RunInboxResponse{cursorMessage("turn-1", "first message"), {TurnID: "steer-1", Kind: "steer", Content: "and one more thing"}},
			then: func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
				if completed == 2 {
					return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
				}
				return nil
			}})
		var steer, turn *TurnCompleteRequest
		for i := range run.completions {
			switch run.completions[i].TurnID {
			case "steer-1":
				steer = &run.completions[i]
			case "turn-1":
				turn = &run.completions[i]
			}
		}
		if steer == nil || steer.Status != stFailed || steer.Subtype != subtypeSteer || turn == nil {
			t.Fatalf("completions = %+v, want the steer refused and the turn settled", run.completions)
		}
		if users := run.of("steer-1", evUser); len(users) != 1 || users[0]["delivery"] != string(deliveryFailed) {
			t.Fatalf("steer user events = %v", users)
		}
		if prompts := run.fake.requests(t, "session/prompt"); len(prompts) != 1 {
			t.Fatalf("session/prompt sent %d times: the steer must never become one", len(prompts))
		}
	})
}

// An image goes into the prompt as an image block, since the CLI's promptCapabilities take one; any
// other attachment is saved beside the session and named.
func TestCursorACPImageAttachments(t *testing.T) {
	t.Run("prompt-capabilities", func(t *testing.T) {
		image := "\x89PNG synthetic image"
		turn := RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "what is in these?", Attachments: []TurnAttachment{
			{ID: "att-image", MimeType: "image/png", FileName: "shot.png"},
			{ID: "att-text", MimeType: "text/plain", FileName: "notes.txt"},
		}}
		first, then := cursorTurns(turn)
		run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", first: first, then: then,
			blobs: map[string]string{"att-image": image, "att-text": "synthetic notes"}})
		notes := filepath.Join(uploadsDir(cursorTestSessionID), "notes.txt")
		if data, err := os.ReadFile(notes); err != nil || string(data) != "synthetic notes" {
			t.Fatalf("notes.txt = %q, %v", data, err)
		}
		prompts := run.fake.requests(t, "session/prompt")
		if len(prompts) != 1 {
			t.Fatalf("prompts = %v", prompts)
		}
		want := []interface{}{
			map[string]interface{}{"type": "text", "text": cursorFirstPrompt(run.job, "[The user uploaded 1 file(s), saved at: "+notes+
				" - read or process them with your tools as needed.]\n\nwhat is in these?")},
			map[string]interface{}{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString([]byte(image))},
		}
		if got := mapValue(prompts[0].Message["params"])["prompt"]; !cursorJSONEqual(t, got, want) {
			t.Fatalf("prompt = %v, want %v", got, want)
		}
		users := run.of("turn-1", evUser)
		if len(users) != 1 || !cursorJSONEqual(t, users[0]["attachments"], []interface{}{
			map[string]interface{}{"id": "att-image", "mime": "image/png", "name": "shot.png"},
			map[string]interface{}{"id": "att-text", "mime": "text/plain", "name": "notes.txt"},
		}) {
			t.Fatalf("user event = %v", users)
		}
	})
	t.Run("no-image-capability", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("\x89PNG synthetic image"))
		}))
		defer server.Close()
		job := &ClaimedSession{SessionID: cursorTestSessionID}
		blocks, refs := prepareCursorPrompt(context.Background(), NewTransport(server.URL, "synthetic-runner-token"), job,
			&RunInboxResponse{Content: "look", Attachments: []TurnAttachment{{ID: "att-image", MimeType: "image/png", FileName: "shot.png"}}}, false, nil, "")
		shot := filepath.Join(uploadsDir(cursorTestSessionID), "shot.png")
		want := []map[string]interface{}{{"type": "text", "text": "[The user uploaded 1 file(s), saved at: " + shot +
			" - read or process them with your tools as needed.]\n\nlook"}}
		if !reflect.DeepEqual(blocks, want) || len(refs) != 1 {
			t.Fatalf("prompt = %v (refs %v), want the image saved and named", blocks, refs)
		}
	})
}

// A shell turn runs on the runner while Cursor is idle: a person's command, whose output is context for
// their next message, and a task's acceptance command, which is the runner's own.
func TestCursorACPShellTurns(t *testing.T) {
	run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background",
		first: []RunInboxResponse{
			{TurnID: "shell-1", Kind: "shell", Content: "echo cursor-shell-ok"},
			{TurnID: "accept-1", Kind: "shell", Content: "echo acceptance-ok", TaskAcceptance: true},
			cursorMessage("turn-1", "what did it print?"),
		},
		then: func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
			if completed == 3 {
				return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
			}
			return nil
		}})
	if len(run.completions) != 3 {
		t.Fatalf("completions = %+v", run.completions)
	}
	for _, req := range run.completions[:2] {
		if req.Subtype != "shell" || req.ShellExitCode == nil || *req.ShellExitCode != 0 || req.RuntimeSessionID != "<UUID_1>" {
			t.Fatalf("shell completion = %+v", req)
		}
	}
	prompts := run.fake.requests(t, "session/prompt")
	if len(prompts) != 1 {
		t.Fatalf("prompts = %v", prompts)
	}
	text := asString(mapValue(mapValue(prompts[0].Message["params"])["prompt"].([]interface{})[0])["text"])
	if want := cursorFirstPrompt(run.job, "<bash-input>echo cursor-shell-ok</bash-input>\n<bash-stdout>cursor-shell-ok\n</bash-stdout>\n\nwhat did it print?"); text != want {
		t.Fatalf("prompt text = %q, want %q", text, want)
	}
}
