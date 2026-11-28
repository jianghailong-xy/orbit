package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orbit/link-gateway/linkpb"
)

// permessage-deflate (gateway.go linkCompressionThreshold, docs/runner-link-design.md §15.17): negotiated with a
// runner that offers it, and not with one that does not, which connects and works as it always has.

type writeCountedConn struct {
	net.Conn
	n *atomic.Int64
}

func (c writeCountedConn) Write(b []byte) (int, error) {
	c.n.Add(int64(len(b)))
	return c.Conn.Write(b)
}

// dialWith dials as a runner in mode, counting the bytes it writes, and says Hello.
func (h *harness) dialWith(t *testing.T, mode websocket.CompressionMode, written *atomic.Int64) (*testConn, *http.Response) {
	t.Helper()
	transport := h.srv.Client().Transport.(*http.Transport).Clone()
	dialer := &net.Dialer{}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := dialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return writeCountedConn{Conn: c, n: written}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: transport}, CompressionMode: mode,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token(runnerA, processA)}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	ws.SetReadLimit(maxChunkedFrameBytes)
	tc := &testConn{t: t, ws: ws, frames: make(chan *linkpb.Frame, 256), done: make(chan struct{})}
	go tc.read()
	t.Cleanup(func() { _ = ws.CloseNow() })
	tc.send(linkHello(processA))
	tc.expect("welcome", 5*time.Second)
	return tc, resp
}

func TestCompressionIsNegotiatedOnlyWithARunnerThatOffersIt(t *testing.T) {
	// A heartbeat whose parts are a few KB of text, as a first beat's are.
	var skills []map[string]string
	for i := 0; i < 60; i++ {
		skills = append(skills, map[string]string{"name": "skill", "description": "Use when the task involves the runner link: conventions, pitfalls and a worked example"})
	}
	raw, _ := json.Marshal(skills)
	beat := fact("skills", string(raw))

	for _, c := range []struct {
		name string
		mode websocket.CompressionMode
		want bool
	}{
		{"an older runner, which offers no compression", websocket.CompressionDisabled, false},
		{"a runner offering permessage-deflate without context takeover", websocket.CompressionNoContextTakeover, true},
		{"a runner offering it with context takeover", websocket.CompressionContextTakeover, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			backend := newFakeBackend(t, heartbeatAnswer)
			h := newLinkHarness(t, []*fakeBackend{backend}, nil)
			var written atomic.Int64
			tc, resp := h.dialWith(t, c.mode, &written)
			ext := resp.Header.Get("Sec-WebSocket-Extensions")
			if got := strings.Contains(ext, "permessage-deflate"); got != c.want {
				t.Fatalf("Sec-WebSocket-Extensions %q, want permessage-deflate %v", ext, c.want)
			}
			if c.want && !strings.Contains(ext, "server_no_context_takeover") {
				t.Errorf("the gateway keeps its context (%q): each connection would hold a writer of its own", ext)
			}
			before := written.Load()
			tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: 1, Facts: []*linkpb.Fact{beat}}))
			ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
			if len(ack.GetReconcileJson()) == 0 {
				t.Fatalf("the heartbeat was not reconciled: %v", ack)
			}
			if body := lastBody(t, backend); !jsonEqual(body["skills"], beat.GetJson()) {
				t.Fatal("the heartbeat was forwarded with other skills than it carried")
			}
			sent := written.Load() - before
			t.Logf("a %d-byte part went in %d bytes on the wire", len(beat.GetJson()), sent)
			if compressed := sent < int64(len(beat.GetJson()))/2; compressed != c.want {
				t.Errorf("%d bytes on the wire for a %d-byte part: compressed %v, want %v", sent, len(beat.GetJson()), compressed, c.want)
			}
		})
	}
}
