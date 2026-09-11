package main

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// warmEngineTTL is how long an idle interactive engine is kept for a zero-startup
// continuation. The Orbit session itself remains resumable after this expires; only
// the local coding-runtime supervisor is recycled.
//
// Now that an agent's background jobs are the runner's own children, recycling a warm
// engine costs nothing but the next turn's startup: it is a pure latency cache, and
// it pays for that cache in resident memory for the whole TTL whether or not the next
// turn ever comes. Measured on this host on 2026-09-07, over two samples of the
// engines the runner supervised (five, then two): 265-273 MB RSS / 199-235 MB PSS
// per engine. The host has 24 GB of RAM, its 8 GB of swap 100% consumed, and a
// global OOM on 2026-08-31 that the kernel resolved by killing a 9.8 GB process
// inside orbit-runner-root.service.
//
// Four hours meant holding ~200 MB per parked session for four hours to save one
// engine start. Forty-five minutes still covers what the cache is for — a session
// that gets another turn in the same sitting — and hands the rest of the day back to
// the host. This number moves down or stays put, never up: a warm engine is a
// convenience, and this machine has already shown what it does when memory runs out.
const warmEngineTTL = 45 * time.Minute

type poolTimer interface {
	Stop() bool
}

type poolClock interface {
	Now() time.Time
	AfterFunc(time.Duration, func()) poolTimer
}

type realPoolClock struct{}

func (realPoolClock) Now() time.Time { return time.Now() }
func (realPoolClock) AfterFunc(d time.Duration, f func()) poolTimer {
	return time.AfterFunc(d, f)
}

// liveSession is the runner-side supervisor for one Orbit session. A supervisor
// may be active (holding a turn permit), warm (idle with a resident engine), or
// cold (idle without an engine). These are deliberately runner-internal states;
// the control-plane status remains AWAITING_INPUT while both warm and cold.
//
// Every field below is protected by sessionPool.mu. engineGeneration identifies
// one concrete runtime generation so a late Wait from an evicted process cannot
// clear a replacement process that has already started.
type liveSession struct {
	id     string
	cancel context.CancelFunc // whole supervisor: real end/cancel only
	job    *ClaimedSession    // newest claim payload; consumed before a cold spawn
	wake   chan struct{}
	done   chan struct{} // closed after supervisor cleanup completes

	// A process-owner takeover must not reuse a supervisor from the predecessor
	// epoch. detaching distinguishes that no-finalize handoff from a real UI cancel.
	detaching bool
	detach    context.CancelFunc
	doneOnce  sync.Once

	active bool // owns one maxConcurrent turn permit
	// Incremented for every server claim, including a claim that races the tail
	// of the prior turn while active is still true locally. A late ack may release
	// only the exact permit generation under which its turn ran.
	permitGeneration uint64

	resident         bool // an engine is starting/running/being reaped
	engineGeneration uint64
	engineCancel     context.CancelFunc
	evictRequested   bool
	// agentMcpServers is agentMcpServerNames of the claim this engine generation was
	// spawned from, taken when the generation is reserved. A warm engine goes on
	// running the servers it started with, whatever a later claim says.
	agentMcpServers []string

	idleGeneration uint64
	warmTimer      poolTimer
	lastActive     time.Time // LRU key: when active -> warm most recently
}

// heartbeatSupervisorSnapshot binds a heartbeat response to the exact local
// supervisor that was advertised in its request. The pointer is the epoch token:
// a delayed lease-loss response must never detach a replacement with the same id.
type heartbeatSupervisorSnapshot struct {
	supervisor       *liveSession
	permitGeneration uint64
	cancel           context.CancelFunc
}

// worktreeOperationState serializes heartbeat-delivered Commit/Merge work with
// provider activation, finalization, and terminal Resume takeover. A fence stops
// new operations; done joins the one operation that may already have linearized.
type worktreeOperationState struct {
	fenced  bool
	running bool
	done    chan struct{}
}

// worktreeHolder is one reason a session's checkout is not free right now. The
// set of them is what a destructive operation — merge, commit, GC — is fenced
// against; the turn permit alone used to stand in for it, which made every
// writer that outlives its turn invisible.
type worktreeHolder struct {
	kind string // one of the worktreeHeldBy* kinds
	name string // what a refusal calls this holder
}

const (
	worktreeHeldByEngine        = "engine"
	worktreeHeldByBackgroundJob = "background job"
	worktreeHeldByOperation     = "worktree operation"
)

func (h worktreeHolder) String() string { return h.kind + " " + h.name }

// bgHold is one live background writer of a checkout. runnerHosted is the fact a
// capacity ledger needs and a fence does not: a shell the engine owns dies with
// it, so it is never the reason a parked session still costs anything, while a
// runner-hosted job goes on running across an engine eviction.
type bgHold struct {
	name         string
	runnerHosted bool
}

// sessionPool owns both concurrency resources:
//   - at most max active turn permits;
//   - at most max resident engines (active + warm).
//
// Warm engines only consume capacity not promised to active turns. Activating a
// cold session therefore evicts the least-recently-active warm engine first. The
// victim remains counted as resident until its process Wait completes, so a new
// process can never transiently push resident engines over max.
type sessionPool struct {
	mu          sync.Mutex
	max         int
	clock       poolClock
	sessions    map[string]*liveSession
	worktreeOps map[string]*worktreeOperationState
	// bgJobs is sessionID → live background shell id → what is known about it: the
	// name a refusal calls it, and whether the runner hosts it. A shell is a writer
	// of the checkout for exactly as long as it runs, and it routinely outlives the
	// turn that launched it.
	bgJobs  map[string]map[string]bgHold
	changed chan struct{}
}

func newSessionPool(max int) *sessionPool {
	return newSessionPoolWithClock(max, realPoolClock{})
}

func newSessionPoolWithClock(max int, clock poolClock) *sessionPool {
	if max < 1 {
		max = 1
	}
	return &sessionPool{
		max:         max,
		clock:       clock,
		sessions:    map[string]*liveSession{},
		worktreeOps: map[string]*worktreeOperationState{},
		bgJobs:      map[string]map[string]bgHold{},
		changed:     make(chan struct{}),
	}
}

func (p *sessionPool) worktreeOpLocked(id string) *worktreeOperationState {
	state := p.worktreeOps[id]
	if state == nil {
		state = &worktreeOperationState{}
		p.worktreeOps[id] = state
	}
	return state
}

// worktreeHoldersLocked enumerates everything that holds this session's
// checkout: the resident engine, every live background job, and a manual
// operation that has already linearized. Each kind is fenced by its own
// mechanism — the engine by the fence itself, an operation by `running`, a
// background job by worktreeWritersLocked below — so this set is the whole
// answer to "may something rewrite this checkout right now".
//
// The engine counts only while a turn is running or one of its background shells
// is still alive. A parked engine with neither still has processes standing in
// the checkout: itself and its MCP servers. The engine and Orbit's own `orbit` MCP
// server write nothing to the checkout between turns — waiting for the next turn
// is their entire job — and counting them anyway would fence every merge on a warm
// session for the whole of warmEngineTTL. An MCP server the agent configured
// itself is not bound by that: nothing here knows what it writes, or when. It is
// not counted either; merge and commit instead evict an engine that runs one,
// servers and all, before they touch the checkout (beginDrainedWorktreeOperation).
func (p *sessionPool) worktreeHoldersLocked(id string) []worktreeHolder {
	names := make([]string, 0, len(p.bgJobs[id]))
	for _, hold := range p.bgJobs[id] {
		names = append(names, hold.name)
	}
	sort.Strings(names) // a receipt reads the same twice
	var holders []worktreeHolder
	if s := p.sessions[id]; s != nil && s.resident && (s.active || len(names) > 0) {
		holders = append(holders, worktreeHolder{kind: worktreeHeldByEngine, name: id})
	}
	for _, name := range names {
		holders = append(holders, worktreeHolder{kind: worktreeHeldByBackgroundJob, name: name})
	}
	if state := p.worktreeOps[id]; state != nil && state.running {
		holders = append(holders, worktreeHolder{kind: worktreeHeldByOperation, name: id})
	}
	return holders
}

// worktreeHolders answers "who holds this checkout" from outside the pool.
func (p *sessionPool) worktreeHolders(id string) []worktreeHolder {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.worktreeHoldersLocked(id)
}

// backgroundJobCounts reports, per session, how many runner-hosted background jobs
// are alive right now. This is the capacity account, and it is a number rather than
// a bit because it is spent as one: a runner-hosted job goes on running with no turn
// permit and no engine, so activeCount() cannot see it, and a runner that admits work
// against permits alone admits it onto a machine that is already busy.
//
// What it is not for is keeping an engine resident. Eviction is lossless now — that
// is the whole of stages 1 and 2 — so a live job is a reason to take less new work,
// never a reason to hold 200 MB of parked engine.
func (p *sessionPool) backgroundJobCounts() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.backgroundJobCountsLocked()
}

func (p *sessionPool) backgroundJobCountsLocked() map[string]int {
	counts := map[string]int{}
	for sessionID, jobs := range p.bgJobs {
		n := 0
		for _, hold := range jobs {
			if hold.runnerHosted {
				n++
			}
		}
		if n > 0 {
			counts[sessionID] = n
		}
	}
	return counts
}

// admissionIdleCapacity spends the account above: it reports how many more sessions
// this runner may be given, counting a session as occupying a slot while it holds a
// turn permit OR while runner-hosted jobs of its own are still running. Per session
// and not per job — several jobs of one session share one checkout, and a session is
// the unit that new work displaces.
func (p *sessionPool) admissionIdleCapacity() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	occupied := make(map[string]bool, len(p.sessions))
	for sessionID := range p.backgroundJobCountsLocked() {
		occupied[sessionID] = true
	}
	for id, s := range p.sessions {
		if s.active {
			occupied[id] = true
		}
	}
	idle := p.max - len(occupied)
	if idle < 0 {
		idle = 0
	}
	return idle
}

// worktreeWritersLocked reports whether a writer that no other mechanism already
// fences is still working in this checkout. That is exactly the live background
// jobs: the engine writes through them (see worktreeHoldersLocked), and a
// linearized manual operation carries its own `running` flag and done barrier.
func (p *sessionPool) worktreeWritersLocked(id string) bool {
	return len(p.bgJobs[id]) > 0
}

// holdWorktreeForBackgroundJob records one background shell as a live writer of
// the session's checkout, and raises the fence on its account. jobID is the
// launching tool_use id; name is what a refusal will call it.
func (p *sessionPool) holdWorktreeForBackgroundJob(sessionID, jobID, name string) {
	p.holdWorktreeWriter(sessionID, jobID, name, false)
}

// holdWorktreeForRunnerJob records the same hold for a job the RUNNER spawned and
// owns. It fences the checkout identically — a writer is a writer — and is
// additionally counted, because this is the work that survives engine eviction
// and therefore the work a capacity account has to know about.
func (p *sessionPool) holdWorktreeForRunnerJob(sessionID, jobID, name string) {
	p.holdWorktreeWriter(sessionID, jobID, name, true)
}

func (p *sessionPool) holdWorktreeWriter(sessionID, jobID, name string, runnerHosted bool) {
	if sessionID == "" || jobID == "" {
		return
	}
	if name == "" {
		name = jobID
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	jobs := p.bgJobs[sessionID]
	if jobs == nil {
		jobs = map[string]bgHold{}
		p.bgJobs[sessionID] = jobs
	}
	jobs[jobID] = bgHold{name: name, runnerHosted: runnerHosted}
	// A shell launched mid-turn already sits behind that turn's fence. Raising it
	// here is for the shell that starts, or survives, past the turn: park is about
	// to hand the permit back, and the fence must not go down with it.
	p.worktreeOpLocked(sessionID).fenced = true
}

// releaseWorktreeBackgroundJob retires one background shell's hold. The last
// writer leaving is what lowers a fence park could not.
func (p *sessionPool) releaseWorktreeBackgroundJob(sessionID, jobID string) {
	if sessionID == "" || jobID == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	jobs := p.bgJobs[sessionID]
	if _, held := jobs[jobID]; !held {
		return
	}
	delete(jobs, jobID)
	if len(jobs) == 0 {
		delete(p.bgJobs, sessionID)
	}
	// An active turn keeps its own fence; only an idle checkout is handed back.
	if s := p.sessions[sessionID]; s == nil || !s.active {
		p.releaseWorktreeFenceLocked(sessionID, s)
	}
}

// worktreeHoldsFor binds this registry to one session, so a component that knows
// shells but not sessions can declare its writers.
func (p *sessionPool) worktreeHoldsFor(sessionID string) worktreeHoldRegistry {
	return sessionWorktreeHolds{pool: p, sessionID: sessionID}
}

type sessionWorktreeHolds struct {
	pool      *sessionPool
	sessionID string
}

func (h sessionWorktreeHolds) holdWorktree(jobID, name string) {
	h.pool.holdWorktreeForBackgroundJob(h.sessionID, jobID, name)
}

func (h sessionWorktreeHolds) holdRunnerJob(jobID, name string) {
	h.pool.holdWorktreeForRunnerJob(h.sessionID, jobID, name)
}

func (h sessionWorktreeHolds) releaseWorktree(jobID string) {
	h.pool.releaseWorktreeBackgroundJob(h.sessionID, jobID)
}

// worktreeOperationRefusal is the sentence a refused destructive operation sends
// back to the control plane in place of doing the work. It is read immediately
// after the refusal, in the same goroutine: a holder that ended in between only
// downgrades the message to the supersession wording — it can never turn a
// refusal into a pass, because beginHeartbeatWorktreeOperation already decided.
func (p *sessionPool) worktreeOperationRefusal(id, operation string) string {
	p.mu.Lock()
	holders := p.worktreeHoldersLocked(id)
	p.mu.Unlock()
	if len(holders) == 0 {
		// Nothing holds it: the server claimed this exact epoch before returning
		// the heartbeat, which is a different fact and reads differently.
		return operation + " was superseded before local execution"
	}
	names := make([]string, 0, len(holders))
	for _, h := range holders {
		names = append(names, h.String())
	}
	return operation + " was refused: this checkout is still held by " + strings.Join(names, ", ")
}

func (p *sessionPool) fenceWorktreeOperationLocked(id string) <-chan struct{} {
	state := p.worktreeOpLocked(id)
	state.fenced = true
	if state.running {
		return state.done
	}
	return nil
}

// fenceWorktreeOperations closes admission before a claim/takeover and returns
// the exact in-flight operation's completion barrier, if any.
func (p *sessionPool) fenceWorktreeOperations(id string) <-chan struct{} {
	p.mu.Lock()
	done := p.fenceWorktreeOperationLocked(id)
	p.mu.Unlock()
	return done
}

func (p *sessionPool) releaseWorktreeFenceLocked(id string, expected *liveSession) {
	if p.sessions[id] != expected {
		return
	}
	state := p.worktreeOps[id]
	if state == nil {
		return
	}
	// The permit is not the holder. A background shell outlives the turn that
	// launched it, so the fence comes down when the last writer leaves — not when
	// the turn ends.
	if p.worktreeWritersLocked(id) {
		return
	}
	state.fenced = false
	if !state.running {
		delete(p.worktreeOps, id)
	}
}

// beginHeartbeatWorktreeOperation binds a command to the exact supervisor map
// captured in its heartbeat request. expected=nil is meaningful: it permits a
// completed session only while no replacement supervisor has since appeared.
func (p *sessionPool) beginHeartbeatWorktreeOperation(
	id string,
	expected *liveSession,
	expectedPermit uint64,
	requireSupervisor bool,
) (func(), bool) {
	p.mu.Lock()
	current := p.sessions[id]
	if current != expected ||
		(requireSupervisor && current == nil) ||
		(current != nil &&
			(current.active || current.detaching || current.permitGeneration != expectedPermit)) {
		p.mu.Unlock()
		return nil, false
	}
	if requireSupervisor && (current.job == nil || current.job.WT == nil) {
		p.mu.Unlock()
		return nil, false
	}
	if state := p.worktreeOps[id]; state != nil && (state.fenced || state.running) {
		p.mu.Unlock()
		return nil, false
	}
	// Belt to the fence's braces: a writer that appeared without anything having
	// re-raised the fence still owns the checkout this operation would rewrite.
	if p.worktreeWritersLocked(id) {
		p.mu.Unlock()
		return nil, false
	}
	state := p.worktreeOpLocked(id)
	state.running = true
	state.done = make(chan struct{})
	p.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			if currentState := p.worktreeOps[id]; currentState == state && state.running {
				state.running = false
				close(state.done)
				state.done = nil
				if !state.fenced && p.sessions[id] == nil {
					delete(p.worktreeOps, id)
				}
			}
			p.mu.Unlock()
		})
	}, true
}

// engineEvictionWaitCap bounds how long a merge or commit waits for the engine it
// evicted to be reaped. Tearing a parked engine down is a process-group kill, so this
// is reached only when something is wrong — and then the operation is refused rather
// than run beside a process tree that may still be alive.
const engineEvictionWaitCap = 30 * time.Second

// agentMcpServerNames names the MCP servers of the agent's own that an engine spawned
// from this claim runs beside Orbit's: the keys of Agent.McpConfig, which the Claude,
// Kimi and OpenCode spawns all merge into the engine's configuration, minus `orbit`,
// which each of them overwrites with the built-in server. Codex's spawn configures the
// built-in server alone, so a Codex engine runs none of them.
//
// Decided from the configuration the runner builds, never by looking for processes:
// that is ownership the runner constructed rather than inferred, and it reads the same
// on every platform a runner runs on.
func agentMcpServerNames(job *ClaimedSession) []string {
	if job == nil || runtimeProvider(job) == providerCodex {
		return nil
	}
	var names []string
	for name := range job.Agent.McpConfig {
		if name != "orbit" {
			names = append(names, name)
		}
	}
	sort.Strings(names) // a receipt reads the same twice
	return names
}

// beginDrainedWorktreeOperation is how merge and commit enter a checkout. It admits the
// operation exactly as beginHeartbeatWorktreeOperation does, then drains the one kind of
// process standing in the checkout that the holder set leaves out (worktreeHoldersLocked):
// a parked engine running MCP servers the agent configured itself. That engine is
// evicted — the same lossless recycle as the warm TTL, which the next turn cold-resumes —
// and the operation begins only once its supervisor has reaped it.
//
// Admitted, it returns the release func and what the operation's receipt has to say
// about that eviction ("" when there was none). Refused, it returns a nil release and the
// refusal itself.
func (p *sessionPool) beginDrainedWorktreeOperation(
	id string,
	expected *liveSession,
	expectedPermit uint64,
	requireSupervisor bool,
	operation string,
	wait time.Duration,
) (func(), string, bool) {
	release, admitted := p.beginHeartbeatWorktreeOperation(id, expected, expectedPermit, requireSupervisor)
	if !admitted {
		return nil, p.worktreeOperationRefusal(id, operation), false
	}
	servers, stopped := p.evictEngineWithAgentMcpServers(id, expected, wait)
	if len(servers) == 0 {
		return release, "", true
	}
	named := strings.Join(servers, ", ")
	if !stopped {
		release()
		return nil, operation + " was refused: the engine evicted for it, which was running MCP servers" +
			" the agent configured itself (" + named + "), had not stopped after " + wait.String(), false
	}
	evicted := "the engine was evicted for this " + operation +
		": it was running MCP servers the agent configured itself (" + named + ")"
	// The eviction took time a writer could have used to appear, and only admission has
	// looked for one. A runner-hosted job outlives the engine that asked for it.
	p.mu.Lock()
	writing := p.worktreeWritersLocked(id)
	p.mu.Unlock()
	if writing {
		release()
		return nil, appendWorktreeReceipt(p.worktreeOperationRefusal(id, operation), evicted), false
	}
	return release, evicted, true
}

// evictEngineWithAgentMcpServers asks this session's parked engine to go if it runs MCP
// servers of the agent's own, and waits until its supervisor has reaped it: session.go
// reports engineStopped only after the engine's process group — servers included — is
// gone. It returns the servers that engine was running and whether it stopped within
// wait. The caller holds an admitted operation, whose `running` keeps a claim from
// starting a replacement engine in the meantime.
func (p *sessionPool) evictEngineWithAgentMcpServers(id string, expected *liveSession, wait time.Duration) ([]string, bool) {
	p.mu.Lock()
	s := p.sessions[id]
	if s == nil || s != expected || !s.resident || len(s.agentMcpServers) == 0 {
		p.mu.Unlock()
		return nil, true
	}
	servers := append([]string(nil), s.agentMcpServers...)
	generation := s.engineGeneration
	cancel := p.requestEvictLocked(s)
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		p.mu.Lock()
		stopped := p.sessions[id] != s || !s.resident || s.engineGeneration != generation
		changed := p.changed
		p.mu.Unlock()
		if stopped {
			return servers, true
		}
		select {
		case <-changed:
		case <-deadline.C:
			return servers, false
		}
	}
}

// appendWorktreeReceipt puts what admitting an operation took after the operation's own
// message, so git's output stays the first thing a failed merge or commit says.
func appendWorktreeReceipt(message, note string) string {
	switch {
	case note == "":
		return message
	case message == "":
		return note
	}
	return message + "\n" + note
}

func (p *sessionPool) signalLocked(s *liveSession) {
	if s != nil {
		close(s.wake)
		s.wake = make(chan struct{})
	}
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *sessionPool) activeCountLocked() int {
	n := 0
	for _, s := range p.sessions {
		if s.active {
			n++
		}
	}
	return n
}

func (p *sessionPool) residentCountLocked() int {
	n := 0
	for _, s := range p.sessions {
		if s.resident {
			n++
		}
	}
	return n
}

func (p *sessionPool) warmCountLocked() int {
	n := 0
	for _, s := range p.sessions {
		if s.resident && !s.active && !s.evictRequested {
			n++
		}
	}
	return n
}

// oldestWarmLocked returns the LRU warm process that is not already on its way
// out. Stable id ordering breaks equal-timestamp ties, making behavior and tests
// deterministic.
//
// Strict least-recently-active, with no exemption for any kind of work. The one
// exemption there ever was — a deferral for a supervisor with a live background job —
// is gone: that job is the runner's own child now, and survives the eviction it used
// to have to be spared from. Re-evaluated alongside warmEngineTTL and deliberately
// left at its tightest: warm engines hold only capacity no active turn is promised,
// and the oldest one goes first.
func (p *sessionPool) oldestWarmLocked(except string) *liveSession {
	var oldest *liveSession
	for _, s := range p.sessions {
		if s.id == except || !s.resident || s.active || s.evictRequested {
			continue
		}
		if oldest == nil || s.lastActive.Before(oldest.lastActive) ||
			(s.lastActive.Equal(oldest.lastActive) && s.id < oldest.id) {
			oldest = s
		}
	}
	return oldest
}

// requestEvictLocked marks one concrete resident engine for silent recycling.
// The returned cancel must run after releasing p.mu: process teardown can call
// engineStopped and must never re-enter the pool under this lock.
func (p *sessionPool) requestEvictLocked(s *liveSession) context.CancelFunc {
	if s == nil || !s.resident || s.active || s.evictRequested {
		return nil
	}
	s.evictRequested = true
	s.idleGeneration++
	if s.warmTimer != nil {
		s.warmTimer.Stop()
		s.warmTimer = nil
	}
	p.signalLocked(s)
	return s.engineCancel
}

// evictWarmExcessLocked enforces "warm uses idle capacity" after an active
// permit is acquired or maxConcurrent is lowered. A nil cancel is intentional:
// the engine may only be reserved/starting; engineStarted observes
// evictRequested and cancels it as soon as the cancel func exists.
func (p *sessionPool) evictWarmExcessLocked() []context.CancelFunc {
	allowed := p.max - p.activeCountLocked()
	if allowed < 0 {
		allowed = 0
	}
	var cancels []context.CancelFunc
	for p.warmCountLocked() > allowed {
		victim := p.oldestWarmLocked("")
		if victim == nil {
			break
		}
		if cancel := p.requestEvictLocked(victim); cancel != nil {
			cancels = append(cancels, cancel)
		}
	}
	return cancels
}

func runCancels(cancels []context.CancelFunc) {
	for _, cancel := range cancels {
		if cancel != nil {
			cancel()
		}
	}
}

// register adds a new supervisor. Reclaimed AWAITING_INPUT sessions register
// cold/inactive; a normal claim registers active and will reserve an engine in
// runInteractiveSession.
func (p *sessionPool) register(job *ClaimedSession, cancel context.CancelFunc, active bool) (*liveSession, bool) {
	p.mu.Lock()
	if existing := p.sessions[job.SessionID]; existing != nil {
		p.mu.Unlock()
		return existing, false
	}
	s := &liveSession{
		id:               job.SessionID,
		cancel:           cancel,
		job:              job,
		active:           active,
		permitGeneration: 0,
		wake:             make(chan struct{}),
		done:             make(chan struct{}),
		lastActive:       p.clock.Now(),
	}
	if active {
		s.permitGeneration = 1
	}
	p.sessions[s.id] = s
	if active {
		p.fenceWorktreeOperationLocked(s.id)
	} else {
		p.releaseWorktreeFenceLocked(s.id, s)
	}
	cancels := p.evictWarmExcessLocked()
	p.signalLocked(s)
	p.mu.Unlock()
	runCancels(cancels)
	return s, true
}

// installDetach gives an active supervisor a no-finalize cancellation path. A
// cold supervisor has not entered runInteractiveSession yet; detachForTakeover
// falls back to its whole-supervisor cancel and the cold wrapper checks detaching.
func (p *sessionPool) installDetach(s *liveSession, detach context.CancelFunc) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s {
		return true
	}
	s.detach = detach
	return s.detaching
}

func (p *sessionPool) startDetachLocked(s *liveSession) (<-chan struct{}, context.CancelFunc) {
	p.fenceWorktreeOperationLocked(s.id)
	if !s.detaching {
		s.detaching = true
		if s.warmTimer != nil {
			s.warmTimer.Stop()
			s.warmTimer = nil
		}
		p.signalLocked(s)
	}
	cancel := s.detach
	if cancel == nil {
		cancel = s.cancel
	}
	return s.done, cancel
}

// detachForTakeover retires one local supervisor epoch without finalizing the
// control-plane Session. The caller must wait for done before restoring the
// process owner or starting a replacement against the same worktree/credential.
func (p *sessionPool) detachForTakeover(id string) (<-chan struct{}, bool) {
	p.mu.Lock()
	s := p.sessions[id]
	if s == nil {
		p.mu.Unlock()
		return nil, false
	}
	done, cancel := p.startDetachLocked(s)
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return done, true
}

// detachExpectedForTakeover is the heartbeat form of detachForTakeover. It acts
// only when the advertised supervisor is still current, closing the response-ABA
// race where an old heartbeat returns after a replacement epoch was registered.
func (p *sessionPool) detachExpectedForTakeover(expected *liveSession) (<-chan struct{}, bool) {
	if expected == nil {
		return nil, false
	}
	p.mu.Lock()
	if p.sessions[expected.id] != expected {
		p.mu.Unlock()
		return nil, false
	}
	done, cancel := p.startDetachLocked(expected)
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return done, true
}

func (p *sessionPool) isDetaching(s *liveSession) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[s.id] != s || s.detaching
}

func (p *sessionPool) detachingDone(id string) (<-chan struct{}, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sessions[id]
	if s == nil || !s.detaching {
		return nil, false
	}
	return s.done, true
}

// beginFinalization linearizes local git finalization against a takeover detach.
// If this check wins, a later takeover still waits for done before touching the
// worktree; if detach won, the predecessor must perform no local finalization.
func (p *sessionPool) beginFinalization(ctx context.Context, s *liveSession) bool {
	p.mu.Lock()
	if p.sessions[s.id] != s || s.detaching {
		p.mu.Unlock()
		return false
	}
	done := p.fenceWorktreeOperationLocked(s.id)
	p.mu.Unlock()
	if done == nil {
		return true
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// activate consumes a server-side claim. A resident warm engine is reused; a
// cold/evicting supervisor is woken and will reserve capacity before spawning.
func (p *sessionPool) activate(job *ClaimedSession) (*liveSession, bool) {
	return p.activatePrepared(job, nil)
}

// activatePrepared runs prepare while the exact reusable supervisor is locked,
// then publishes the claim and wakeup. Credential staging uses this hook so a
// heartbeat cannot begin detaching the epoch between staging and activation.
func (p *sessionPool) activatePrepared(job *ClaimedSession, prepare func()) (*liveSession, bool) {
	p.mu.Lock()
	s := p.sessions[job.SessionID]
	if s == nil || s.detaching {
		p.mu.Unlock()
		return nil, false
	}
	if state := p.worktreeOps[job.SessionID]; state != nil && state.running {
		p.mu.Unlock()
		return nil, false
	}
	if prepare != nil {
		prepare()
	}
	// Runner-local worktree state is not present in a claim payload. Carry it
	// across so heartbeats and the cold-resume process keep using the same checkout.
	if s.job != nil {
		job.WT = s.job.WT
		job.IsolationStatus = s.job.IsolationStatus
	}
	s.job = job
	s.active = true
	p.fenceWorktreeOperationLocked(s.id)
	s.permitGeneration++
	s.idleGeneration++
	if s.warmTimer != nil {
		s.warmTimer.Stop()
		s.warmTimer = nil
	}
	cancels := p.evictWarmExcessLocked()
	p.signalLocked(s)
	p.mu.Unlock()
	runCancels(cancels)
	return s, true
}

// park releases the active-turn permit only after /turn-complete has durably
// moved the control-plane session to AWAITING_INPUT. The engine remains resident
// and warm until its timer or LRU pressure recycles it.
//
// The timer wound here is one warmEngineTTL, with nothing that renews it: whatever
// this session left running does not belong to the engine any more. lastActive, set
// just below, is the LRU order.
func (p *sessionPool) park(s *liveSession, expectedPermit uint64) {
	p.mu.Lock()
	if p.sessions[s.id] != s || !s.active || s.permitGeneration != expectedPermit {
		p.mu.Unlock()
		return
	}
	s.active = false
	p.releaseWorktreeFenceLocked(s.id, s)
	s.lastActive = p.clock.Now()
	s.idleGeneration++
	idleGeneration := s.idleGeneration
	if s.warmTimer != nil {
		s.warmTimer.Stop()
	}
	if s.resident && !s.evictRequested {
		s.warmTimer = p.clock.AfterFunc(warmEngineTTL, func() {
			p.expireWarm(s, idleGeneration)
		})
	} else {
		s.warmTimer = nil
	}
	p.signalLocked(s)
	p.mu.Unlock()
}

func (p *sessionPool) permitGeneration(s *liveSession) uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s || !s.active || s.detaching {
		return 0
	}
	return s.permitGeneration
}

// expireWarm recycles a warm engine when its TTL elapses. Nothing defers it: a
// supervisor's background jobs are the runner's own children and keep running.
func (p *sessionPool) expireWarm(s *liveSession, idleGeneration uint64) {
	p.mu.Lock()
	if p.sessions[s.id] != s || s.active || !s.resident || s.evictRequested ||
		s.idleGeneration != idleGeneration {
		p.mu.Unlock()
		return
	}
	cancel := p.requestEvictLocked(s)
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// waitActive keeps a cold supervisor cheap while its Orbit session remains
// AWAITING_INPUT. shutdown is separate from session cancellation: shutdown must
// detach without /complete, while a real cancel must finalize normally.
func (p *sessionPool) waitActive(s *liveSession, sessionCtx, shutdown context.Context) bool {
	for {
		p.mu.Lock()
		if p.sessions[s.id] != s || s.detaching {
			p.mu.Unlock()
			return false
		}
		if s.active {
			p.mu.Unlock()
			return true
		}
		wake := s.wake
		p.mu.Unlock()
		select {
		case <-wake:
		case <-sessionCtx.Done():
			return false
		case <-shutdown.Done():
			return false
		}
	}
}

// reserveEngine waits until starting this cold active session cannot exceed the
// resident-engine cap. It requests LRU warm eviction as needed, then counts the
// new engine as resident before the process is spawned.
func (p *sessionPool) reserveEngine(s *liveSession, sessionCtx, shutdown context.Context) (uint64, *ClaimedSession, bool) {
	for {
		p.mu.Lock()
		if p.sessions[s.id] != s || !s.active || s.detaching {
			p.mu.Unlock()
			return 0, nil, false
		}
		if s.resident {
			gen, job := s.engineGeneration, s.job
			p.mu.Unlock()
			return gen, job, true
		}
		if p.residentCountLocked() < p.max {
			s.resident = true
			s.engineGeneration++
			s.engineCancel = nil
			s.evictRequested = false
			s.agentMcpServers = agentMcpServerNames(s.job)
			gen, job := s.engineGeneration, s.job
			p.signalLocked(s)
			p.mu.Unlock()
			return gen, job, true
		}

		victim := p.oldestWarmLocked(s.id)
		cancel := p.requestEvictLocked(victim)
		changed := p.changed
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		select {
		case <-changed:
		case <-sessionCtx.Done():
			return 0, nil, false
		case <-shutdown.Done():
			return 0, nil, false
		}
	}
}

// engineStarted installs the cancel func for the exact reserved generation. If
// timer/LRU eviction won the race while exec.Cmd was starting, it asks the caller
// to cancel immediately.
func (p *sessionPool) engineStarted(s *liveSession, generation uint64, cancel context.CancelFunc) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s || !s.resident || s.engineGeneration != generation || s.detaching {
		return true
	}
	s.engineCancel = cancel
	return s.evictRequested
}

// engineStopped releases resident capacity only after cmd.Wait/app.close has
// completed. The return value identifies a silent warm eviction, which must not
// finalize the Orbit session.
func (p *sessionPool) engineStopped(s *liveSession, generation uint64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s || !s.resident || s.engineGeneration != generation {
		return false
	}
	evicted := s.evictRequested
	s.resident = false
	s.engineCancel = nil
	s.evictRequested = false
	if s.warmTimer != nil {
		s.warmTimer.Stop()
		s.warmTimer = nil
	}
	p.signalLocked(s)
	return evicted
}

func (p *sessionPool) latestJob(s *liveSession) *ClaimedSession {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s {
		return nil
	}
	return s.job
}

func (p *sessionPool) isActive(s *liveSession) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[s.id] == s && s.active && !s.detaching
}

// engineResident reports whether this supervisor currently has an engine process,
// which is the difference between warm and cold. A cold session has nobody to read
// what its background jobs did, so it is the one that has to be told out of band.
//
// Takes p.mu, so a caller holding another lock must not be one the pool calls back
// into under p.mu. The pool holds no callback into the tailer any more, so nothing
// inverts today — see finishJob, which asks after releasing the tailer's anyway.
func (p *sessionPool) engineResident(s *liveSession) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[s.id] == s && s.resident
}

func (p *sessionPool) remove(s *liveSession) {
	p.mu.Lock()
	if p.sessions[s.id] == s {
		if s.warmTimer != nil {
			s.warmTimer.Stop()
			s.warmTimer = nil
		}
		delete(p.sessions, s.id)
		p.signalLocked(s)
	}
	p.mu.Unlock()
}

// finish publishes supervisor completion only after its map entry has been
// removed. A takeover waiter may then safely stage credentials and touch the
// worktree for the replacement epoch.
func (p *sessionPool) finish(s *liveSession) {
	p.mu.Lock()
	if p.sessions[s.id] == s {
		if s.warmTimer != nil {
			s.warmTimer.Stop()
			s.warmTimer = nil
		}
		delete(p.sessions, s.id)
		if !s.detaching {
			p.releaseWorktreeFenceLocked(s.id, nil)
		}
		p.signalLocked(s)
	}
	p.mu.Unlock()
	s.doneOnce.Do(func() { close(s.done) })
}

func (p *sessionPool) setMax(max int) {
	if max < 1 {
		max = 1
	}
	p.mu.Lock()
	p.max = max
	cancels := p.evictWarmExcessLocked()
	p.signalLocked(nil)
	p.mu.Unlock()
	runCancels(cancels)
}

func (p *sessionPool) maxConcurrent() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.max
}

func (p *sessionPool) activeCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.activeCountLocked()
}

func (p *sessionPool) residentCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.residentCountLocked()
}

func (p *sessionPool) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sessions)
}

// heartbeatSnapshot retains every supervisor in the control/lease snapshot, but
// returns only active turns for live worktree telemetry. Cold and warm sessions
// keep their lease without paying for a full Git scan every 30 seconds.
func (p *sessionPool) heartbeatSnapshot() (map[string]heartbeatSupervisorSnapshot, []heartbeatTelemetryTarget) {
	p.mu.Lock()
	defer p.mu.Unlock()
	supervisors := make(map[string]heartbeatSupervisorSnapshot, len(p.sessions))
	targets := make([]heartbeatTelemetryTarget, 0, p.activeCountLocked())
	for id, s := range p.sessions {
		supervisors[id] = heartbeatSupervisorSnapshot{
			supervisor:       s,
			permitGeneration: s.permitGeneration,
			cancel:           s.cancel,
		}
		if s.active && s.job != nil {
			targets = append(targets, heartbeatTelemetryTarget{
				supervisor:       s,
				sessionID:        s.job.SessionID,
				isolationStatus:  s.job.IsolationStatus,
				worktree:         s.job.WT.heartbeatCopy(),
				permitGeneration: s.permitGeneration,
			})
		}
	}
	return supervisors, targets
}

func (p *sessionPool) ids() map[string]bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make(map[string]bool, len(p.sessions))
	for id := range p.sessions {
		ids[id] = true
	}
	// GC is the third destructive operation, and the bluntest: it deletes the
	// directory. A checkout with a live writer is never a candidate, supervisor
	// or no supervisor.
	for id := range p.bgJobs {
		ids[id] = true
	}
	return ids
}

// reclaimStates snapshots whether each locally known supervisor already owns an
// active-turn permit. An ambiguous claim must revive a known cold/warm session
// when reclaim says RUNNING, while a genuinely active one must not be activated
// twice and advance its permit generation.
func (p *sessionPool) reclaimStates() map[string]bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	states := make(map[string]bool, len(p.sessions))
	for id, session := range p.sessions {
		states[id] = session.active
	}
	return states
}

func (p *sessionPool) providerCount(provider string, activeOnly bool) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, s := range p.sessions {
		if activeOnly && !s.active {
			continue
		}
		if !activeOnly && !s.resident {
			continue
		}
		if runtimeProvider(s.job) == provider {
			n++
		}
	}
	return n
}
