package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// swapPoolSession is one Orbit session of the relay tests: registered in the pool on a folder, with a
// conversation in that folder and the record a run leaves.
type swapPoolSession struct {
	id      string
	live    *liveSession
	stopped chan struct{} // closed when its engine has been stopped
	execDir string
}

func startSwapPoolSession(t *testing.T, p *sessionPool, id, configDir string, active bool) *swapPoolSession {
	t.Helper()
	job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude, Agent: AgentExecConfig{Provider: providerClaude, Env: map[string]string{}}}
	if configDir != "" {
		job.Agent.Env["CLAUDE_CONFIG_DIR"] = configDir
	}
	s, added := p.register(job, func() {}, true)
	if !added {
		t.Fatalf("%s not registered", id)
	}
	ss := &swapPoolSession{id: id, live: s, stopped: make(chan struct{}), execDir: t.TempDir()}
	gen, _, ok := p.reserveEngine(s, context.Background(), context.Background())
	if !ok {
		t.Fatalf("no engine for %s", id)
	}
	var once sync.Once
	// The engine's process ends shortly after it is cancelled, as a real one does.
	stop := func() {
		once.Do(func() {
			go func() {
				time.Sleep(10 * time.Millisecond)
				p.engineStopped(s, gen)
				close(ss.stopped)
			}()
		})
	}
	if p.engineStarted(s, gen, stop) {
		stop()
	}
	// Its run so far: the record and a conversation in the folder it runs in.
	scratch := runDir(id)
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	writeClaudeSessionMeta(scratch, job, ss.execDir)
	base := configDir
	if base == "" {
		base, _ = effectiveClaudeConfigDir(os.Environ(), "")
	}
	path, err := claudeTranscriptPathIn(base, ss.execDir, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(swapTranscript(id)), 0o600); err != nil {
		t.Fatal(err)
	}
	if !active {
		p.park(s, p.permitGeneration(s))
	}
	return ss
}

func swapTranscript(id string) string {
	return `{"type":"user","timestamp":"2026-11-17T01:00:00Z","message":{"role":"user","content":"remember the word heron (` + id + `)"}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-11-17T01:00:05Z","message":{"role":"assistant","content":"heron"}}` + "\n"
}

func (ss *swapPoolSession) engineStopped() bool {
	select {
	case <-ss.stopped:
		return true
	default:
		return false
	}
}

type swapResults struct {
	mu  sync.Mutex
	all []ClaudeAccountSwapResult
	ch  chan ClaudeAccountSwapResult
}

func newSwapResults() *swapResults { return &swapResults{ch: make(chan ClaudeAccountSwapResult, 64)} }

func (r *swapResults) post(res ClaudeAccountSwapResult) error {
	r.mu.Lock()
	r.all = append(r.all, res)
	r.mu.Unlock()
	r.ch <- res
	return nil
}

func (r *swapResults) next(t *testing.T, status string) ClaudeAccountSwapResult {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case res := <-r.ch:
			if res.Status == status {
				return res
			}
		case <-deadline:
			t.Fatalf("no %s result; results so far: %+v", status, r.all)
		}
	}
}

func newTestSwapRelay(t *testing.T, p *sessionPool, f *claudeSwapFixture, results *swapResults, configure func(*claudeLoginSwap)) (*claudeAccountSwapRelay, *atomic.Int32) {
	ended := new(atomic.Int32)
	r := newClaudeAccountSwapRelay(p, results.post, func() { ended.Add(1) })
	r.folders = func(string) (claudeLoginFolder, claudeLoginFolder, error) { return f.def, f.acct, nil }
	r.newSwap = func(claudeLoginFolder, claudeLoginFolder, string) claudeSwapRunner {
		s := f.swap(t)
		if configure != nil {
			configure(s)
		}
		return s
	}
	r.processes = func([]string) ([]ClaudeSwapProcess, int) { return nil, 0 }
	r.poll = 20 * time.Millisecond
	return r, ended
}

func waitHeld(t *testing.T, p *sessionPool, s *liveSession) chan bool {
	t.Helper()
	started := make(chan bool, 1)
	go func() { started <- p.waitActive(s, context.Background(), context.Background()) }()
	select {
	case <-started:
		t.Fatalf("a turn of %s started during the swap", s.id)
	case <-time.After(50 * time.Millisecond):
	}
	return started
}

// The whole swap on a busy machine: an idle and a mid-turn session on each account, and one on a third
// account the swap does not concern. The idle engines on both folders stop at once; the swap waits for
// the two turns and says so; a message for an idle session and a follow-up for a busy one are held; then
// the logins swap, every session on the two folders is pointed at its account's new folder with its
// conversation there, and the held turns start.
func TestClaudeAccountSwapQuietsBothFoldersSwapsAndReleasesHeldTurns(t *testing.T) {
	f := newClaudeSwapFixture(t)
	other, err := claudeAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	p := newSessionPool(8)
	idleDef := startSwapPoolSession(t, p, "0a000000-0000-4000-8000-000000000001", "", false)
	busyDef := startSwapPoolSession(t, p, "0a000000-0000-4000-8000-000000000002", "", true)
	idleAcct := startSwapPoolSession(t, p, "0a000000-0000-4000-8000-000000000003", f.acct.dir, false)
	busyAcct := startSwapPoolSession(t, p, "0a000000-0000-4000-8000-000000000004", f.acct.dir, true)
	bystander := startSwapPoolSession(t, p, "0a000000-0000-4000-8000-000000000005", other.Dir, false)

	results := newSwapResults()
	relay, ended := newTestSwapRelay(t, p, f, results, nil)
	cmd := ClaudeAccountSwapCommand{Account: filepath.Base(f.acct.dir), Attempt: "2026-11-17T03:00:00.000Z",
		Expect: &ClaudeAccountSwapExpect{DefaultAccountUUID: "uuid-default", AccountAccountUUID: "uuid-work"}}
	relay.handle(cmd)

	pending := results.next(t, "pending")
	if want := []string{busyDef.id, busyAcct.id}; !reflect.DeepEqual(pending.WaitingOn, want) {
		t.Fatalf("pending waits on %v, want the two mid-turn sessions %v", pending.WaitingOn, want)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !(idleDef.engineStopped() && idleAcct.engineStopped()) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !idleDef.engineStopped() || !idleAcct.engineStopped() {
		t.Fatal("the idle engines on the two folders were not stopped at once")
	}
	if busyDef.engineStopped() || busyAcct.engineStopped() {
		t.Fatal("an engine with a turn running was stopped")
	}
	// A redelivery while it waits says the same.
	relay.handle(cmd)
	if again := results.next(t, "pending"); !reflect.DeepEqual(again.WaitingOn, pending.WaitingOn) {
		t.Fatalf("redelivered pending = %+v", again)
	}
	// A message arrives for the idle session on Default: its claim lands, its turn is held.
	idleDefJob := *p.latestJob(idleDef.live)
	if _, ok := p.activate(&idleDefJob); !ok {
		t.Fatal("claim refused")
	}
	heldIdle := waitHeld(t, p, idleDef.live)

	// The mid-turn session on the account ends its turn and the control plane hands its permit to a
	// queued follow-up: held, and no longer waited on; its engine stops.
	heldFollowUp := waitHeld(t, p, busyAcct.live)
	// A claim counts as a turn only until its turn is held, so the reports converge on the one turn
	// still running.
	for res := results.next(t, "pending"); !reflect.DeepEqual(res.WaitingOn, []string{busyDef.id}); res = results.next(t, "pending") {
		t.Logf("pending on %v", res.WaitingOn)
	}
	// The mid-turn session on Default ends its turn and parks.
	p.park(busyDef.live, p.permitGeneration(busyDef.live))

	done := results.next(t, "done")
	if done.Now == nil || done.Now.DefaultAccountUUID != "uuid-work" || done.Now.AccountAccountUUID != "uuid-default" || done.Message != "" {
		t.Fatalf("done = %+v", done)
	}
	for _, ss := range []*swapPoolSession{idleDef, busyDef, idleAcct, busyAcct} {
		if !ss.engineStopped() {
			t.Errorf("%s's engine spanned the swap", ss.id)
		}
	}
	if bystander.engineStopped() {
		t.Error("the engine on a third account was stopped")
	}
	for _, held := range []chan bool{heldIdle, heldFollowUp} {
		select {
		case ok := <-held:
			if !ok {
				t.Fatal("a held turn was dropped")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a held turn was not released after the swap")
		}
	}
	for deadline := time.Now().Add(2 * time.Second); ended.Load() == 0 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if got := ended.Load(); got != 1 {
		t.Errorf("engine re-probe after the swap ran %d times, want 1", got)
	}

	// Each session is on its account's new folder, with its conversation there for the next turn's --resume.
	for _, c := range []struct {
		ss      *swapPoolSession
		wantDir string // "" = Default
		newBase string
	}{
		{idleDef, f.acct.dir, f.acct.dir},
		{busyDef, f.acct.dir, f.acct.dir},
		{idleAcct, "", f.def.dir},
		{busyAcct, "", f.def.dir},
	} {
		job := p.latestJob(c.ss.live)
		if got := job.Agent.Env["CLAUDE_CONFIG_DIR"]; got != c.wantDir {
			t.Errorf("%s now runs with CLAUDE_CONFIG_DIR=%q, want %q", c.ss.id, got, c.wantDir)
		}
		path, _ := claudeTranscriptPathIn(c.newBase, c.ss.execDir, c.ss.id)
		if b, err := os.ReadFile(path); err != nil || string(b) != swapTranscript(c.ss.id) {
			t.Errorf("%s's conversation in its account's new folder: %q, %v", c.ss.id, b, err)
		}
		meta := readSessionMeta(filepath.Join(runDir(c.ss.id), "meta.json"))
		if meta == nil || meta.ClaudeConfigDir != c.wantDir {
			t.Errorf("%s's record names %+v, want %q", c.ss.id, meta, c.wantDir)
		}
	}
	if got := p.latestJob(bystander.live).Agent.Env["CLAUDE_CONFIG_DIR"]; got != other.Dir {
		t.Errorf("the session on a third account moved to %q", got)
	}
	// A redelivery of the finished swap reports done again and swaps nothing back.
	before := f.read(t)
	relay.handle(cmd)
	if again := results.next(t, "done"); !reflect.DeepEqual(again, done) {
		t.Fatalf("redelivered done = %+v", again)
	}
	if !reflect.DeepEqual(f.read(t), before) {
		t.Fatal("a redelivered swap changed the logins")
	}
}

// A swap that fails reports failed with its reason, leaves both logins and every session where they
// were, and still releases the turns it held.
func TestClaudeAccountSwapThatFailsReportsWhyAndReleasesHeldTurns(t *testing.T) {
	f := newClaudeSwapFixture(t)
	p := newSessionPool(4)
	idleDef := startSwapPoolSession(t, p, "0b000000-0000-4000-8000-000000000001", "", false)
	busyAcct := startSwapPoolSession(t, p, "0b000000-0000-4000-8000-000000000002", f.acct.dir, true)
	results := newSwapResults()
	// The swap pauses inside its oauthAccount step until the test has seen the turn held: a failure
	// rolls back and releases within milliseconds, faster than waitHeld's window.
	reached, proceed := make(chan struct{}), make(chan struct{})
	relay, _ := newTestSwapRelay(t, p, f, results, func(s *claudeLoginSwap) {
		s.after = func(step string) error {
			if step == claudeSwapStepOAuthAccount {
				close(reached)
				<-proceed
				return context.DeadlineExceeded
			}
			return nil
		}
	})
	relay.handle(ClaudeAccountSwapCommand{Account: filepath.Base(f.acct.dir), Attempt: "a1"})
	results.next(t, "pending")
	held := make(chan bool, 1)
	go func() { held <- p.waitActive(busyAcct.live, context.Background(), context.Background()) }()
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the swap never reached its oauthAccount step")
	}
	select {
	case <-held:
		t.Fatalf("a turn of %s started during the swap", busyAcct.id)
	case <-time.After(50 * time.Millisecond):
	}
	close(proceed)
	failed := results.next(t, "failed")
	if failed.Message != "Rolled back: context deadline exceeded — both logins are as they were." {
		t.Fatalf("failed = %+v", failed)
	}
	f.assertOriginal(t, "after a failed swap")
	select {
	case ok := <-held:
		if !ok {
			t.Fatal("held turn dropped")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("held turn not released after a failed swap")
	}
	if got := p.latestJob(busyAcct.live).Agent.Env["CLAUDE_CONFIG_DIR"]; got != f.acct.dir {
		t.Errorf("after a failed swap the session runs in %q, want its own folder", got)
	}
	if _, has := p.latestJob(idleDef.live).Agent.Env["CLAUDE_CONFIG_DIR"]; has {
		t.Error("after a failed swap the session on Default was moved")
	}
}

// The swap waits for a Claude process on either folder that is not Orbit's, and names it.
func TestClaudeAccountSwapWaitsForATerminalClaude(t *testing.T) {
	f := newClaudeSwapFixture(t)
	p := newSessionPool(2)
	results := newSwapResults()
	relay, _ := newTestSwapRelay(t, p, f, results, nil)
	var mu sync.Mutex
	running := true
	relay.processes = func([]string) ([]ClaudeSwapProcess, int) {
		mu.Lock()
		defer mu.Unlock()
		if running {
			return []ClaudeSwapProcess{{PID: 4242, Command: "claude"}}, 0
		}
		return nil, 0
	}
	relay.handle(ClaudeAccountSwapCommand{Account: filepath.Base(f.acct.dir), Attempt: "a2"})
	pending := results.next(t, "pending")
	if len(pending.WaitingOn) != 0 || !reflect.DeepEqual(pending.ForeignProcesses, []ClaudeSwapProcess{{PID: 4242, Command: "claude"}}) {
		t.Fatalf("pending = %+v", pending)
	}
	f.assertOriginal(t, "while a terminal claude runs")
	mu.Lock()
	running = false
	mu.Unlock()
	results.next(t, "done")
}

// Folders already exchanged as the command expects them after the swap — a runner restarted after it
// swapped — report done without swapping back; folders matching neither are refused.
func TestClaudeAccountSwapRedeliveredAfterARestartReportsDone(t *testing.T) {
	f := newClaudeSwapFixture(t)
	if out := f.swap(t).run(context.Background()); !out.ok {
		t.Fatal(out.message)
	}
	swapped := f.read(t)
	p := newSessionPool(2)
	results := newSwapResults()
	relay, _ := newTestSwapRelay(t, p, f, results, nil)
	relay.handle(ClaudeAccountSwapCommand{Account: filepath.Base(f.acct.dir), Attempt: "a3",
		Expect: &ClaudeAccountSwapExpect{DefaultAccountUUID: "uuid-default", AccountAccountUUID: "uuid-work"}})
	if done := results.next(t, "done"); done.Now == nil || done.Now.DefaultAccountUUID != "uuid-work" {
		t.Fatalf("done = %+v", done)
	}
	if !reflect.DeepEqual(f.read(t), swapped) {
		t.Fatal("the logins were swapped back")
	}
	relay2, _ := newTestSwapRelay(t, p, f, results, nil)
	relay2.handle(ClaudeAccountSwapCommand{Account: filepath.Base(f.acct.dir), Attempt: "a4",
		Expect: &ClaudeAccountSwapExpect{DefaultAccountUUID: "uuid-x", AccountAccountUUID: "uuid-y"}})
	if failed := results.next(t, "failed"); failed.Message == "" {
		t.Fatalf("failed = %+v", failed)
	}
}

// On Linux the scan finds a `claude` running on one of the folders by its environment: one this runner
// started counts as its own, one it did not (re-parented away, as a terminal's is) as foreign.
func TestClaudeProcessesOnFindsClaudesOnTheFolders(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	bin, dir, elsewhere := t.TempDir(), t.TempDir(), t.TempDir()
	script := filepath.Join(bin, "claude")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nwhile :; do sleep 1; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	start := func(configDir string, detach bool) {
		cmd := exec.Command(script)
		if detach {
			// The subshell exits at once, so the claude it started is nobody's child here.
			cmd = exec.Command("/bin/sh", "-c", script+" >/dev/null 2>&1 &")
		}
		cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+configDir)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if !detach {
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			return
		}
		_ = cmd.Wait()
	}
	start(dir, false)
	start(elsewhere, false)
	start(dir, true)
	t.Cleanup(func() {
		foreign, _ := claudeProcessesOn([]string{dir})
		for _, p := range foreign {
			if proc, err := os.FindProcess(p.PID); err == nil {
				_ = proc.Kill()
			}
		}
	})
	var foreign []ClaudeSwapProcess
	own := 0
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if foreign, own = claudeProcessesOn([]string{dir}); len(foreign) == 1 && own == 1 {
			break
		}
	}
	if len(foreign) != 1 || foreign[0].Command != "claude" || own != 1 {
		t.Fatalf("on the folder: foreign %+v, own %d; want one of each", foreign, own)
	}
}

// The macOS scan, fed what ps prints there: a terminal claude on Default (no CLAUDE_CONFIG_DIR, so
// $HOME/.claude), node running claude-code on the added folder under this runner, a claude on a third
// folder, another user's claude whose environment ps does not show, and a process that is not Claude.
func TestClaudeProcessesOnDarwinReadsPS(t *testing.T) {
	const self = 500
	home := "/Users/me"
	def, added, other := home+"/.claude", home+"/.orbit/claude-accounts/1e84046c", home+"/.orbit/claude-accounts/9a9a9a9a"
	list := "    1     0 /sbin/launchd\n" +
		"  500     1 /usr/local/bin/orbit runner\n" +
		"  610   500 /bin/zsh -c run\n" +
		"  611   610 /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi\n" +
		"  700   690 /Users/me/.local/bin/claude --resume abc\n" +
		"  701   690 /Users/me/.local/bin/claude\n" +
		"  702     1 /Users/other/.local/bin/claude\n" +
		"  703     1 /usr/bin/vim notes.txt\n"
	envs := map[string]string{
		"611": "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi TERM=dumb CLAUDE_CONFIG_DIR=" + added + " HOME=" + home + " PATH=/usr/bin:/bin",
		"700": "/Users/me/.local/bin/claude --resume abc SHELL=/bin/zsh HOME=" + home + " LANG=en_US.UTF-8 TERM_PROGRAM=Apple Terminal",
		"701": "/Users/me/.local/bin/claude HOME=" + home + " CLAUDE_CONFIG_DIR=" + other,
		"702": "/Users/other/.local/bin/claude",
		"703": "/usr/bin/vim notes.txt HOME=" + home,
	}
	var asked []string
	ps := func(args ...string) ([]byte, error) {
		if args[0] == "-axww" {
			return []byte(list), nil
		}
		pid := args[len(args)-1]
		asked = append(asked, pid)
		return []byte(envs[pid] + "\n"), nil
	}
	foreign, own := claudeProcessesOnDarwin([]string{def, added}, self, ps)
	if !reflect.DeepEqual(foreign, []ClaudeSwapProcess{{PID: 700, Command: "claude"}}) || own != 1 {
		t.Fatalf("foreign %+v, own %d; want the terminal claude on Default, and one of the runner's own", foreign, own)
	}
	if !reflect.DeepEqual(asked, []string{"611", "700", "701", "702"}) {
		t.Fatalf("environments read for %v, want only the Claude processes", asked)
	}
	// Nothing on the folders: the swap does not wait.
	if foreign, own := claudeProcessesOnDarwin([]string{"/nowhere"}, self, ps); len(foreign) != 0 || own != 0 {
		t.Fatalf("on another folder: %+v, %d", foreign, own)
	}
}

func TestParseDarwinPSEnvKeepsValuesWithSpaces(t *testing.T) {
	got := parseDarwinPSEnv("/bin/claude -p x  TERM_PROGRAM=Apple Terminal HOME=/Users/me CLAUDE_CONFIG_DIR=/Users/me/My Accounts/a\n", "/bin/claude -p x")
	want := []string{"TERM_PROGRAM=Apple Terminal", "HOME=/Users/me", "CLAUDE_CONFIG_DIR=/Users/me/My Accounts/a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}
