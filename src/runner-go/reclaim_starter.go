package main

import "sync"

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
// What the lock used to protect is held per session instead:
//   - Every session's takeover has answered, and its fence is up, before the starter exists. Each
//     fence comes down when that session's own start ends (endTakeover), so no merge or commit is
//     admitted against a supervisor that does not exist yet.
//   - A claim for a session still queued here starts it first, on the claim loop, and one for a
//     session a worker is starting waits for that start (settle): the claim then finds the supervisor
//     the reclaim registered, exactly as when the reclaim had finished before the claim, and no
//     session gets two.
//   - The pool counts each session as being reclaimed until its start ends (markReclaiming), and the
//     run loop keeps worktree GC unarmed until every start has ended (finished).
type reclaimStarter struct {
	pool  *sessionPool
	start func(reclaimedStart)

	mu    sync.Mutex
	queue []*reclaimStartEntry
	next  int
	byID  map[string]*reclaimStartEntry
	left  int
	done  chan struct{}
}

type reclaimStartEntry struct {
	pending reclaimedStart
	// taken is set once a worker or a claim has started this entry: nothing starts it again.
	taken bool
	done  chan struct{}
}

// newReclaimStarter registers every one of pending as being reclaimed in the pool. Nothing starts
// until run. start starts one session's supervisor; the starter ends its takeover afterwards.
func newReclaimStarter(pool *sessionPool, pending []reclaimedStart, start func(reclaimedStart)) *reclaimStarter {
	r := &reclaimStarter{
		pool:  pool,
		start: start,
		byID:  make(map[string]*reclaimStartEntry, len(pending)),
		done:  make(chan struct{}),
	}
	for _, p := range pending {
		e := &reclaimStartEntry{pending: p, done: make(chan struct{})}
		r.queue = append(r.queue, e)
		r.byID[p.job.SessionID] = e
		pool.markReclaiming(p.job.SessionID, p.initiallyActive)
	}
	r.left = len(r.queue)
	if r.left == 0 {
		close(r.done)
	}
	return r
}

// run starts the queue on up to workers goroutines and returns at once. onDone, if any, runs once
// every entry has ended, on a goroutine of its own.
func (r *reclaimStarter) run(workers int, onDone func()) {
	if workers > len(r.queue) {
		workers = len(r.queue)
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

func (r *reclaimStarter) takeNext() *reclaimStartEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	for r.next < len(r.queue) {
		e := r.queue[r.next]
		r.next++
		if !e.taken {
			e.taken = true
			return e
		}
	}
	return nil
}

func (r *reclaimStarter) startEntry(e *reclaimStartEntry) {
	r.start(e.pending)
	e.pending.endTakeover()
	r.pool.unmarkReclaiming(e.pending.job.SessionID)
	close(e.done)
	r.mu.Lock()
	r.left--
	if r.left == 0 {
		close(r.done)
	}
	r.mu.Unlock()
}

// settle is what a claim for sessionID goes through before it takes the session over: it returns once
// no reclaim start of that session is still to come. A start still queued runs now, on the caller; one
// a worker is running is waited for. Every other session goes on starting meanwhile. A nil starter, or
// a session it does not hold, returns at once.
func (r *reclaimStarter) settle(sessionID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	e := r.byID[sessionID]
	if e == nil {
		r.mu.Unlock()
		return
	}
	if !e.taken {
		e.taken = true
		r.mu.Unlock()
		r.startEntry(e)
		return
	}
	r.mu.Unlock()
	<-e.done
}

// finished reports whether every start has ended. A nil starter (no reclaim answered) has none.
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

// wait blocks until every start has ended.
func (r *reclaimStarter) wait() {
	if r != nil {
		<-r.done
	}
}
