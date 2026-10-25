package main

import (
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Welcome's sessions and release, as the welcome route answers them (welcome.go).

const (
	// resumedA is a session a runner names by its UUID; resumedB one it names by its public id, resumedBPublic.
	resumedA       = "0190a0b0-0000-7000-8000-0000000000a1"
	resumedB       = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6071"
	resumedBPublic = "31PykwnEeaJbPHsbp3a1h"
)

// resumingHello is linkHello naming the sessions process resumes, as a runner with work in hand says it.
func resumingHello(process string, sessions ...*linkpb.SessionResume) *linkpb.Frame {
	f := linkHello(process)
	f.GetHello().Sessions = sessions
	return f
}

// greet dials as process of runner, says hello and returns the connection with its Welcome.
func (h *harness) greet(runner, process string, hello *linkpb.Frame) (*testConn, *linkpb.Welcome) {
	h.t.Helper()
	tc, resp, err := h.dial(h.token(runner, process))
	if err != nil {
		h.t.Fatalf("dial: %v (%v)", err, resp)
	}
	tc.send(hello)
	return tc, tc.expect("welcome", 5*time.Second).GetWelcome()
}

// welcomeAsked is the session ids a welcome call named.
func welcomeAsked(t *testing.T, r backendRequest) []string {
	t.Helper()
	var asked struct {
		SessionIDs []string `json:"sessionIds"`
	}
	if err := json.Unmarshal(r.Body, &asked); err != nil || asked.SessionIDs == nil {
		t.Fatalf("welcome body %s: %v", r.Body, err)
	}
	return asked.SessionIDs
}

func TestWelcomeSaysWhereEachSessionStandsAsTheWelcomeRouteAnswers(t *testing.T) {
	backend := newFakeBackend(t, nil)
	backend.setWelcome(func(w http.ResponseWriter, r *http.Request, body []byte) {
		answer := map[string]any{"release": map[string]any{"version": "0.1.241", "rollback": true}}
		var sessions []map[string]any
		for _, id := range welcomeAsked(t, backendRequest{Body: body}) {
			state := map[string]any{"sessionId": id, "durableSeq": 0, "leaseHeld": false, "sessionPublicId": "ignored"}
			switch id {
			case resumedA:
				state["durableSeq"], state["leaseHeld"] = 41, true
			case resumedB:
				state["durableSeq"] = 7
			}
			sessions = append(sessions, state)
		}
		answer["sessions"] = sessions
		writeJSON(w, http.StatusOK, answer)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	_, welcome := h.greet(runnerA, processA, resumingHello(processA,
		&linkpb.SessionResume{SessionId: resumedA, LastSeq: 45, TurnId: "0190a0b0-0000-7000-8000-0000000000f1"},
		&linkpb.SessionResume{SessionId: resumedBPublic, LastSeq: 7},
		&linkpb.SessionResume{SessionId: "not.a.session"},
	))

	calls := backend.welcomeCalls()
	if len(calls) != 1 || calls[0].Method != http.MethodPost {
		t.Fatalf("welcome calls %+v", calls)
	}
	// The route is asked in the spelling it reads, a UUID, with the headers every forwarded call carries.
	if got := welcomeAsked(t, calls[0]); !slices.Equal(got, []string{resumedA, resumedB, "not.a.session"}) {
		t.Fatalf("asked %v", got)
	}
	if calls[0].Header.Get(runnerLinkTokenHeader) == "" || calls[0].Header.Get("Authorization") != "Bearer "+h.g.cfg.GatewayToken ||
		calls[0].Header.Get(runnerCapabilitiesHeader) != "session-terminal-handoff-v1,source-pin/v1" {
		t.Fatalf("headers %v", calls[0].Header)
	}
	// Under the ids the runner sent, in its order.
	want := []*linkpb.SessionState{
		{SessionId: resumedA, DurableSeq: 41, LeaseHeld: true},
		{SessionId: resumedBPublic, DurableSeq: 7},
		{SessionId: "not.a.session"},
	}
	if len(welcome.GetSessions()) != len(want) {
		t.Fatalf("sessions %v", welcome.GetSessions())
	}
	for i, s := range welcome.GetSessions() {
		if !proto.Equal(s, want[i]) {
			t.Fatalf("session %d: %v, want %v", i, s, want[i])
		}
	}
	if r := welcome.GetRelease(); r.GetVersion() != "0.1.241" || !r.GetRollback() {
		t.Fatalf("release %v", r)
	}
	if welcome.GetMode() != linkpb.Mode_MODE_LINK || h.g.metrics.welcomeLookups.get("answered") != 1 {
		t.Fatalf("mode %v, lookups %v", welcome.GetMode(), h.g.metrics.welcomeLookups.get("answered"))
	}

	// A Hello naming no session still asks, for the release.
	_, empty := h.greet(runnerA, processB, linkHello(processB))
	if len(empty.GetSessions()) != 0 || empty.GetRelease().GetVersion() != "0.1.241" {
		t.Fatalf("a Hello naming nothing: %v", empty)
	}
	if calls := backend.welcomeCalls(); len(calls) != 2 || len(welcomeAsked(t, calls[1])) != 0 {
		t.Fatalf("welcome calls %+v", calls)
	}
}

// Whatever keeps the route from answering, the Welcome goes without sessions or release, at once, and the connection
// works: the runner keeps every unacknowledged event and sends it again, as it would with no Welcome state at all.
func TestAWelcomeTheRouteCannotAnswerGoesWithoutSessionsOrReleaseAndTheConnectionWorks(t *testing.T) {
	statesNoneOfTwo := func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": []map[string]any{
			{"sessionId": resumedA, "durableSeq": 3, "leaseHeld": true},
		}, "release": map[string]any{"version": "0.1.241"}})
	}
	for _, c := range []struct {
		name, result string
		welcome      func(w http.ResponseWriter, r *http.Request, body []byte)
	}{
		{"the database is down", "refused", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"code": "DB_UNAVAILABLE", "retryable": true})
		}},
		{"an apiserver older than the route", "refused", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeJSON(w, http.StatusNotFound, map[string]any{"message": "Cannot POST /api/runner/link/welcome"})
		}},
		{"an answer stating one session of two", "malformed", statesNoneOfTwo},
		{"an answer out of order", "malformed", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeJSON(w, http.StatusOK, map[string]any{"sessions": []map[string]any{
				{"sessionId": resumedB, "durableSeq": 3, "leaseHeld": true},
				{"sessionId": resumedA, "durableSeq": 3, "leaseHeld": true},
			}})
		}},
		{"an answer without a lease", "malformed", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			writeJSON(w, http.StatusOK, map[string]any{"sessions": []map[string]any{
				{"sessionId": resumedA, "durableSeq": 3}, {"sessionId": resumedB, "durableSeq": 3, "leaseHeld": true},
			}})
		}},
		{"an answer that is not JSON", "malformed", func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("<html>"))
		}},
		{"a route slower than the Welcome waits", "failed", func(w http.ResponseWriter, r *http.Request, body []byte) {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			statesNoneOfTwo(w, r, body)
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			backend := newFakeBackend(t, heartbeatAnswer)
			backend.setWelcome(c.welcome)
			h := newLinkHarness(t, []*fakeBackend{backend}, func(cfg *config) { cfg.link.WelcomeTimeout = 300 * time.Millisecond })
			started := time.Now()
			tc, welcome := h.greet(runnerA, processA, resumingHello(processA,
				&linkpb.SessionResume{SessionId: resumedA, LastSeq: 9}, &linkpb.SessionResume{SessionId: resumedB, LastSeq: 2}))
			if took := time.Since(started); took > 2*time.Second {
				t.Fatalf("Welcome took %s", took)
			}
			if len(welcome.GetSessions()) != 0 || welcome.GetRelease() != nil || welcome.GetMode() != linkpb.Mode_MODE_LINK {
				t.Fatalf("Welcome %v", welcome)
			}
			if got := h.g.metrics.welcomeLookups.get(c.result); got != 1 {
				t.Fatalf("lookups %s: %v", c.result, got)
			}
			// The connection carries the work: a heartbeat is forwarded and answered.
			tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, IdleCapacity: 1, SessionIds: []string{resumedA}}))
			if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 {
				t.Fatalf("heartbeat ack %v", ack)
			}
		})
	}

	t.Run("no backend reached", func(t *testing.T) {
		h := newHarness(t, func(cfg *config) {
			cfg.Mode = linkpb.Mode_MODE_LINK
			cfg.InternalAPIURLs = []string{deadBackend(t)}
			cfg.link.RetryBudget, cfg.link.WelcomeTimeout = 200*time.Millisecond, time.Second
		})
		_, welcome := h.greet(runnerA, processA, resumingHello(processA, &linkpb.SessionResume{SessionId: resumedA, LastSeq: 9}))
		if len(welcome.GetSessions()) != 0 || welcome.GetRelease() != nil {
			t.Fatalf("Welcome %v", welcome)
		}
		if got := h.g.metrics.welcomeLookups.get("failed"); got != 1 {
			t.Fatalf("lookups failed: %v", got)
		}
	})
}

func TestAWelcomeInModeHTTPAsksNothing(t *testing.T) {
	backend := newFakeBackend(t, nil)
	h := newHarness(t, func(cfg *config) { cfg.InternalAPIURLs = []string{backend.url()} })
	_, welcome := h.greet(runnerA, processA, resumingHello(processA, &linkpb.SessionResume{SessionId: resumedA, LastSeq: 9}))
	if welcome.GetMode() != linkpb.Mode_MODE_HTTP || len(welcome.GetSessions()) != 0 || welcome.GetRelease() != nil {
		t.Fatalf("Welcome %v", welcome)
	}
	if n := len(backend.welcomeCalls()) + len(backend.requests()); n != 0 {
		t.Fatalf("MODE_HTTP called a backend %d times", n)
	}
}
