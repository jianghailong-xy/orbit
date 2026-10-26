package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orbit/link-gateway/linkpb"
)

// Answers a drill has the gateway lose (drill.go, LINK_DRILL_LOSE_ANSWERS).

const drillSession = "0190a0b0-0000-7000-8000-0000000000d1"

// drillBackend answers a claim with drillSession, or with nothing when asked ?empty=1, and an inbox fetch with a turn
// of the kind ?kind= names, or with none. Asked ?refuse=1, it answers 409 with a body that still names them.
func drillBackend(t *testing.T) *fakeBackend {
	return newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		q := r.URL.Query()
		switch {
		case q.Get("refuse") == "1":
			writeJSON(w, http.StatusConflict, map[string]any{"code": "CONFLICT", "retryable": false,
				"sessionId": drillSession, "turnId": "turn-message", "kind": "message"})
		case strings.HasSuffix(r.URL.Path, "/claim") && q.Get("empty") == "1":
			writeJSON(w, http.StatusOK, map[string]any{})
		case strings.HasSuffix(r.URL.Path, "/claim"):
			writeJSON(w, http.StatusOK, map[string]any{"sessionId": drillSession, "title": "a drill"})
		case strings.HasSuffix(r.URL.Path, "/inbox") && q.Get("kind") == "":
			writeJSON(w, http.StatusOK, map[string]any{"turnId": "", "seq": 0, "kind": "message"})
		case strings.HasSuffix(r.URL.Path, "/inbox"):
			writeJSON(w, http.StatusOK, map[string]any{"turnId": "turn-" + q.Get("kind"), "seq": 7, "kind": q.Get("kind")})
		default:
			// Another route, whatever its answer names, is never a drill's.
			writeJSON(w, http.StatusOK, map[string]any{"sessionId": drillSession, "turnId": "turn-message", "kind": "message"})
		}
	})
}

// framesUntilEnd is every frame the connection got until it ended.
func (tc *testConn) framesUntilEnd(timeout time.Duration) []*linkpb.Frame {
	tc.t.Helper()
	var got []*linkpb.Frame
	deadline := time.After(timeout)
	for {
		select {
		case f := <-tc.frames:
			got = append(got, f)
		case <-tc.done:
			for {
				select {
				case f := <-tc.frames:
					got = append(got, f)
				default:
					return got
				}
			}
		case <-deadline:
			tc.t.Fatalf("connection still open after %s", timeout)
			return nil
		}
	}
}

// expectCut sends the call request and checks that the connection is then cut: no answer to it, no Close frame, no
// WebSocket close.
func (tc *testConn) expectCut(request, method, path string) {
	tc.t.Helper()
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: request,
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: method, Path: path}}}}})
	for _, f := range tc.framesUntilEnd(5 * time.Second) {
		if f.GetRpcResult().GetRequestId() == request || f.GetClose() != nil {
			tc.t.Fatalf("the connection was not cut: it carried %s", summarize(f))
		}
	}
	if status := websocket.CloseStatus(tc.err); status != -1 {
		tc.t.Fatalf("the connection was closed with %v, not cut: %v", status, tc.err)
	}
}

func TestADrillLosesTheAnswersItNamesAndTheCallIsAnsweredAgain(t *testing.T) {
	backend := drillBackend(t)
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) {
		c.DrillLoseAnswers = map[string]int{"claim": 2, "inbox": 1}
	})
	tc, _ := h.connectLink(runnerA, processA)
	inbox := "/runner/sessions/" + drillSession + "/inbox?acceptsSteer=1"
	session := func(res *linkpb.RpcResult) bool {
		return strings.Contains(string(res.GetTunnel().GetJsonBody()), drillSession)
	}

	// What hands out no work is relayed: a claim with no session, an inbox with no turn, a control turn, a refusal,
	// another route.
	for _, c := range []struct {
		id, method, path string
		status           uint32
	}{
		{"claim-empty", "GET", "/runner/sessions/claim?empty=1", http.StatusOK},
		{"inbox-empty", "GET", inbox, http.StatusOK},
		{"inbox-interrupt", "GET", inbox + "&kind=interrupt", http.StatusOK},
		{"inbox-steer", "GET", inbox + "&kind=steer", http.StatusOK},
		{"claim-refused", "GET", "/runner/sessions/claim?refuse=1", http.StatusConflict},
		{"inbox-refused", "GET", inbox + "&kind=message&refuse=1", http.StatusConflict},
		{"turn-complete", "POST", "/runner/sessions/" + drillSession + "/turn-complete", http.StatusOK},
	} {
		if res := tc.rpc(c.id, c.method, c.path, nil); res.GetTunnel().GetStatus() != c.status {
			t.Fatalf("%s: %v", c.id, res)
		}
	}

	// A claim that hands out a session: the answer is lost and the connection cut. The runner connects again and sends the
	// call again under its request_id. A call's answer is lost once: what it gets from then on is relayed, here a refusal
	// first and then the session, though a loss is left.
	tc.expectCut("claim-1", "GET", "/runner/sessions/claim?wait=0")
	eventually(t, 5*time.Second, "the cut counted", func() bool { return h.g.metrics.disconnects.get("drill_lost_answer") == 1 })
	tc, _ = h.connectLink(runnerA, processA)
	if res := tc.rpc("claim-1", "GET", "/runner/sessions/claim?refuse=1", nil); res.GetTunnel().GetStatus() != http.StatusConflict {
		t.Fatalf("the claim sent again: %v", res)
	}
	if res := tc.rpc("claim-1", "GET", "/runner/sessions/claim?wait=0", nil); !session(res) {
		t.Fatalf("the claim sent once more: %v", res)
	}
	// The next claim's answer is the second loss armed, and the one after it is relayed.
	tc.expectCut("claim-2", "GET", "/runner/sessions/claim?wait=0")
	tc, _ = h.connectLink(runnerA, processA)
	if res := tc.rpc("claim-2", "GET", "/runner/sessions/claim?wait=0", nil); !session(res) {
		t.Fatalf("the claim sent again: %v", res)
	}
	if res := tc.rpc("claim-3", "GET", "/runner/sessions/claim?wait=0", nil); !session(res) {
		t.Fatalf("the next claim: %v", res)
	}

	// An inbox fetch that hands out a message turn, the same way.
	tc.expectCut("inbox-1", "GET", inbox+"&kind=message")
	tc, _ = h.connectLink(runnerA, processA)
	if res := tc.rpc("inbox-1", "GET", inbox+"&kind=message", nil); !strings.Contains(string(res.GetTunnel().GetJsonBody()), "turn-message") {
		t.Fatalf("the fetch sent again: %v", res)
	}
	if res := tc.rpc("inbox-2", "GET", inbox+"&kind=shell", nil); !strings.Contains(string(res.GetTunnel().GetJsonBody()), "turn-shell") {
		t.Fatalf("the next fetch: %v", res)
	}

	eventually(t, 5*time.Second, "the answer again logged", func() bool {
		return strings.Contains(h.logs.String(), `call=inbox request=inbox-1 after_ms=`)
	})
	logs := h.logs.String()
	for _, want := range []string{
		`msg="drill: an answer is lost on its way to the runner; the connection is cut" conn=`,
		`msg="drill: the call whose answer was lost is answered again" conn=`,
		`call=claim request=claim-1 work=` + drillSession + ` left=1`,
		`call=claim request=claim-2 work=` + drillSession + ` left=0`,
		`call=inbox request=inbox-1 work=turn-message left=0`,
		// The first answer after a loss is the one logged: claim-1's was the refusal.
		`answer=409 work="" same_work=false`,
		`answer=200 work=` + drillSession + ` same_work=true`,
		`answer=200 work=turn-message same_work=true`,
	} {
		if !strings.Contains(logs, want) {
			t.Errorf("the log does not say %q", want)
		}
	}
	if n := strings.Count(logs, "drill: an answer is lost"); n != 3 {
		t.Errorf("%d answers lost, want 3", n)
	}
	if n := strings.Count(logs, "is answered again"); n != 3 {
		t.Errorf("%d calls answered again, want 3", n)
	}
	if got := h.g.metrics.disconnects.get("drill_lost_answer"); got != 3 {
		t.Errorf("link_disconnects_total{reason=\"drill_lost_answer\"} = %v", got)
	}
	// The lost answers were the backend's: claim-1 reached it three times and claim-2 twice, beside the empty, the
	// refused and the last claim.
	if n := len(backend.requestsTo("/api/runner/sessions/claim")); n != 8 {
		t.Errorf("%d claims reached the backend, want 8", n)
	}
}

func TestNoAnswerIsLostUnlessADrillSaysSo(t *testing.T) {
	h := newLinkHarness(t, []*fakeBackend{drillBackend(t)}, nil)
	if h.g.drill != nil {
		t.Fatal("a drill is armed by default")
	}
	tc, _ := h.connectLink(runnerA, processA)
	if res := tc.rpc("claim-1", "GET", "/runner/sessions/claim?wait=0", nil); !strings.Contains(string(res.GetTunnel().GetJsonBody()), drillSession) {
		t.Fatalf("claim: %v", res)
	}
	inbox := "/runner/sessions/" + drillSession + "/inbox?acceptsSteer=1&kind=message"
	if res := tc.rpc("inbox-1", "GET", inbox, nil); !strings.Contains(string(res.GetTunnel().GetJsonBody()), "turn-message") {
		t.Fatalf("inbox: %v", res)
	}
	if strings.Contains(h.logs.String(), "drill:") || h.g.metrics.disconnects.get("drill_lost_answer") != 0 {
		t.Fatalf("a drill acted:\n%s", h.logs.String())
	}
}

func TestTheDrillSettingIsChecked(t *testing.T) {
	for value, want := range map[string]map[string]int{
		"":                nil,
		" ":               nil,
		"claim":           {"claim": 1},
		"claim:3, inbox":  {"claim": 3, "inbox": 1},
		"inbox:2,inbox:1": {"inbox": 3},
	} {
		got, err := parseDrillLoseAnswers(value)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%q: %v, %v", value, got, err)
		}
	}
	for _, bad := range []string{"heartbeat", "claim:0", "claim:-1", "claim:x", "claim:", ":3", "Claim"} {
		if _, err := parseDrillLoseAnswers(bad); err == nil || !strings.Contains(err.Error(), "LINK_DRILL_LOSE_ANSWERS") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	keys := newTestKeys(t)
	env := map[string]string{
		"LINK_PUBLIC_KEYS": publicPEM(t, keys.pub), "LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
		"LINK_API_URL": "http://apiserver:3000", "LINK_TLS_MODE": "off",
	}
	if c, err := configFromEnv(func(k string) string { return env[k] }); err != nil || c.DrillLoseAnswers != nil {
		t.Fatalf("by default: %v, %v", c.DrillLoseAnswers, err)
	}
	env["LINK_DRILL_LOSE_ANSWERS"] = "inbox:2"
	if c, err := configFromEnv(func(k string) string { return env[k] }); err != nil || c.DrillLoseAnswers["inbox"] != 2 {
		t.Fatalf("set: %v, %v", c.DrillLoseAnswers, err)
	}
	env["LINK_DRILL_LOSE_ANSWERS"] = "everything"
	if _, err := configFromEnv(func(k string) string { return env[k] }); err == nil || !strings.Contains(err.Error(), `"everything" is not claim or inbox`) {
		t.Fatalf("a bad value: %v", err)
	}
}
