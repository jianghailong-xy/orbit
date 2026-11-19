package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeAPI is the apiserver route the client calls: link tokens from the harness's key.
func fakeAPI(t *testing.T, h *harness, runner string) *httptest.Server {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer runner-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/api/runner/link-token" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			LeaseOwner string `json:"leaseOwner"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		exp := time.Now().Add(time.Hour)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token": h.keys.sign(tokenClaims(runner, body.LeaseOwner, exp)), "expiresAt": exp.UTC().Format(time.RFC3339Nano),
			"cellId": "cell-1", "linkUrl": h.url,
		})
	}))
	t.Cleanup(api.Close)
	return api
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

// The test client connects and heartbeats, each beat answered with MODE_LINK; told to Drain, it opens its next
// connection after the delay and carries on there.
func TestClientHeartbeatsAndReconnectsAfterDrain(t *testing.T) {
	h := newHarness(t, nil)
	api := fakeAPI(t, h, runnerA)
	m := h.g.metrics
	sum := runClient(t, h, clientOptions{
		api: api.URL, runnerToken: "runner-token", processID: processA, heartbeat: 100 * time.Millisecond,
		untilDrains: 1, refreshBefore: 5 * time.Minute,
	}, func() {
		eventually(t, 10*time.Second, "heartbeats", func() bool { return m.heartbeats.get() >= 3 })
		for _, c := range h.g.reg.snapshot() {
			c.drain(150 * time.Millisecond)
		}
	})
	if sum.Connects < 2 || sum.Drains != 1 || sum.ReconnectsAfterDrain != 1 || len(sum.DrainReconnectsMs) != 1 || sum.DrainReconnectsMs[0] != 150 {
		t.Fatalf("summary %+v", sum)
	}
	if sum.HeartbeatsSent < 3 || sum.HeartbeatAcks < 3 || sum.Modes["MODE_LINK"] != sum.HeartbeatAcks || len(sum.RPCResults) != 0 {
		t.Fatalf("heartbeats %+v", sum)
	}
	// The process's second connection superseded its first.
	eventually(t, 5*time.Second, "the drained connection closed", func() bool {
		return m.disconnects.get("superseded")+m.disconnects.get("client_closed") >= 1
	})
}

func TestClientFollowsRefusalsAndRevocation(t *testing.T) {
	h := newHarness(t, nil)
	api := fakeAPI(t, h, runnerA)
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
