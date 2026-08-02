package main

import (
	"context"
	"sync"
)

// eventEmissionGate is the producer side of terminal event fencing. seal waits
// for an emitter that already entered, then permanently rejects every later
// emission. A final flush after seal therefore observes a closed, stable buffer.
type eventEmissionGate struct {
	mu     sync.RWMutex
	sealed bool
}

func (g *eventEmissionGate) run(emit func()) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.sealed {
		return false
	}
	emit()
	return true
}

func (g *eventEmissionGate) seal() {
	g.mu.Lock()
	g.sealed = true
	g.mu.Unlock()
}

// eventFlushGate serializes event sends while allowing a terminal drain to stop
// waiting at its own deadline. The permit covers both buffer extraction and the
// network request, so crossing the gate is a real barrier for every earlier batch.
type eventFlushGate struct {
	permit chan struct{}
}

func newEventFlushGate() *eventFlushGate {
	permit := make(chan struct{}, 1)
	permit <- struct{}{}
	return &eventFlushGate{permit: permit}
}

func (g *eventFlushGate) run(ctx context.Context, send func(context.Context) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-g.permit:
	}
	defer func() { g.permit <- struct{}{} }()
	return send(ctx)
}
