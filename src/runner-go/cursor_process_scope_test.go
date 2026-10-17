//go:build linux

package main

// The process scope of a Cursor CLI session (session_scope.go, docs/cursor-runtime-contract.md §3.4), run
// on the recorded CLI (fake_cursor_acp_test.go) set to start, as its first prompt arrives, what a
// session's commands leave running (fakeCursorScope): a helper in the CLI's own process group, a command
// detached into a process group and session of its own as Cursor runs every command, a child in that
// command's group, a process the command moved into a session of its own, and a daemon orphaned the moment
// it started. However the session's process ends — Orbit stopping it mid-turn, the session's end, the CLI
// killed, the lease lost, the runner stopping or going away — none of it is left, while another Cursor
// session's processes, a runner-hosted bg_run job and a process tree started the way every other engine
// starts its own run on untouched. The named scenarios here are the ones
// scripts/test-cursor-process-scope.mjs runs.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// cursorScopeMarkerVar marks every process of one test session, or of one neighbour: as a workspace
// variable it reaches the CLI's environment (cursor_launch.go), and every process the CLI starts inherits it.
const cursorScopeMarkerVar = "ORBIT_TEST_PROCESS_SCOPE"

// cursorScopeNewMarker is a marker no other process carries. Under scripts/test-cursor-process-scope.mjs
// it begins with the run's id (ORBIT_TEST_PROCESS_SCOPE_RUN), so the script can look for what the run left.
func cursorScopeNewMarker(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	marker := hex.EncodeToString(b[:])
	if run := os.Getenv("ORBIT_TEST_PROCESS_SCOPE_RUN"); run != "" {
		marker = run + "-" + marker
	}
	return marker
}

// cursorScopeProcess is one process as its /proc/<pid>/stat has it.
type cursorScopeProcess struct {
	pid, ppid, pgid, sid int
	state, comm          string
}

func (p cursorScopeProcess) String() string {
	return fmt.Sprintf("%d %s (ppid %d, pgid %d, sid %d, %s)", p.pid, p.comm, p.ppid, p.pgid, p.sid, p.state)
}

// cursorScopeStat reads one process; ok is false once it is gone.
func cursorScopeStat(pid int) (cursorScopeProcess, bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	open, end := bytes.IndexByte(data, '('), bytes.LastIndexByte(data, ')')
	if err != nil || open < 0 || end < open {
		return cursorScopeProcess{}, false
	}
	fields := strings.Fields(string(data[end+1:])) // state ppid pgrp session …
	if len(fields) < 4 {
		return cursorScopeProcess{}, false
	}
	p := cursorScopeProcess{pid: pid, state: fields[0], comm: string(data[open+1 : end])}
	p.ppid, _ = strconv.Atoi(fields[1])
	p.pgid, _ = strconv.Atoi(fields[2])
	p.sid, _ = strconv.Atoi(fields[3])
	return p, true
}

// cursorScopeLive is whether pid is still running: neither gone nor a zombie.
func cursorScopeLive(pid int) bool {
	p, ok := cursorScopeStat(pid)
	return ok && p.state != "Z" && p.state != "X"
}

// cursorScopeMarked is every process still running whose environment carries marker.
func cursorScopeMarked(marker string) []cursorScopeProcess {
	want := []byte(cursorScopeMarkerVar + "=" + marker)
	entries, _ := os.ReadDir("/proc")
	var marked []cursorScopeProcess
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		environ, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "environ"))
		if err != nil {
			continue
		}
		for _, variable := range bytes.Split(environ, []byte{0}) {
			if bytes.Equal(variable, want) {
				if p, ok := cursorScopeStat(pid); ok && cursorScopeLive(pid) {
					marked = append(marked, p)
				}
				break
			}
		}
	}
	return marked
}

// cursorScopeLeft waits up to within for no process of marker to be running, and returns those that are.
func cursorScopeLeft(marker string, within time.Duration) []cursorScopeProcess {
	deadline := time.Now().Add(within)
	for {
		left := cursorScopeMarked(marker)
		if len(left) == 0 || time.Now().After(deadline) {
			return left
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cursorScopeAwaitFile waits for a file a fake writes once what it started is running.
func cursorScopeAwaitFile(t *testing.T, path string) []byte {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if data, err := os.ReadFile(path); err == nil {
			return data
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was never written", path)
		}
	}
}

// cursorPersonStop is the Stop a person presses in front of a session: an interrupt that also asks for
// the session's background work to stop (RunInterruptRequest.stopBackgroundWork).
func cursorPersonStop(turnID string) RunInboxResponse {
	return RunInboxResponse{TurnID: turnID, Kind: "interrupt", Content: `{"stopBackgroundWork":true}`}
}

// shortCursorStopGrace gives a stopped prompt no more than a moment to be answered.
func shortCursorStopGrace(t *testing.T) {
	t.Helper()
	previous := cursorStopGrace
	cursorStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { cursorStopGrace = previous })
}

// cursorScopeProbe watches one test session's processes: what was running when its end was set off,
// against what is left once that end has come.
type cursorScopeProbe struct {
	marker string
	mu     sync.Mutex
	fake   *cursorReplay
	scope  fakeCursorScope      // what the fake started (scope.json)
	seen   []cursorScopeProcess // the session's processes then, the keeper's and the CLI's among them
	err    error
}

func newCursorScopeProbe(t *testing.T) *cursorScopeProbe {
	return &cursorScopeProbe{marker: cursorScopeNewMarker(t)}
}

// options run a session on recording, its fake set to start its processes at the first prompt (and
// adjusted as script says), its every process marked.
func (p *cursorScopeProbe) options(recording string, script func(*fakeCursorACPScript)) cursorRunOptions {
	return cursorRunOptions{recording: recording,
		env: map[string]string{"CURSOR_API_KEY": cursorTestKey, cursorScopeMarkerVar: p.marker},
		script: func(s *fakeCursorACPScript) {
			s.Spawn = true
			if script != nil {
				script(s)
			}
		},
		replay: func(fake *cursorReplay) {
			p.mu.Lock()
			p.fake = fake
			p.mu.Unlock()
		}}
}

// look records what is running now, with every process the session starts already started.
func (p *cursorScopeProbe) look() {
	p.mu.Lock()
	defer p.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(p.fake.dir, "scope.json"))
	if err == nil {
		err = json.Unmarshal(data, &p.scope)
	}
	p.err, p.seen = err, cursorScopeMarked(p.marker)
}

// fire holds once: the first time when does, after the probe has looked.
func (p *cursorScopeProbe) fire(when func(cursorEvent) bool) func(cursorEvent) bool {
	var once sync.Once
	return func(event cursorEvent) bool {
		fired := false
		if when(event) {
			once.Do(func() {
				p.look()
				fired = true
			})
		}
		return fired
	}
}

// deliver delivers items when fire does.
func (p *cursorScopeProbe) deliver(when func(cursorEvent) bool, items ...RunInboxResponse) func(cursorEvent) []RunInboxResponse {
	fire := p.fire(when)
	return func(event cursorEvent) []RunInboxResponse {
		if fire(event) {
			return items
		}
		return nil
	}
}

func (p *cursorScopeProbe) started() fakeCursorScope {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.scope
}

// assertReclaimed checks that the session's processes were all running when its end was set off — the
// keeper between the runner and the CLI, each process scope.json names where it was meant to be, the
// daemon already the keeper's — and that none of them is left now.
func (p *cursorScopeProbe) assertReclaimed(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	scope, seen, err := p.scope, p.seen, p.err
	p.mu.Unlock()
	if seen == nil || err != nil {
		t.Fatalf("the session's processes were never seen running (scope.json: %v)", err)
	}
	running := map[int]cursorScopeProcess{}
	for _, proc := range seen {
		running[proc.pid] = proc
	}
	cli, ok := running[scope.CLI]
	keeper, kept := running[cli.ppid]
	if !ok || !kept || keeper.ppid != os.Getpid() || cli.pgid != keeper.pid {
		t.Fatalf("no keeper between the runner and the CLI %d: %v", scope.CLI, seen)
	}
	for name, pid := range map[string]int{"helper": scope.Helper, "command": scope.Command, "command's child": scope.CommandChild,
		"escaped process": scope.Escaped, "daemon": scope.Daemon} {
		if _, ok := running[pid]; !ok {
			t.Fatalf("the %s (%d) was not running when the session's end was set off: %v", name, pid, seen)
		}
	}
	if running[scope.Helper].pgid != keeper.pid || running[scope.Command].sid != scope.Command ||
		running[scope.CommandChild].pgid != scope.Command || running[scope.Escaped].sid != scope.Escaped {
		t.Fatalf("the session's processes are not where they were meant to be: %v", seen)
	}
	if daemon := running[scope.Daemon]; daemon.ppid != keeper.pid {
		t.Fatalf("the daemon %v was adopted by %d, not by the session's keeper %d", daemon, daemon.ppid, keeper.pid)
	}
	if left := cursorScopeLeft(p.marker, 5*time.Second); len(left) != 0 {
		t.Fatalf("the session's processes outlived it: %v (running before its end: %v)", left, seen)
	}
}

// cursorScopeACP is a Cursor session's process started as the driver starts one (startCursorACP), its
// turn running on the crash recording — which never answers — with its commands' processes started.
type cursorScopeACP struct {
	app  *cursorACPClient
	fake *cursorReplay
}

func startCursorScopeACP(t *testing.T, sessionID, marker string) *cursorScopeACP {
	t.Helper()
	fake := newCursorReplayScript(t, fakeCursorACPScript{Recording: "crash-recover-and-move/crash", Spawn: true})
	job := &ClaimedSession{SessionID: sessionID, Provider: providerCursor, Agent: AgentExecConfig{Provider: providerCursor,
		Env: map[string]string{"CURSOR_API_KEY": cursorTestKey, cursorScopeMarkerVar: marker}}}
	spec, err := prepareCursorLaunch(job, t.TempDir(), fake.shim, filepath.Join(runDir(sessionID), "cursor"))
	if err != nil {
		t.Fatal(err)
	}
	mapper := newCursorEventMapper(func(string, string, map[string]interface{}) {})
	app, err := startCursorACP(context.Background(), spec, mapper, nil, func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conversation := ""
	if err = app.initialize(ctx); err == nil {
		conversation, err = app.open(ctx, spec.Cwd, []interface{}{})
	}
	if err == nil {
		err = mapper.begin("turn-1")
	}
	if err != nil {
		app.dispose()
		t.Fatal(err)
	}
	go func() {
		_, _ = app.prompt(context.Background(), conversation, []map[string]interface{}{{"type": "text", "text": "run the sleep"}})
	}()
	cursorScopeAwaitFile(t, filepath.Join(fake.dir, "scope.json"))
	return &cursorScopeACP{app: app, fake: fake}
}

// cursorScopeNeighbours are what the end of no Cursor session may touch: another Cursor session holding a
// turn open with its commands running, a runner-hosted bg_run job, and a process tree started as every
// other engine starts its own.
type cursorScopeNeighbours struct {
	bg      *bgTailer
	job     bgJobStatus
	running map[string][]int // which neighbour → the processes its marker was on when it started
	markers map[string]string
}

func startCursorScopeNeighbours(t *testing.T) *cursorScopeNeighbours {
	t.Helper()
	n := &cursorScopeNeighbours{running: map[string][]int{}, markers: map[string]string{}}
	settled := func(name string, enough func([]cursorScopeProcess) bool) {
		t.Helper()
		for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			marked := cursorScopeMarked(n.markers[name])
			if enough(marked) {
				for _, proc := range marked {
					n.running[name] = append(n.running[name], proc.pid)
				}
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("the %s never got going: %v", name, marked)
			}
		}
	}

	n.markers["other Cursor session"] = cursorScopeNewMarker(t)
	other := startCursorScopeACP(t, "41111111-2222-4333-8444-666666666666", n.markers["other Cursor session"])
	t.Cleanup(func() {
		// Its own end reclaims its own scope.
		other.app.dispose()
		if left := cursorScopeLeft(n.markers["other Cursor session"], 5*time.Second); len(left) != 0 {
			t.Errorf("the other Cursor session's processes outlived it: %v", left)
		}
	})
	settled("other Cursor session", func(marked []cursorScopeProcess) bool { return len(marked) == 7 })

	n.markers["bg_run job"] = cursorScopeNewMarker(t)
	n.bg = newBgTailer(context.Background(), (&bgJobEvents{}).emit, nil)
	dir := t.TempDir()
	job, err := n.bg.startJob(bgJobSpec{Command: "sleep 600", Kind: bgKindService, Dir: dir, ScratchDir: dir,
		Description: "a bg_run job beside the Cursor sessions", Env: map[string]string{cursorScopeMarkerVar: n.markers["bg_run job"]}})
	if err != nil {
		t.Fatal(err)
	}
	n.job = job
	t.Cleanup(func() {
		_, _ = n.bg.killJob(job.JobID, bgKillTeardownGrace)
		n.bg.stopAll()
	})
	settled("bg_run job", func(marked []cursorScopeProcess) bool {
		for _, proc := range marked {
			if proc.comm == "sleep" {
				return true
			}
		}
		return false
	})

	n.markers["other engine's process tree"] = cursorScopeNewMarker(t)
	engine := exec.CommandContext(context.Background(), "sh", "-c", "sleep 600 & wait")
	engine.Env = append(os.Environ(), cursorScopeMarkerVar+"="+n.markers["other engine's process tree"])
	configureSessionProcessTree(engine)
	if err := startSessionProcess(engine); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = terminateSessionProcessTree(engine)
		_ = engine.Wait()
	})
	settled("other engine's process tree", func(marked []cursorScopeProcess) bool { return len(marked) == 2 })
	return n
}

// assertUntouched checks that every neighbour's process is still running, still the one it was.
func (n *cursorScopeNeighbours) assertUntouched(t *testing.T) {
	t.Helper()
	for name, pids := range n.running {
		marked := map[int]bool{}
		for _, proc := range cursorScopeMarked(n.markers[name]) {
			marked[proc.pid] = true
		}
		for _, pid := range pids {
			if !marked[pid] {
				t.Errorf("the %s's process %d is gone", name, pid)
			}
		}
	}
	if status, ok := n.bg.jobStatus(n.job.JobID); !ok || status.Status != bgStatusRunning {
		t.Errorf("the bg_run job is %+v, not running", status)
	}
}

// However a Cursor session's process ends, nothing it started is left — and nothing else is touched.
func TestCursorProcessScope(t *testing.T) {
	useCursorRealHome(t)
	neighbours := startCursorScopeNeighbours(t)

	t.Run("stop-mid-turn", func(t *testing.T) {
		// The person's Stop reaches a CLI that no longer answers (§3.3): once the stop's grace has run out
		// the process is ended, and the turn settles interrupted.
		shortCursorStopGrace(t)
		probe := newCursorScopeProbe(t)
		opts := probe.options("cancel-mid-tool/cancel", func(s *fakeCursorACPScript) { s.IgnoreCancel = true })
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.onEvent = probe.deliver(cursorToolStarted("turn-1", "Bash"), cursorPersonStop("stop-1"))
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stInterrupted {
			t.Fatalf("completions = %+v, want the turn interrupted once", run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("stop-engine-mid-turn", func(t *testing.T) {
		// Orbit stops the session's engine mid-turn — what a session cancel or an idle recycle does: its
		// context ends, and the process tree is killed then and there.
		probe := newCursorScopeProbe(t)
		opts := probe.options("crash-recover-and-move/crash", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.stopEngine = probe.fire(cursorToolStarted("turn-1", "Bash"))
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stInterrupted || run.status != stCancelled {
			t.Fatalf("run %s, completions %+v: want the turn interrupted once and the run cancelled", run.status, run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("stop-runner-mid-turn", func(t *testing.T) {
		// The runner stops mid-turn, draining for a restart or an update: the turn is cancelled — Cursor
		// answers, ending its command's process group (§3.3) — and the process is ended with the drain.
		probe := newCursorScopeProbe(t)
		opts := probe.options("cancel-mid-tool/cancel", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.stopRunner = probe.fire(cursorToolStarted("turn-1", "Bash"))
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stInterrupted || run.status != stCancelled {
			t.Fatalf("run %s, completions %+v: want the turn interrupted once and the run cancelled", run.status, run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("answered-stop-then-session-end", func(t *testing.T) {
		// The person's Stop, answered: Cursor ends the command's process group itself (§3.3), and the turn
		// settles interrupted. The process lives on for the next turn, as an interrupt leaves every
		// engine's — and so does what had left the command's group, until the session ends: then none of it
		// is left.
		probe := newCursorScopeProbe(t)
		opts := probe.options("cancel-mid-tool/cancel", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.onEvent = probe.deliver(cursorToolStarted("turn-1", "Bash"), cursorPersonStop("stop-1"))
		afterStop := map[string]bool{}
		opts.then = func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
			if completed != 1 {
				return nil
			}
			scope := probe.started()
			for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline) &&
				(cursorScopeLive(scope.Command) || cursorScopeLive(scope.CommandChild)); {
				time.Sleep(20 * time.Millisecond)
			}
			for name, pid := range map[string]int{"CLI": scope.CLI, "helper": scope.Helper, "command": scope.Command,
				"command's child": scope.CommandChild, "escaped process": scope.Escaped, "daemon": scope.Daemon} {
				afterStop[name] = cursorScopeLive(pid)
			}
			return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
		}
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stInterrupted || !run.ended {
			t.Fatalf("run (%s, ended=%v), completions %+v: want the turn interrupted once, then the session ended", run.status, run.ended, run.completions)
		}
		want := map[string]bool{"CLI": true, "helper": true, "command": false, "command's child": false, "escaped process": true, "daemon": true}
		for name, live := range want {
			if afterStop[name] != live {
				t.Fatalf("after the answered stop: %v, want %v", afterStop, want)
			}
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("session-end-mid-turn", func(t *testing.T) {
		// The session ends mid-turn: its turn is cancelled, and its process ended.
		probe := newCursorScopeProbe(t)
		opts := probe.options("cancel-mid-tool/cancel", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.onEvent = probe.deliver(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "end-session", Kind: "end"})
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stInterrupted || run.status != stSucceeded || !run.ended {
			t.Fatalf("run (%s, ended=%v), completions %+v: want the turn interrupted once and the session ended", run.status, run.ended, run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("session-end-after-turn", func(t *testing.T) {
		// The session ends after a turn that finished with its commands' processes still running.
		probe := newCursorScopeProbe(t)
		opts := probe.options("multi-turn-tools-default/turns", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "first message")}
		opts.then = func(completed int, _ TurnCompleteRequest) []RunInboxResponse {
			if completed != 1 {
				return nil
			}
			probe.look()
			return []RunInboxResponse{{TurnID: "end-session", Kind: "end"}}
		}
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stSucceeded || run.status != stSucceeded || !run.ended {
			t.Fatalf("run (%s, ended=%v), completions %+v: want the turn done, then the session ended", run.status, run.ended, run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("cli-sigkill-mid-turn", func(t *testing.T) {
		// The CLI is SIGKILLed mid-turn, as a crash or the OOM killer kills it: what it ran was orphaned
		// in the scope, not to init (§3.4). The turn fails on the crash, saying how the process ended.
		probe := newCursorScopeProbe(t)
		opts := probe.options("crash-recover-and-move/crash", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		fire := probe.fire(cursorToolStarted("turn-1", "Bash"))
		opts.onEvent = func(event cursorEvent) []RunInboxResponse {
			if fire(event) {
				_ = syscall.Kill(probe.started().CLI, syscall.SIGKILL)
			}
			return nil
		}
		run := runCursorSession(t, opts)
		if turn := run.completionsOf("turn-1"); len(turn) != 1 || turn[0].Status != stFailed ||
			!strings.Contains(turn[0].Error, "exited during this turn (signal: killed)") || run.status != stFailed || !run.ended {
			t.Fatalf("run (%s, ended=%v), completions %+v: want the turn failed once on the kill", run.status, run.ended, run.completions)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("lease-loss-mid-turn", func(t *testing.T) {
		// The lease moves to another owner mid-turn: this runner reports nothing more and ends the process.
		probe := newCursorScopeProbe(t)
		opts := probe.options("crash-recover-and-move/crash", nil)
		opts.first = []RunInboxResponse{cursorMessage("turn-1", "run the sleep")}
		opts.onEvent = probe.deliver(cursorToolStarted("turn-1", "Bash"), RunInboxResponse{TurnID: "lease", Kind: cursorLeaseLost})
		run := runCursorSession(t, opts)
		if run.leaseLost == nil || len(run.completions) != 0 || run.status != stFailed || !run.ended {
			t.Fatalf("lease %v, completions %+v, run (%s, %v): want the lease lost and nothing reported", run.leaseLost, run.completions, run.status, run.ended)
		}
		probe.assertReclaimed(t)
		neighbours.assertUntouched(t)
	})
	t.Run("runner-gone-mid-turn", func(t *testing.T) {
		// The runner dies mid-turn, and its end of the keeper's control socket closes without a word (under
		// systemd, KillMode=mixed then ends the unit's processes anyway): the keeper sends the CLI SIGTERM,
		// as the runner would have, and reclaims the scope after it.
		probe := newCursorScopeProbe(t)
		session := startCursorScopeACP(t, "51111111-2222-4333-8444-666666666666", probe.marker)
		t.Cleanup(session.app.dispose)
		probe.fake = session.fake
		probe.look()
		session.app.scope.close()
		probe.assertReclaimed(t)
		if exit := session.app.awaitExit(5 * time.Second); exit != "exit status 143" {
			t.Fatalf("the CLI ended with %q, want SIGTERM's exit status 143", exit)
		}
		neighbours.assertUntouched(t)
	})
}

// What the scope changes for no other engine: the runner does not make itself a subreaper, so what any
// other engine's processes orphan goes where it always went; a process started the way every other engine
// starts its own is still the runner's own child, leading its own process group, and still ended with its
// group; and only the Cursor driver starts a process in a scope.
func TestSessionProcessScopeOtherEngines(t *testing.T) {
	t.Run("runner-not-a-subreaper", func(t *testing.T) {
		useCursorRealHome(t)
		marker := cursorScopeNewMarker(t)
		session := startCursorScopeACP(t, "61111111-2222-4333-8444-666666666666", marker)
		session.app.dispose()
		if left := cursorScopeLeft(marker, 5*time.Second); len(left) != 0 {
			t.Fatalf("the Cursor session's processes outlived it: %v", left)
		}
		const prGetChildSubreaper = 37
		var subreaper int32
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prGetChildSubreaper, uintptr(unsafe.Pointer(&subreaper)), 0); errno != 0 {
			t.Fatal(errno)
		}
		if subreaper != 0 {
			t.Fatal("the runner made itself a child subreaper: every engine's orphans would come to it")
		}
	})
	t.Run("engine-process-starts-directly", func(t *testing.T) {
		cmd := exec.CommandContext(context.Background(), "sh", "-c", "sleep 600 & wait")
		configureSessionProcessTree(cmd)
		if err := startSessionProcess(cmd); err != nil {
			t.Fatal(err)
		}
		var child cursorScopeProcess
		for deadline := time.Now().Add(10 * time.Second); child.pid == 0; time.Sleep(10 * time.Millisecond) {
			for _, pid := range sessionScopeDescendants(cmd.Process.Pid) {
				child, _ = cursorScopeStat(pid)
			}
			if time.Now().After(deadline) {
				t.Fatal("the shell's child never started")
			}
		}
		shell, _ := cursorScopeStat(cmd.Process.Pid)
		if shell.ppid != os.Getpid() || shell.pgid != shell.pid || shell.comm != "sh" || child.pgid != shell.pid {
			t.Fatalf("shell %v, child %v: want the runner's own child leading its own process group, with no keeper between", shell, child)
		}
		if err := terminateSessionProcessTree(cmd); err != nil {
			t.Fatal(err)
		}
		_ = cmd.Wait()
		for deadline := time.Now().Add(5 * time.Second); cursorScopeLive(child.pid); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("the shell's child %v outlived the process tree's end", child)
			}
		}
	})
	t.Run("scope-only-in-the-cursor-driver", func(t *testing.T) {
		files, err := filepath.Glob("*.go")
		if err != nil {
			t.Fatal(err)
		}
		var callers []string
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			for i, line := range strings.Split(string(data), "\n") {
				if strings.Contains(line, "startInSessionScope(") && !strings.HasPrefix(line, "func startInSessionScope(") {
					callers = append(callers, fmt.Sprintf("%s:%d", file, i+1))
				}
			}
		}
		if len(callers) != 1 || !strings.HasPrefix(callers[0], "cursor_acp.go:") {
			t.Fatalf("startInSessionScope is called from %v, want the Cursor driver alone", callers)
		}
	})
}
