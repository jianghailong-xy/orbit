package main

import (
	"context"
	"sync"
	"time"
)

// warmEngineTTL is how long an idle interactive engine is kept for a zero-startup
// continuation. The Orbit session itself remains resumable after this expires; only
// the local Claude/Codex process is recycled.
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
// one concrete Claude/Codex process so a late Wait from an evicted process cannot
// clear a replacement process that has already started.
type liveSession struct {
	id     string
	cancel context.CancelFunc // whole supervisor: real end/cancel only
	job    *ClaimedSession    // newest claim payload; consumed before a cold spawn
	wake   chan struct{}

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

// sessionPool owns both concurrency resources:
//   - at most max active turn permits;
//   - at most max resident engines (active + warm).
//
// Warm engines only consume capacity not promised to active turns. Activating a
// cold session therefore evicts the least-recently-active warm engine first. The
// victim remains counted as resident until its process Wait completes, so a new
// process can never transiently push resident engines over max.
type sessionPool struct {
	mu       sync.Mutex
	max      int
	clock    poolClock
	sessions map[string]*liveSession
	changed  chan struct{}
}

func newSessionPool(max int) *sessionPool {
	return newSessionPoolWithClock(max, realPoolClock{})
}

func newSessionPoolWithClock(max int, clock poolClock) *sessionPool {
	if max < 1 {
		max = 1
	}
	return &sessionPool{
		max:      max,
		clock:    clock,
		sessions: map[string]*liveSession{},
		changed:  make(chan struct{}),
	}
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
		lastActive:       p.clock.Now(),
	}
	if active {
		s.permitGeneration = 1
	}
	p.sessions[s.id] = s
	cancels := p.evictWarmExcessLocked()
	p.signalLocked(s)
	p.mu.Unlock()
	runCancels(cancels)
	return s, true
}

// activate consumes a server-side claim. A resident warm engine is reused; a
// cold/evicting supervisor is woken and will reserve capacity before spawning.
func (p *sessionPool) activate(job *ClaimedSession) (*liveSession, bool) {
	p.mu.Lock()
	s := p.sessions[job.SessionID]
	if s == nil {
		p.mu.Unlock()
		return nil, false
	}
	// Runner-local worktree state is not present in a claim payload. Carry it
	// across so heartbeats and the cold-resume process keep using the same checkout.
	if s.job != nil {
		job.WT = s.job.WT
		job.IsolationStatus = s.job.IsolationStatus
	}
	s.job = job
	s.active = true
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
	if p.sessions[s.id] != s || !s.active {
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
		if p.sessions[s.id] != s {
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
		if p.sessions[s.id] != s || !s.active {
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
	if p.sessions[s.id] != s || !s.resident || s.engineGeneration != generation {
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
	return p.sessions[s.id] == s && s.active
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

func (p *sessionPool) snapshot() (map[string]context.CancelFunc, []*ClaimedSession) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cancels := make(map[string]context.CancelFunc, len(p.sessions))
	jobs := make([]*ClaimedSession, 0, len(p.sessions))
	for id, s := range p.sessions {
		cancels[id] = s.cancel
		jobs = append(jobs, s.job)
	}
	return cancels, jobs
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
