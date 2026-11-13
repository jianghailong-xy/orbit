package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// reclaimStartWorkers bounds how many reclaimed sessions start at once. Each start is a few git
// commands and a volume sync, and git takes its own locks in the repository the sessions share, so a
// handful at once is enough to keep a restart's queue moving without piling them all onto one disk.
const reclaimStartWorkers = 4

// reclaimStarter starts a reclaim's sessions in the background, in the order the reclaim handed them
// back (orderReclaimedStarts), so that neither the claim loop nor the first heartbeat waits for every
// open session this runner owns to be set up again. A restart used to start each of them, months-old
// idle ones included, before claiming anything: on 2026-11-12 a new session sat Queued for minutes
// behind a reclaim of one from 09-20.
//
// The startup reclaim also hands it the idle sessions (AWAITING_INPUT, INTERRUPTED) whose takeovers it
// has not made (reclaimWaitedOnSessions): on 2026-11-13 the takeovers of 339 sessions, one request each,
// held the claim loop for three minutes. takeOverIdle makes those in the background, one at a time in
// ascending id order, and each session goes to the workers as its takeover answers.
//
// What the lock used to protect is held per session instead:
//   - A session handed over by the reclaim has its takeover answered and its fence up. Each fence comes
//     down when that session's own start ends (endTakeover), so no merge or commit is admitted against
//     a supervisor that does not exist yet. One still waiting for its takeover has no fence, but the
//     pool counts it as being reclaimed from the start, so the heartbeat defers a merge or commit for
//     it (reclaimDeferredOps) and never advertises it as supervised.
//   - A claim for a session still queued here starts it first, on the claim loop; one for a session
//     whose takeover has not run yet has that takeover made first, on the claim loop too; and one for
//     a session a worker is starting, or takeOverIdle is taking over, waits for that (settle): the claim
//     then finds the supervisor the reclaim registered, exactly as when the reclaim had finished before
//     the claim, and no session gets two.
//   - The pool counts each session as being reclaimed until its start ends (markReclaiming), and the
//     run loop keeps worktree GC unarmed until every takeover and every start has ended (finished).
type reclaimStarter struct {
	pool  *sessionPool
	start func(reclaimedStart)
	// onStarted, if set before run, is told each session whose start has ended, once the pool no longer
	// counts it as being reclaimed. A session given up without a start is told too.
	onStarted func(sessionID string)
	// takeover makes one idle session's takeover, local and on the server, as the reclaim makes it: on
	// success the func it returns ends the local takeover, and the status is the server's answer. Set
	// before run whenever there are idle sessions.
	takeover func(job *ClaimedSession) (endTakeover func(), status string, err error)

	mu   sync.Mutex
	cond *sync.Cond
	// queue is the order the workers start entries in: the reclaim's own, then idle sessions as their
	// takeovers answer.
	queue []*reclaimStartEntry
	next  int
	// idle is the sessions whose takeovers are still to be made, in ascending id order.
	idle []*reclaimStartEntry
	byID map[string]*reclaimStartEntry
	// unsettled counts the idle entries not yet handed to the workers or given up: a worker with nothing
	// to start waits while there are any.
	unsettled int
	// left counts the entries not ended, and the idle phase itself while it has not returned.
	left int
	done chan struct{}

	// What the idle phase did, for the log line: how many sessions it handed over, when it began and
	// when it returned, and whether it set any aside over takeover conflicts.
	idleHanded           int
	idleBegan, idleEnded time.Time
	idleSetAside         bool
}

type reclaimEntryState int

const (
	// entryAwaitingTakeover: an idle session nobody has taken over yet.
	entryAwaitingTakeover reclaimEntryState = iota
	// entryTakingOver: takeOverIdle or a claim is making its takeover.
	entryTakingOver
	// entryReady: taken over, queued for a worker.
	entryReady
	// entryStarting: a worker or a claim is starting it.
	entryStarting
	// entryEnded: started, or given up.
	entryEnded
)

type reclaimStartEntry struct {
	pending reclaimedStart
	state   reclaimEntryState
	// replacedOwner is the lease owner an idle takeover replaced with this process: a claim answered
	// before that takeover still names it (settle).
	replacedOwner string
	tookOver      bool
}

// newReclaimStarter registers every one of pending, and every one of idle, as being reclaimed in the
// pool. pending have been taken over; idle (in ascending id order) have not, and takeOverIdle must run
// for them. Nothing starts until run. start starts one session's supervisor; the starter ends its
// takeover afterwards.
func newReclaimStarter(pool *sessionPool, pending []reclaimedStart, idle []*ClaimedSession, start func(reclaimedStart)) *reclaimStarter {
	r := &reclaimStarter{
		pool:  pool,
		start: start,
		byID:  make(map[string]*reclaimStartEntry, len(pending)+len(idle)),
		done:  make(chan struct{}),
	}
	r.cond = sync.NewCond(&r.mu)
	for _, p := range pending {
		e := &reclaimStartEntry{pending: p, state: entryReady}
		r.queue = append(r.queue, e)
		r.byID[p.job.SessionID] = e
		pool.markReclaiming(p.job.SessionID, p.initiallyActive)
	}
	for _, job := range idle {
		if _, dup := r.byID[job.SessionID]; dup {
			continue
		}
		e := &reclaimStartEntry{pending: reclaimedStart{job: job, endTakeover: func() {}}, state: entryAwaitingTakeover}
		r.idle = append(r.idle, e)
		r.byID[job.SessionID] = e
		pool.markReclaiming(job.SessionID, false)
	}
	r.unsettled = len(r.idle)
	r.left = len(r.byID)
	if len(r.idle) > 0 {
		// takeOverIdle's own return.
		r.left++
	}
	if r.left == 0 {
		close(r.done)
	}
	return r
}

// run starts the queue on up to workers goroutines and returns at once. onDone, if any, runs once
// every entry has ended, and the idle phase with it, on a goroutine of its own.
func (r *reclaimStarter) run(workers int, onDone func()) {
	if workers > len(r.byID) {
		workers = len(r.byID)
	}
	for i := 0; i < workers; i++ {
		go func() {
			for e := r.takeNext(); e != nil; e = r.takeNext() {
				r.startEntry(e)
			}
		}()
	}
	if onDone != nil {
		go func() {
			<-r.done
			onDone()
		}()
	}
}

// takeNext is a worker's next entry to start, waiting while idle takeovers may still hand one over.
func (r *reclaimStarter) takeNext() *reclaimStartEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		for r.next < len(r.queue) {
			e := r.queue[r.next]
			r.next++
			if e.state == entryReady {
				e.state = entryStarting
				return e
			}
		}
		if r.unsettled == 0 {
			return nil
		}
		r.cond.Wait()
	}
}

func (r *reclaimStarter) startEntry(e *reclaimStartEntry) {
	r.start(e.pending)
	e.pending.endTakeover()
	r.endEntry(e)
}

// endEntry ends an entry, started or given up.
func (r *reclaimStarter) endEntry(e *reclaimStartEntry) {
	r.pool.unmarkReclaiming(e.pending.job.SessionID)
	if r.onStarted != nil {
		r.onStarted(e.pending.job.SessionID)
	}
	r.mu.Lock()
	e.state = entryEnded
	r.endOneLocked()
	r.cond.Broadcast()
	r.mu.Unlock()
}

func (r *reclaimStarter) endOneLocked() {
	r.left--
	if r.left == 0 {
		close(r.done)
	}
}

// handOver queues an idle entry whose takeover answered status for a worker, or ends it when the
// answer says the session is no longer open. Called with the entry in entryTakingOver, and returns with
// the takeover owned by the entry.
func (r *reclaimStarter) handOver(e *reclaimStartEntry, replacedOwner string, endTakeover func(), status string) bool {
	if !reclaimStatusOpen(status) {
		endTakeover()
		r.giveUp(e)
		return false
	}
	active := reclaimInitiallyActive(status)
	if active {
		r.pool.markReclaiming(e.pending.job.SessionID, true)
	}
	r.mu.Lock()
	e.pending.initiallyActive = active
	e.pending.endTakeover = endTakeover
	e.pending.status = status
	e.replacedOwner, e.tookOver = replacedOwner, true
	e.state = entryReady
	r.queue = append(r.queue, e)
	r.unsettled--
	r.cond.Broadcast()
	r.mu.Unlock()
	return true
}

// giveUp ends an idle entry nobody will start: its session is gone from the reclaim, terminal, or set
// aside. Called with the entry in entryTakingOver.
func (r *reclaimStarter) giveUp(e *reclaimStartEntry) {
	r.mu.Lock()
	r.unsettled--
	r.mu.Unlock()
	r.endEntry(e)
}

// takeoverInline makes an idle entry's takeover on the caller, which holds it in entryTakingOver, and
// hands it over or gives it up. A failure is the caller's to judge.
func (r *reclaimStarter) takeoverInline(e *reclaimStartEntry) (handed bool, err error) {
	job := e.pending.job
	replaced := job.LeaseOwner
	endTakeover, status, err := r.takeover(job)
	if err != nil {
		return false, err
	}
	return r.handOver(e, replaced, endTakeover, status), nil
}

// takeOverIdle is the startup reclaim's idle phase: it makes the takeovers of the idle sessions
// newReclaimStarter was given, one at a time and in ascending id order, the order every process takes
// rows over in, and hands each to the workers as it answers. It returns once none is left.
//
// A 409 or 403 is handled as reclaimMissingSessions handles one: the snapshot is read again (refresh),
// and the sessions still waiting take their lease owner from it, or are given up if it no longer lists
// them; one that conflicts takeoverConflictLimit times is set aside, and setAside then says so for the
// run loop's deferred retry. Sessions already handed over are not taken over again. Any other failure
// gives every waiting session up and is returned: the reclaim failed, as it fails when blocking.
func (r *reclaimStarter) takeOverIdle(ctx context.Context, refresh func(context.Context) ([]ReclaimSession, error)) error {
	if len(r.idle) == 0 {
		return nil
	}
	r.mu.Lock()
	r.idleBegan = time.Now()
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.idleEnded = time.Now()
		r.endOneLocked()
		r.mu.Unlock()
	}()
	delay := 250 * time.Millisecond
	conflicts := map[string]int{}
	for {
		e := r.takeNextIdle()
		if e == nil {
			return nil
		}
		id := e.pending.job.SessionID
		handed, err := r.takeoverInline(e)
		if err == nil {
			if handed {
				r.mu.Lock()
				r.idleHanded++
				r.mu.Unlock()
			}
			continue
		}
		if !isTransportHTTPStatus(err, 409) && !isTransportHTTPStatus(err, 403) {
			r.giveUp(e)
			r.giveUpIdle()
			return err
		}
		conflicts[id]++
		if conflicts[id] >= takeoverConflictLimit {
			logln(fmt.Sprintf("reclaim: setting session %s aside after %d takeover conflicts (last: %v); retrying on a later reclaim",
				id, conflicts[id], err))
			r.mu.Lock()
			r.idleSetAside = true
			r.mu.Unlock()
			r.giveUp(e)
			continue
		}
		logln(fmt.Sprintf("reclaim: takeover conflict for %s: %v; refreshing snapshot", id, err))
		// Back to waiting, where a claim may take it meanwhile.
		r.mu.Lock()
		e.state = entryAwaitingTakeover
		r.cond.Broadcast()
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			r.giveUpIdle()
			return ctx.Err()
		case <-time.After(delay):
		}
		if delay < 5*time.Second {
			delay *= 2
		}
		sessions, err := refresh(ctx)
		if err != nil {
			r.giveUpIdle()
			return err
		}
		r.refreshIdle(sessions)
	}
}

// takeNextIdle takes the first idle entry still waiting for its takeover, in ascending id order.
func (r *reclaimStarter) takeNextIdle() *reclaimStartEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.idle {
		if e.state == entryAwaitingTakeover {
			e.state = entryTakingOver
			return e
		}
	}
	return nil
}

// refreshIdle brings the idle entries still waiting up to a fresh snapshot: each takes its row's lease
// owner, and one the snapshot no longer lists (or lists closed) is given up.
func (r *reclaimStarter) refreshIdle(sessions []ReclaimSession) {
	rows := make(map[string]ReclaimSession, len(sessions))
	for _, s := range sessions {
		rows[s.SessionID] = s
	}
	var gone []*reclaimStartEntry
	r.mu.Lock()
	for _, e := range r.idle {
		if e.state != entryAwaitingTakeover {
			continue
		}
		row, listed := rows[e.pending.job.SessionID]
		if !listed || !reclaimStatusOpen(row.Status) {
			e.state = entryTakingOver
			gone = append(gone, e)
			continue
		}
		e.pending.job = claimedSessionFromReclaim(row)
	}
	r.mu.Unlock()
	for _, e := range gone {
		r.giveUp(e)
	}
}

// giveUpIdle gives up every idle entry still waiting for its takeover: the idle phase is ending without
// them. One a claim is taking over stays the claim's.
func (r *reclaimStarter) giveUpIdle() {
	var gone []*reclaimStartEntry
	r.mu.Lock()
	for _, e := range r.idle {
		if e.state == entryAwaitingTakeover {
			e.state = entryTakingOver
			gone = append(gone, e)
		}
	}
	r.mu.Unlock()
	for _, e := range gone {
		r.giveUp(e)
	}
}

// settle is what a claim for sessionID goes through before it takes the session over: it returns once
// no reclaim takeover or start of that session is still to come. A start still queued runs now, on the
// caller, and so does the takeover of an idle session nobody has taken over yet, followed by its start;
// one a worker or takeOverIdle is running is waited for. Every other session goes on meanwhile. A nil
// starter, or a session it does not hold, returns at once.
//
// replacedOwner, with true, is the lease owner an idle takeover of the session replaced with this
// process: a claim answered before that takeover still names it, and takes the session over from this
// process instead. A failed takeover here leaves the session to the claim's own takeover, unstarted.
func (r *reclaimStarter) settle(sessionID string) (replacedOwner string, tookOver bool) {
	if r == nil {
		return "", false
	}
	r.mu.Lock()
	e := r.byID[sessionID]
	if e == nil {
		r.mu.Unlock()
		return "", false
	}
	for {
		switch e.state {
		case entryAwaitingTakeover:
			e.state = entryTakingOver
			r.mu.Unlock()
			handed, err := r.takeoverInline(e)
			if err != nil {
				logln(fmt.Sprintf("reclaim: takeover of %s for its claim failed: %v; the claim takes it over", sessionID, err))
				r.giveUp(e)
				return "", false
			}
			if !handed {
				return "", false
			}
			r.mu.Lock()
			continue
		case entryReady:
			e.state = entryStarting
			r.mu.Unlock()
			r.startEntry(e)
			r.mu.Lock()
			continue
		case entryEnded:
			replaced, took := e.replacedOwner, e.tookOver
			r.mu.Unlock()
			return replaced, took
		default:
			r.cond.Wait()
		}
	}
}

// finished reports whether every takeover and every start has ended. A nil starter (no reclaim
// answered) has none.
func (r *reclaimStarter) finished() bool {
	if r == nil {
		return true
	}
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// setAside reports whether the idle phase set a session aside over takeover conflicts. Read once
// finished.
func (r *reclaimStarter) setAside() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.idleSetAside
}

// startupReclaimFinishedLine is the log line the startup reclaim ends with: every session it started in
// took, then the priority phase's sessions and how long their snapshot and takeovers took before the
// claim loop opened, then the idle phase's sessions and how long their background takeovers took.
func startupReclaimFinishedLine(took time.Duration, priority int, priorityTook time.Duration, idle int, idleTook time.Duration) string {
	return fmt.Sprintf("startup reclaim finished: %d session(s) in %s (priority: %d session(s), snapshot and takeovers %s; idle: %d session(s), takeovers %s)",
		priority+idle, took.Round(time.Millisecond), priority, priorityTook.Round(time.Millisecond), idle, idleTook.Round(time.Millisecond))
}

// idlePhase is what the idle phase did: sessions handed over, and how long it ran (zero without one).
func (r *reclaimStarter) idlePhase() (handed int, took time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.idleEnded.IsZero() {
		took = r.idleEnded.Sub(r.idleBegan)
	}
	return r.idleHanded, took
}

// reclaimDeferredOps holds the sessions a heartbeat left a merge or commit unanswered for, because the
// reclaim had not started them yet (deferForReclaim).
type reclaimDeferredOps struct {
	sessions sync.Map
}

// deferForReclaim decides whether a heartbeat-delivered merge or commit for sessionID waits for a later
// beat: it does when the request that brought it was made while a reclaim's start of the session had not
// ended (advertised.reclaiming). Until then the takeover's fence refuses the operation, and a refusal is
// an error the person who pressed Merge or Commit would see; left unanswered instead, the control plane
// hands it over again on every beat until it has an outcome (drainMergeRequests, drainCommitRequests),
// and this one does it against the supervisor the start made. beatNow is asked for once the session's
// start has ended (started), so that beat is not a tick away.
func (d *reclaimDeferredOps) deferForReclaim(pool *sessionPool, sessionID, operation string, advertised heartbeatSupervisorSnapshot, beatNow func()) bool {
	if !advertised.reclaiming {
		return false
	}
	logln(fmt.Sprintf("%s for %s waits for its session to be started again after this runner's restart", operation, sessionID))
	d.sessions.Store(sessionID, true)
	// The start may have ended since the request was made: then nothing else asks for the beat.
	if !pool.isReclaiming(sessionID) {
		d.started(sessionID, beatNow)
	}
	return true
}

// started is the starter's onStarted: a session a merge or commit waited for has a beat asked for.
func (d *reclaimDeferredOps) started(sessionID string, beatNow func()) {
	if _, waited := d.sessions.LoadAndDelete(sessionID); waited {
		beatNow()
	}
}

// wait blocks until every start has ended.
func (r *reclaimStarter) wait() {
	if r != nil {
		<-r.done
	}
}
