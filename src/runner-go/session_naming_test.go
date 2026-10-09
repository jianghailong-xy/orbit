package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Naming a session through the engine running it (session_naming.go, codex_naming.go): the engine
// is asked from inside the process already running the session, and its answer reaches the control
// plane against the title the claim carried.

type namingReport struct {
	path string
	body SessionNamingRequest
}

// namingServer stands in for the control plane's naming door and records what reaches it.
func namingServer(t *testing.T) (*Transport, chan namingReport) {
	t.Helper()
	reports := make(chan namingReport, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body SessionNamingRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		reports <- namingReport{path: r.URL.Path, body: body}
		_, _ = w.Write([]byte(`{"applied":true}`))
	}))
	t.Cleanup(srv.Close)
	return NewTransport(srv.URL, "runner-token"), reports
}

func namingJob() *ClaimedSession {
	return &ClaimedSession{
		SessionID: "session-naming",
		Title:     "Fix the flaky login timeout on Safari",
		Naming: &SessionNamingJob{
			Description:  "Fix the flaky login timeout on Safari\nIt fails about once in ten runs.",
			Instructions: `You name a software-engineering session. Reply with ONLY a JSON object {"title": string}.`,
		},
	}
}

func nextReport(t *testing.T, reports chan namingReport) namingReport {
	t.Helper()
	select {
	case got := <-reports:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("no title reached the control plane")
		return namingReport{}
	}
}

func noReport(t *testing.T, reports chan namingReport) {
	t.Helper()
	select {
	case got := <-reports:
		t.Fatalf("a title reached the control plane: %+v", got)
	default:
	}
}

// Claude Code is asked with its own request, persist false, and its answer is reported against
// the title the claim carried.
func TestClaudeNamesItsSessionThroughItsOwnTitleRequest(t *testing.T) {
	transport, reports := namingServer(t)
	rt := newPipeRuntime(t)
	job := namingJob()
	done := make(chan struct{})
	go func() {
		defer close(done)
		askClaudeSessionTitle(context.Background(), transport, rt.claudeRuntime, job)
	}()

	msg := decodeControlRequest(t, rt.nextLine(t))
	req := mapValue(msg["request"])
	if req["subtype"] != ctrlGenerateSessionTitle || req["description"] != job.Naming.Description || req["persist"] != false {
		t.Fatalf("the CLI was asked %v, want generate_session_title of the opening request, persist false", req)
	}
	id, _ := msg["request_id"].(string)
	rt.resolveControl(claudeControlResponse{
		RequestID: id, Subtype: ctrlSuccess, Response: map[string]interface{}{"title": "Safari login timeout"},
	})

	got := nextReport(t, reports)
	if got.path != "/api/runner/sessions/session-naming/naming" {
		t.Errorf("reported to %s", got.path)
	}
	if got.body != (SessionNamingRequest{Replaces: job.Title, Title: "Safari login timeout"}) {
		t.Errorf("reported %+v", got.body)
	}
	<-done
}

// A CLI that predates the request refuses it, and one may answer with nothing: either way the
// session keeps the title it has, and nothing is reported.
func TestClaudeThatCannotNameLeavesTheTitleAlone(t *testing.T) {
	for _, answer := range []claudeControlResponse{
		{Subtype: ctrlError, Error: "Unsupported control request subtype"},
		{Subtype: ctrlSuccess, Response: map[string]interface{}{"title": "   "}},
	} {
		transport, reports := namingServer(t)
		rt := newPipeRuntime(t)
		done := make(chan struct{})
		go func() {
			defer close(done)
			askClaudeSessionTitle(context.Background(), transport, rt.claudeRuntime, namingJob())
		}()
		msg := decodeControlRequest(t, rt.nextLine(t))
		answer.RequestID, _ = msg["request_id"].(string)
		rt.resolveControl(answer)
		<-done
		noReport(t, reports)
	}
}

// Through the real session loop: the opening turn's frame reaches the engine, the same engine is
// asked to name the session right behind it, once, and the answer goes to the control plane.
func TestSessionAsksItsEngineToNameItOnceWhenTheClaimSaysSo(t *testing.T) {
	var mu sync.Mutex
	var named []SessionNamingRequest
	opts := deliveryOptions{
		claim: func(job *ClaimedSession) {
			job.Title = "Fix the flaky login timeout on Safari"
			job.Naming = &SessionNamingJob{Description: "Fix the flaky login timeout on Safari", Instructions: "unused by claude"}
		},
		onRequest: func(path string, body []byte) {
			if !strings.HasSuffix(path, "/naming") {
				return
			}
			var req SessionNamingRequest
			_ = json.Unmarshal(body, &req)
			mu.Lock()
			named = append(named, req)
			mu.Unlock()
		},
	}
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Await: "control_request", Subtype: ctrlGenerateSessionTitle},
			{Emit: "control_response", Response: map[string]interface{}{"title": "Safari login timeout"}},
			{Emit: "result", Text: "done"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done again"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "Fix the flaky login timeout on Safari"),
			{turn: RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "and the other browser too"}, after: "turn-1"},
		},
		func(*deliverySession) bool {
			mu.Lock()
			defer mu.Unlock()
			return len(named) > 0
		}, opts)

	asks := controlRequestsOfSubtype(run.fake, ctrlGenerateSessionTitle)
	if len(asks) != 1 {
		t.Fatalf("the engine was asked to name the session %d time(s), want once", len(asks))
	}
	if asks[0]["description"] != "Fix the flaky login timeout on Safari" || asks[0]["persist"] != false {
		t.Errorf("the engine was asked %v", asks[0])
	}
	mu.Lock()
	defer mu.Unlock()
	if len(named) != 1 || named[0] != (SessionNamingRequest{Replaces: "Fix the flaky login timeout on Safari", Title: "Safari login timeout"}) {
		t.Errorf("the control plane was told %+v", named)
	}
}

// The control group: a claim that does not ask leaves the engine unasked.
func TestSessionLeavesItsEngineUnaskedWithoutANamingJob(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "Fix the flaky login timeout on Safari")}, nil)
	if asks := controlRequestsOfSubtype(run.fake, ctrlGenerateSessionTitle); len(asks) != 0 {
		t.Fatalf("the engine was asked to name the session: %v", asks)
	}
}

// codexNamingRun drives nameCodexSession against the in-process fake app-server up to the naming
// turn's own start, and returns that turn's request.
func codexNamingRun(t *testing.T, f *fakeCodexAppServer, transport *Transport, job *ClaimedSession) (map[string]interface{}, chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		nameCodexSession(context.Background(), transport, f.app, job)
	}()
	start := f.take("thread/start")
	params := mapValue(start["params"])
	if params["ephemeral"] != true || params["approvalPolicy"] != "never" || params["sandbox"] != "read-only" {
		t.Errorf("the side thread was started as %v, want ephemeral, read-only and asking nobody", params)
	}
	if params["developerInstructions"] != job.Naming.Instructions || asString(params["model"]) != job.Agent.Model {
		t.Errorf("the side thread was started as %v, want Orbit's naming prompt on the session's own model", params)
	}
	if cwd, _ := params["cwd"].(string); cwd == "" {
		t.Error("the side thread was started with no directory of its own")
	}
	// Orbit's own MCP server is not started for it — and not named at all to a process that runs
	// without one, which would refuse the thread.
	config, named := params["config"]
	if want := map[string]interface{}{"mcp_servers.orbit.enabled": false}; f.app.orbitMCP && !reflect.DeepEqual(config, want) {
		t.Errorf("the side thread's config is %v, want %v", config, want)
	}
	if !f.app.orbitMCP && named {
		t.Errorf("a process with no Orbit MCP server was handed %v", config)
	}
	f.answer(start, map[string]interface{}{"thread": map[string]interface{}{"id": "side-1"}})
	turn := f.take("turn/start")
	p := mapValue(turn["params"])
	input, _ := p["input"].([]interface{})
	if p["threadId"] != "side-1" || p["effort"] != "low" || len(input) != 1 || mapValue(input[0])["text"] != job.Naming.Description {
		t.Errorf("the naming turn was started as %v", p)
	}
	if schema := mapValue(p["outputSchema"]); schema["additionalProperties"] != false {
		t.Errorf("the naming turn's answer is not held to a schema: %v", p["outputSchema"])
	}
	return turn, done
}

// Codex has no request that names a thread, so the session is named in a side thread of the same
// app-server: its traffic never reaches the session's own handler, what it asks for is declined
// without asking anybody, and it is unsubscribed when it has answered.
func TestCodexNamesItsSessionInASideThreadOfTheSameAppServer(t *testing.T) {
	f := newFakeCodexAppServer(t)
	f.app.orbitMCP = true
	var approvals atomic.Int32
	f.app.approve = func(context.Context, codexApprovalRequest, map[string]interface{}) bool {
		approvals.Add(1)
		return true
	}
	transport, reports := namingServer(t)
	job := namingJob()
	job.Agent.Model = "gpt-5.5-codex"
	turn, done := codexNamingRun(t, f, transport, job)

	// Codex may speak before it answers the turn/start that began it.
	f.say(map[string]interface{}{"method": "turn/started", "params": map[string]interface{}{
		"threadId": "side-1", "turn": map[string]interface{}{"id": "turn-side"},
	}})
	f.say(map[string]interface{}{"id": "srv-1", "method": "item/commandExecution/requestApproval", "params": map[string]interface{}{
		"threadId": "side-1", "command": "ls",
	}})
	select {
	case answer := <-f.requests:
		if answer["id"] != "srv-1" || mapValue(answer["result"])["decision"] != "decline" {
			t.Fatalf("the side thread's request was answered %v, want declined", answer)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the side thread's request was never answered")
	}
	f.answer(turn, map[string]interface{}{"turn": map[string]interface{}{"id": "turn-side"}})
	f.say(map[string]interface{}{"method": "item/completed", "params": map[string]interface{}{
		"threadId": "side-1",
		"item":     map[string]interface{}{"type": "agentMessage", "id": "m1", "text": `{"title":"Safari login timeout"}`},
	}})
	f.say(map[string]interface{}{"method": "turn/completed", "params": map[string]interface{}{
		"threadId": "side-1", "turn": map[string]interface{}{"id": "turn-side", "status": "completed"},
	}})
	unsubscribe := f.take("thread/unsubscribe")
	if mapValue(unsubscribe["params"])["threadId"] != "side-1" {
		t.Errorf("unsubscribed from %v", unsubscribe["params"])
	}
	f.answer(unsubscribe, map[string]interface{}{"status": "unsubscribed"})

	got := nextReport(t, reports)
	if got.body != (SessionNamingRequest{Replaces: job.Title, Title: "Safari login timeout"}) {
		t.Errorf("reported %+v", got.body)
	}
	<-done
	if n := approvals.Load(); n != 0 {
		t.Errorf("the side thread's request reached the session's approvals %d time(s)", n)
	}
	if n := len(f.app.notifications); n != 0 {
		t.Errorf("%d side-thread notification(s) reached the session's own handler", n)
	}
	if f.app.isSideThread("side-1") {
		t.Error("the side thread is still routed after it was closed")
	}
}

// A naming turn that does not complete names nothing, and the side thread is still let go.
func TestCodexNamingTurnThatFailsNamesNothing(t *testing.T) {
	f := newFakeCodexAppServer(t)
	transport, reports := namingServer(t)
	job := namingJob()
	turn, done := codexNamingRun(t, f, transport, job)
	f.answer(turn, map[string]interface{}{"turn": map[string]interface{}{"id": "turn-side"}})
	f.say(map[string]interface{}{"method": "turn/completed", "params": map[string]interface{}{
		"threadId": "side-1", "turn": map[string]interface{}{"id": "turn-side", "status": "failed", "error": map[string]interface{}{"message": "usage limit"}},
	}})
	f.answer(f.take("thread/unsubscribe"), map[string]interface{}{"status": "unsubscribed"})
	<-done
	noReport(t, reports)
}
