//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The gate on `run`, over a real socket and against a control plane double, because the socket is the door
// every engine and a shell that reaches it by itself come through.

// gateCards is a control plane whose cards stay PENDING until the test answers them.
type gateCards struct {
	mu     sync.Mutex
	filed  []map[string]interface{}
	answer map[string]ApprovalDecisionResponse
	srv    *httptest.Server
}

func newGateCards(t *testing.T) *gateCards {
	t.Helper()
	c := &gateCards{answer: map[string]ApprovalDecisionResponse{}}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/approvals"):
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			c.filed = append(c.filed, body)
			id := fmt.Sprintf("card-%d", len(c.filed))
			c.answer[id] = ApprovalDecisionResponse{ID: id, Status: "PENDING"}
			_, _ = fmt.Fprintf(w, `{"id":%q,"status":"PENDING"}`, id)
		case strings.Contains(r.URL.Path, "/approvals/"):
			_ = json.NewEncoder(w).Encode(c.answer[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]])
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *gateCards) cards() []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]interface{}{}, c.filed...)
}

func (c *gateCards) decide(n int, status, message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := fmt.Sprintf("card-%d", n)
	c.answer[id] = ApprovalDecisionResponse{ID: id, Status: status, Message: message}
}

// gateFixture is one session's job service on a real socket.
type gateFixture struct {
	t      *testing.T
	cards  *gateCards
	svc    *bgJobService
	bg     *bgTailer
	dir    string
	socket string
	events *bgJobEvents
	holds  *recordingHolds

	mu    sync.Mutex
	mode  string
	wakes []bgWake
}

// recordingHolds remembers which door each hold came through.
type recordingHolds struct {
	mu     sync.Mutex
	active map[string]string
}

func (h *recordingHolds) set(id, door string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.active[id] = door
}
func (h *recordingHolds) holdWorktree(id, _ string)    { h.set(id, "engine") }
func (h *recordingHolds) holdRunnerJob(id, _ string)   { h.set(id, "job") }
func (h *recordingHolds) holdRunnerWatch(id, _ string) { h.set(id, "watch") }
func (h *recordingHolds) releaseWorktree(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.active, id)
}
func (h *recordingHolds) door(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.active[id]
}

func newGateFixture(t *testing.T, mode string) *gateFixture {
	t.Helper()
	// A unix socket path has to stay short, and t.TempDir() names itself after the test.
	dir, err := os.MkdirTemp("", "bggate")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	ctx, cancel := context.WithCancel(context.Background())
	f := &gateFixture{t: t, cards: newGateCards(t), dir: dir, mode: mode, events: &bgJobEvents{},
		socket: filepath.Join(dir, "bg.sock"), holds: &recordingHolds{active: map[string]string{}}}
	f.bg = newBgTailer(ctx, f.events.emit, f.holds)
	f.bg.wakeSessionVia(func(w bgWake) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.wakes = append(f.wakes, w)
		return nil
	})
	f.svc = &bgJobService{bg: f.bg, token: "tok", execDir: dir, scratchDir: dir, sessionID: "sess-gate",
		t: NewTransport(f.cards.srv.URL, "runner-token"),
		mode: func() string {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.mode
		}}
	stop, err := startBgJobService(ctx, f.svc, f.socket, filepath.Join(dir, "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop()
		f.bg.stopAll()
		cancel()
	})
	return f
}

func (f *gateFixture) setMode(mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode = mode
}

func (f *gateFixture) wakesOf(jobID string) []bgWake {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []bgWake
	for _, w := range f.wakes {
		if w.JobID == jobID {
			out = append(out, w)
		}
	}
	return out
}

// sentinelCommand writes a file only if it runs, which is all any of these tests need to know.
func (f *gateFixture) sentinelCommand(name string) (string, string) {
	path := filepath.Join(f.dir, name)
	return "echo ran > " + shellQuote(path), path
}

func (f *gateFixture) run(args map[string]interface{}) (bgJobStatus, error) {
	raw, err := bgSocketCall(f.socket, "tok", "run", args)
	if err != nil {
		return bgJobStatus{}, err
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		f.t.Fatal(err)
	}
	return status, nil
}

// shortGateWait makes a call stop waiting at once, for the tests about what happens after it has.
func shortGateWait(t *testing.T) {
	t.Helper()
	old := bgGateInlineWait
	bgGateInlineWait = 20 * time.Millisecond
	t.Cleanup(func() { bgGateInlineWait = old })
}

// Plan and Don't Ask refuse, file nothing and run nothing, and say what to do other than fall back on Bash.
func TestBgGateRefusesInPlanAndDontAsk(t *testing.T) {
	for _, mode := range []string{"plan", "dontAsk"} {
		t.Run(mode, func(t *testing.T) {
			f := newGateFixture(t, mode)
			command, sentinel := f.sentinelCommand("ran")
			_, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob, "wakeOnExit": true})
			if err == nil {
				t.Fatal("the job was not refused")
			}
			for _, want := range []string{"Not started", "Do not retry", "run_in_background"} {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("refusal %q does not say %q", err, want)
				}
			}
			time.Sleep(100 * time.Millisecond)
			if fileExists(sentinel) || len(f.cards.cards()) != 0 || len(f.bg.listJobs(true)) != 0 {
				t.Fatalf("a refused job left something: ran=%v cards=%v jobs=%v", fileExists(sentinel), f.cards.cards(), f.bg.listJobs(true))
			}
		})
	}
}

// Auto and Bypass start the job as they always did: no card, no waiting, the same answer. An unset mode is the
// server's floor, Auto.
func TestBgGateStartsAtOnceInAutoAndBypass(t *testing.T) {
	for _, mode := range []string{"auto", "bypassPermissions", ""} {
		t.Run("mode="+mode, func(t *testing.T) {
			f := newGateFixture(t, mode)
			command, sentinel := f.sentinelCommand("ran")
			status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob})
			if err != nil {
				t.Fatal(err)
			}
			if status.Status != bgStatusRunning && status.Status != bgStatusCompleted {
				t.Fatalf("status = %q", status.Status)
			}
			if status.Note != "" {
				t.Fatalf("a job that started carries a note: %q", status.Note)
			}
			awaitCondition(t, 10*time.Second, "the job never ran", func() bool { return fileExists(sentinel) })
			if cards := f.cards.cards(); len(cards) != 0 {
				t.Fatalf("a card was filed: %v", cards)
			}
		})
	}
}

// A mode that asks shows the owner what would run, under the job's own id, and runs it only on a yes. An answer
// inside the call comes back in the call, as a Bash card's does.
func TestBgGateAsksInDefaultAndAcceptEdits(t *testing.T) {
	for _, mode := range []string{"default", "acceptEdits", "a-mode-from-later"} {
		t.Run(mode, func(t *testing.T) {
			f := newGateFixture(t, mode)
			command, sentinel := f.sentinelCommand("ran")
			type answer struct {
				status bgJobStatus
				err    error
			}
			done := make(chan answer, 1)
			go func() {
				status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob, "description": "the build",
					"cwd": f.dir, "env": map[string]interface{}{"FROM_THE_REQUEST": "1"}})
				done <- answer{status, err}
			}()
			awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
			card := f.cards.cards()[0]
			if card["toolName"] != "Bash" || card["toolUseId"] != card["backgroundJobId"] || !strings.HasPrefix(fmt.Sprint(card["backgroundJobId"]), "bgj_") {
				t.Fatalf("card = %+v", card)
			}
			input := card["input"].(map[string]interface{})
			env, _ := input["env"].(map[string]interface{})
			if input["command"] != command || input["kind"] != bgKindJob || input["description"] != "the build" || input["cwd"] != f.dir ||
				env["FROM_THE_REQUEST"] != "1" || !strings.Contains(fmt.Sprint(input["runsOn"]), "outside this engine's sandbox") {
				t.Fatalf("the card does not show what would run: %+v", input)
			}
			select {
			case got := <-done:
				t.Fatalf("the call returned before the owner answered: %+v", got)
			case <-time.After(100 * time.Millisecond):
			}
			if fileExists(sentinel) {
				t.Fatal("the job ran before the owner answered")
			}
			f.cards.decide(1, "ALLOWED", "")
			got := <-done
			if got.err != nil {
				t.Fatal(got.err)
			}
			if got.status.JobID != card["backgroundJobId"] || got.status.Status == bgStatusWaitingForOwner || got.status.Note != "" {
				t.Fatalf("status = %+v", got.status)
			}
			awaitCondition(t, 10*time.Second, "an allowed job never ran", func() bool { return fileExists(sentinel) })
			if wakes := f.wakesOf(got.status.JobID); len(wakes) != 0 {
				t.Fatalf("an answer the call carried also woke the session: %+v", wakes)
			}
		})
	}
}

// A refusal inside the call comes back in the call, and it is the only thing that does.
func TestBgGateOwnerRefusalInTheCall(t *testing.T) {
	f := newGateFixture(t, "default")
	command, sentinel := f.sentinelCommand("ran")
	done := make(chan error, 1)
	go func() {
		_, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob, "wakeOnExit": true})
		done <- err
	}()
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	f.cards.decide(1, "DENIED", "not this one")
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "refused") || !strings.Contains(err.Error(), "not this one") {
		t.Fatalf("refusal = %v", err)
	}
	if fileExists(sentinel) {
		t.Fatal("a refused job ran")
	}
	jobID := fmt.Sprint(f.cards.cards()[0]["backgroundJobId"])
	status, _ := f.bg.jobStatus(jobID)
	if status.Status != bgStatusKilled || status.ExitCode != nil || status.PID != 0 {
		t.Fatalf("a job that never started reads %+v", status)
	}
	ended := f.events.withStatus(bgStatusKilled)
	if len(ended) != 1 || ended[0]["reason"] != bgNotAllowedReason {
		t.Fatalf("its end was reported as %+v", ended)
	}
	if wakes := f.wakesOf(jobID); len(wakes) != 0 {
		t.Fatalf("the call carried the refusal and the session was woken as well: %+v", wakes)
	}
}

// A person takes longer than the call can stay open. The call says the job is waiting; the job keeps its id; the
// card stays answerable, because the control plane is told the job is running; and the answer wakes the session.
func TestBgGateAnswerAfterTheCallStartsTheJobAndWakes(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "acceptEdits")
	command, sentinel := f.sentinelCommand("ran")
	started := time.Now()
	status, err := f.run(map[string]interface{}{"command": command + "; sleep 30", "kind": bgKindJob})
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("the call stayed open %s", took)
	}
	if status.Status != bgStatusWaitingForOwner || status.PID != 0 || status.Note != bgGateWaitingNote {
		t.Fatalf("status = %+v", status)
	}
	for _, want := range []string{"Not started yet", "do not run it with Bash", "wakes this session"} {
		if !strings.Contains(status.Note, want) {
			t.Fatalf("note %q does not say %q", status.Note, want)
		}
	}
	running := f.events.withStatus(bgStatusRunning)
	if len(running) != 1 || running[0]["toolUseId"] != status.JobID {
		t.Fatalf("the control plane was not told of the job its card names: %+v", running)
	}
	if door := f.holds.door(status.JobID); door != "watch" {
		t.Fatalf("a waiting job holds the checkout through %q; it takes no capacity", door)
	}
	listed := f.bg.listJobs(false)
	if len(listed) != 1 || listed[0].JobID != status.JobID || listed[0].Status != bgStatusWaitingForOwner {
		t.Fatalf("bg_list = %+v", listed)
	}
	out, err := f.bg.jobOutput(status.JobID, 0, 0)
	if err != nil || out.Status != bgStatusWaitingForOwner || !strings.Contains(out.Output, "has not started") {
		t.Fatalf("bg_output = %+v, %v", out, err)
	}
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	if fileExists(sentinel) {
		t.Fatal("the job ran before the owner answered")
	}

	f.cards.decide(1, "ALLOWED", "")
	awaitCondition(t, 10*time.Second, "an allowed job never ran", func() bool { return fileExists(sentinel) })
	after, _ := f.bg.jobStatus(status.JobID)
	if after.Status != bgStatusRunning || after.PID == 0 {
		t.Fatalf("status once allowed = %+v", after)
	}
	if door := f.holds.door(status.JobID); door != "job" {
		t.Fatalf("a job that started holds the checkout through %q", door)
	}
	awaitCondition(t, 10*time.Second, "the answer never woke the session", func() bool { return len(f.wakesOf(status.JobID)) == 1 })
	wake := f.wakesOf(status.JobID)[0]
	if wake.Trigger != bgWakeOnOutput || wake.Status != bgStatusRunning || !strings.Contains(wake.OutputExcerpt, "allowed") {
		t.Fatalf("wake = %+v", wake)
	}
}

// A refusal after the call has returned wakes the session whatever the job asked for: it was told to expect it.
func TestBgGateRefusalAfterTheCallWakesTheSession(t *testing.T) {
	shortGateWait(t)
	for _, tc := range []struct {
		status, message, says string
	}{
		{"DENIED", "", "The owner refused"},
		{"ABANDONED", "the turn that asked this ended", "Nobody answered"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			f := newGateFixture(t, "default")
			command, sentinel := f.sentinelCommand("ran")
			status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob})
			if err != nil {
				t.Fatal(err)
			}
			awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
			f.cards.decide(1, tc.status, tc.message)
			awaitCondition(t, 10*time.Second, "the refusal never woke the session", func() bool { return len(f.wakesOf(status.JobID)) == 1 })
			wake := f.wakesOf(status.JobID)[0]
			if wake.Trigger != bgWakeOnExit || wake.Status != bgStatusKilled || wake.Reason != bgNotAllowedReason || wake.ExitCode != nil ||
				!strings.Contains(wake.OutputExcerpt, tc.says) {
				t.Fatalf("wake = %+v", wake)
			}
			if fileExists(sentinel) {
				t.Fatal("a job nobody allowed ran")
			}
			if door := f.holds.door(status.JobID); door != "" {
				t.Fatalf("a job that never started still holds the checkout through %q", door)
			}
		})
	}
}

// bg_kill withdraws a waiting job: it ends at once, never runs however the card is answered, and wakes nobody,
// because whoever killed it is reading the answer.
func TestBgGateKillWithdrawsAWaitingJob(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "default")
	command, sentinel := f.sentinelCommand("ran")
	status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob, "wakeOnExit": true})
	if err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	killed, err := f.bg.killJob(status.JobID, bgKillTeardownGrace)
	if err != nil || killed.Status != bgStatusKilled {
		t.Fatalf("kill = %+v, %v", killed, err)
	}
	f.cards.decide(1, "ALLOWED", "")
	time.Sleep(200 * time.Millisecond)
	if fileExists(sentinel) {
		t.Fatal("a withdrawn job ran on a late yes")
	}
	if wakes := f.wakesOf(status.JobID); len(wakes) != 0 {
		t.Fatalf("a kill woke the session: %+v", wakes)
	}
}

// The session's end does not sit out a job nobody allowed: it has nothing to land, unlike a job that is running.
func TestBgGateDrainDoesNotWaitForAWaitingJob(t *testing.T) {
	shortGateWait(t)
	old := bgDrainWaitCap
	bgDrainWaitCap = time.Minute
	t.Cleanup(func() { bgDrainWaitCap = old })
	f := newGateFixture(t, "default")
	command, sentinel := f.sentinelCommand("ran")
	if _, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob}); err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	started := time.Now()
	f.bg.stopAll()
	if took := time.Since(started); took > 20*time.Second {
		t.Fatalf("the drain waited %s for a job that had not started", took)
	}
	if fileExists(sentinel) {
		t.Fatal("a drained job ran")
	}
}

// A person's Stop ends a waiting job with the rest of the session's work, and wakes nobody.
func TestBgGateStopEndsAWaitingJob(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "default")
	command, sentinel := f.sentinelCommand("ran")
	status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob})
	if err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	f.bg.stopBackgroundWork()
	awaitCondition(t, 10*time.Second, "Stop did not end the waiting job", func() bool {
		now, _ := f.bg.jobStatus(status.JobID)
		return now.Status == bgStatusKilled
	})
	f.cards.decide(1, "ALLOWED", "")
	time.Sleep(200 * time.Millisecond)
	if fileExists(sentinel) {
		t.Fatal("a stopped job ran on a late yes")
	}
	if wakes := f.wakesOf(status.JobID); len(wakes) != 0 {
		t.Fatalf("Stop woke the session: %+v", wakes)
	}
}

// A runner's stop ends a job that has not started, whichever way it stops, and the session that was told to expect
// an answer hears why it will not get one. A self-update has nothing to hand on: no process, and a card the next
// image could not read (the control plane collects it with the takeover).
func TestBgGateRunnerStopEndsAWaitingJob(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cause error
	}{{"signal", context.Canceled}, {"self-update", errRunnerSelfUpdate}} {
		t.Run(tc.name, func(t *testing.T) {
			shortGateWait(t)
			t.Setenv("ORBIT_HOME", t.TempDir())
			f := newGateFixture(t, "default")
			runnerCtx, stopRunner := context.WithCancelCause(context.Background())
			defer stopRunner(nil)
			f.bg.recordJobs("sess-gate", &sessionPool{}, func(map[string]interface{}) error { return nil })
			f.bg.drainOnRunnerShutdown(runnerCtx)
			command, sentinel := f.sentinelCommand("ran")
			status, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob})
			if err != nil {
				t.Fatal(err)
			}
			awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
			stopRunner(tc.cause)
			awaitCondition(t, 10*time.Second, "the waiting job was not ended", func() bool {
				now, ok := f.bg.jobStatus(status.JobID)
				return ok && now.Status == bgStatusKilled
			})
			awaitCondition(t, 10*time.Second, "the session was not told", func() bool { return len(f.wakesOf(status.JobID)) == 1 })
			wake := f.wakesOf(status.JobID)[0]
			if wake.Reason != bgRunnerShutdownReason || wake.Status != bgStatusKilled {
				t.Fatalf("wake = %+v", wake)
			}
			if fileExists(sentinel) {
				t.Fatal("it ran")
			}
		})
	}
}

// The control plane empties its set of running jobs on a resumed engine's handshake, and a card lives only while the
// job it names is in that set: a waiting job is reported again like any other, or the card dies with the engine.
func TestBgGateWaitingJobIsAnnouncedAgain(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "default")
	status, err := f.run(map[string]interface{}{"command": "true", "kind": bgKindService})
	if err != nil {
		t.Fatal(err)
	}
	before := len(f.events.withStatus(bgStatusRunning))
	f.bg.announceRunningJobs()
	running := f.events.withStatus(bgStatusRunning)
	if len(running) != before+1 || running[len(running)-1]["toolUseId"] != status.JobID || running[len(running)-1]["kind"] != bgKindService {
		t.Fatalf("running reports = %+v", running)
	}
}

// The lines the runner writes about the wait are not the job's output: a job that asked to be woken for new output
// is woken for what it writes.
func TestBgGateWaitIsNotNewOutput(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "default")
	status, err := f.run(map[string]interface{}{"command": "sleep 30", "kind": bgKindJob, "wakeOnOutput": true})
	if err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { return len(f.cards.cards()) == 1 })
	f.cards.decide(1, "ALLOWED", "")
	awaitCondition(t, 10*time.Second, "the answer never woke the session", func() bool { return len(f.wakesOf(status.JobID)) == 1 })
	f.bg.mu.Lock()
	job := f.bg.jobs[status.JobID]
	through := job.wokenThrough
	f.bg.mu.Unlock()
	if size := outputSizeOf(job.outputPath); through != size || size == 0 {
		t.Fatalf("woken through %d of %d: the runner's own lines would wake the session again", through, size)
	}
}

// DeepSeek Harness's Auto keeps its file sandbox, so a job outside it is an escalation, judged by Auto's rule.
func TestBgGateDshAutoAsksUnlessRoutine(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "auto")
	f.svc.engine = providerDsh

	routine, err := f.run(map[string]interface{}{"command": "go test ./...", "kind": bgKindJob})
	if err != nil {
		t.Fatal(err)
	}
	if routine.Status == bgStatusWaitingForOwner || len(f.cards.cards()) != 0 {
		t.Fatalf("a routine command asked: %+v, %v", routine, f.cards.cards())
	}

	outside, err := f.run(map[string]interface{}{"command": "touch /etc/orbit-gate-probe", "kind": bgKindJob})
	if err != nil {
		t.Fatal(err)
	}
	if outside.Status != bgStatusWaitingForOwner {
		t.Fatalf("a command naming a path outside the workspace = %+v", outside)
	}

	// The rule reads a command line, and these change what the line does.
	withEnv, err := f.run(map[string]interface{}{"command": "go test ./...", "kind": bgKindJob, "env": map[string]interface{}{"BASH_ENV": "./x"}})
	if err != nil {
		t.Fatal(err)
	}
	if withEnv.Status != bgStatusWaitingForOwner {
		t.Fatalf("a routine line with variables of the request's own = %+v", withEnv)
	}

	// Every other engine's Auto starts it.
	f.svc.engine = providerClaude
	other, err := f.run(map[string]interface{}{"command": "touch /tmp/orbit-gate-probe-other-engine-$$", "kind": bgKindJob})
	if err != nil {
		t.Fatal(err)
	}
	if other.Status == bgStatusWaitingForOwner {
		t.Fatalf("Claude's Auto asked: %+v", other)
	}
}

// The mode is read at each call: a person may switch it during the session, either way.
func TestBgGateReadsTheModeAtEachCall(t *testing.T) {
	shortGateWait(t)
	f := newGateFixture(t, "plan")
	if _, err := f.run(map[string]interface{}{"command": "true", "kind": bgKindJob}); err == nil {
		t.Fatal("Plan did not refuse")
	}
	f.setMode("auto")
	status, err := f.run(map[string]interface{}{"command": "true", "kind": bgKindJob})
	if err != nil || status.Status == bgStatusWaitingForOwner {
		t.Fatalf("after switching to Auto: %+v, %v", status, err)
	}
	f.setMode("default")
	status, err = f.run(map[string]interface{}{"command": "true", "kind": bgKindJob})
	if err != nil || status.Status != bgStatusWaitingForOwner {
		t.Fatalf("after switching to Default: %+v, %v", status, err)
	}
	f.setMode("dontAsk")
	if _, err := f.run(map[string]interface{}{"command": "true", "kind": bgKindJob}); err == nil {
		t.Fatal("Don't Ask did not refuse")
	}
}

// A request that could not start anyway is refused before anybody is asked about it.
func TestBgGateAsksNobodyAboutAnInvalidRequest(t *testing.T) {
	f := newGateFixture(t, "default")
	for _, args := range []map[string]interface{}{
		{"command": "true", "kind": "nonsense"},
		{"command": "  ", "kind": bgKindJob},
		{"command": "true", "kind": bgKindJob, "cwd": "/somewhere/else"},
		{"command": "true", "kind": bgKindJob, "wakeOnExit": "yes"},
	} {
		if _, err := f.run(args); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if cards := f.cards.cards(); len(cards) != 0 {
		t.Fatalf("somebody was asked: %v", cards)
	}
}

// With no mode to read, nothing starts: a service wired without one refuses rather than runs.
func TestBgGateRefusesWithoutAModeToRead(t *testing.T) {
	f := newGateFixture(t, "auto")
	f.svc.mode = nil
	command, sentinel := f.sentinelCommand("ran")
	if _, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob}); err == nil {
		t.Fatal("a job started with no mode to read")
	}
	time.Sleep(100 * time.Millisecond)
	if fileExists(sentinel) {
		t.Fatal("it ran")
	}
}

// A card that cannot be filed starts nothing, and says so.
func TestBgGateCardThatCannotBeFiled(t *testing.T) {
	f := newGateFixture(t, "default")
	f.svc.t = NewTransport("http://127.0.0.1:1", "runner-token")
	shortCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan error, 1)
	command, sentinel := f.sentinelCommand("ran")
	go func() {
		_, err := f.run(map[string]interface{}{"command": command, "kind": bgKindJob})
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "could not get the owner's answer") {
			t.Fatalf("answer = %v", err)
		}
	case <-shortCtx.Done():
		t.Fatal("the call never answered")
	}
	if fileExists(sentinel) {
		t.Fatal("it ran")
	}
}

// The hosted wait of a call that asks a person is not a job the gate judges: its own operation runs in every mode.
// It can do nothing else: what it runs is fixed by the runner, for a call that puts a card in front of the owner.
func TestBgOwnerWaitIsItsOwnOperation(t *testing.T) {
	f := newGateFixture(t, "plan")
	f.svc.agentID, f.svc.taskID = "agent-1", "task-1"
	raw, err := bgSocketCall(f.socket, "tok", "owner_wait", map[string]interface{}{"tool": "task_create", "arguments": map[string]interface{}{"title": "x"}})
	if err != nil {
		t.Fatalf("Plan refused the hosted wait: %v", err)
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatal(err)
	}
	if status.Kind != bgKindWatch || !status.WakeOnExit || !strings.Contains(status.Command, envMCPTools+"='task_create'") ||
		!strings.Contains(status.Command, "ORBIT_AGENT_ID='agent-1'") || !strings.HasSuffix(status.Description, "waiting for the owner's confirmation") {
		t.Fatalf("the hosted wait = %+v", status)
	}

	// Nothing but a call that waits for the owner, and no way to name what runs.
	for _, args := range []map[string]interface{}{
		{"tool": "task_list"},
		{"tool": "bg_run", "arguments": map[string]interface{}{"command": "true", "kind": bgKindJob}},
		{"tool": "task_create_batch", "arguments": map[string]interface{}{"dryRun": true}},
		{"tool": ""},
	} {
		if _, err := bgSocketCall(f.socket, "tok", "owner_wait", args); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}

	// And looking like the hosted wait buys `run` nothing.
	command, sentinel := f.sentinelCommand("ran")
	if _, err := f.run(map[string]interface{}{"command": command, "kind": bgKindWatch, "wakeOnExit": true,
		"description": "Orbit task_create: waiting for the owner's confirmation"}); err == nil {
		t.Fatal("a job dressed as the hosted wait started in Plan")
	}
	time.Sleep(100 * time.Millisecond)
	if fileExists(sentinel) {
		t.Fatal("it ran")
	}
}

// A batch of tasks can be far longer than any command line, and has to fit through the door whole.
func TestBgOwnerWaitTakesALargeCall(t *testing.T) {
	f := newGateFixture(t, "dontAsk")
	raw, err := bgSocketCall(f.socket, "tok", "owner_wait", map[string]interface{}{"tool": "task_create_batch", "arguments": map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "x", "description": strings.Repeat("y", 512*1024)}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatal(err)
	}
	if status.JobID == "" {
		t.Fatalf("status = %s", raw)
	}
}

// What the gate reads moves with what a session is told, and only the supervisor's own writes reach job.Agent.
func TestSessionLiveModeFollowsReloadsAndTheEngine(t *testing.T) {
	job := &ClaimedSession{SessionID: "s", Agent: AgentExecConfig{PermissionMode: "default"}}
	// Before the service starts there is nobody to tell, and that is not an error.
	job.notePermissionMode("plan")

	live := &sessionLiveMode{mode: job.Agent.PermissionMode}
	job.liveMode = live
	applyRuntimeReload(job, `{"permissionMode":"auto"}`)
	if live.current() != "auto" || job.Agent.PermissionMode != "auto" {
		t.Fatalf("after a reload: live %q, agent %q", live.current(), job.Agent.PermissionMode)
	}
	applyRuntimeReload(job, `{"model":"another"}`)
	if live.current() != "auto" {
		t.Fatalf("a reload that names no mode moved it to %q", live.current())
	}

	// An approved plan leaves Plan with no word to anyone but this frame, and a respawn starts from job.Agent.
	claudeNoteEngineMode(job, map[string]interface{}{"type": "system", "subtype": "status", "status": nil, "permissionMode": "plan"})
	if live.current() != "plan" || job.Agent.PermissionMode != "auto" {
		t.Fatalf("after the engine's report: live %q, agent %q", live.current(), job.Agent.PermissionMode)
	}
	claudeNoteEngineMode(job, map[string]interface{}{"type": "system", "subtype": "init", "permissionMode": "default"})
	if live.current() != "default" {
		t.Fatalf("after init: live %q", live.current())
	}
	for _, frame := range []map[string]interface{}{
		{"type": "system", "subtype": "status", "status": "compacting"},
		{"type": "system", "subtype": "status", "permissionMode": "auto", "parent_tool_use_id": "toolu_1"},
		{"type": "system", "subtype": "task_progress", "permissionMode": "auto"},
		{"type": "assistant", "subtype": "status", "permissionMode": "auto"},
	} {
		claudeNoteEngineMode(job, frame)
		if live.current() != "default" {
			t.Fatalf("%v moved the mode to %q", frame, live.current())
		}
	}
}

// Codex would ask for its own consent before every bg_run. The gate is the one card, in every mode.
func TestCodexConsentForBgRunIsTheGates(t *testing.T) {
	bgRun := codexApprovalRequest{mcpTool: true, server: codexOrbitMCPServer, tool: "bg_run"}
	for _, mode := range []string{"default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"} {
		if allowed, decided := codexAutomaticApproval(mode, bgRun); !decided || !allowed {
			t.Fatalf("%s: bg_run's consent = %v/%v, want answered yes", mode, allowed, decided)
		}
	}
	// Another of Orbit's tools still asks in the modes that ask, and Plan still refuses it.
	other := codexApprovalRequest{mcpTool: true, server: codexOrbitMCPServer, tool: "task_update"}
	if _, decided := codexAutomaticApproval("default", other); decided {
		t.Fatal("another Orbit tool's consent was answered in Default")
	}
	if allowed, decided := codexAutomaticApproval("plan", other); !decided || allowed {
		t.Fatalf("another Orbit tool in Plan = %v/%v, want refused", allowed, decided)
	}
	// A tool of that name on somebody else's server is not this gate's.
	foreign := codexApprovalRequest{mcpTool: true, server: "acme", tool: "bg_run"}
	if _, decided := codexAutomaticApproval("default", foreign); decided {
		t.Fatal("another server's bg_run was answered")
	}
	if allowed, decided := codexAutomaticApproval("plan", foreign); !decided || allowed {
		t.Fatalf("another server's bg_run in Plan = %v/%v, want refused", allowed, decided)
	}
}

// Plan means nothing runs without a person: the setting that would hand a command to the classifier stays off,
// in the only settings layer this session's CLI reads for Orbit.
func TestClaudeSettingsTurnThePlanClassifierOff(t *testing.T) {
	path, err := writeClaudeSettings(t.TempDir(), "/usr/local/bin/orbit", false)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	if on, present := settings["useAutoModeDuringPlan"]; !present || on != false {
		t.Fatalf("useAutoModeDuringPlan = %v, %v", on, present)
	}
}
