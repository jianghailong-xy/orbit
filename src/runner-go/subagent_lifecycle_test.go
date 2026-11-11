//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The SubAgent lifecycle (docs/subagent-design.md §5.2), each case on the real supervisor (runInteractiveSession)
// against the fake CLI and the stub control plane of session_pool_self_driven_turn_test.go. The parent is the fake
// CLI; the SubAgent's child engine is a scripted `claude` of its own (subagentChildScript), told apart from the
// parent by ORBIT_SUBAGENT_RUN_ID, which only a child engine is started with. It writes the first half of
// half.txt, says so, and then waits for the test to let it finish — so every case has a SubAgent in the middle
// of writing a file.

// subagentChildScript is the child engine: one prompt in, a Write of half.txt reported and half-done, then the
// rest once $SUBAGENT_MARKS/finish exists. SUBAGENT_IGNORE_INT makes it ignore the stop's SIGINT, so only the
// kill after the grace ends it.
const subagentChildScript = `#!/bin/sh
[ -n "$SUBAGENT_IGNORE_INT" ] && trap '' INT
read -r frame
printf '%s' "$frame" > "$SUBAGENT_MARKS/frame"
printf '%s\n' "$@" > "$SUBAGENT_MARKS/argv"
echo "$$" > "$SUBAGENT_MARKS/pid"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"child"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w","name":"Write","input":{"file_path":"half.txt","content":"first half second half"}}]}}'
printf 'first half' > half.txt
# What a Bash call of the child writes: no tool event names it.
mkdir -p gen && printf 'generated\n' > gen/bash-gen.txt
touch "$SUBAGENT_MARKS/started"
while [ ! -f "$SUBAGENT_MARKS/finish" ]; do sleep 0.05; done
printf ' second half\n' >> half.txt
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"written"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"half.txt is written","total_cost_usd":0.01}'
`

// subagentRig is a supervised parent with the scripted child engine installed ahead of the fake on PATH.
type subagentRig struct {
	*supervisedSession
	marks string
}

// installSubagentChild puts the child engine on PATH. Called once the parent's engine has started, so the parent
// keeps the fake CLI the harness spawned it as; every later `claude` goes through the wrapper, which hands
// anything but a child engine to the fake.
func installSubagentChild(t *testing.T, s *supervisedSession) *subagentRig {
	t.Helper()
	bin, marks := t.TempDir(), t.TempDir()
	child := filepath.Join(bin, "subagent-child.sh")
	if err := os.WriteFile(child, []byte(subagentChildScript), 0o755); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nif [ -n \"$" + envSubagentRunID + "\" ]; then exec /bin/sh " + child + " \"$@\"; fi\nexec " +
		filepath.Join(s.fake.Dir, "claude") + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SUBAGENT_MARKS", marks)
	return &subagentRig{supervisedSession: s, marks: marks}
}

// call is one exchange on the session's job socket, as `orbit mcp` makes it.
func (r *subagentRig) call(op string, args map[string]interface{}) subagentReport {
	r.t.Helper()
	waitUntil(r.t, func() bool { _, err := os.Stat(bgTokenPath(r.job.SessionID)); return err == nil },
		"the session's job socket never came up")
	token, err := os.ReadFile(bgTokenPath(r.job.SessionID))
	if err != nil {
		r.t.Fatalf("the session's job socket has no token: %v", err)
	}
	raw, err := bgSocketCall(bgSocketPath(r.job.SessionID), string(token), op, args)
	if err != nil {
		r.t.Fatalf("%s: %v", op, err)
	}
	var report subagentReport
	if err := json.Unmarshal(raw, &report); err != nil {
		r.t.Fatalf("%s answered %s", op, raw)
	}
	return report
}

// delegate starts a SubAgent the way the delegate tool does, and waits until it is half-way through half.txt.
func (r *subagentRig) delegate(background bool) subagentReport {
	r.t.Helper()
	report := r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "write the half file", "prompt": "write half.txt",
		"background": background,
	})
	if report.Status != subagentStatusRunning {
		r.t.Fatalf("the SubAgent started as %+v", report)
	}
	waitUntil(r.t, func() bool { _, err := os.Stat(filepath.Join(r.marks, "started")); return err == nil },
		"the SubAgent's child engine never started writing")
	return report
}

func (r *subagentRig) finishChild() {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.marks, "finish"), nil, 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// reports is what the runner told the control plane about its SubAgents, in order.
func (r *subagentRig) reports() []map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]interface{}(nil), r.subagentReports...)
}

func (r *subagentRig) awaitReport(status string) map[string]interface{} {
	r.t.Helper()
	var found map[string]interface{}
	waitUntil(r.t, func() bool {
		for _, report := range r.reports() {
			if report["status"] == status {
				found = report
				return true
			}
		}
		return false
	}, "the runner never reported a SubAgent "+status)
	return found
}

// pathIndex is where in the runner's requests the first one ending in suffix came, or -1.
func (r *subagentRig) pathIndex(suffix string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, path := range r.paths {
		if strings.HasSuffix(path, suffix) {
			return i
		}
	}
	return -1
}

func childAlive(t *testing.T, marks string) bool {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(marks, "pid"))
	if err != nil {
		return false
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

// oneTurn is a parent turn that ends, leaving its engine resident and idle.
func oneTurn() []fakeStep {
	return []fakeStep{
		{Await: "user"},
		{Emit: "replay_user"},
		{Emit: "system_init"},
		{Emit: "assistant", Text: "handed the half file to a SubAgent"},
		{Emit: "result", Text: "handed the half file to a SubAgent"},
	}
}

// Case 1: the parent's turn ends while a background SubAgent runs. The session stays up — the supervisor, its job
// socket and the child engine all go on — and when the SubAgent ends, the runner reports it with the wake owed,
// for the server to file (`<orbit-subagent-finished>`, subagent-wake.ts), and clears the delegate call from the
// session's running SubAgents with its terminal background_task.
func TestSubagentBackgroundRunOutlivesTheTurnAndOwesTheWake(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	run := r.delegate(true)

	// The turn is over; the SubAgent is not.
	if !childAlive(t, r.marks) {
		t.Fatal("the SubAgent's child engine is not running after the parent's turn ended")
	}
	if len(r.reports()) != 0 {
		t.Fatalf("the SubAgent was reported ended while it ran: %v", r.reports())
	}

	r.finishChild()
	done := r.awaitReport(subagentStatusDone)
	if done["runId"] != run.RunID || done["wake"] != true || !strings.Contains(asString(done["resultSummary"]), "half.txt is written") {
		t.Fatalf("the end was reported as %v, want run %s DONE with its result and the wake owed", done, run.RunID)
	}
	r.awaitEvents("the delegate call's terminal background_task", 1, func(e RunEvent) bool {
		return e.Type == evBackgroundTask && e.Payload["toolUseId"] == "toolu_delegate" && e.Payload["status"] == bgStatusCompleted &&
			e.Payload["subagentRunId"] == run.RunID
	})
	if r.requested("/background-wake") {
		t.Fatal("the runner sent a bg_run wake for the SubAgent: the server files a SubAgent's own")
	}
}

// The preamble reaches the child once: in its appended system prompt, before the definition's body, and not
// again at the head of the prompt it is handed.
func TestSubagentPreambleReachesTheChildOnce(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)
	r.finishChild()
	r.awaitReport(subagentStatusDone)

	argv, err := os.ReadFile(filepath.Join(r.marks, "argv"))
	if err != nil {
		t.Fatal(err)
	}
	frame, err := os.ReadFile(filepath.Join(r.marks, "frame"))
	if err != nil {
		t.Fatal(err)
	}
	head := subagentPreamble[:40]
	if n := strings.Count(string(argv), head); n != 1 {
		t.Errorf("the preamble is in the child's argv %d times, want once:\n%s", n, argv)
	}
	if strings.Contains(string(frame), head) {
		t.Errorf("the preamble is also prepended to the child's prompt: %s", frame)
	}
	if !strings.Contains(string(frame), "write half.txt") {
		t.Errorf("the child was not handed the bare prompt: %s", frame)
	}
}

// Case 2: the idle park waits for a running SubAgent. The warm TTL comes and goes with the SubAgent half-way
// through half.txt and the engine stays — nothing is parked and nothing committed — and once the SubAgent has
// ended the next TTL parks the engine as usual.
func TestSubagentRunningDefersTheIdlePark(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSessionInWorktree(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)

	clock.Advance(warmEngineTTL + time.Second)
	if recycleRequested(pool, s.live) {
		t.Fatal("the warm TTL parked the engine while its SubAgent was writing")
	}
	clock.Advance(warmEngineTTL)
	if recycleRequested(pool, s.live) {
		t.Fatal("a second TTL parked the engine while its SubAgent was writing")
	}
	if out := mustGit(t, s.execDir, "log", "--all", "--format=%H %s", "--", "half.txt"); strings.TrimSpace(out) != "" {
		t.Fatalf("a commit holds the half-written file: %s", out)
	}
	if out := mustGit(t, s.execDir, "log", "--all", "--grep", parkCheckpointTrailer, "--format=%H"); strings.TrimSpace(out) != "" {
		t.Fatalf("a park checkpoint was committed while the SubAgent ran: %s", out)
	}

	r.finishChild()
	r.awaitReport(subagentStatusDone)
	waitUntil(t, func() bool { return !subagentRunningOf(pool, s.live) }, "the SubAgent never stopped counting as running")
	clock.Advance(warmEngineTTL + time.Second)
	if !recycleRequested(pool, s.live) {
		t.Fatal("the engine was not parked at its TTL once the SubAgent had ended")
	}
}

func subagentRunningOf(p *sessionPool, s *liveSession) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return subagentRunningLocked(s)
}

// Case 3: the parent ends while its SubAgent is half-way through half.txt and ignores the stop's SIGINT. The
// SubAgent is given the grace, killed, and reported STOPPED before the session's finalize runs; the finalize
// commit (a park checkpoint, for this resumable end) holds the parent's own work and not half.txt, which stays in
// the working tree, uncommitted.
func TestSubagentStoppedBeforeFinalizeAndItsFileNotCommitted(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })
	t.Setenv("SUBAGENT_IGNORE_INT", "1")

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSessionInWorktree(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	if err := os.WriteFile(filepath.Join(s.execDir, "parent.txt"), []byte("the parent's own work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := installSubagentChild(t, s)
	r.delegate(true)

	s.live.cancel() // the session ends
	stopped := r.awaitReport(subagentStatusStopped)
	if stopped["wake"] == true {
		t.Fatalf("a SubAgent stopped with its session owes a wake: %v", stopped)
	}
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	if stop, finalize := r.pathIndex("/subagents/run-1"), r.pathIndex("/finalize"); stop < 0 || stop > finalize {
		t.Fatalf("the SubAgent was reported at request %d and the session finalized at %d: the stop must come first", stop, finalize)
	}
	if childAlive(t, r.marks) {
		t.Fatal("the SubAgent's child engine outlived the stop")
	}

	committed := mustGit(t, s.execDir, "log", "--all", "--name-only", "--format=")
	if !strings.Contains(committed, "parent.txt") {
		t.Fatalf("the finalize commit does not hold the parent's own work; committed files:\n%s", committed)
	}
	if strings.Contains(committed, "half.txt") || strings.Contains(committed, "bash-gen.txt") {
		t.Fatalf("a commit holds a file the stopped SubAgent was writing:\n%s", committed)
	}
	if raw, err := os.ReadFile(filepath.Join(s.execDir, "half.txt")); err != nil || string(raw) != "first half" {
		t.Fatalf("half.txt in the working tree = %q, %v: it stays there, uncommitted", raw, err)
	}
}

// Case 4: the runner stops — a restart or an update — with a SubAgent running. The child engine ends with it, the
// run is reported INTERRUPTED with the runner's stop as its reason, and the wake is owed, so the server wakes the
// parent with it.
func TestSubagentInterruptedByRunnerStopOwesTheWake(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	s := superviseClaudeSessionUntil(t, pool, t.TempDir(), shutdown, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)

	stop() // the runner begins to stop
	interrupted := r.awaitReport(subagentStatusInterrupted)
	if interrupted["wake"] != true || !strings.Contains(asString(interrupted["resultSummary"]), "runner process hosting it stopped") {
		t.Fatalf("the interruption was reported as %v, want the wake owed and the runner's stop named", interrupted)
	}
	waitUntil(t, func() bool { return !childAlive(t, r.marks) }, "the SubAgent's child engine outlived the runner's stop")
}

// Case 6, the runner's half: a foreground delegate call that runs out of time stops waiting (subagent_detach),
// and the runner records that on the server at once — a RUNNING report with the wake owed — so the wake survives
// whatever happens to this runner next. Then the runner restarts: the run is reported INTERRUPTED, still owing it.
func TestSubagentForegroundDetachRecordsTheWakeOnTheServer(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	s := superviseClaudeSessionUntil(t, pool, t.TempDir(), shutdown, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	run := r.delegate(false)

	if detached := r.call("subagent_detach", map[string]interface{}{"runId": run.RunID}); detached.Status != subagentStatusRunning {
		t.Fatalf("detach answered %+v for a run still going", detached)
	}
	held := r.awaitReport(subagentStatusRunning)
	if held["wake"] != true || held["runId"] != run.RunID {
		t.Fatalf("the detach was recorded as %v, want run %s RUNNING with the wake owed", held, run.RunID)
	}

	stop()
	if interrupted := r.awaitReport(subagentStatusInterrupted); interrupted["wake"] != true {
		t.Fatalf("the detached run's interruption does not owe the wake: %v", interrupted)
	}
}

// Point 1 of the review: a file a stopped SubAgent wrote through Bash — no tool event names it — is held out of the
// finalize commit like the one its Write tool named, and the run's result lists both; a file the parent's own Write
// tool wrote while the SubAgent ran is the parent's, and is committed.
func TestSubagentBashWriteHeldParentEditCommitted(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSessionInWorktree(t, pool, append(oneTurn(),
		// A second turn in which the parent's own Write tool writes parent-edit.txt while the SubAgent runs.
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_parent_write", ToolName: "Write",
			Input: map[string]interface{}{"file_path": "parent-edit.txt", "content": "the parent's edit\n"}},
		fakeStep{Await: "release", Text: "written"},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_parent_write", Text: "written"},
		fakeStep{Emit: "result", Text: "edited while the SubAgent works"},
	)...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)

	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("the claim for turn-2 could not activate the session")
	}
	s.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "edit parent-edit.txt"})
	s.awaitEvents("the parent's Write", 1, isToolUse("toolu_parent_write"))
	if err := os.WriteFile(filepath.Join(s.execDir, "parent-edit.txt"), []byte("the parent's edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.fake.Release("written")
	s.awaitParked("turn-2")

	s.live.cancel() // the session ends with the SubAgent still running
	stopped := r.awaitReport(subagentStatusStopped)
	const want = "Left uncommitted because SubAgent run-1 was stopped while they changed: gen/bash-gen.txt, half.txt"
	if !strings.Contains(asString(stopped["resultSummary"]), want) {
		t.Fatalf("the stopped run's result = %q, want it to say %q", stopped["resultSummary"], want)
	}
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")

	committed := mustGit(t, s.execDir, "log", "--all", "--name-only", "--format=")
	if !strings.Contains(committed, "parent-edit.txt") {
		t.Fatalf("the parent's own edit is not committed; committed files:\n%s", committed)
	}
	if strings.Contains(committed, "bash-gen.txt") || strings.Contains(committed, "half.txt") {
		t.Fatalf("a commit holds a file the stopped SubAgent was writing:\n%s", committed)
	}
	if raw, err := os.ReadFile(filepath.Join(s.execDir, "gen", "bash-gen.txt")); err != nil || string(raw) != "generated\n" {
		t.Fatalf("gen/bash-gen.txt in the working tree = %q, %v: it stays there, uncommitted", raw, err)
	}
	if status := mustGit(t, s.execDir, "status", "--porcelain", "--untracked-files=all"); !strings.Contains(status, "gen/bash-gen.txt") {
		t.Fatalf("gen/bash-gen.txt is not left uncommitted: %q", status)
	}
}

// Point 2 of the review: the parent's engine is rebuilt in place (a reload here; a crash respawn says the same
// `resumed`), and the control plane empties the session's running SubAgents on that handshake. The runner
// announces each SubAgent still running again, after the handshake, so the session goes on reading as working;
// and a foreground call that was the replaced engine's is gone, so the run's end is now owed as a wake.
func TestSubagentReannouncedAfterTheParentEngineResumes(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	run := r.delegate(false)

	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("the claim could not activate the parked session")
	}
	s.queue(RunInboxResponse{TurnID: "reload-1", Kind: "reload", Content: `{"fastMode":true}`})
	s.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "carry on"})
	s.awaitParked("turn-2")

	resumedSeq := -1
	for _, e := range s.eventsOf(func(e RunEvent) bool { return e.Type == evSystem && e.Payload["subtype"] == "resumed" }) {
		resumedSeq = e.Seq
		break
	}
	if resumedSeq < 0 {
		t.Fatal("the rebuild was not marked by a resumed handshake, so nothing here is tested")
	}
	again := s.eventsOf(func(e RunEvent) bool {
		return e.Seq > resumedSeq && e.Type == evBackgroundTask && e.Payload["status"] == "running" &&
			e.Payload["subagentRunId"] == run.RunID && e.Payload["toolUseId"] == "toolu_delegate"
	})
	if len(again) != 1 {
		t.Fatalf("the running SubAgent was announced %d times after the handshake, want once", len(again))
	}
	if !childAlive(t, r.marks) {
		t.Fatal("the SubAgent did not outlive the parent's engine")
	}
	held := r.awaitReport(subagentStatusRunning)
	if held["wake"] != true || held["runId"] != run.RunID {
		t.Fatalf("the foreground run whose call went with the engine was recorded as %v, want RUNNING owing a wake", held)
	}

	r.finishChild()
	if done := r.awaitReport(subagentStatusDone); done["wake"] != true {
		t.Fatalf("the run's end does not owe the wake: %v", done)
	}
}

// Point 3 of the review: the session moves to another runner process (this supervisor loses its ownership).
// Its SubAgent is stopped, reported STOPPED with the reason and the wake owed, so the parent is woken in its
// new home.
func TestSubagentStoppedByAHandoffOwesTheWake(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)

	if _, ok := pool.detachForTakeover(s.job.SessionID); !ok {
		t.Fatal("the supervisor could not be detached for a takeover")
	}
	stopped := r.awaitReport(subagentStatusStopped)
	if stopped["wake"] != true || !strings.Contains(asString(stopped["resultSummary"]), "stopped when this session moved to another runner process") {
		t.Fatalf("the handoff's stop was reported as %v, want STOPPED with the reason and the wake owed", stopped)
	}
	waitUntil(t, func() bool { return !childAlive(t, r.marks) }, "the SubAgent's child engine outlived the handoff")
}
