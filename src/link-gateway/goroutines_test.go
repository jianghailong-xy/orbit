package main

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// An idle connection holds one goroutine, its reader: the writer runs only while there is something to write, the
// heartbeat worker only while a beat is forwarded, and pings come from a timer. At hundreds of thousands of
// connections each goroutine is a stack the GC scans at every cycle (task 34paLvEDFObkoBxYLAJSN: 4 a connection).
func TestAnIdleConnectionHoldsOneGoroutine(t *testing.T) {
	const conns = 40
	h := newLinkHarness(t, []*fakeBackend{newFakeBackend(t, heartbeatAnswer)}, func(c *config) {
		c.PingInterval = 50 * time.Millisecond
	})
	tcs := make([]*testConn, conns)
	for i := range tcs {
		process := fmt.Sprintf("0190a0b0-0000-4000-8000-%012x", 0x700+i)
		tcs[i], _ = h.connectLink(fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", 0x700+i), process)
		tcs[i].send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: process, BeatId: 1}))
	}
	for _, tc := range tcs {
		tc.await("heartbeat_ack", 5*time.Second, nil)
	}
	// Pings come and go meanwhile; between them, each connection is down to its reader.
	var got map[string]int
	eventually(t, 5*time.Second, "one goroutine a connection", func() bool {
		got = gatewayGoroutines()
		return got["reader"] == conns && got["other"] == 0
	})
	if h.g.reg.count() != conns {
		t.Fatalf("%d connections", h.g.reg.count())
	}
	t.Logf("%d idle connections: %v", conns, got)
}

// gatewayGoroutines counts the goroutines serving connections: the readers, and any other running the gateway's
// connection code.
func gatewayGoroutines() map[string]int {
	buf := make([]byte, 16<<20)
	buf = buf[:runtime.Stack(buf, true)]
	counts := map[string]int{}
	for _, g := range strings.Split(string(buf), "\n\n") {
		switch {
		case strings.Contains(g, "link-gateway.(*conn).readLoop"):
			counts["reader"]++
		case strings.Contains(g, "link-gateway.(*conn).") || strings.Contains(g, "link-gateway.(*linkState)."):
			counts["other"]++
		}
	}
	return counts
}
