package main

// The claude-account-swap/v1 relay (docs/claude-default-swap-contract.md §5): what this runner does
// with a swap the heartbeat hands it. It is the account removal's relay — a command redelivered on
// every heartbeat until a result says it ended, answered off the heartbeat goroutine — with the wait
// for turns done here, in the session pool:
//
//  1. Quiet. No turn starts on either folder from now on (a claim still lands; waitActive holds its
//     turn), each idle engine on either folder is stopped at once, and a turn in progress runs to its
//     end before its engine is stopped. Until nothing runs, every redelivery reports pending with the
//     sessions waited on.
//  2. Swap (claude_account_swap.go), verify, and on any failure roll back.
//  3. Release. Each held session's claim is pointed at its account's new folder and its conversation
//     carried there, the result goes to the control plane, and the held turns start.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// poolAccountSwap is a Claude login swap as the session pool sees it (sessionPool.accountSwap).
type poolAccountSwap struct {
	// on reports whether a claim runs on one of the two folders being swapped.
	on func(job *ClaimedSession) bool
	// reported: the swap's result is going to the control plane, so a claim from now on already names
	// the folder its account has moved to (liveSession.jobAfterSwap).
	reported bool
}

// accountSwapHoldsLocked reports whether a Claude login swap keeps s from starting a turn.
func (p *sessionPool) accountSwapHoldsLocked(s *liveSession) bool {
	return p.accountSwap != nil && s.job != nil && p.accountSwap.on(s.job)
}

// holdForAccountSwap starts holding every session on is true for: none of them starts a turn until
// releaseAccountSwap.
func (p *sessionPool) holdForAccountSwap(on func(job *ClaimedSession) bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.accountSwap = &poolAccountSwap{on: on}
}

// accountSwapProgress is where the quiet stands: the sessions on the two folders with a turn running
// (waitingOn), and how many of their engines are still resident. Every engine on them with no turn
// running — idle, or holding a turn the swap holds back — is stopped now.
func (p *sessionPool) accountSwapProgress() (waitingOn []string, engines int) {
	p.mu.Lock()
	var cancels []func()
	for _, s := range p.sessions {
		if !p.accountSwapHoldsLocked(s) {
			continue
		}
		if (s.active && !s.heldForUpdate && !s.heldForSwap) || s.selfDrivenTurn {
			waitingOn = append(waitingOn, s.id)
			if s.resident {
				engines++
			}
			continue
		}
		if !s.resident {
			continue
		}
		engines++
		if !s.evictRequested {
			// requestEvictLocked's recycling, for an engine that may hold a permit whose turn the swap holds:
			// that turn has not started, and it starts on a fresh engine once the swap ends.
			s.evictRequested = true
			s.idleGeneration++
			if s.warmTimer != nil {
				s.warmTimer.Stop()
				s.warmTimer = nil
			}
			if s.engineCancel != nil {
				cancels = append(cancels, s.engineCancel)
			}
			p.signalLocked(s)
		}
	}
	p.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	sort.Strings(waitingOn)
	return waitingOn, engines
}

// changedChan is closed at the pool's next change: a turn ending, an engine stopping, a turn held.
func (p *sessionPool) changedChan() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.changed
}

// markAccountSwapReported records that the swap's result is about to go to the control plane, which
// moves the sessions' account pins with it: a claim from now on names the new folders already.
func (p *sessionPool) markAccountSwapReported() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.accountSwap != nil {
		p.accountSwap.reported = true
	}
}

// remapAccountSwapJobs points the claim of every session the swap holds at its account's new folder
// (remap returns the claim to use instead, or nil to keep it), except a claim that arrived after the
// result was reported, which names it already. The claim is replaced rather than changed in place, so
// the supervisor still reading the old one is not raced, and adopts the new one as its next spawn's.
func (p *sessionPool) remapAccountSwapJobs(remap func(job *ClaimedSession) *ClaimedSession) map[string]*ClaimedSession {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]*ClaimedSession{}
	for id, s := range p.sessions {
		if !p.accountSwapHoldsLocked(s) || s.jobAfterSwap {
			continue
		}
		if job := remap(s.job); job != nil {
			s.job = job
			out[id] = job
		}
	}
	return out
}

// releaseAccountSwap ends the hold: every turn it held starts now.
func (p *sessionPool) releaseAccountSwap() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.accountSwap = nil
	for _, s := range p.sessions {
		s.jobAfterSwap = false
		if s.heldForSwap {
			s.heldForSwap = false
			p.signalLocked(s)
		}
	}
	p.signalLocked(nil)
}

// claudeSwapRunner is one swap of two logins (claudeLoginSwap).
type claudeSwapRunner interface {
	run(ctx context.Context) claudeSwapOutcome
}

// claudeAccountSwapRelay carries out the swaps the heartbeat delivers, one at a time.
type claudeAccountSwapRelay struct {
	pool *sessionPool
	// post sends one result to the control plane.
	post func(ClaudeAccountSwapResult) error
	// ended runs after a swap has ended either way: re-probe the engine, beat at once.
	ended func()

	// The outside world, replaceable in tests.
	folders   func(account string) (def, acct claudeLoginFolder, err error)
	newSwap   func(def, acct claudeLoginFolder, attempt string) claudeSwapRunner
	processes func(dirs []string) (foreign []ClaudeSwapProcess, own int)
	fence     func(ctx context.Context, keys []string) func()
	carry     func(sessionID string, job *ClaimedSession)
	deadline  time.Duration
	poll      time.Duration

	mu      sync.Mutex
	account string
	attempt string
	running bool
	pending ClaudeAccountSwapResult
	last    *ClaudeAccountSwapResult
}

func newClaudeAccountSwapRelay(pool *sessionPool, post func(ClaudeAccountSwapResult) error, ended func()) *claudeAccountSwapRelay {
	return &claudeAccountSwapRelay{
		pool: pool, post: post, ended: ended,
		folders: func(account string) (claudeLoginFolder, claudeLoginFolder, error) {
			def, err := claudeDefaultLoginFolder()
			if err != nil {
				return def, claudeLoginFolder{}, err
			}
			acct, err := claudeAddedLoginFolder(account)
			return def, acct, err
		},
		newSwap: func(def, acct claudeLoginFolder, attempt string) claudeSwapRunner {
			return newClaudeLoginSwap(def, acct, claudeSwapBackupDir(attempt))
		},
		processes: claudeProcessesOn,
		fence:     fenceClaudeRefreshes,
		carry:     carryHeldClaudeConversation,
		// The control plane gives up on a swap waiting on turns after 6 hours (§5); this outlasts it a little,
		// so the server's word is the one the page shows.
		deadline: 6*time.Hour + 10*time.Minute,
		poll:     2 * time.Second,
	}
}

// handle answers one heartbeat's command. It never waits: a swap runs on its own goroutine, and a
// redelivery of one in progress reports where it stands, of one that ended how it ended.
func (r *claudeAccountSwapRelay) handle(cmd ClaudeAccountSwapCommand) {
	r.mu.Lock()
	var res ClaudeAccountSwapResult
	switch {
	case r.account == cmd.Account && r.attempt == cmd.Attempt && r.last != nil:
		res = *r.last
	case r.account == cmd.Account && r.attempt == cmd.Attempt && r.running:
		res = r.pending
	case r.running:
		res = ClaudeAccountSwapResult{Account: cmd.Account, Attempt: cmd.Attempt, Status: "failed",
			Message: "Another swap of Claude accounts is still running on this machine — try again once it ends."}
	default:
		r.account, r.attempt, r.running, r.last = cmd.Account, cmd.Attempt, true, nil
		r.pending = ClaudeAccountSwapResult{Account: cmd.Account, Attempt: cmd.Attempt, Status: "pending"}
		r.mu.Unlock()
		go r.run(cmd)
		return
	}
	r.mu.Unlock()
	go r.send(res)
}

func (r *claudeAccountSwapRelay) send(res ClaudeAccountSwapResult) {
	if err := r.post(res); err != nil {
		logln("claude-account-swap-result POST failed:", err)
	}
}

// finish records how the swap ended, for every redelivery of it, and reports it.
func (r *claudeAccountSwapRelay) finish(res ClaudeAccountSwapResult) {
	r.mu.Lock()
	r.last, r.running = &res, false
	r.mu.Unlock()
	r.send(res)
}

// run is one swap from quiet to release.
func (r *claudeAccountSwapRelay) run(cmd ClaudeAccountSwapCommand) {
	res := ClaudeAccountSwapResult{Account: cmd.Account, Attempt: cmd.Attempt, Status: "failed"}
	def, acct, err := r.folders(cmd.Account)
	if err != nil {
		res.Message = "Not swapped: " + firstLine(err.Error())
		r.finish(res)
		return
	}
	// A redelivery of a swap that already happened — this runner restarted since, say — finds the
	// folders exchanged, and reports done again rather than swapping them back.
	if e := cmd.Expect; e != nil && e.DefaultAccountUUID != "" && e.AccountAccountUUID != "" {
		nowDef, nowAcct := readClaudeOAuthAccountUUID(def), readClaudeOAuthAccountUUID(acct)
		if nowDef == e.AccountAccountUUID && nowAcct == e.DefaultAccountUUID {
			res.Status, res.Now = "done", &ClaudeAccountSwapNow{DefaultAccountUUID: nowDef, AccountAccountUUID: nowAcct}
			r.finish(res)
			r.ended()
			return
		}
		if nowDef != e.DefaultAccountUUID || nowAcct != e.AccountAccountUUID {
			res.Message = "Not swapped: the accounts signed in to these folders changed since the swap was asked for — try again."
			r.finish(res)
			return
		}
	}
	dirs := []string{filepath.Clean(def.dir), filepath.Clean(acct.dir)}
	dirOf := func(job *ClaimedSession) string {
		if v := strings.TrimSpace(job.Agent.Env["CLAUDE_CONFIG_DIR"]); v != "" {
			if abs, err := absoluteFrom("", v); err == nil {
				return abs
			}
		}
		return dirs[0]
	}
	r.pool.holdForAccountSwap(func(job *ClaimedSession) bool {
		if runtimeProvider(job) != providerClaude {
			return false
		}
		d := dirOf(job)
		return d == dirs[0] || d == dirs[1]
	})
	defer func() {
		r.pool.releaseAccountSwap()
		r.ended()
	}()

	if !r.quiet(cmd, dirs) {
		res.Message = "Its sessions did not finish their turns in time — try again."
		r.finish(res)
		return
	}
	ctx := context.Background()
	release := r.fence(ctx, []string{"", def.envDir, def.dir, acct.dir})
	outcome := r.newSwap(def, acct, cmd.Attempt).run(ctx)
	release()
	if !outcome.ok {
		res.Message = outcome.message
		logln("claude account swap of", cmd.Account, "failed:", outcome.message)
		r.finish(res)
		return
	}
	logln("claude account swap: account", cmd.Account, "is now Default; Default's login is in", acct.dir)
	r.pool.markAccountSwapReported()
	moved := r.pool.remapAccountSwapJobs(func(job *ClaimedSession) *ClaimedSession {
		next := *job
		next.Agent.Env = make(map[string]string, len(job.Agent.Env)+1)
		for k, v := range job.Agent.Env {
			next.Agent.Env[k] = v
		}
		switch dirOf(job) {
		case dirs[1]: // its account is Default now
			delete(next.Agent.Env, "CLAUDE_CONFIG_DIR")
		case dirs[0]: // its account's login is in the added folder now
			next.Agent.Env["CLAUDE_CONFIG_DIR"] = acct.dir
		default:
			return nil
		}
		return &next
	})
	for id, job := range moved {
		r.carry(id, job)
	}
	res.Status = "done"
	res.Now = &ClaudeAccountSwapNow{DefaultAccountUUID: outcome.defaultAccountUUID, AccountAccountUUID: outcome.accountAccountUUID}
	r.finish(res)
}

// quiet waits until no turn, no engine and no other Claude process runs on either folder, reporting
// pending whenever what it waits on changes. False when the deadline passed first.
func (r *claudeAccountSwapRelay) quiet(cmd ClaudeAccountSwapCommand, dirs []string) bool {
	deadline := time.Now().Add(r.deadline)
	var said string
	for {
		changed := r.pool.changedChan()
		waitingOn, engines := r.pool.accountSwapProgress()
		foreign, own := r.processes(dirs)
		if len(waitingOn) == 0 && engines == 0 && len(foreign) == 0 && own == 0 {
			return true
		}
		pending := ClaudeAccountSwapResult{Account: cmd.Account, Attempt: cmd.Attempt, Status: "pending",
			WaitingOn: waitingOn, ForeignProcesses: foreign}
		r.mu.Lock()
		r.pending = pending
		r.mu.Unlock()
		if key := strings.Join(waitingOn, ",") + "|" + claudeSwapProcessesKey(foreign); key != said {
			said = key
			r.send(pending)
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-changed:
		case <-time.After(r.poll):
		}
	}
}

func claudeSwapProcessesKey(ps []ClaudeSwapProcess) string {
	var b strings.Builder
	for _, p := range ps {
		b.WriteString(strconv.Itoa(p.PID))
		b.WriteByte(',')
	}
	return b.String()
}

// carryHeldClaudeConversation carries a held session's conversation to the folder its claim now names,
// as an idle session's account switch does (moveIdleClaudeConversation), so its next turn resumes with
// its context.
func carryHeldClaudeConversation(sessionID string, job *ClaimedSession) {
	scratch := runDir(sessionID)
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || meta.WorkDir == "" {
		return // never ran here: its first spawn finds whatever there is
	}
	moveIdleClaudeConversation(job, meta.WorkDir, scratch)
}

// fenceClaudeRefreshes keeps the runner's own token refresher (refreshClaudeToken) out of the folders
// keys names until the returned release: it waits out a refresh already running there, then holds
// them as running.
func fenceClaudeRefreshes(ctx context.Context, keys []string) func() {
	for {
		claudeRefreshing.Lock()
		busy := false
		for _, k := range keys {
			busy = busy || claudeRefreshing.dirs[k]
		}
		if !busy {
			for _, k := range keys {
				claudeRefreshing.dirs[k] = true
			}
			claudeRefreshing.Unlock()
			return func() {
				claudeRefreshing.Lock()
				for _, k := range keys {
					delete(claudeRefreshing.dirs, k)
				}
				claudeRefreshing.Unlock()
			}
		}
		claudeRefreshing.Unlock()
		select {
		case <-ctx.Done():
			return func() {}
		case <-time.After(time.Second):
		}
	}
}

// claudeProcessesOn finds the Claude Code processes running on one of dirs: foreign ones — a `claude`
// in a terminal, nothing this runner started — by pid and name, and how many of this runner's own
// (an engine still stopping, a probe) there are. Both are waited for. Linux reads /proc; macOS asks ps
// (claudeProcessesOnDarwin).
func claudeProcessesOn(dirs []string) (foreign []ClaudeSwapProcess, own int) {
	switch runtime.GOOS {
	case "linux":
		return claudeProcessesOnLinux(dirs)
	case "darwin":
		return claudeProcessesOnDarwin(dirs, os.Getpid(), claudeSwapPS)
	}
	return nil, 0
}

// claudeSwapPS runs ps with args; a variable so the darwin scan can be fed recorded output.
var claudeSwapPS = func(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "ps", args...).Output()
}

// darwinProc is one line of `ps -axww -o pid=,ppid=,command=`.
type darwinProc struct {
	pid, ppid int
	command   string
}

// parseDarwinPS reads `ps -axww -o pid=,ppid=,command=`: two numbers, then the command line.
func parseDarwinPS(out []byte) []darwinProc {
	var procs []darwinProc
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		// The command is everything after the second number, its own spacing kept.
		rest := strings.TrimLeft(line, " \t")
		rest = strings.TrimLeft(rest[len(fields[0]):], " \t")
		rest = strings.TrimLeft(rest[len(fields[1]):], " \t")
		procs = append(procs, darwinProc{pid: pid, ppid: ppid, command: strings.TrimRight(rest, " \t\r")})
	}
	return procs
}

// claudeCommandName is the command's name when it is Claude Code: the native `claude`, or node running
// the claude-code package.
func claudeCommandName(command string) (string, bool) {
	args := strings.Fields(command)
	if len(args) == 0 {
		return "", false
	}
	if filepath.Base(args[0]) == "claude" {
		return "claude", true
	}
	for _, a := range args[1:] {
		if strings.Contains(a, "claude-code/cli") || strings.Contains(a, "@anthropic-ai/claude-code") {
			return filepath.Base(args[0]), true
		}
	}
	return "", false
}

// darwinEnvVar finds where each NAME= starts in what `ps -E` appends after a command.
var darwinEnvVar = regexp.MustCompile(`(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=`)

// parseDarwinPSEnv reads the environment `ps -E -ww -o command= -p <pid>` appends to command. ps joins
// the variables with spaces, so a value runs until the next NAME=. Empty when ps shows none, which is
// what it shows of another user's process.
func parseDarwinPSEnv(line, command string) []string {
	rest := strings.TrimSpace(line)
	if !strings.HasPrefix(rest, command) {
		return nil
	}
	rest = rest[len(command):]
	idx := darwinEnvVar.FindAllStringSubmatchIndex(rest, -1)
	var env []string
	for i, m := range idx {
		end := len(rest)
		if i+1 < len(idx) {
			end = idx[i+1][0]
		}
		env = append(env, rest[m[2]:m[3]]+"="+strings.TrimSpace(rest[m[3]+1:end]))
	}
	return env
}

// claudeProcessesOnDarwin is claudeProcessesOn on macOS, which has no /proc: ps lists every process with
// its parent, and `ps -E` gives each Claude Code process's environment, which says its folder the way the
// CLI resolves it (CLAUDE_CONFIG_DIR, else $HOME/.claude). A process whose environment ps does not show is
// another user's, on another HOME.
func claudeProcessesOnDarwin(dirs []string, self int, ps func(args ...string) ([]byte, error)) (foreign []ClaudeSwapProcess, own int) {
	out, err := ps("-axww", "-o", "pid=,ppid=,command=")
	if err != nil {
		return nil, 0
	}
	procs := parseDarwinPS(out)
	parent := map[int]int{}
	for _, p := range procs {
		parent[p.pid] = p.ppid
	}
	want := map[string]bool{}
	for _, d := range dirs {
		want[filepath.Clean(d)] = true
	}
	for _, p := range procs {
		if p.pid == self {
			continue
		}
		name, ok := claudeCommandName(p.command)
		if !ok {
			continue
		}
		line, err := ps("-E", "-ww", "-o", "command=", "-p", strconv.Itoa(p.pid))
		if err != nil {
			continue // ended meanwhile
		}
		env := parseDarwinPSEnv(string(line), p.command)
		if len(env) == 0 {
			continue
		}
		dir, err := effectiveClaudeConfigDir(env, "/")
		if err != nil || !want[filepath.Clean(dir)] {
			continue
		}
		if descendsFrom(parent, p.pid, self) {
			own++
		} else {
			foreign = append(foreign, ClaudeSwapProcess{PID: p.pid, Command: name})
		}
	}
	sort.Slice(foreign, func(i, j int) bool { return foreign[i].PID < foreign[j].PID })
	return foreign, own
}

// descendsFrom reports whether pid's parent chain in parent reaches ancestor.
func descendsFrom(parent map[int]int, pid, ancestor int) bool {
	for i := 0; i < 64 && pid > 1; i++ {
		ppid, ok := parent[pid]
		if !ok {
			return false
		}
		if ppid == ancestor {
			return true
		}
		pid = ppid
	}
	return false
}

// claudeProcessesOnLinux is claudeProcessesOn read from /proc.
func claudeProcessesOnLinux(dirs []string) (foreign []ClaudeSwapProcess, own int) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, 0
	}
	self := os.Getpid()
	want := map[string]bool{}
	for _, d := range dirs {
		want[filepath.Clean(d)] = true
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		comm, ok := claudeProcessName(pid)
		if !ok {
			continue
		}
		environ, err := os.ReadFile(filepath.Join("/proc", e.Name(), "environ"))
		if err != nil {
			continue
		}
		env := strings.Split(string(environ), "\x00")
		dir, err := effectiveClaudeConfigDir(env, "/")
		if err != nil || !want[filepath.Clean(dir)] {
			continue
		}
		if procDescendsFrom(pid, self) {
			own++
		} else {
			foreign = append(foreign, ClaudeSwapProcess{PID: pid, Command: comm})
		}
	}
	sort.Slice(foreign, func(i, j int) bool { return foreign[i].PID < foreign[j].PID })
	return foreign, own
}

// claudeProcessName is the process's name when it is Claude Code: the native `claude`, or node running
// the claude-code package.
func claudeProcessName(pid int) (string, bool) {
	base := filepath.Join("/proc", strconv.Itoa(pid))
	comm, err := os.ReadFile(filepath.Join(base, "comm"))
	if err != nil {
		return "", false
	}
	name := strings.TrimSpace(string(comm))
	if name == "claude" {
		return name, true
	}
	cmdline, err := os.ReadFile(filepath.Join(base, "cmdline"))
	if err != nil {
		return "", false
	}
	args := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
	if len(args) > 0 && filepath.Base(args[0]) == "claude" {
		return "claude", true
	}
	for _, a := range args {
		if strings.Contains(a, "claude-code/cli") || strings.Contains(a, "@anthropic-ai/claude-code") {
			return name, true
		}
	}
	return "", false
}

// procDescendsFrom reports whether pid's parent chain reaches ancestor.
func procDescendsFrom(pid, ancestor int) bool {
	for i := 0; i < 64 && pid > 1; i++ {
		stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
		if err != nil {
			return false
		}
		// pid (comm) state ppid ...: comm may hold spaces, so read after its closing parenthesis.
		s := string(stat)
		end := strings.LastIndexByte(s, ')')
		if end < 0 {
			return false
		}
		fields := strings.Fields(s[end+1:])
		if len(fields) < 2 {
			return false
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			return false
		}
		if ppid == ancestor {
			return true
		}
		pid = ppid
	}
	return false
}
