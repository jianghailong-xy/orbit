package main

import (
	"strings"
	"sync"
)

// registry holds the gateway's connections: at most cfg.MaxConnsPerRunner per runner, and per process (a runner's
// leaseOwner) only the newest, which supersedes the one before it (docs/runner-link-design.md §5.4, §6.1). A
// handshake takes its runner's slot before the upgrade, so two at once cannot both pass the limit, and gives it back
// when it fails.
type registry struct {
	mu        sync.Mutex
	max       int
	pending   map[string]int
	byRunner  map[string]map[*conn]struct{}
	byProcess map[processKey]*conn
}

type processKey struct{ runner, process string }

func newRegistry(max int) *registry {
	return &registry{
		max:       max,
		pending:   map[string]int{},
		byRunner:  map[string]map[*conn]struct{}{},
		byProcess: map[processKey]*conn{},
	}
}

func keyOf(runner, process string) processKey {
	return processKey{runner: runner, process: strings.ToLower(process)}
}

// reserve takes a slot for a handshake of process on runner. The process's own open connection does not count: the
// new one will supersede it.
func (r *registry) reserve(runner, process string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	used := r.pending[runner] + len(r.byRunner[runner])
	if _, ok := r.byProcess[keyOf(runner, process)]; ok {
		used--
	}
	if used >= r.max {
		return false
	}
	r.pending[runner]++
	return true
}

// release gives back the slot of a handshake that did not reach Welcome.
func (r *registry) release(runner string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.releaseLocked(runner)
}

func (r *registry) releaseLocked(runner string) {
	if r.pending[runner] <= 1 {
		delete(r.pending, runner)
	} else {
		r.pending[runner]--
	}
}

// activate turns a handshake's slot into an open connection, and returns the connection of the same process it
// supersedes, if there is one.
func (r *registry) activate(c *conn) (superseded *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	runner := c.claims.RunnerID
	r.releaseLocked(runner)
	key := keyOf(runner, c.claims.LeaseOwner)
	superseded = r.byProcess[key]
	r.byProcess[key] = c
	if r.byRunner[runner] == nil {
		r.byRunner[runner] = map[*conn]struct{}{}
	}
	r.byRunner[runner][c] = struct{}{}
	return superseded
}

// remove forgets a closed connection.
func (r *registry) remove(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	runner := c.claims.RunnerID
	if set := r.byRunner[runner]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(r.byRunner, runner)
		}
	}
	key := keyOf(runner, c.claims.LeaseOwner)
	if r.byProcess[key] == c {
		delete(r.byProcess, key)
	}
}

// connsOf is the runner's open connections.
func (r *registry) connsOf(runner string) []*conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*conn, 0, len(r.byRunner[runner]))
	for c := range r.byRunner[runner] {
		out = append(out, c)
	}
	return out
}

// snapshot is every open connection.
func (r *registry) snapshot() []*conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*conn
	for _, set := range r.byRunner {
		for c := range set {
			out = append(out, c)
		}
	}
	return out
}

func (r *registry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, set := range r.byRunner {
		n += len(set)
	}
	return n
}
