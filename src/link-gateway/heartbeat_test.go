package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// Heartbeats forwarded to the heartbeat route (heartbeat.go).

const (
	watchedSession  = "0190a0b0-0000-7000-8000-0000000000d1"
	decidedApproval = "0190a0b0-0000-7000-8000-0000000000f1"
)

func fact(kind, value string) *linkpb.Fact {
	sum := sha256.Sum256([]byte(value))
	return &linkpb.Fact{Kind: kind, Sha256: hex.EncodeToString(sum[:]), Json: []byte(value)}
}

func digestOnly(f *linkpb.Fact) *linkpb.Fact {
	return &linkpb.Fact{Kind: f.GetKind(), Sha256: f.GetSha256()}
}

func heartbeatFrame(hb *linkpb.Heartbeat) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}
}

// heartbeatAnswer is what the heartbeat route answers a link call with: today's HeartbeatResponse and linkHints.
func heartbeatAnswer(w http.ResponseWriter, r *http.Request, body []byte) {
	writeJSON(w, 200, map[string]any{
		"cancelSessionIds": []string{}, "maxConcurrent": 2, "loginRequest": map[string]any{"provider": "claude"},
		"linkHints": map[string]any{
			"inboxSessionIds": []string{"0190a0b0-0000-7000-8000-0000000000c1"}, "claim": true,
			"approvals": []map[string]any{{"sessionId": "0190a0b0-0000-7000-8000-0000000000c1", "approvalId": decidedApproval}},
			"watchers":  map[string]any{"instance": "i-1", "sessions": []map[string]any{{"sessionId": watchedSession, "watchers": 2}}},
		},
	})
}

func TestAHeartbeatIsForwardedAsTheBodyItsMirrorWouldCarry(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	hb := &linkpb.Heartbeat{
		ProcessId: processA, IdleCapacity: 3, Draining: true,
		SessionIds:         []string{"0190a0b0-0000-7000-8000-0000000000c2", "0190a0b0-0000-7000-8000-0000000000c1"},
		SupportedProviders: []string{"claude", "codex", "cursor"},
		Facts: []*linkpb.Fact{
			fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5","label":"Opus 5.5 — 長文"}]}`),
			fact("engines", `[{"engine":"claude","installed":true,"auth":"yes"}]`),
			fact("reposRoot", `"/srv/repos/naïve"`),
			fact("runsAsRoot", `false`),
		},
	}
	tc.send(heartbeatFrame(hb))
	ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()

	calls := backend.requestsTo("/api/runner/heartbeat")
	if len(calls) != 1 || calls[0].Method != "POST" {
		t.Fatalf("calls %+v", calls)
	}
	// The body is exactly what the shadow comparison holds the HTTP heartbeat to: the two mappings are inverses.
	hello := linkHello(processA).GetHello()
	if diffs := compareHeartbeat(hb, &linkpb.TunnelRequest{Method: "POST", Path: "/runner/heartbeat", JsonBody: calls[0].Body}, hello); len(diffs) != 0 {
		t.Fatalf("the forwarded body differs from the mirror's mapping: %s\nbody %s", fields(diffs), calls[0].Body)
	}
	var body map[string]any
	_ = json.Unmarshal(calls[0].Body, &body)
	if body["status"] != "ONLINE" || body["version"] != "0.1.240" || body["leaseOwner"] != strings.ToLower(processA) || body["draining"] != true {
		t.Fatalf("body %s", calls[0].Body)
	}
	// The providers the beat names replace Hello's on its call and every later one.
	if got := calls[0].Header.Get("X-Orbit-Supported-Providers"); got != "claude,codex,cursor" {
		t.Fatalf("providers header %q", got)
	}

	if ack.GetMode() != linkpb.Mode_MODE_LINK || len(ack.GetWantFacts()) != 0 {
		t.Fatalf("ack %v", ack)
	}
	// reconcile_json is today's HeartbeatResponse, with the link's hints taken out of it.
	var reconcile map[string]json.RawMessage
	if err := json.Unmarshal(ack.GetReconcileJson(), &reconcile); err != nil {
		t.Fatal(err)
	}
	if _, ok := reconcile["linkHints"]; ok || string(reconcile["maxConcurrent"]) != "2" || reconcile["loginRequest"] == nil {
		t.Fatalf("reconcile_json %s", ack.GetReconcileJson())
	}
	hints := ack.GetHints()
	if !hints.GetClaim() || strings.Join(hints.GetInboxSessionIds(), ",") != "0190a0b0-0000-7000-8000-0000000000c1" ||
		len(hints.GetWatchers()) != 1 || hints.GetWatchers()[0].GetSessionId() != watchedSession || hints.GetWatchers()[0].GetWatchers() != 2 {
		t.Fatalf("hints %v", hints)
	}
	// The approvals the route names as decided and still waited for, as the ApprovalHints they stand for.
	if a := hints.GetApprovals(); len(a) != 1 || a[0].GetSessionId() != "0190a0b0-0000-7000-8000-0000000000c1" || a[0].GetApprovalId() != decidedApproval {
		t.Fatalf("hints.approvals %v", a)
	}
	if got := h.g.metrics.heartbeatForwards.get("forwarded"); got != 1 {
		t.Fatalf("forwarded %v", got)
	}
}

func TestAFactSentByDigestIsFilledFromWhatTheConnectionHolds(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	catalog := fact("modelCatalog", `{"claude":[{"id":"claude-opus-5-5"}]}`)
	engines := fact("engines", `[{"engine":"claude","installed":true,"auth":"yes"}]`)

	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, Facts: []*linkpb.Fact{catalog, engines}}))
	tc.await("heartbeat_ack", 5*time.Second, nil)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(engines)}}))
	if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 || len(ack.GetWantFacts()) != 0 {
		t.Fatalf("a beat of known digests: %v", ack)
	}
	calls := backend.requestsTo("/api/runner/heartbeat")
	if len(calls) != 2 {
		t.Fatalf("%d calls", len(calls))
	}
	var first, second map[string]json.RawMessage
	_ = json.Unmarshal(calls[0].Body, &first)
	_ = json.Unmarshal(calls[1].Body, &second)
	for _, kind := range []string{"modelCatalog", "engines"} {
		if !jsonEqual(first[kind], second[kind]) || second[kind] == nil {
			t.Fatalf("%s: the digest-only beat carried %s", kind, second[kind])
		}
	}

	// A digest the connection does not hold: the beat is not forwarded, and the runner is asked for the part whole.
	changed := fact("engines", `[{"engine":"claude","installed":true,"auth":"no"}]`)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, Facts: []*linkpb.Fact{digestOnly(catalog), digestOnly(changed)}}))
	ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if strings.Join(ack.GetWantFacts(), ",") != "engines" || len(ack.GetReconcileJson()) != 0 || ack.GetHints() != nil {
		t.Fatalf("a beat of an unknown digest: %v", ack)
	}
	if n := len(backend.requestsTo("/api/runner/heartbeat")); n != 2 {
		t.Fatalf("a beat with an unknown digest was forwarded (%d calls)", n)
	}
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, Facts: []*linkpb.Fact{digestOnly(catalog), changed}}))
	if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); len(ack.GetReconcileJson()) == 0 {
		t.Fatalf("the beat with the part whole: %v", ack)
	}
	calls = backend.requestsTo("/api/runner/heartbeat")
	var last map[string]json.RawMessage
	_ = json.Unmarshal(calls[len(calls)-1].Body, &last)
	if !jsonEqual(last["engines"], changed.GetJson()) {
		t.Fatalf("engines %s", last["engines"])
	}
	m := h.g.metrics
	if m.heartbeatFacts.get("cached") != 4 || m.heartbeatFacts.get("unknown_digest") != 1 || m.heartbeatForwards.get("want_facts") != 1 {
		t.Fatalf("cached %v unknown %v want %v", m.heartbeatFacts.get("cached"), m.heartbeatFacts.get("unknown_digest"), m.heartbeatForwards.get("want_facts"))
	}
}

func TestAHeartbeatWithoutAnAnswerIsAcknowledgedWithNothingToApply(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Retry-After-Ms", "2000")
		writeJSON(w, 503, map[string]any{"code": "DATABASE_UNAVAILABLE", "retryable": true, "retryAfterMs": 2000})
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if ack.GetMode() != linkpb.Mode_MODE_LINK || len(ack.GetReconcileJson()) != 0 || ack.GetHints() != nil {
		t.Fatalf("ack %v", ack)
	}
	if h.g.metrics.heartbeatForwards.get("refused") != 1 {
		t.Fatal("not counted as refused")
	}
	if h.g.reg.count() != 1 {
		t.Fatal("the connection was closed")
	}
}

func TestABeatWaitingForItsTurnIsReplacedByTheNewest(t *testing.T) {
	release := make(chan struct{})
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if strings.Contains(string(body), `"idleCapacity":1`) {
			<-release
		}
		heartbeatAnswer(w, r, body)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, IdleCapacity: 1}))
	eventually(t, 5*time.Second, "the first beat at the route", func() bool { return len(backend.requests()) == 1 })
	for capacity := uint32(2); capacity <= 4; capacity++ {
		tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, IdleCapacity: capacity}))
	}
	eventually(t, 5*time.Second, "two beats replaced", func() bool { return h.g.metrics.heartbeatForwards.get("superseded") == 2 })
	close(release)
	tc.await("heartbeat_ack", 5*time.Second, nil)
	tc.await("heartbeat_ack", 5*time.Second, nil)
	calls := backend.requestsTo("/api/runner/heartbeat")
	if len(calls) != 2 || !strings.Contains(string(calls[1].Body), `"idleCapacity":4`) {
		t.Fatalf("calls %d, last %s", len(calls), calls[len(calls)-1].Body)
	}
}

// A session a heartbeat names by its public id is written in the spelling the heartbeat route reads, its UUID.
func TestSupervisedSessionsAreForwardedByTheirUUID(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, SessionIds: []string{"2x5PpI0zRtLFFWeu0anPl", eventSession, "not-an-id"}}))
	tc.await("heartbeat_ack", 5*time.Second, nil)
	var body struct {
		Supervised []string `json:"supervisedSessionIds"`
	}
	_ = json.Unmarshal(backend.requestsTo("/api/runner/heartbeat")[0].Body, &body)
	if strings.Join(body.Supervised, ",") != eventSession+","+eventSession+",not-an-id" {
		t.Fatalf("supervisedSessionIds %v", body.Supervised)
	}
}

func TestAHeartbeatIsForwardedForItsConnectionsProcess(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processB}))
	tc.await("heartbeat_ack", 5*time.Second, nil)
	var body map[string]any
	_ = json.Unmarshal(backend.requestsTo("/api/runner/heartbeat")[0].Body, &body)
	if body["leaseOwner"] != strings.ToLower(processA) {
		t.Fatalf("leaseOwner %v", body["leaseOwner"])
	}
	if h.g.metrics.heartbeatForwards.get("other_process") != 1 {
		t.Fatal("not counted")
	}
}
