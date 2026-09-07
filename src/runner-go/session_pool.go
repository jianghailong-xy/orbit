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
const warmEngineTTL = 4 * time.Hour

// warmResidencyHardCap is the absolute ceiling on one idle engine's warm residency,
// every background-job renewal included. The renewal below exists because a parked
// session's Bash(run_in_background) children are children of the engine process, so
// recycling the engine reports them killed — but a renewal a still-running process can
// refresh is a renewal a forgotten `vite` refreshes forever, and this host has a
// global-OOM history (2026-08-31: five runner drops in one day, swap fully consumed).
// Peak memory is already bounded elsewhere — warm engines never exceed the resident
// cap — so what this bounds is how long one abandoned session may hold a slot.
//
// 12h = 3x warmEngineTTL: two renewals, enough for a genuinely long job to outlive a
// session parked without a human present, and the slot still comes back inside a day.
//
// Stage-0 stopgap. Stage 3 makes background jobs runner-owned rather than engine
// children, at which point this constant, the probe, and both deferrals come out.
const warmResidencyHardCap = 12 * time.Hour

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

	idleGeneration uint64
	warmTimer      poolTimer
	lastActive     time.Time // LRU key: when active -> warm most recently

	// Stage-0 stopgap: read-only liveness query into this run's bgTailer, so warm
	// eviction can see work the active turn permit does not represent. A plain
	// func keeps the tailer out of the pool; it is called under p.mu and must
	// therefore never re-enter the pool (bgTailer takes only its own lock).
	bgJobsLive func() bool
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
// The engine counts only while it can actually write: a turn is running, or one
// of its background shells is still alive. A parked engine with neither writes
// nothing — being a warm process waiting for the next turn is its entire job —
// and counting it anyway would fence every merge on a warm session for the four
// hours of warmEngineTTL.
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

// backgroundJobCounts reports, per session, how many runner-hosted background
// jobs are alive right now. Stage 0 could only ask "is this session doing
// something", and only through the turn permit, which is why recycling an engine
// could silently destroy an agent's build. This is the number, not the bit:
// stage 3 spends it as capacity, and until then it is what makes the work
// visible at all.
func (p *sessionPool) backgroundJobCounts() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
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

// setBackgroundJobProbe installs one session run's background-job liveness query
// and returns the deregistration func. The supervisor pointer is the epoch token:
// a probe belonging to a superseded run can neither install onto nor uninstall
// from its replacement.
func (p *sessionPool) setBackgroundJobProbe(s *liveSession, probe func() bool) func() {
	p.mu.Lock()
	if p.sessions[s.id] == s {
		s.bgJobsLive = probe
	}
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		if p.sessions[s.id] == s {
			s.bgJobsLive = nil
		}
		p.mu.Unlock()
	}
}

// warmResidencyDeadlineLocked returns the instant after which this warm supervisor
// stops being deferred for its background job, or the zero time when no deferral
// applies at all (no probe registered, or no job running). lastActive is when the
// supervisor went warm, so it is both the LRU key and the start of the capped window.
//
// This is the only place the cap is expressed. Both deferrals below read it, so a
// supervisor cannot be spared by one and capped by the other.
func (p *sessionPool) warmResidencyDeadlineLocked(s *liveSession) time.Time {
	if s.bgJobsLive == nil || !s.bgJobsLive() {
		return time.Time{}
	}
	return s.lastActive.Add(warmResidencyHardCap)
}

// sparedForBackgroundJobLocked reports whether this warm supervisor still earns the
// stage-0 deferral: a live background job, and warm residency not yet spent.
func (p *sessionPool) sparedForBackgroundJobLocked(s *liveSession) bool {
	return p.clock.Now().Before(p.warmResidencyDeadlineLocked(s))
}

// oldestWarmLocked returns the LRU warm process that is not already on its way
// out. Stable id ordering breaks equal-timestamp ties, making behavior and tests
// deterministic.
//
// Stage-0 stopgap: a supervisor spared for a live background job sorts after every
// supervisor that is not, so it is chosen only when nothing else is left. That is a
// deprioritization, not an exemption — real capacity pressure still recycles it, and
// so does warmResidencyHardCap, which ends the deferral outright.
func (p *sessionPool) oldestWarmLocked(except string) *liveSession {
	var oldest *liveSession
	oldestSpared := false
	for _, s := range p.sessions {
		if s.id == except || !s.resident || s.active || s.evictRequested {
			continue
		}
		spared := p.sparedForBackgroundJobLocked(s)
		if oldest == nil || (oldestSpared && !spared) ||
			(spared == oldestSpared &&
				(s.lastActive.Before(oldest.lastActive) ||
					(s.lastActive.Equal(oldest.lastActive) && s.id < oldest.id))) {
			oldest, oldestSpared = s, spared
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
// The timer wound here is always one warmEngineTTL; a session with a live background
// job renews it from expireWarm rather than starting longer, so a job that finishes
// during the first window costs nothing. lastActive, set just below, anchors both the
// LRU order and the warmResidencyHardCap window those renewals run out of.
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

// warmRenewalLocked returns how much longer a warm engine may be held for a live
// background job, or 0 to recycle it now. One warmEngineTTL at a time, and never past
// warmResidencyHardCap — so the renewal is a bounded number of extensions, not a loop
// a still-running process can keep alive.
func (p *sessionPool) warmRenewalLocked(s *liveSession) time.Duration {
	remaining := p.warmResidencyDeadlineLocked(s).Sub(p.clock.Now())
	if remaining <= 0 {
		return 0
	}
	if remaining < warmEngineTTL {
		return remaining
	}
	return warmEngineTTL
}

// expireWarm recycles a warm engine when its TTL elapses. Stage-0 stopgap: a
// supervisor still running a background job rewinds the timer instead, under the same
// idleGeneration — a claim that arrives meanwhile bumps that generation and defuses
// the renewed timer exactly as it defused the original one.
func (p *sessionPool) expireWarm(s *liveSession, idleGeneration uint64) {
	p.mu.Lock()
	if p.sessions[s.id] != s || s.active || !s.resident || s.evictRequested ||
		s.idleGeneration != idleGeneration {
		p.mu.Unlock()
		return
	}
	if renewal := p.warmRenewalLocked(s); renewal > 0 {
		s.warmTimer = p.clock.AfterFunc(renewal, func() {
			p.expireWarm(s, idleGeneration)
		})
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
// into under p.mu (bgJobsLive is exactly that) — see finishJob, which asks after
// releasing the tailer's.
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
