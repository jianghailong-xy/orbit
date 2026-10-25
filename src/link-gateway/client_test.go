package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeAPI is the two apiserver routes the client calls: link tokens from the harness's key, and heartbeats.
func fakeAPI(t *testing.T, h *harness, runner string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var beats atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer runner-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/runner/link-token":
			var body struct {
				LeaseOwner string `json:"leaseOwner"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			exp := time.Now().Add(time.Hour)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"token": h.keys.sign(tokenClaims(runner, body.LeaseOwner, exp)), "expiresAt": exp.UTC().Format(time.RFC3339Nano),
				"cellId": "cell-1", "linkUrl": h.url,
			})
		case "/api/runner/heartbeat":
			beats.Add(1)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(api.Close)
	return api, &beats
}

func runClient(t *testing.T, h *harness, o clientOptions, during func()) clientSummary {
	t.Helper()
	cl, err := newClient(o, slog.New(slog.NewTextHandler(h.logs, nil)).With("side", "client"))
	if err != nil {
		t.Fatal(err)
	}
	cl.dial = h.srv.Client() // trusts the harness's test certificate
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); cl.run(ctx) }()
	during()
	<-done
	return cl.sum
}

// The test client connects, sends each heartbeat over HTTPS and mirrors it with a synthetic event batch, all of
// which the gateway pairs and finds equal; told to Drain, it opens its next connection after the delay and carries
// on there.
func TestClientMirrorsAndReconnectsAfterDrain(t *testing.T) {
	h := newHarness(t, nil)
	api, beats := fakeAPI(t, h, runnerA)
	m := h.g.metrics
	sum := runClient(t, h, clientOptions{
		api: api.URL, runnerToken: "runner-token", processID: processA, heartbeat: 100 * time.Millisecond,
		mirror: true, httpBeats: true, events: 3, untilDrains: 1, refreshBefore: 5 * time.Minute,
	}, func() {
		eventually(t, 10*time.Second, "mirrors compared", func() bool { return m.shadowPairs.get("events", "match") >= 2 })
		for _, c := range h.g.reg.snapshot() {
			c.drain(150 * time.Millisecond)
		}
	})
	if sum.Connects < 2 || sum.Drains != 1 || sum.ReconnectsAfterDrain != 1 || len(sum.DrainReconnectsMs) != 1 || sum.DrainReconnectsMs[0] != 150 {
		t.Fatalf("summary %+v", sum)
	}
	if sum.HTTPHeartbeats["ok"] < 2 || int(beats.Load()) != sum.HTTPHeartbeats["ok"] || sum.MirrorsSent["heartbeat"] != sum.HTTPHeartbeats["ok"] {
		t.Fatalf("HTTP heartbeats %v, the API saw %d, mirrored %v", sum.HTTPHeartbeats, beats.Load(), sum.MirrorsSent)
	}
	if sum.RPCResults["LINK_MODE_HTTP"] == 0 || sum.Modes["MODE_HTTP"] == 0 {
		t.Fatalf("answers %+v", sum)
	}
	eventually(t, 5*time.Second, "every mirror compared", func() bool {
		return int(m.shadowPairs.get("heartbeat", "match")) == sum.MirrorsSent["heartbeat"] &&
			int(m.shadowPairs.get("events", "match")) == sum.MirrorsSent["events"]
	})
	if m.shadowPairs.get("heartbeat", "mismatch")+m.shadowPairs.get("events", "mismatch") != 0 {
		t.Fatal("a mirror differed")
	}
	for _, side := range []string{"typed", "raw"} {
		for _, reason := range []string{"expired", "evicted", "closed"} {
			if n := m.shadowUnpaired.get(side, reason); n != 0 {
				t.Errorf("%v %s halves %s", n, side, reason)
			}
		}
	}
	// The process's second connection superseded its first.
	eventually(t, 5*time.Second, "the drained connection closed", func() bool {
		return m.disconnects.get("superseded")+m.disconnects.get("client_closed") >= 1
	})
}

func TestAlteredMirrorsAreCountedAsMismatches(t *testing.T) {
	h := newHarness(t, nil)
	api, _ := fakeAPI(t, h, runnerA)
	m := h.g.metrics
	sum := runClient(t, h, clientOptions{
		api: api.URL, runnerToken: "runner-token", processID: processA, heartbeat: 50 * time.Millisecond,
		mirror: true, events: 2, corruptEvery: 3, refreshBefore: 5 * time.Minute, untilDrains: 1,
	}, func() {
		eventually(t, 10*time.Second, "mismatches", func() bool {
			return m.shadowPairs.get("heartbeat", "mismatch") >= 1 && m.shadowPairs.get("events", "mismatch") >= 1
		})
		for _, c := range h.g.reg.snapshot() {
			c.drain(10 * time.Millisecond)
		}
	})
	if sum.CorruptedMirrors == 0 {
		t.Fatal("nothing altered")
	}
	if m.shadowMismatches.get("heartbeat", "idleCapacity") == 0 || m.shadowMismatches.get("events", "type") == 0 {
		t.Fatalf("fields: idleCapacity %v type %v", m.shadowMismatches.get("heartbeat", "idleCapacity"), m.shadowMismatches.get("events", "type"))
	}
}

func TestClientFollowsRefusalsAndRevocation(t *testing.T) {
	h := newHarness(t, nil)
	api, _ := fakeAPI(t, h, runnerA)
	h.g.deny.replace(map[string]struct{}{"cred-" + runnerA: {}})
	cl, err := newClient(clientOptions{api: api.URL, runnerToken: "runner-token", processID: processA, refreshBefore: time.Minute},
		slog.New(slog.NewTextHandler(h.logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	cl.dial = h.srv.Client()
	_, err = cl.connect(context.Background())
	var ref *refusal
	if !asRefusal(err, &ref) || ref.status != http.StatusUnauthorized || ref.code != "UNAUTHENTICATED" || cl.token != "" {
		t.Fatalf("revoked: %v (token kept: %v)", err, cl.token != "")
	}
	if cl.sum.Refusals["401"] != 1 {
		t.Fatalf("refusals %v", cl.sum.Refusals)
	}
}

func asRefusal(err error, target **refusal) bool {
	r, ok := err.(*refusal)
	if ok {
		*target = r
	}
	return ok
}

func TestBackoffIsJitteredUpToAMinute(t *testing.T) {
	for n := 0; n < 20; n++ {
		ceiling := time.Second << min(n, 6)
		if ceiling > time.Minute {
			ceiling = time.Minute
		}
		for i := 0; i < 50; i++ {
			if d := backoff(n); d <= 0 || d > ceiling+time.Millisecond {
				t.Fatalf("backoff(%d) = %s", n, d)
			}
		}
	}
}
