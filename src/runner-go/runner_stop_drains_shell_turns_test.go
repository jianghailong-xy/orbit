package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A runner stop — SIGTERM from `systemctl restart`/`systemctl stop`, a Ctrl-C — drains: it stops
// claiming and gives what is in flight the drain budget to finish. A turn in the engine always had
// that budget. A turn the runner runs itself, an EXECUTABLE acceptance command or a `!` shell, did
// not: the Claude drain found nothing pending and tore the process down at once, and OpenCode ran
// the command under a context the stop itself cancelled. Either way the command was killed within
// seconds and reported as exit -1, and an acceptance command's -1 is a FAILED task.

// The Claude runtime, end to end through the real supervisor: the acceptance command is running
// when runLoop's context is cancelled, which is what SIGTERM does.
func TestARunnerStopLetsAnAcceptanceCommandInFlightFinish(t *testing.T) {
	pool := newSessionPool(2)
	loopCtx, stopLoop := context.WithCancel(context.Background())
	defer stopLoop()
	s := superviseClaudeSessionUntil(t, pool, t.TempDir(), loopCtx,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "implemented"},
		fakeStep{Emit: "result", Text: "implemented"},
	)
	s.awaitParked("turn-1")

	// The task's acceptance command, claimed as runLoop claims a turn for a warm session.
	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("the acceptance turn's claim was not activated")
	}
	started := filepath.Join(t.TempDir(), "started")
	s.queue(RunInboxResponse{TurnID: "accept-1", Kind: "shell", TaskAcceptance: true,
		Content: "touch " + started + "; sleep 1; exit 0"})
	waitUntil(t, func() bool { _, err := os.Stat(started); return err == nil }, "the acceptance command never started")

	stopLoop()

	waitUntil(t, func() bool { return s.settledTurn("accept-1") != nil }, "the acceptance turn was never settled")
	if settled := s.settledTurn("accept-1"); settled.ShellExitCode == nil || *settled.ShellExitCode != 0 {
		t.Fatalf("the acceptance command settled as %q, want exit 0: the runner stop killed it mid-run", settled.Result)
	}
	// What the stop does to the session once the command is done is what it always did to an idle
	// one: detach it, resumable, rather than end it.
	waitUntil(t, func() bool { return pool.count() == 0 }, "the supervisor never detached for the stop")
	if s.requested("/finalize") || s.requested("/complete") {
		t.Fatal("the stop ended the session instead of detaching it")
	}
}

// The same on OpenCode. A shell turn starts no OpenCode process, so the session loop is driven
// directly against a stub inbox.
func TestAnOpenCodeRunnerStopLetsAnAcceptanceCommandInFlightFinish(t *testing.T) {
	started := filepath.Join(t.TempDir(), "started")
	inbox := &oneTurnInbox{turn: RunInboxResponse{TurnID: "accept-1", Kind: "shell", TaskAcceptance: true,
		Content: "touch " + started + "; sleep 1; exit 0"}}
	api := httptest.NewServer(inbox)
	defer api.Close()

	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	var mu sync.Mutex
	var settled []TurnCompleteRequest
	complete := func(req TurnCompleteRequest, _ ...context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		settled = append(settled, req)
		return nil
	}
	job := &ClaimedSession{SessionID: "s-opencode-stop", Provider: providerOpenCode}
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		runOpenCodeSessionProcess(context.Background(), shutdown, NewTransport(api.URL, "runner-token"), job,
			"generation-1", t.TempDir(), t.TempDir(),
			func(string, map[string]interface{}) {}, func(string, string, map[string]interface{}) {},
			func(string) {}, false, nil, complete,
			func(context.Context) bool { return true }, func(error) {})
	}()
	waitUntil(t, func() bool { _, err := os.Stat(started); return err == nil }, "the acceptance command never started")

	stop()

	select {
	case <-returned:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the OpenCode session loop never returned after the stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(settled) != 1 || settled[0].ShellExitCode == nil || *settled[0].ShellExitCode != 0 {
		var results []string
		for _, req := range settled {
			results = append(results, req.Result)
		}
		t.Fatalf("settled %v, want the acceptance command's own exit 0: the runner stop killed it mid-run",
			results)
	}
}

// oneTurnInbox hands out one turn, then answers every later long-poll with nothing.
type oneTurnInbox struct {
	mu   sync.Mutex
	turn RunInboxResponse
	sent bool
}

func (i *oneTurnInbox) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/inbox") {
		i.mu.Lock()
		send := !i.sent
		i.sent = true
		i.mu.Unlock()
		if send {
			_ = json.NewEncoder(w).Encode(i.turn)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, _ = w.Write([]byte(`{}`))
}
