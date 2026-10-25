package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The control plane unavailable while a session keeps working (§10: a gateway node down, a backend down, the database
// failing over), for as long as ORBIT_LINK_OUTAGE says: ten minutes is the acceptance's figure, and without it the
// outage lasts 20 seconds. Throughout, the session's engine emits, and its flush hands what is buffered to the stream
// every 250ms, each on a goroutine of its own as in session.go. The engine never waits on the link or the disk. When the
// outage ends, every event is stored once, in seq order, without a gap.
//
//   - gateway down: every connection is refused, and HTTPS answers UPGRADE_REQUIRED (RUNNER_LINK_REQUIRED is on), so
//     the events wait on the link the whole time, past the session's memory on disk, until a connection is welcomed.
//   - ingest down: the gateway takes the batches and the ingest cannot store them, retryably, the whole time.
func TestLinkEventsSurviveTheControlPlaneBeingUnavailable(t *testing.T) {
	outage := 20 * time.Second
	if v := os.Getenv("ORBIT_LINK_OUTAGE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			t.Fatalf("ORBIT_LINK_OUTAGE=%q is not a duration", v)
		}
		outage = d
	}
	for _, what := range []string{"gateway down", "ingest down"} {
		t.Run(what, func(t *testing.T) { linkOutage(t, what, outage) })
	}
}

func linkOutage(t *testing.T, what string, outage time.Duration) {
	r, in := newLinkEventsRig(t)
	// HTTPS refuses the daemon routes: nothing sends the work back to HTTPS, however long the link is gone.
	r.cp.mu.Lock()
	r.cp.status = func(string) int { return http.StatusUpgradeRequired }
	r.cp.mu.Unlock()
	first := r.useLink(t)
	r.m.upgradeRequired("POST /runner/heartbeat")
	s, buf := linkSessionBuffer(r, "session-outage")
	defer s.release()

	// The engine: four events every 250ms, one of them live. Enough bytes to pass the session's memory during the
	// outage, whatever its length.
	const perTick = 4
	ticks := int(outage / (250 * time.Millisecond))
	payload := max(4<<10, (12<<20)/max(ticks*(perTick-1), 1))
	var mu sync.Mutex
	var slowestEmit, slowestFlush time.Duration
	emitted, onDisk := 0, 0
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { // the engine's stdout reader
		defer wg.Done()
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for n := 0; ; n++ {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			for i := 0; i < perTick; i++ {
				began := time.Now()
				if i == 0 {
					buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "x"}, nil)
				} else {
					buf.add("turn-1", evToolResult, map[string]interface{}{"toolUseId": fmt.Sprintf("toolu_%d_%d", n, i),
						"content": fmt.Sprintf("%d.%d %s", n, i, strings.Repeat("z", payload))}, nil)
				}
				mu.Lock()
				slowestEmit = max(slowestEmit, time.Since(began))
				if i > 0 {
					emitted++
				}
				mu.Unlock()
			}
		}
	}()
	go func() { // the session's flush
		defer wg.Done()
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			began := time.Now()
			if err := s.submit(buf.take()); err != nil {
				t.Errorf("handing events over: %v", err)
				return
			}
			s.mu.Lock()
			disk := s.disk.count()
			s.mu.Unlock()
			mu.Lock()
			slowestFlush = max(slowestFlush, time.Since(began))
			onDisk = max(onDisk, disk)
			mu.Unlock()
		}
	}()

	time.Sleep(2 * time.Second)
	t.Logf("%s for %s, %d-byte events", what, outage, payload)
	switch what {
	case "gateway down":
		r.g.mu.Lock()
		r.g.refuse = func(*http.Request) (int, string, string) {
			return http.StatusServiceUnavailable, `{"code":"DRAINING"}`, ""
		}
		r.g.mu.Unlock()
		first.drop()
	case "ingest down":
		in.setDown(true)
	}
	began := time.Now()
	time.Sleep(outage)
	switch what {
	case "gateway down":
		r.g.mu.Lock()
		r.g.refuse = nil
		r.g.mu.Unlock()
	case "ingest down":
		in.setDown(false)
	}
	t.Logf("the outage ended after %s", time.Since(began).Round(time.Second))
	time.Sleep(2 * time.Second)
	close(stop)
	wg.Wait()
	if err := s.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	recovered := time.Now()
	if err := s.waitStored(ctx); err != nil {
		t.Fatalf("the events were not all stored after the outage: %v", err)
	}
	t.Logf("everything stored %s after the outage ended", time.Since(recovered).Round(time.Millisecond))
	mu.Lock()
	defer mu.Unlock()
	in.assertContiguous(t, "session-outage", 1, uint64(emitted))
	// Every event is the one that took its seq: none was lost or swapped on its way through memory and disk.
	n := 0
	for seq := uint64(1); seq <= uint64(emitted); seq++ {
		ev := in.event("session-outage", seq)
		if ev == nil || !strings.Contains(string(ev.GetPayloadJson()), fmt.Sprintf(`"content":"%d.%d `, n/(perTick-1), n%(perTick-1)+1)) {
			t.Fatalf("seq %d holds %.80s", seq, ev.GetPayloadJson())
		}
		n++
	}
	if slowestEmit > 50*time.Millisecond {
		t.Errorf("an event took %s to emit: the engine waited on the link or the disk", slowestEmit)
	}
	if outage >= 20*time.Second && onDisk == 0 {
		t.Errorf("the session's events never went to the spool, past %d bytes of memory", linkSessionMemoryBytes)
	}
	if line := strings.Join(r.logs.all(), "\n"); strings.Contains(line, "dropping") || strings.Contains(line, "not sent") {
		t.Errorf("the log says events were dropped:\n%s", line)
	}
	t.Logf("%d events, at most %d on disk at once; the slowest emit %s, the slowest hand-over %s", emitted, onDisk,
		slowestEmit, slowestFlush)
}
