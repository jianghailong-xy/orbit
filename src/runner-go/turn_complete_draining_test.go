package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"
)

// drainingSaid records, by turn, whether each turn completion a session sent said it drains for an update: read off
// the request body itself, so it holds whatever the runner's request type is.
type drainingSaid struct {
	mu   sync.Mutex
	said map[string]bool
}

func (d *drainingSaid) of(turnID string) (said, sent bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	said, sent = d.said[turnID]
	return said, sent
}

// recordDraining wraps the rig's control plane so every turn completion's `draining` field is recorded before the
// stub answers it.
func recordDraining(r *regionRig) *drainingSaid {
	d := &drainingSaid{said: map[string]bool{}}
	inner := r.server.Config.Handler
	r.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPost && len(req.URL.Path) > len("/turn-complete") &&
			req.URL.Path[len(req.URL.Path)-len("/turn-complete"):] == "/turn-complete" {
			body, _ := io.ReadAll(req.Body)
			var fields struct {
				TurnID   string `json:"turnId"`
				Draining bool   `json:"draining"`
			}
			_ = json.Unmarshal(body, &fields)
			d.mu.Lock()
			d.said[fields.TurnID] = fields.Draining
			d.mu.Unlock()
			req.Body = io.NopCloser(bytes.NewReader(body))
		}
		inner.ServeHTTP(w, req)
	})
	return d
}

// runOnDrainingTransport is regionRig.run on a transport that says, as runLoop's does, whether its pool drains for an
// update (Transport.draining).
func runOnDrainingTransport(r *regionRig, job *ClaimedSession, script ...fakeStep) {
	t := r.t
	t.Helper()
	r.fake = newFakeClaude(t, script...)
	t.Setenv("PATH", r.fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	r.job = job
	r.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "rename the widget"})
	r.pool = newSessionPool(2)
	ctx, cancel := context.WithCancel(context.Background())
	live, added := r.pool.register(job, cancel, true)
	if !added {
		t.Fatal("the session was not registered")
	}
	r.live = live
	transport := NewTransport(r.server.URL, "runner-token")
	transport.draining = r.pool.isDrainingForUpdate
	execDir := t.TempDir()
	go func() {
		defer close(r.done)
		runInteractiveSession(transport, job, ctx, context.Background(), execDir, nil, r.pool, live)
		r.pool.finish(live)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-r.done:
		case <-time.After(30 * time.Second):
			t.Error("the supervisor did not return after its session was cancelled")
		}
	})
}

// A turn that ends while the pool drains for an update, with a follow-up queued behind it
// (docs/runner-update-drain-design.md §7.3): the completion says draining, the control plane keeps no slot for the
// follow-up and answers PENDING, and the runner parks the session — its permit released, its engine still warm —
// instead of holding the follow-up for the update. A control plane that ignores the field answers RUNNING, as it did,
// which the stub below does for a completion that does not say it.
func TestATurnEndingWhileDrainingSaysSoAndReleasesItsPermit(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	var said *drainingSaid
	status := func(req TurnCompleteRequest) string {
		if req.TurnID != "turn-1" {
			return stAwaitingInput
		}
		if draining, _ := said.of("turn-1"); draining {
			return stPending // the session went back to the queue behind the update
		}
		return stRunning // the slot kept for the follow-up queued behind it
	}
	rig := prepareRegionRig(t, regionAnswerAllowed, status)
	said = recordDraining(rig)
	job := claudeSpawnJob(t)
	job.Agent.Env = anthropicKey()
	runOnDrainingTransport(rig, job,
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "renamed it"},
		fakeStep{Await: "release", Text: "end turn one"},
		fakeStep{Emit: "result", Text: "renamed it"},
		fakeStep{Await: "user"},
	)
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "renamed it") }, "turn-1 never started")
	rig.pool.drainForUpdate()
	rig.fake.Release("end turn one")
	rig.awaitSettled("turn-1")

	if draining, sent := said.of("turn-1"); !sent || !draining {
		t.Fatalf("turn-1's completion, sent while the pool drained for an update, said draining = %t (sent: %t), want true", draining, sent)
	}
	waitUntil(t, func() bool { return !rig.pool.isActive(rig.live) }, "the permit was kept after the control plane answered PENDING")
	rig.pool.mu.Lock()
	held, resident := rig.live.heldForUpdate, rig.live.resident
	rig.pool.mu.Unlock()
	if held {
		t.Fatal("the follow-up was held for the update instead of the session parked")
	}
	if !resident {
		t.Fatal("the engine did not stay warm when the session parked")
	}
	if n := rig.pool.turnsInFlight(); n != 0 {
		t.Fatalf("turnsInFlight after turn-1 ended while draining = %d, want 0", n)
	}
}

// A completion sent while the pool is not draining says nothing of it, as before.
func TestATurnEndingWhileNotDrainingSaysNothing(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	rig := prepareRegionRig(t, regionAnswerAllowed, nil)
	said := recordDraining(rig)
	job := claudeSpawnJob(t)
	job.Agent.Env = anthropicKey()
	runOnDrainingTransport(rig, job,
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "renamed it"},
		fakeStep{Emit: "result", Text: "renamed it"},
		fakeStep{Await: "user"},
	)
	rig.awaitSettled("turn-1")
	if draining, sent := said.of("turn-1"); !sent || draining {
		t.Fatalf("turn-1's completion said draining = %t (sent: %t), want false", draining, sent)
	}
}
