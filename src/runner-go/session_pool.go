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
// The value is the owner's decision, not something derived here: on 2026-09-12 the
// owner set it to four hours. A warm engine saves the next turn's startup and holds
// its resident memory while it waits, but this TTL is not what bounds that memory —
// the pool is. Resident engines, active and warm together, are capped at
// maxConcurrent, and warm ones only hold capacity no active turn is promised: a turn
// that needs the slot evicts the least-recently-active warm engine first. A longer
// TTL therefore means fewer cold starts, and once the pool is full it is LRU eviction,
// not this timer, that recycles engines.
//
// Measured on this host on 2026-09-12: nine engines at 1826 MB PSS together (~200 MB
// each), 13.4 GB of memory available, all 8191 MB of swap in use. maxConcurrent is 16
// in this host's config and the control plane lowers it to 12, so resident engines
// top out near 2.4 GB here, and near 3.2 GB at 16.
const warmEngineTTL = 4 * time.Hour

// warmResidencyHardCap is the absolute ceiling on one idle engine's warm residency, every
// renewal for a live Monitor included. A Monitor runs its watch command inside the engine
// process, so recycling the engine ends a watch the agent asked for and is waiting on, and
// Claude writes a <task-notification> only for a Monitor that ends by itself: the wait is
// simply gone (stage 1 reports it; this is the part that does not do it in the first place).
//
// The pin is a deferral, not an exemption. But a deferral that a running process renews is a
// deferral a Monitor that watches forever renews forever, and this host has a global-OOM
// history (2026-08-31: five runner drops in one day, swap fully consumed). Peak memory is
// bounded elsewhere — warm engines never exceed the resident cap — so what this bounds is how
// long one watch may hold a slot: 12h, measured from the end of the last turn Orbit delivered
// (liveSession.lastOrbitTurnAt). Long enough to outlive a watch somebody still has a session
// open for, and the slot comes back inside a day.
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
	// selfDrivenTurn: this resident engine is running a turn Orbit did not deliver — a
	// Monitor event, a <task-notification>, a ScheduleWakeup. It holds no permit, and it
	// is not idle either, so nothing that recycles warm engines takes it (engineTurnEvent).
	selfDrivenTurn bool

	idleGeneration uint64
	warmTimer      poolTimer
	lastActive     time.Time // LRU key: when active -> warm most recently
	// lastOrbitTurnAt is when the last turn ORBIT delivered ended — park, and nothing else. The
	// warm timer moves lastActive at the end of a turn the engine started on its own, and the
	// Monitor pin must not move with it: an engine a Monitor keeps waking would otherwise push
	// its own ceiling forward on every wake and never reach it.
	lastOrbitTurnAt time.Time

	// monitorProbe is this run's read-only "does the engine still have a Monitor running"
	// query, and nil where no tailer is at stake. A plain func keeps the tailer out of the
	// pool. It is called under p.mu, and the tailer calls into the pool from under its own
	// lock (bgTailer.holdFor), so it must be lock-free on the tailer's side.
	monitorProbe func() bool
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
	// takeovers counts the supervisor takeovers holding the fence open. A takeover that meets a
	// detaching predecessor holds it across the gap where this session has no supervisor at all —
	// from the predecessor's cleanup to the replacement's registration — and that one has no
	// supervisor to belong to, so each takeover releases its own hold. A takeover that reuses a
	// live supervisor holds it with that supervisor still active and parkable, which is why no
	// supervisor's lifecycle may lower the fence while this is non-zero: the count lives in this
	// entry, and the park that lowered the fence would take the entry — and the hold — with it.
	takeovers int
}

// worktreeHolder is one reason a session's checkout is not free right now. A
// refused merge or commit names the holders that refused it, and one that runs
// names the live background jobs it ran beside; the turn permit alone used to
// stand in for the set, which made every writer that outlives its turn invisible.
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
	// watch marks a runner-hosted job that only waits (bgKindWatch): it holds the checkout like
	// any other, and is no capacity.
	watch bool
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
	// name a receipt calls it, and whether the runner hosts it. A shell is a writer
	// of the checkout for exactly as long as it runs, and it routinely outlives the
	// turn that launched it.
	bgJobs map[string]map[string]bgHold
	// hostless is sessionID → the runner-hosted jobs of that session no supervisor hosts right now:
	// handed on by a supervisor whose runner is re-executing into a self-update, or adopted from their
	// records before any supervisor started (background_job_handoff.go). The pool keeps them because it
	// outlives supervisors, and a session that stays cold has none.
	hostless map[string][]*bgJob
	changed  chan struct{}
	// closedForUpdate is set once, by closeForUpdate, when this runner has decided to re-execute
	// into a newer release; from then on no turn begins here (waitActive).
	closedForUpdate bool
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

// sessionIDs is every session this process supervises right now, in whatever state: a cold
// supervisor holds no engine, but it is still this runner's session and the next claim resumes it in
// the account its state was opened under.
func (p *sessionPool) sessionIDs() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make([]string, 0, len(p.sessions))
	for id := range p.sessions {
		ids = append(ids, id)
	}
	return ids
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
// checkout: the engine while a turn runs in it, every live background job, and a
// manual operation that has already linearized. It says who is there, not who may
// proceed — the fence and `running` decide that (beginHeartbeatWorktreeOperation).
//
// The turn's engine and a running operation are what refuse a merge or commit, and
// the refusal names them (worktreeOperationRefusal). A background job refuses
// nothing: a merge replays committed work in a scratch worktree and a commit writes
// only the index and refs, so both run beside a live job and name it in their
// receipt (beginManualWorktreeOperation). The worktree GC, which deletes the
// directory, is the one thing a live job holds off (ids).
//
// A parked engine is no holder at all, whatever it left running: between turns
// neither it nor its MCP servers — Orbit's own, or any the agent configured — are
// waited on or stopped for a merge or commit.
func (p *sessionPool) worktreeHoldersLocked(id string) []worktreeHolder {
	names := make([]string, 0, len(p.bgJobs[id]))
	for _, hold := range p.bgJobs[id] {
		names = append(names, hold.name)
	}
	sort.Strings(names) // a receipt reads the same twice
	var holders []worktreeHolder
	if s := p.sessions[id]; s != nil && s.resident && s.active {
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
			if hold.runnerHosted && !hold.watch {
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
// the unit that new work displaces. A watch is not among those jobs: it only waits.
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

// holdWorktreeForBackgroundJob records one background shell as a live writer of
// the session's checkout. The hold raises no fence: a merge or commit runs beside a
// live writer and names it in its receipt. jobID is the launching tool_use id; name
// is what that receipt will call it.
func (p *sessionPool) holdWorktreeForBackgroundJob(sessionID, jobID, name string) {
	p.holdWorktreeWriter(sessionID, jobID, bgHold{name: name})
}

// holdWorktreeForRunnerJob records the same hold for a job the RUNNER spawned and
// owns. It holds the checkout identically — a writer is a writer — and is
// additionally counted, because this is the work that survives engine eviction
// and therefore the work a capacity account has to know about.
func (p *sessionPool) holdWorktreeForRunnerJob(sessionID, jobID, name string) {
	p.holdWorktreeWriter(sessionID, jobID, bgHold{name: name, runnerHosted: true})
}

// holdWorktreeForRunnerWatch records the hold of a watch the runner hosts: the checkout
// is held as for any runner-hosted job, and the watch is not counted, because a job
// that only waits costs this machine nothing.
func (p *sessionPool) holdWorktreeForRunnerWatch(sessionID, jobID, name string) {
	p.holdWorktreeWriter(sessionID, jobID, bgHold{name: name, runnerHosted: true, watch: true})
}

func (p *sessionPool) holdWorktreeWriter(sessionID, jobID string, hold bgHold) {
	if sessionID == "" || jobID == "" {
		return
	}
	if hold.name == "" {
		hold.name = jobID
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	jobs := p.bgJobs[sessionID]
	if jobs == nil {
		jobs = map[string]bgHold{}
		p.bgJobs[sessionID] = jobs
	}
	jobs[jobID] = hold
}

// releaseWorktreeBackgroundJob retires one background shell's hold.
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

func (h sessionWorktreeHolds) holdRunnerWatch(jobID, name string) {
	h.pool.holdWorktreeForRunnerWatch(h.sessionID, jobID, name)
}

func (h sessionWorktreeHolds) releaseWorktree(jobID string) {
	h.pool.releaseWorktreeBackgroundJob(h.sessionID, jobID)
}

// worktreeOperationRefusal is the sentence a refused merge or commit sends back to
// the control plane in place of doing the work. It names what refuses one — a
// turn's engine, an operation already running — and never a background job, which
// refuses nothing. It is read immediately after the refusal, in the same goroutine:
// a holder that ended in between only downgrades the message to the supersession
// wording — it can never turn a refusal into a pass, because
// beginHeartbeatWorktreeOperation already decided.
func (p *sessionPool) worktreeOperationRefusal(id, operation string) string {
	p.mu.Lock()
	holders := p.worktreeHoldersLocked(id)
	p.mu.Unlock()
	names := make([]string, 0, len(holders))
	for _, h := range holders {
		if h.kind != worktreeHeldByBackgroundJob {
			names = append(names, h.String())
		}
	}
	if len(names) == 0 {
		// Nothing that refuses holds it: the server claimed this exact epoch before
		// returning the heartbeat, which is a different fact and reads differently.
		return operation + " was superseded before local execution"
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

// beginWorktreeTakeover closes admission before a claim/takeover. It returns the exact
// in-flight operation's completion barrier, if any, and the release that ends the takeover.
//
// The release is what keeps this fence from outliving its reason. A fence a supervisor
// raises is lowered by that same supervisor's lifecycle (park, register, finish); this one is
// not a supervisor's — it is raised for a row whose supervisor is being replaced, and for as
// long as it is held even a live supervisor may not lower it (releaseWorktreeFenceLocked) —
// so the takeover lowers its own, for whatever supervisor the map holds by then or for none.
// Callers release once they have started the replacement supervisor or given the row up —
// both, because a row given up is exactly the case that used to leave a checkout fenced for
// the life of the process.
func (p *sessionPool) beginWorktreeTakeover(id string) (<-chan struct{}, func()) {
	p.mu.Lock()
	done := p.fenceWorktreeOperationLocked(id)
	state := p.worktreeOps[id]
	state.takeovers++
	p.mu.Unlock()

	var once sync.Once
	return done, func() {
		once.Do(func() {
			p.mu.Lock()
			if current := p.worktreeOps[id]; current == state && state.takeovers > 0 {
				state.takeovers--
				// A supervisor that is ACTIVE meanwhile owns the fence under its own rules and
				// lowers it in its own lifecycle; releaseWorktreeFenceLocked lowers it for an id
				// nobody took. A parked or cold one took nothing: it already lowered the fence it
				// raised, and it will not run another park until a turn gives it one, so this hold
				// has to come down here or it stays up until that turn ends or the engine is
				// evicted — the fence-outliving-its-reason shape of the 2026-09-15 incident.
				if state.takeovers == 0 {
					if supervisor := p.sessions[id]; supervisor == nil || !supervisor.active {
						p.releaseWorktreeFenceLocked(id, supervisor)
					}
				}
			}
			p.mu.Unlock()
		})
	}
}

func (p *sessionPool) releaseWorktreeFenceLocked(id string, expected *liveSession) {
	if p.sessions[id] != expected {
		return
	}
	state := p.worktreeOps[id]
	if state == nil {
		return
	}
	// A takeover is holding this fence open, and only that takeover's own release ends it. A
	// supervisor's lifecycle runs inside the same window — a takeover that matches the process
	// owner leaves its supervisor alive, so the turn that was already ending when the claim
	// arrived still parks — and lowering here takes the takeover's hold down with it: the count
	// lives in this entry, so the delete below loses it, and the release that was going to
	// lower the fence finds no entry to lower and no way to raise another.
	if state.takeovers > 0 {
		return
	}
	state.fenced = false
	if !state.running {
		delete(p.worktreeOps, id)
	}
}

// takeoverPendingLocked reports whether a supervisor takeover is holding this checkout's
// fence open right now. It is the difference between a fence something is still coming for
// and one nobody is.
func (p *sessionPool) takeoverPendingLocked(id string) bool {
	state := p.worktreeOps[id]
	return state != nil && state.takeovers > 0
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
	// A live background job is deliberately not asked about: a merge or commit runs
	// beside it (beginManualWorktreeOperation).
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

// beginManualWorktreeOperation is how merge and commit enter a checkout. It admits the
// operation exactly as beginHeartbeatWorktreeOperation does, and nothing else running in
// the checkout comes into that: a merge replays the branch's commits in a scratch worktree
// and never touches the checkout, and a commit writes only the index and refs. So a live
// background job holds neither up, and a parked engine is not stopped for either, whatever
// MCP servers it runs.
//
// Admitted, it returns the release func and the operation's receipt note, which names the
// live background jobs it runs beside ("" when there are none). Refused, it returns a nil
// release and the refusal itself.
func (p *sessionPool) beginManualWorktreeOperation(
	id string,
	expected *liveSession,
	expectedPermit uint64,
	requireSupervisor bool,
	operation string,
) (func(), string, bool) {
	release, admitted := p.beginHeartbeatWorktreeOperation(id, expected, expectedPermit, requireSupervisor)
	if !admitted {
		return nil, p.worktreeOperationRefusal(id, operation), false
	}
	p.mu.Lock()
	holders := p.worktreeHoldersLocked(id)
	p.mu.Unlock()
	var jobs []string
	for _, h := range holders {
		if h.kind == worktreeHeldByBackgroundJob {
			jobs = append(jobs, h.name)
		}
	}
	if len(jobs) == 0 {
		return release, "", true
	}
	beside := "this " + operation + " ran while background jobs were still running in the checkout (" +
		strings.Join(jobs, ", ") + ")"
	if operation == "commit" {
		// A commit reads the checkout as it stands, so whoever reads this receipt has to be
		// able to tell that a file those jobs were writing may have gone in half-written.
		return release, beside + ": a file one of them was still writing is committed as it stood at that moment", true
	}
	return release, beside + ": a merge takes only what the branch had already committed", true
}

// appendWorktreeReceipt puts an operation's receipt note after the operation's own message,
// so git's output stays the first thing a failed merge or commit says.
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

// turnsInFlightLocked counts the sessions a turn is running in right now: every permit holder — a
// permit is taken at the claim and handed back only once the turn's /turn-complete has landed, so a
// message, a `!` shell and an EXECUTABLE acceptance command are all counted from claim to settle —
// and every engine running a turn of its own, which holds no permit (selfDrivenTurn).
func (p *sessionPool) turnsInFlightLocked() int {
	n := 0
	for _, s := range p.sessions {
		if s.active || s.selfDrivenTurn {
			n++
		}
	}
	return n
}

// closeForUpdate is the only way a self-update gets to stop this runner: it succeeds only while no
// turn is in flight, and from then on no turn begins here. Otherwise it reports how many turns are
// running and changes nothing, and the update waits for a later check.
//
// The owner's rule (2026-09-25): an automatic update never evicts a running turn — the drain is
// for the water to run out by itself, not for pouring out what is still running. Stopping first
// and draining after had torn EXECUTABLE acceptance commands down within seconds of "update
// available", each reported as exit -1 and judged FAILED.
//
// Both halves are decided under one lock, so "nothing is running" is still true when the runner
// stops. A claim that lands after this gets its permit, but waitActive holds its turn back until
// the stop that follows, and the turn stays RUNNING for the updated runner to reclaim — the path
// a claim racing any runner stop already takes. It never starts, so there is nothing to tear down.
func (p *sessionPool) closeForUpdate() (turnsInFlight int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := p.turnsInFlightLocked(); n > 0 {
		return n
	}
	p.closedForUpdate = true
	return 0
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

// setMonitorProbe installs one session run's Monitor liveness query and returns the
// deregistration func. The supervisor pointer is the epoch token: a probe belonging to a
// superseded run can neither install onto nor uninstall from its replacement.
func (p *sessionPool) setMonitorProbe(s *liveSession, probe func() bool) func() {
	p.mu.Lock()
	if p.sessions[s.id] == s {
		s.monitorProbe = probe
	}
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		if p.sessions[s.id] == s {
			s.monitorProbe = nil
		}
		p.mu.Unlock()
	}
}

// monitorPinDeadlineLocked returns the instant after which this warm engine stops being held
// for its Monitor, or the zero time when nothing is holding it at all: no probe registered, no
// Monitor running, or the cap already spent. Past the cap a Monitor that is still running no
// longer defers anything, which is what makes the pin bounded.
//
// This is the only place the cap is expressed. Every path that can recycle a warm engine reads
// it — the timer (expireWarm, through warmTimerDelayLocked) and the victim search
// (oldestWarmLocked) — so no engine can be held by one and taken by the other.
//
// The window starts at the last turn Orbit delivered, never at lastActive: engineTurnEvent
// moves lastActive when a Monitor's own wake ends, and a pin measured from there would be
// renewed by the very Monitor it is bounding.
func (p *sessionPool) monitorPinDeadlineLocked(s *liveSession) time.Time {
	if s.monitorProbe == nil || !s.monitorProbe() {
		return time.Time{}
	}
	deadline := s.lastOrbitTurnAt.Add(warmResidencyHardCap)
	if !p.clock.Now().Before(deadline) {
		return time.Time{}
	}
	return deadline
}

// warmTimerDelayLocked is how long this engine's next warm timer runs: one warmEngineTTL, or
// whatever a live Monitor's pin has left of it when that is shorter. A pin is a deferral that
// is re-decided at every one of those timers, never a single long nap to the cap.
func (p *sessionPool) warmTimerDelayLocked(s *liveSession) time.Duration {
	delay := warmEngineTTL
	if deadline := p.monitorPinDeadlineLocked(s); !deadline.IsZero() {
		if remaining := deadline.Sub(p.clock.Now()); remaining < delay {
			delay = remaining
		}
	}
	return delay
}

// oldestWarmLocked returns the LRU warm process that is not already on its way
// out. Stable id ordering breaks equal-timestamp ties, making behavior and tests
// deterministic.
//
// Strict least-recently-active, with no exemption for any kind of work. The one
// exemption there ever was — a deferral for a supervisor with a live background job —
// is gone: that job is the runner's own child now, and survives the eviction it used
// to have to be spared from. An engine running a turn of its own is passed over like an
// active one, and for the same reason — a turn is running in it — never for anything it
// has left running in the background (engineTurnEvent).
//
// An engine still holding a live Monitor sorts after every engine that is not, so it is
// chosen only when nothing else is left. That is a deprioritization, not an exemption:
// capacity pressure still recycles it — a session waiting to start is never starved by a
// watch — and so does warmResidencyHardCap, which ends the pin outright. Either way the
// Monitor goes through killEngineShells and is reported killed, so the agent is told on
// resume rather than left waiting on events that will never come.
func (p *sessionPool) oldestWarmLocked(except string) *liveSession {
	var oldest *liveSession
	oldestPinned := false
	for _, s := range p.sessions {
		if s.id == except || !s.resident || s.active || s.evictRequested || s.selfDrivenTurn {
			continue
		}
		pinned := !p.monitorPinDeadlineLocked(s).IsZero()
		if oldest == nil || (oldestPinned && !pinned) ||
			(pinned == oldestPinned &&
				(s.lastActive.Before(oldest.lastActive) ||
					(s.lastActive.Equal(oldest.lastActive) && s.id < oldest.id))) {
			oldest, oldestPinned = s, pinned
		}
	}
	return oldest
}

// requestEvictLocked marks one concrete resident engine for silent recycling.
// The returned cancel must run after releasing p.mu: process teardown can call
// engineStopped and must never re-enter the pool under this lock. An engine with a
// turn running in it — Orbit's, or one of its own — is not recycled, and gets nil.
func (p *sessionPool) requestEvictLocked(s *liveSession) context.CancelFunc {
	if s == nil || !s.resident || s.active || s.evictRequested || s.selfDrivenTurn {
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
		// A registered session has no engine yet; park sets the real anchor. Well-defined
		// rather than zero so a pin can never be measured from the year 1.
		lastOrbitTurnAt: p.clock.Now(),
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
// The timer wound here is one warmEngineTTL, and nothing this session left running
// renews it: that work does not belong to the engine any more. A turn the engine
// runs on its own holds recycling off, and the end of that turn winds a fresh timer
// (engineTurnEvent). A Monitor still running in the engine defers it too, and re-defers at
// every timer, up to warmResidencyHardCap from this park (monitorPinDeadlineLocked).
// lastActive, set with the timer, is the LRU order.
func (p *sessionPool) park(s *liveSession, expectedPermit uint64) {
	p.mu.Lock()
	if p.sessions[s.id] != s || !s.active || s.permitGeneration != expectedPermit {
		p.mu.Unlock()
		return
	}
	s.active = false
	s.lastOrbitTurnAt = p.clock.Now()
	p.releaseWorktreeFenceLocked(s.id, s)
	p.armWarmTimerLocked(s)
	p.signalLocked(s)
	p.mu.Unlock()
}

// armWarmTimerLocked starts the warm TTL of an engine that has just gone idle, and makes
// now its LRU position.
func (p *sessionPool) armWarmTimerLocked(s *liveSession) {
	s.lastActive = p.clock.Now()
	p.rewarmLocked(s)
}

// rewarmLocked winds the next warm timer without moving the LRU position, which a renewal
// did not earn: a timer that fired is replaced by whatever the session's Monitor pin has
// left of it (warmTimerDelayLocked).
func (p *sessionPool) rewarmLocked(s *liveSession) {
	s.idleGeneration++
	idleGeneration := s.idleGeneration
	if s.warmTimer != nil {
		s.warmTimer.Stop()
	}
	if s.resident && !s.evictRequested {
		s.warmTimer = p.clock.AfterFunc(p.warmTimerDelayLocked(s), func() {
			p.expireWarm(s, idleGeneration)
		})
	} else {
		s.warmTimer = nil
	}
}

// engineTurnSignal reads one event the way the control plane's engineTurnActiveAfter
// (apiserver runner-api/engine-turn.ts) does. Assistant, thinking, tool_use and
// tool_result are output only a generating engine produces; a turn_end, or a system
// init/resumed handshake, says no turn is running. A Bash pair the runner ran itself — a
// `!cmd`, an EXECUTABLE acceptance (shell.go) — wears the engine's tool shape under a
// `shell-` id, and says nothing about the engine.
func engineTurnSignal(eventType string, payload map[string]interface{}) (generating, ended bool) {
	switch eventType {
	case evAssistant, evThinking:
		return true, false
	case evToolUse, evToolResult:
		id, _ := payload["id"].(string)
		if id == "" {
			id, _ = payload["toolUseId"].(string)
		}
		return !strings.HasPrefix(id, "shell-"), false
	case evTurnEnd:
		return false, true
	case evSystem:
		subtype, _ := payload["subtype"].(string)
		return false, subtype == "init" || subtype == "resumed"
	}
	return false, false
}

// engineTurnEvent is how the pool sees a turn the engine runs on its own: a Monitor event,
// a <task-notification>, a ScheduleWakeup. Such a turn holds no permit, and to the warm
// TTL, requestEvictLocked and LRU alike a resident engine without one was idle, so it was
// recycled mid-tool-call warmEngineTTL after the last turn Orbit delivered. The event
// stream is the one place that turn shows up; the supervisor reports every event here.
//
// Output from a parked engine marks the turn; the turn's end, or the engine stopping,
// clears the mark. Only a running turn is protected, never background work that might
// start one. A turn that ends parked leaves an idle engine, whose warm TTL starts over
// from that moment the way park starts it; one that a claim took over in the meantime
// ends with the permit protecting the engine, and park still to come.
func (p *sessionPool) engineTurnEvent(s *liveSession, eventType string, payload map[string]interface{}) {
	generating, ended := engineTurnSignal(eventType, payload)
	if !generating && !ended {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s || !s.resident {
		return
	}
	if generating {
		if !s.active && !s.evictRequested {
			s.selfDrivenTurn = true
		}
		return
	}
	if !s.selfDrivenTurn {
		return
	}
	s.selfDrivenTurn = false
	if !s.active {
		p.armWarmTimerLocked(s)
	}
	// A cold start waiting at the resident cap may take this engine now.
	p.signalLocked(s)
}

func (p *sessionPool) permitGeneration(s *liveSession) uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sessions[s.id] != s || !s.active || s.detaching {
		return 0
	}
	return s.permitGeneration
}

// expireWarm recycles a warm engine when its TTL elapses. Background work never defers
// it: a supervisor's background jobs are the runner's own children and keep running. A
// turn the engine is running on its own does — requestEvictLocked declines — and the end
// of that turn winds the next timer. A Monitor still running inside the engine does too,
// and is the one deferral that has to re-arm the timer here: the engine is genuinely idle,
// so nothing else will come along to wind it.
func (p *sessionPool) expireWarm(s *liveSession, idleGeneration uint64) {
	p.mu.Lock()
	if p.sessions[s.id] != s || s.active || !s.resident || s.evictRequested ||
		s.idleGeneration != idleGeneration {
		p.mu.Unlock()
		return
	}
	if !p.monitorPinDeadlineLocked(s).IsZero() {
		p.rewarmLocked(s)
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
//
// Once the pool is closed for an update, a permit no longer starts a turn: the
// wait goes on until the stop that follows, and ends on shutdown like any other.
func (p *sessionPool) waitActive(s *liveSession, sessionCtx, shutdown context.Context) bool {
	for {
		p.mu.Lock()
		if p.sessions[s.id] != s || s.detaching {
			p.mu.Unlock()
			return false
		}
		if s.active && !p.closedForUpdate {
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
	s.selfDrivenTurn = false
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
		// A detached supervisor's fence is the takeover's to lower — but only while there is
		// one. Left raised without a takeover it can never come down: this id is out of the
		// pool, so no register, park or finish will ever run for it again, and every later
		// merge is refused as superseded for the life of the process. That is the 2026-09-15
		// incident: a self-update re-exec reclaimed an already-ended session, a heartbeat
		// detached it 28 seconds later when its lease moved, and its merge was wedged for good.
		if !s.detaching || !p.takeoverPendingLocked(s.id) {
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
