package main

import (
	"context"
	"sync"
	"time"
)

// warmEngineTTL is how long an idle interactive engine is kept for a zero-startup
// continuation. The Orbit session itself remains resumable after this expires; only
// the local coding-runtime supervisor is recycled.
const warmEngineTTL = 4 * time.Hour

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
	changed     chan struct{}
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
	state := p.worktreeOpLocked(id)
	if state.fenced || state.running {
		p.mu.Unlock()
		return nil, false
	}
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

// oldestWarmLocked returns the LRU warm process that is not already on its way
// out. Stable id ordering breaks equal-timestamp ties, making behavior and tests
// deterministic.
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
