package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Records what a supervisor's drain watcher did: the events it published, and whether it
// stopped the inbox poller / tore the process down.
type drainProbe struct {
	mu       sync.Mutex
	events   []RunEvent
	polled   bool // pollCancel called
	torndown bool // procCancel called
}

func (p *drainProbe) emit(eventType string, payload map[string]interface{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, RunEvent{Type: eventType, Payload: payload})
}

func (p *drainProbe) interrupts() []RunEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []RunEvent
	for _, ev := range p.events {
		if ev.Type == evInterrupt {
			out = append(out, ev)
		}
	}
	return out
}

func (p *drainProbe) flags() (polled, torndown bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.polled, p.torndown
}

// Runs watchShutdownDrain against a probe and returns once it has finished. `feed` names the
// turns already handed to claude but not yet acked; the returned channel is how a test drains
// them, standing in for the stdout reader acking a `result`.
func runDrainWatcher(t *testing.T, feed []string, timeout time.Duration,
	act func(pending chan string, procCancel context.CancelFunc)) *drainProbe {
	t.Helper()
	procCtx, procCancel := context.WithCancel(context.Background())
	defer procCancel()
	shutdownCtx, shutdown := context.WithCancel(context.Background())
	defer shutdown()

	pending := make(chan string, 8)
	for _, id := range feed {
		pending <- id
	}
	probe := &drainProbe{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchShutdownDrain(procCtx, shutdownCtx, pending, new(atomic.Int32), timeout,
			func() {
				probe.mu.Lock()
				probe.polled = true
				probe.mu.Unlock()
			},
			func() {
				probe.mu.Lock()
				probe.torndown = true
				probe.mu.Unlock()
				procCancel()
			},
			probe.emit, "s-1")
	}()

	shutdown()
	if act != nil {
		act(pending, procCancel)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("drain watcher never returned")
	}
	return probe
}

// The turn is still in flight when the drain runs out of patience: it is about to lose its
// process with no result of its own, so the transcript has to say so — otherwise the reply
// just stops mid-thought and looks identical to the agent still working.
func TestShutdownDrainMarksTheTurnItTearsDown(t *testing.T) {
	probe := runDrainWatcher(t, []string{"turn-1"}, 30*time.Millisecond, nil)

	interrupts := probe.interrupts()
	if len(interrupts) != 1 {
		t.Fatalf("published %d interrupt events, want exactly 1 (events: %+v)", len(interrupts), probe.events)
	}
	if got := interrupts[0].Payload["reason"]; got != "runner_restart" {
		t.Errorf("interrupt reason = %v, want %q", got, "runner_restart")
	}
	polled, torndown := probe.flags()
	if !polled {
		t.Error("inbox poller was left running; a drain must stop pulling new turns")
	}
	if !torndown {
		t.Error("process was not torn down after the drain deadline")
	}
}

// The ordinary restart: the in-flight turn finishes and acks inside the window. Nothing was
// interrupted, so marking the transcript would be a lie — and would leave a "⊘ interrupted"
// note on a turn the user watched complete.
func TestShutdownDrainStaysSilentWhenTheTurnFinishes(t *testing.T) {
	probe := runDrainWatcher(t, []string{"turn-1"}, 5*time.Second,
		func(pending chan string, _ context.CancelFunc) {
			// Past one poll interval, so the watcher has to observe the turn in flight and
			// come back for it rather than finding an empty queue on its first look.
			time.Sleep(2 * drainPollInterval)
			<-pending // the stdout reader acking the turn's `result`
		})

	if got := probe.interrupts(); len(got) != 0 {
		t.Errorf("published %d interrupt events for a turn that finished, want 0", len(got))
	}
	if _, torndown := probe.flags(); !torndown {
		t.Error("a drained session must still be torn down so the runner can exit")
	}
}

// An idle session has nothing to wait for and detaches at once — no marker, no delay.
func TestShutdownDrainDetachesIdleSessionImmediately(t *testing.T) {
	probe := runDrainWatcher(t, nil, 5*time.Second, nil)

	if got := probe.interrupts(); len(got) != 0 {
		t.Errorf("published %d interrupt events for an idle session, want 0", len(got))
	}
	if _, torndown := probe.flags(); !torndown {
		t.Error("idle session was not torn down")
	}
}

// The process died on its own while the drain was waiting on it. Its own crash path decides
// what that turn reports, so the watcher must not also stamp an interrupt on it.
func TestShutdownDrainStaysSilentWhenTheProcessDiesFirst(t *testing.T) {
	probe := runDrainWatcher(t, []string{"turn-1"}, 5*time.Second,
		func(_ chan string, procCancel context.CancelFunc) { procCancel() })

	if got := probe.interrupts(); len(got) != 0 {
		t.Errorf("published %d interrupt events for an already-dead process, want 0", len(got))
	}
}

// No shutdown at all: the supervisor's process ends and the watcher just goes away. It must
// not fire pollCancel/procCancel or publish anything on that path.
func TestShutdownDrainIsANoOpWithoutShutdown(t *testing.T) {
	procCtx, procCancel := context.WithCancel(context.Background())
	shutdownCtx, shutdown := context.WithCancel(context.Background())
	defer shutdown()

	probe := &drainProbe{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchShutdownDrain(procCtx, shutdownCtx, make(chan string), new(atomic.Int32), time.Second,
			func() {
				probe.mu.Lock()
				probe.polled = true
				probe.mu.Unlock()
			},
			func() {
				probe.mu.Lock()
				probe.torndown = true
				probe.mu.Unlock()
			},
			probe.emit, "s-1")
	}()

	procCancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("drain watcher never returned")
	}
	if polled, torndown := probe.flags(); polled || torndown {
		t.Errorf("watcher acted without a shutdown: pollCancel=%v procCancel=%v", polled, torndown)
	}
	if got := probe.interrupts(); len(got) != 0 {
		t.Errorf("published %d interrupt events without a shutdown, want 0", len(got))
	}
}

// startShellDrainWatcher shuts down with `shells` runner shell turns in flight and nothing fed to
// claude; the returned func waits for the watcher to finish.
func startShellDrainWatcher(t *testing.T, shells *atomic.Int32, timeout time.Duration) (*drainProbe, func()) {
	t.Helper()
	procCtx, procCancel := context.WithCancel(context.Background())
	t.Cleanup(procCancel)
	shutdownCtx, shutdown := context.WithCancel(context.Background())
	t.Cleanup(shutdown)
	probe := &drainProbe{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchShutdownDrain(procCtx, shutdownCtx, make(chan string, 8), shells, timeout,
			func() {
				probe.mu.Lock()
				probe.polled = true
				probe.mu.Unlock()
			},
			func() {
				probe.mu.Lock()
				probe.torndown = true
				probe.mu.Unlock()
				procCancel()
			},
			probe.emit, "s-1")
	}()
	shutdown()
	return probe, func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("drain watcher never returned")
		}
	}
}

// A shell turn the runner runs itself — an acceptance command, a `!cmd` — holds the drain as a turn
// in the engine does: the process is torn down once the turn is settled, not while its command runs.
func TestShutdownDrainWaitsForARunnerShellTurn(t *testing.T) {
	var shells atomic.Int32
	shells.Store(1)
	probe, wait := startShellDrainWatcher(t, &shells, 5*time.Second)

	time.Sleep(2 * drainPollInterval)
	if _, torndown := probe.flags(); torndown {
		t.Fatal("the process was torn down while a runner shell turn was still running: its command dies as exit -1")
	}
	shells.Add(-1) // the command exits and its turn-complete is sent
	wait()

	if got := probe.interrupts(); len(got) != 0 {
		t.Errorf("published %d interrupt events for a shell turn that finished, want 0", len(got))
	}
	if _, torndown := probe.flags(); !torndown {
		t.Error("a drained session must still be torn down so the runner can exit")
	}
}

// And the same budget bounds it: a command still running at the deadline is torn down and marked
// like any turn still in flight then, so a runner stop cannot outlast the service manager's wait.
func TestShutdownDrainTearsDownARunnerShellTurnAtTheDeadline(t *testing.T) {
	var shells atomic.Int32
	shells.Store(1)
	probe, wait := startShellDrainWatcher(t, &shells, 30*time.Millisecond)
	wait()

	interrupts := probe.interrupts()
	if len(interrupts) != 1 || interrupts[0].Payload["reason"] != "runner_restart" {
		t.Fatalf("interrupt events = %+v, want one runner_restart marker", interrupts)
	}
	if _, torndown := probe.flags(); !torndown {
		t.Error("the process was not torn down at the drain deadline")
	}
}
