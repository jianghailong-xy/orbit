package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Writing a message into the Codex turn that is already running.
//
// What makes this worth an integration-shaped test rather than a handful of unit tests is that
// the interesting part is the seam between three goroutines that all touch the same turn: the
// inbox loop hands the message over, turn/start names the turn from one goroutine while the
// steer is being aimed at it from another, and the echo that finally settles the message arrives
// on the notification stream. Each of those alone is trivial; the failures are all in between.
//
// So these drive the real codexAppServer over a pipe against a fake app-server the test answers
// by hand — no codex process, and no reimplementation of the request/response plumbing either.

// fakeCodexAppServer is one app-server connection the test speaks for. It records every request
// Orbit sends and answers only what a test tells it to, so "did a second turn/start go out" and
// "what was this steer addressed to" are both readable off the same record.
type fakeCodexAppServer struct {
	t        *testing.T
	app      *codexAppServer
	out      *io.PipeWriter // what codex says to Orbit
	requests chan map[string]interface{}

	mu   sync.Mutex
	seen []map[string]interface{}
}

func newFakeCodexAppServer(t *testing.T) *fakeCodexAppServer {
	t.Helper()
	clientReader, serverWriter := io.Pipe() // codex -> Orbit
	serverReader, clientWriter := io.Pipe() // Orbit -> codex
	f := &fakeCodexAppServer{
		t:        t,
		out:      serverWriter,
		requests: make(chan map[string]interface{}, 32),
		app: &codexAppServer{
			ctx:           context.Background(),
			stdin:         clientWriter,
			pending:       map[string]chan codexRPCMessage{},
			notifications: make(chan codexRPCMessage, 32),
			done:          make(chan struct{}),
		},
	}
	go f.app.readLoop(clientReader)
	go func() {
		sc := bufio.NewScanner(serverReader)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			var msg map[string]interface{}
			if json.Unmarshal(sc.Bytes(), &msg) != nil {
				continue
			}
			f.mu.Lock()
			f.seen = append(f.seen, msg)
			f.mu.Unlock()
			f.requests <- msg
		}
	}()
	t.Cleanup(func() {
		_ = serverWriter.Close()
		_ = clientWriter.Close()
	})
	return f
}

// take returns the next request Orbit sent, failing the test rather than hanging if none comes.
func (f *fakeCodexAppServer) take(method string) map[string]interface{} {
	f.t.Helper()
	select {
	case msg := <-f.requests:
		if msg["method"] != method {
			f.t.Fatalf("next request was %v, want %s", msg["method"], method)
		}
		return msg
	case <-time.After(3 * time.Second):
		f.t.Fatalf("no %s request arrived", method)
		return nil
	}
}

// methods lists every request sent so far, in order. This is how "and no second turn/start" is
// asked: not by watching for one, but by reading back the whole conversation.
func (f *fakeCodexAppServer) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, msg := range f.seen {
		out = append(out, asString(msg["method"]))
	}
	return out
}

func (f *fakeCodexAppServer) say(msg map[string]interface{}) {
	f.t.Helper()
	b, err := json.Marshal(msg)
	if err != nil {
		f.t.Fatalf("marshal: %v", err)
	}
	if _, err := f.out.Write(append(b, '\n')); err != nil {
		f.t.Fatalf("write: %v", err)
	}
}

func (f *fakeCodexAppServer) answer(req map[string]interface{}, result map[string]interface{}) {
	f.say(map[string]interface{}{"id": req["id"], "result": result})
}

// refuse answers the way the real app-server does: -32600 for everything, including a method it
// has never heard of (contract §4.1).
func (f *fakeCodexAppServer) refuse(req map[string]interface{}, message string) {
	f.say(map[string]interface{}{
		"id":    req["id"],
		"error": map[string]interface{}{"code": -32600, "message": message},
	})
}

// codexSteerSession is the part of a codex session loop a steer passes through: the active turn,
// the notification pump that carries echoes, and the dispatcher itself — wired the way
// runCodexAppServerSessionProcess wires them.
type codexSteerSession struct {
	t        *testing.T
	fake     *fakeCodexAppServer
	dispatch *codexSteerDispatcher
	activeMu sync.Mutex
	active   *codexAppActiveTurn
	job      *ClaimedSession
	cancel   context.CancelFunc

	mu          sync.Mutex
	events      []recordedEvent
	completions []TurnCompleteRequest
}

type recordedEvent struct {
	turnID  string
	typ     string
	payload map[string]interface{}
}

const (
	steerThreadID   = "thread-1"
	steerMainTurn   = "orbit-turn-main"
	steerCodexTurn  = "01a02539-dabf-7752-9856-7b701e1871af"
	steerOrbitTurn  = "orbit-turn-steer"
	steerOtherTurn  = "orbit-turn-steer-2"
	steerNoSuchTurn = "01a02538-0000-7000-8000-000000000000"
)

func newCodexSteerSession(t *testing.T) *codexSteerSession {
	t.Helper()
	s := &codexSteerSession{
		t:    t,
		fake: newFakeCodexAppServer(t),
		job:  &ClaimedSession{SessionID: "s-1", Agent: AgentExecConfig{Provider: providerCodex}},
	}
	s.dispatch = &codexSteerDispatcher{
		app: s.fake.app, job: s.job, threadID: steerThreadID,
		activeMu: &s.activeMu, active: &s.active,
		emitFor: func(turnID, typ string, payload map[string]interface{}) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.events = append(s.events, recordedEvent{turnID, typ, payload})
		},
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.completions = append(s.completions, req)
			return nil
		},
	}
	// The notification pump, as the session loop runs it: one goroutine, so an echo and the
	// turn/completed that follows it can never be observed out of order.
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-s.fake.app.notifications:
				handleCodexAppNotification(steerThreadID, msg, func(string, map[string]interface{}) {},
					&s.activeMu, &s.active, s.finalize, nil, nil, nil, s.dispatch.acknowledge)
			}
		}
	}()
	t.Cleanup(cancel)
	return s
}

// finalize mirrors the session loop's own finalizer for the part that matters here: a turn ending
// answers every steer it was still holding, before it settles itself.
func (s *codexSteerSession) finalize(result codexTurnResult) {
	a, snapshot, ok := beginCodexAppTurnFinalize(&s.activeMu, &s.active)
	if !ok {
		return
	}
	for _, steerTurnID := range snapshot.openSteers {
		s.dispatch.fail(steerTurnID, errCodexSteerDropped)
	}
	s.mu.Lock()
	s.completions = append(s.completions, TurnCompleteRequest{
		TurnID: snapshot.orbitTurnID, Status: result.Status, Subtype: result.Subtype,
	})
	s.mu.Unlock()
	finishCodexAppTurnFinalize(&s.activeMu, &s.active, a)
}

// startTurn puts a turn on the session and, unless named, leaves it in the window turn/start has
// not answered yet — active, running, and with no Codex turn id to address anything to.
func (s *codexSteerSession) startTurn() {
	s.activeMu.Lock()
	s.active = &codexAppActiveTurn{
		orbitTurnID: steerMainTurn,
		startSent:   true,
		result:      codexTurnResult{Status: stSucceeded, Subtype: "completed"},
	}
	s.activeMu.Unlock()
}

func (s *codexSteerSession) name(codexTurnID string) {
	s.activeMu.Lock()
	s.active.codexTurnID = codexTurnID
	s.activeMu.Unlock()
}

// steer delivers one message the way the inbox loop's steer worker does, from a control plane
// that can take a provably-undelivered one back (which every control plane that files a codex
// steer at all can — see steerFromLegacyControlPlane for the one that cannot).
func (s *codexSteerSession) steer(ctx context.Context, turnID, content string) {
	s.dispatch.deliver(ctx, &RunInboxResponse{
		TurnID: turnID, Kind: "steer", Content: content, SteerRequeue: true,
	})
}

func (s *codexSteerSession) currentWorkSteer(ctx context.Context, turnID, targetTurnID, content string) {
	s.dispatch.deliver(ctx, &RunInboxResponse{
		TurnID: turnID, TargetTurnID: targetTurnID, Kind: "steer", Content: content,
	})
}

// steerFromLegacyControlPlane delivers one the way a control plane that predates `steer_requeue`
// does: no flag on the delivery, so nothing may be re-filed through it.
func (s *codexSteerSession) steerFromLegacyControlPlane(ctx context.Context, turnID, content string) {
	s.dispatch.deliver(ctx, &RunInboxResponse{TurnID: turnID, Kind: "steer", Content: content})
}

func (s *codexSteerSession) snapshot() ([]recordedEvent, []TurnCompleteRequest) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recordedEvent(nil), s.events...), append([]TurnCompleteRequest(nil), s.completions...)
}

// deliveries returns the delivery states reported for one turn, in order — the whole visible life
// of a steer, since it has no reply of its own to show for it.
func (s *codexSteerSession) deliveries(turnID string) []string {
	events, _ := s.snapshot()
	var out []string
	for _, ev := range events {
		if ev.turnID != turnID {
			continue
		}
		if ev.typ == evUser || ev.typ == evUserDelivery {
			out = append(out, asString(ev.payload["delivery"]))
		}
	}
	return out
}

// bubbles counts the `user` events filed for one turn. A message gets exactly one, whoever files
// it: a second would show what the person sent twice, in a transcript where the same turn can be
// answered for by the goroutine that sent it, the one reading Codex's notifications, or a later
// process picking up after this one died.
func (s *codexSteerSession) bubbles(turnID string) int {
	events, _ := s.snapshot()
	n := 0
	for _, ev := range events {
		if ev.turnID == turnID && ev.typ == evUser {
			n++
		}
	}
	return n
}

func (s *codexSteerSession) lastDelivery(turnID string) map[string]interface{} {
	events, _ := s.snapshot()
	var last map[string]interface{}
	for _, ev := range events {
		if ev.typ == evUserDelivery && ev.turnID == turnID {
			last = ev.payload
		}
	}
	return last
}

func (s *codexSteerSession) completionFor(turnID string) *TurnCompleteRequest {
	_, completions := s.snapshot()
	for i := range completions {
		if completions[i].TurnID == turnID {
			return &completions[i]
		}
	}
	return nil
}

// echo is the userMessage Codex replays for a message it took, carrying back the
// clientUserMessageId on item.clientId — the only key a steer can be correlated by (contract §3).
func (s *codexSteerSession) echo(clientID string) {
	s.fake.say(map[string]interface{}{
		"method": "item/started",
		"params": map[string]interface{}{
			"threadId": steerThreadID,
			"item": map[string]interface{}{
				"type": "userMessage", "id": "item-" + clientID, "clientId": clientID,
				"content": []map[string]interface{}{{"type": "text", "text": "…"}},
			},
		},
	})
}

// completeEcho is the second notification for the SAME Codex item, not a second message. Real
// app-server 0.149 emits both phases for every steered userMessage.
func (s *codexSteerSession) completeEcho(clientID string) {
	s.fake.say(map[string]interface{}{
		"method": "item/completed",
		"params": map[string]interface{}{
			"threadId": steerThreadID,
			"item": map[string]interface{}{
				"type": "userMessage", "id": "item-" + clientID, "clientId": clientID,
				"content": []map[string]interface{}{{"type": "text", "text": "…"}},
			},
		},
	})
}

// waitFor spins until cond holds, so a test can wait on the notification pump without sleeping
// for a fixed interval it would then have to guess at.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func captureRunnerStdout(t *testing.T, run func()) string {
	t.Helper()
	previous := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	defer func() { os.Stdout = previous }()
	run()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	return string(output)
}

func TestCodexSteerLifecyclePairIsOneEchoButTwoItemIDsAreDuplicates(t *testing.T) {
	const clientID = "orbit-steer"
	activeMu := &sync.Mutex{}
	active := &codexAppActiveTurn{steers: map[string]*codexSteerDelivery{
		clientID: {orbitTurnID: clientID, state: deliveryWritten},
	}}
	item := func(id string) map[string]interface{} {
		return map[string]interface{}{"type": "userMessage", "id": id, "clientId": clientID}
	}

	if got := acknowledgeCodexSteerEcho(activeMu, &active, item("item-one")); got != clientID {
		t.Fatalf("first echo acknowledged %q, want %q", got, clientID)
	}
	if got := active.steers[clientID].echoItemID; got != "item-one" {
		t.Fatalf("remembered echo item = %q, want item-one", got)
	}
	if output := captureRunnerStdout(t, func() {
		acknowledgeCodexSteerEcho(activeMu, &active, item("item-one"))
	}); output != "" {
		t.Fatalf("item/completed for the same item was logged as a duplicate: %q", output)
	}
	if output := captureRunnerStdout(t, func() {
		acknowledgeCodexSteerEcho(activeMu, &active, item("item-two"))
	}); !strings.Contains(output, "twice") {
		t.Fatalf("a second Codex item with the same client id was not diagnosed: %q", output)
	}
}

// The headline case, and the one the whole feature is: a message sent while Codex is mid-turn
// goes INTO that turn. It must reach the turn already running — not open a second one, which is
// what every "just start another turn" shortcut degenerates into, and which would throw away the
// tool results the running turn has already paid for.
//
// It is delivered in the window turn/start has not answered in yet, because that is the window
// the runner is actually in: the start request is sent on its own goroutine and the turn is named
// by whichever of the response and the turn/started notification arrives first.
func TestASteerJoinsTheRunningTurnInsteadOfStartingASecondOne(t *testing.T) {
	s := newCodexSteerSession(t)
	job := &ClaimedSession{SessionID: "s-1", Agent: AgentExecConfig{Provider: providerCodex}}
	s.startTurn()

	// turn/start goes out and is deliberately left unanswered: the turn is running.
	started := make(chan struct{})
	go func() {
		defer close(started)
		_, _ = s.fake.app.startTurn(context.Background(), steerThreadID, job, t.TempDir(), t.TempDir(),
			steerMainTurn, "do the long thing", nil)
	}()
	startReq := s.fake.take("turn/start")
	if params := mapValue(startReq["params"]); asString(params["threadId"]) != steerThreadID {
		t.Fatalf("turn/start threadId = %v", params["threadId"])
	}
	// The turn/started notification names it — the same path recordCodexTurnID feeds.
	s.fake.say(map[string]interface{}{
		"method": "turn/started",
		"params": map[string]interface{}{"threadId": steerThreadID, "turn": map[string]interface{}{"id": steerCodexTurn}},
	})
	waitFor(t, "the turn to be named", func() bool {
		s.activeMu.Lock()
		defer s.activeMu.Unlock()
		return s.active.codexTurnID == steerCodexTurn
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()

	steerReq := s.fake.take("turn/steer")
	params := mapValue(steerReq["params"])
	if got := asString(params["threadId"]); got != steerThreadID {
		t.Errorf("steer threadId = %q, want %q", got, steerThreadID)
	}
	// Addressed to the turn in progress. Without it the message is merely aimed at the thread,
	// and Codex would fold it into whatever turn happened to be running by the time it landed.
	if got := asString(params["expectedTurnId"]); got != steerCodexTurn {
		t.Errorf("steer expectedTurnId = %q, want the running Codex turn %q", got, steerCodexTurn)
	}
	// Orbit's own turn for this message, which is the only key its echo comes back under.
	if got := asString(params["clientUserMessageId"]); got != steerOrbitTurn {
		t.Errorf("steer clientUserMessageId = %q, want this message's own turn %q", got, steerOrbitTurn)
	}
	input, _ := params["input"].([]interface{})
	if len(input) != 1 || asString(mapValue(input[0])["text"]) != "actually, call it gadget" {
		t.Errorf("steer input = %#v", params["input"])
	}
	// No turn-level override rides along: this message joins a turn whose model, cwd and sandbox
	// are already settled, and 0.149.0 would silently ignore one rather than reject it.
	for _, override := range []string{"model", "cwd", "sandboxPolicy", "effort", "approvalPolicy"} {
		if _, ok := params[override]; ok {
			t.Errorf("steer carried a %q override", override)
		}
	}

	s.fake.answer(steerReq, map[string]interface{}{"turnId": steerCodexTurn})
	<-done

	// Codex has it, the model has not seen it yet — a real 31-second gap, in the measured case.
	waitFor(t, "the steer to report written", func() bool {
		return len(s.deliveries(steerOrbitTurn)) >= 2
	})
	// The bubble opens at the first thing anyone actually knows about this message, and `written`
	// is that: Codex has taken it and the model has not read it yet. It stays there for a real
	// 31-second gap in the measured case, which is the truth rather than a stall.
	if got := s.deliveries(steerOrbitTurn); got[0] != string(deliveryWritten) || got[len(got)-1] != string(deliveryWritten) {
		t.Errorf("delivery states = %v, want written", got)
	}
	// One message, one bubble — no matter which goroutine got to say the first word about it.
	if n := s.bubbles(steerOrbitTurn); n != 1 {
		t.Errorf("user events for the steer = %d, want exactly one", n)
	}
	// Nothing is settled yet: an OK is not delivery, and saying so early is the fake send this
	// whole receipt chain exists to remove.
	if c := s.completionFor(steerOrbitTurn); c != nil {
		t.Fatalf("the steer was settled before codex echoed it: %+v", c)
	}

	s.echo(steerOrbitTurn)
	waitFor(t, "the steer to be acknowledged", func() bool { return s.completionFor(steerOrbitTurn) != nil })
	s.completeEcho(steerOrbitTurn)
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryAcknowledged) {
		t.Errorf("delivery states = %v, want acknowledged last", got)
	}
	if n := len(s.deliveries(steerOrbitTurn)); n != 3 {
		t.Errorf("delivery events = %d, want written bubble + written update + one acknowledgement", n)
	}

	// Settled as a steer, and ONLY the steer: its own row is answered, the turn it joined is
	// still running, and the session's slot, billing and status all still belong to that turn.
	c := s.completionFor(steerOrbitTurn)
	if c.Status != stSucceeded || c.Subtype != subtypeSteer {
		t.Errorf("steer completion = %+v, want a succeeded %q", *c, subtypeSteer)
	}
	if c.NumTurns != 0 {
		t.Errorf("the steer reported %d turns; it is not a turn of its own", c.NumTurns)
	}
	if c := s.completionFor(steerMainTurn); c != nil {
		t.Fatalf("the running turn was settled by a message written into it: %+v", *c)
	}
	s.activeMu.Lock()
	stillRunning := s.active != nil && !s.active.finishing
	s.activeMu.Unlock()
	if !stillRunning {
		t.Error("the running turn ended when a message was written into it")
	}

	// And the whole conversation with Codex was: start the turn, steer it. A second turn/start
	// would be the failure this test exists to catch.
	if got := s.fake.methods(); len(got) != 2 || got[0] != "turn/start" || got[1] != "turn/steer" {
		t.Errorf("requests = %v, want exactly one turn/start and one turn/steer", got)
	}

	// The start request finally answers, naming the turn a second time. It has to be harmless:
	// the response and the turn/started notification race by design, and whichever loses must not
	// disturb a turn that has since been steered.
	s.fake.answer(startReq, map[string]interface{}{"turn": map[string]interface{}{"id": steerCodexTurn}})
	<-started
	if got := s.fake.methods(); len(got) != 2 {
		t.Errorf("requests = %v, want no further traffic once the start answered", got)
	}
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	if len(s.active.steers) != 1 || s.active.steers[steerOrbitTurn].state != deliveryAcknowledged {
		t.Errorf("the running turn's steers = %+v, want the one delivered message", s.active.steers)
	}
}

// The window before turn/start has answered is real — the request goes out on its own goroutine —
// and expectedTurnId is mandatory, so a steer arriving in it has nothing to address itself to.
// It waits, and if the turn is never named it gives up having sent nothing at all, which is the
// cleanest kind of failure there is: not a byte left the runner, so the message simply becomes
// the ordinary next one.
func TestASteerAimedAtATurnThatIsNeverNamedSendsNothing(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn() // running, unnamed: turn/start has not come back

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	s.steer(ctx, steerOrbitTurn, "hurry up")

	if got := s.fake.methods(); len(got) != 0 {
		t.Fatalf("requests = %v, want none: there was no turn id to address one to", got)
	}
	assertSteerRefiled(t, s, steerOrbitTurn)
	assertRunningTurnUntouched(t, s)
}

func TestCodexCurrentWorkSteerTargetFenceRejectsARolloverBeforeTurnSteer(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn() // active Orbit turn is steerMainTurn (B)
	s.name(steerCodexTurn)

	s.currentWorkSteer(context.Background(), steerOrbitTurn, "turn-A-that-ended", "A only")

	if got := s.fake.methods(); len(got) != 0 {
		t.Fatalf("stale CURRENT_WORK sent provider requests into B: %v", got)
	}
	if got := s.completionFor(steerOrbitTurn); got == nil || got.Status != stFailed || got.Subtype != subtypeSteer {
		t.Fatalf("stale CURRENT_WORK settled as %+v, want visible failed steer", got)
	}
	if got := s.lastDelivery(steerOrbitTurn); got["delivery"] != string(deliveryFailed) {
		t.Fatalf("stale CURRENT_WORK delivery = %v, want failed", got)
	}
	assertRunningTurnUntouched(t, s)
}

// A steer with nothing running to fold it into. The control plane files one only while a turn
// holds the lease, so this is the turn ending in the gap between that decision and this delivery
// — which is a race, not a bug, and it happens. Nothing is sent, so the message is re-filed as an
// ordinary one; what must never happen is dropping it, since a steer's row is leased and never
// handed out again.
func TestASteerWithNoTurnRunningIsRefiledAsAnOrdinaryMessage(t *testing.T) {
	s := newCodexSteerSession(t)

	s.steer(context.Background(), steerOrbitTurn, "one more thing")

	if got := s.fake.methods(); len(got) != 0 {
		t.Fatalf("requests = %v, want none: a doomed request is not worth sending", got)
	}
	assertSteerRefiled(t, s, steerOrbitTurn)
}

// A turn on its way out is the same answer. Codex discards a steer buffered behind an interrupt
// silently — no notification, nothing in the thread (§4.4) — so a message aimed at a turn that is
// being stopped is refused before it can join that class of loss.
func TestASteerIntoATurnBeingInterruptedIsRefused(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)
	if _, beforeStart := requestCodexAppInterrupt(&s.activeMu, &s.active); beforeStart {
		t.Fatal("the turn was treated as not yet started")
	}

	s.steer(context.Background(), steerOrbitTurn, "wait, stop")

	if got := s.fake.methods(); len(got) != 0 {
		t.Fatalf("requests = %v, want none", got)
	}
	assertSteerRefiled(t, s, steerOrbitTurn)
}

// Codex refusing the message. The turn it was aimed at is still running and still owns the
// session — a side-channel message that never arrived is no reason to take a working run down —
// so the refusal settles that message and nothing else.
func TestARefusedSteerSettlesItselfAndLeavesTheTurnRunning(t *testing.T) {
	for _, tc := range []struct {
		name      string
		message   string
		retryable bool
	}{
		// Orbit built the request wrong. Retryable is false on purpose: sending it again
		// reproduces it exactly, which is a loop rather than a recovery.
		{"orbit built it wrong", "Invalid request: missing field `expectedTurnId`", false},
		// Something no one has seen. Treated as "we do not know whether it arrived", which is why
		// nothing here retries by itself — Codex does not de-duplicate, so a retry it accepts
		// puts the message in the conversation twice.
		{"something new", "the turn is in a state that cannot be steered", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newCodexSteerSession(t)
			s.startTurn()
			s.name(steerCodexTurn)

			done := make(chan struct{})
			go func() {
				defer close(done)
				s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
			}()
			s.fake.refuse(s.fake.take("turn/steer"), tc.message)
			<-done

			assertSteerFailedVisibly(t, s, steerOrbitTurn, tc.retryable)
			if reason := asString(s.lastDelivery(steerOrbitTurn)["reason"]); !strings.Contains(reason, tc.message) {
				t.Errorf("reason = %q, want codex's own words in it", reason)
			}
			assertRunningTurnUntouched(t, s)
		})
	}
}

// An app-server that stops answering. The request was written, so whether Codex read it is not
// knowable from here — and that is precisely why it is not retried: a retry Codex accepts would
// insert the message a second time, and the model would read it as the user asking twice.
func TestASteerThatIsNeverAnsweredFailsWithoutBeingResent(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	s.steer(ctx, steerOrbitTurn, "actually, call it gadget")

	if got := s.fake.methods(); len(got) != 1 {
		t.Fatalf("requests = %v, want exactly one: an unanswered steer is never re-sent", got)
	}
	assertSteerFailedVisibly(t, s, steerOrbitTurn, true)
	assertRunningTurnUntouched(t, s)
}

// turn/steer answering for a turn other than the one it was addressed to has never been seen.
// Asserting it anyway is cheap, and the alternative is filing a message as delivered into a turn
// it did not join — a wrong answer that would look exactly like a right one.
func TestASteerAnsweredForAnotherTurnIsNotDelivery(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerNoSuchTurn})
	<-done

	// Not delivery, and provably not: the turn it named is not the one this message was aimed
	// at, so it goes back to being an ordinary message rather than being reported as lost.
	assertSteerRefiled(t, s, steerOrbitTurn)
	assertRunningTurnUntouched(t, s)
}

// A Codex too old to have the method at all. It answers with the same code as everything else, so
// the only signal is the wording — and once it has been given, asking again per message spends a
// round trip to be told the same thing. The answer is a property of the process.
func TestACodexWithoutTurnSteerIsOnlyAskedOnce(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.refuse(s.fake.take("turn/steer"),
		"Invalid request: unknown variant `turn/steer`, expected one of `initialize`, `turn/start`, `turn/interrupt`")
	<-done
	// A build with no turn/steer refused before reading the input, so the message is provably not
	// in the conversation and becomes the ordinary next one — which is also the whole mixed-version
	// story: an engine too old to be steered simply runs the message a turn later (§6.3).
	assertSteerRefiled(t, s, steerOrbitTurn)

	if !s.fake.app.steerUnsupported.Load() {
		t.Fatal("the engine's answer was not remembered; every later message would ask again")
	}
	s.steer(context.Background(), steerOtherTurn, "and another")
	if got := s.fake.methods(); len(got) != 1 {
		t.Errorf("requests = %v, want the second message to be refused without asking", got)
	}
	// Still answered, though — refusing without asking must not mean refusing in silence.
	assertSteerRefiled(t, s, steerOtherTurn)
	assertRunningTurnUntouched(t, s)
}

// Codex takes a steer and buffers it until its next model request. If the turn is interrupted in
// between, the message goes with the buffer — silently, with no notification and nothing in the
// thread. So a turn ending owes an answer for every steer still open on it; without one the
// sender is left watching "Delivering…" forever on a message that is never coming.
func TestATurnEndingAnswersEveryMessageItWasStillHolding(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
	<-done
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryWritten) {
		t.Fatalf("delivery states = %v, want written", got)
	}

	s.fake.say(map[string]interface{}{
		"method": "turn/completed",
		"params": map[string]interface{}{
			"threadId": steerThreadID,
			"turn":     map[string]interface{}{"id": steerCodexTurn, "status": "interrupted"},
		},
	})
	waitFor(t, "the turn to end", func() bool { return s.completionFor(steerMainTurn) != nil })

	assertSteerFailedVisibly(t, s, steerOrbitTurn, true)
	if reason := asString(s.lastDelivery(steerOrbitTurn)["reason"]); !strings.Contains(reason, "not delivered") {
		t.Errorf("reason = %q, want it to say the message did not arrive", reason)
	}
	// The turn's own completion is untouched by any of it: interrupted is interrupted.
	if c := s.completionFor(steerMainTurn); c.Subtype != "interrupted" {
		t.Errorf("the running turn completed as %+v", *c)
	}
}

// The tests above drive a finalizer of their own, because the session loop's is a closure inside
// a function that spawns a codex process. That leaves one thing they cannot see: whether the real
// finalizer still answers the steers its snapshot hands it. Deleting that loop compiles, passes
// every test above, and strands each mid-turn message at "Delivering…" forever — so it is asked
// of the source directly, the way the missing `case "steer"` it descends from is.
func TestTheSessionLoopsFinalizerAnswersTheSteersItsSnapshotHandsIt(t *testing.T) {
	src, err := os.ReadFile("codex_appserver.go")
	if err != nil {
		t.Fatalf("read codex_appserver.go: %v", err)
	}
	finalizer := string(src)
	start := strings.Index(finalizer, "finalizeActive := func(")
	if start < 0 {
		t.Fatal("the session loop has no finalizeActive; re-point this test at whatever replaced it")
	}
	end := strings.Index(finalizer[start:], "\n\tsendInterrupt :=")
	if end < 0 {
		t.Fatal("could not find the end of finalizeActive")
	}
	finalizer = finalizer[start : start+end]
	if !strings.Contains(finalizer, "snapshot.openSteers") {
		t.Error("the finalizer ignores snapshot.openSteers: a message codex took and never read " +
			"would be left reporting \"Delivering…\" with nothing coming")
	}
	if !strings.Contains(finalizer, "errCodexSteerDropped") {
		t.Error("the finalizer does not settle its open steers as undelivered")
	}
}

// A steer already in the conversation must not be reported as dropped when its turn ends: it was
// delivered, the model read it, and the answer to it is in the turn's own reply.
func TestATurnEndingLeavesAnAlreadyDeliveredMessageAlone(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.steer(context.Background(), steerOrbitTurn, "actually, call it gadget")
	}()
	s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
	<-done
	s.echo(steerOrbitTurn)
	waitFor(t, "the steer to be acknowledged", func() bool { return s.completionFor(steerOrbitTurn) != nil })

	s.finalize(codexTurnResult{Status: stSucceeded, Subtype: "completed"})

	_, completions := s.snapshot()
	settled := 0
	for _, c := range completions {
		if c.TurnID == steerOrbitTurn {
			settled++
		}
	}
	if settled != 1 {
		t.Errorf("the steer was settled %d times, want once", settled)
	}
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryAcknowledged) {
		t.Errorf("delivery states = %v, want it to stay acknowledged", got)
	}
}

// Echoes are matched by the id we sent, not by arrival order. The claude path has to match
// positionally because its replays carry no id at all; Codex's do, and using order here would
// answer the wrong message the moment two are outstanding.
func TestEchoesAreMatchedByIdRatherThanArrivalOrder(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	for _, turnID := range []string{steerOrbitTurn, steerOtherTurn} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			s.steer(context.Background(), turnID, "message for "+turnID)
		}()
		s.fake.answer(s.fake.take("turn/steer"), map[string]interface{}{"turnId": steerCodexTurn})
		<-done
	}

	// The second one comes back first.
	s.echo(steerOtherTurn)
	waitFor(t, "the second steer to be acknowledged", func() bool { return s.completionFor(steerOtherTurn) != nil })
	if c := s.completionFor(steerOrbitTurn); c != nil {
		t.Fatalf("the first message was settled by the second one's echo: %+v", *c)
	}
	if got := s.deliveries(steerOrbitTurn); got[len(got)-1] != string(deliveryWritten) {
		t.Errorf("first message = %v, want it still delivering", got)
	}

	s.echo(steerOrbitTurn)
	waitFor(t, "the first steer to be acknowledged", func() bool { return s.completionFor(steerOrbitTurn) != nil })
}

// The turn's own opening message is echoed the same way, under the turn's own id. It must not be
// mistaken for a steer: doing so would settle a conversation turn nothing is waiting to settle.
func TestTheTurnsOwnOpeningMessageIsNotMistakenForASteer(t *testing.T) {
	s := newCodexSteerSession(t)
	s.startTurn()
	s.name(steerCodexTurn)

	s.echo(steerMainTurn)
	time.Sleep(50 * time.Millisecond)

	if _, completions := s.snapshot(); len(completions) != 0 {
		t.Errorf("completions = %+v, want none", completions)
	}
}

// Every refusal Codex can answer with is the same JSON-RPC code — "no such method" included, as
// -32600 rather than -32601 — so the message text is the only thing that separates "the turn just
// ended, this is safe to send again" from "this Codex cannot do it at all" from "we have no idea".
// A release that reworded one would land in the unknown bucket, which is the safe end.
// `requeue` is the column that matters most here: true means "Codex PROVED it never read this",
// which is the only licence to put the message back in the queue. Marking an outcome that is
// merely unknown as re-filable would run the person's message twice — once inside the turn and
// once as the turn after it — because Codex does not de-duplicate (contract §4.3).
func TestARefusalIsClassifiedByItsWording(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want codexSteerRefusal
	}{
		{
			"the turn ended", errors.New("turn/steer: no active turn to steer"),
			codexSteerRefusal{code: "E-NO-ACTIVE", retryable: true, requeue: true},
		},
		{
			"a different turn is running",
			errors.New("turn/steer: expected active turn id `01a0…` but found `01a1…`"),
			codexSteerRefusal{code: "E-MISMATCH", retryable: true, requeue: true},
		},
		{
			// Ordered ahead of the malformed-request row on purpose: Codex prefixes an absent
			// method with "Invalid request" too, and reading this as a bad request would keep
			// asking an engine that has already said it cannot.
			"no such method",
			errors.New("turn/steer: Invalid request: unknown variant `turn/steer`, expected one of `initialize`, `turn/start`"),
			codexSteerRefusal{code: "E-UNSUPPORTED", retryable: true, unsupported: true, requeue: true},
		},
		{
			"a field orbit left out", errors.New("turn/steer: Invalid request: missing field `expectedTurnId`"),
			codexSteerRefusal{code: "E-BAD-REQUEST", retryable: false},
		},
		{
			"a thread id orbit built wrong", errors.New("turn/steer: invalid thread id: invalid character"),
			codexSteerRefusal{code: "E-BAD-REQUEST", retryable: false},
		},
		{
			"nothing was sent", errCodexSteerUnaimed,
			codexSteerRefusal{code: "E-UNSENT", retryable: true, requeue: true},
		},
		{
			"no turn to send it into", errNoTurnToSteer,
			codexSteerRefusal{code: "E-NO-ACTIVE", retryable: true, requeue: true},
		},
		{
			// Provably not sent, and still not re-filed: the message this duplicates is already
			// on its way in, so re-filing would queue a second copy of it.
			"handed over twice", errCodexSteerDuplicate,
			codexSteerRefusal{code: "E-DUPLICATE"},
		},
		{
			// The process that had it died. Not knowable either way, so it is reported and left
			// for a person — never re-filed, never re-delivered.
			"abandoned by a dead process", errSteerAbandoned,
			codexSteerRefusal{code: "E-ABANDONED", retryable: true},
		},
		{
			"taken and never echoed", errCodexSteerDropped,
			codexSteerRefusal{code: "E-DROPPED", retryable: true},
		},
		{
			"no answer came back", context.DeadlineExceeded,
			codexSteerRefusal{code: "E-TIMEOUT", retryable: true},
		},
		{
			"the engine went away", errors.New("codex app-server closed"),
			codexSteerRefusal{code: "E-TIMEOUT", retryable: true},
		},
		{
			"something new", errors.New("turn/steer: the turn is asleep"),
			codexSteerRefusal{code: "E-UNKNOWN", retryable: true},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyCodexSteerFailure(tc.err); got != tc.want {
				t.Errorf("classify(%v) = %+v, want %+v", tc.err, got, tc.want)
			}
		})
	}
}

// A steer carries the message and nothing else. It joins a turn whose model, cwd, sandbox and
// agent context are already settled, and 0.149.0 ignores params it does not know rather than
// rejecting them — so an override sent here would be silently wrong, which is the worst kind.
func TestASteerCarriesTheMessageAndNothingElse(t *testing.T) {
	params := codexSteerParams(steerThreadID, steerCodexTurn, steerOrbitTurn, "look at this",
		[]string{"/tmp/uploads/shot.png"})

	want := map[string]bool{"threadId": true, "expectedTurnId": true, "input": true, "clientUserMessageId": true}
	for key := range params {
		if !want[key] {
			t.Errorf("steer carried an extra %q; turn/steer takes no turn-level overrides", key)
		}
	}
	for key := range want {
		if _, ok := params[key]; !ok {
			t.Errorf("steer is missing %q", key)
		}
	}
	input, _ := params["input"].([]map[string]interface{})
	if len(input) != 2 {
		t.Fatalf("input = %#v, want the text and the image", input)
	}
	if input[0]["type"] != "text" || input[0]["text"] != "look at this" {
		t.Errorf("input[0] = %#v", input[0])
	}
	// An attachment reaches a steer the same way it reaches a turn: written to the session's
	// uploads dir and named by path, so the same message works either side of the turn boundary.
	if input[1]["type"] != "localImage" || input[1]["path"] != "/tmp/uploads/shot.png" {
		t.Errorf("input[1] = %#v", input[1])
	}
}

// assertSteerFailedVisibly checks the whole visible outcome of a message that did not arrive: it
// is in the transcript as the failure it is, it says why, and its own turn is settled so it stops
// being a leased row nobody will ever answer.
// assertSteerRefiled is the outcome for a message Codex PROVED it never read: the row goes back
// to being an ordinary queued message and runs when the turn it could not join ends. Nobody is
// told, because nothing went wrong from where the person is standing — and a bubble left here
// would be duplicated by the delivery that eventually runs it (contract §4.3a).
func assertSteerRefiled(t *testing.T, s *codexSteerSession, turnID string) {
	t.Helper()
	c := s.completionFor(turnID)
	if c == nil {
		t.Fatalf("%s was never answered: a steer is never re-delivered, so its row would stay in flight", turnID)
	}
	if c.Subtype != subtypeSteerRequeue || c.Status != stSucceeded {
		t.Fatalf("completion for %s = %+v, want a succeeded %q", turnID, *c, subtypeSteerRequeue)
	}
	if got := s.deliveries(turnID); len(got) != 0 {
		t.Errorf("delivery events for %s = %v, want none: nothing failed", turnID, got)
	}
	if n := s.bubbles(turnID); n != 0 {
		t.Errorf("user events for %s = %d, want none", turnID, n)
	}
}

func assertSteerFailedVisibly(t *testing.T, s *codexSteerSession, turnID string, retryable bool) {
	t.Helper()
	events, _ := s.snapshot()
	var user map[string]interface{}
	for _, ev := range events {
		if ev.typ == evUser && ev.turnID == turnID {
			user = ev.payload
		}
	}
	if user == nil {
		t.Fatalf("no user event for %s: the sender is left watching a bubble that never resolves", turnID)
	}
	// Filed as a steer either way, because that is what tells a client it has no reply of its own
	// coming and that how far it got is the whole outcome.
	if user["steer"] != true {
		t.Errorf("user event = %+v, want it marked as a steer", user)
	}
	last := s.lastDelivery(turnID)
	if last == nil || last["delivery"] != string(deliveryFailed) {
		t.Fatalf("last delivery for %s = %+v, want failed", turnID, last)
	}
	if asString(last["reason"]) == "" {
		t.Errorf("delivery = %+v, want a reason someone can act on", last)
	}
	if last["retryable"] != retryable {
		t.Errorf("retryable = %v, want %v", last["retryable"], retryable)
	}
	c := s.completionFor(turnID)
	if c == nil {
		t.Fatalf("%s was never settled: a steer is never re-delivered, so its row would stay in flight", turnID)
	}
	if c.Status != stFailed || c.Subtype != subtypeSteer {
		t.Errorf("completion = %+v, want a failed %q", *c, subtypeSteer)
	}
}

// assertRunningTurnUntouched checks that a message that failed took nothing else with it. The
// turn it was aimed at is still running and still owns the session's slot and status; failing it
// over a side-channel message would take a working run down.
func assertRunningTurnUntouched(t *testing.T, s *codexSteerSession) {
	t.Helper()
	if c := s.completionFor(steerMainTurn); c != nil {
		t.Errorf("the running turn was settled by a failed message: %+v", *c)
	}
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	if s.active == nil || s.active.finishing {
		t.Error("the running turn ended when a message failed to reach it")
	}
}
