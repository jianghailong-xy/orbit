package main

import (
	"compress/flate"
	"io"
	"sync"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Heartbeat bytes (README.md, "Metrics"). The WebSocket library returns a message inflated, so link_heartbeat_bytes_total
// counts inflated bytes, split by part: typed fields, facts sent whole, facts sent by digest. What crossed the wire is
// estimated by deflating one heartbeat in heartbeatWireSampleEvery with the link's flate settings (BestSpeed, no
// context takeover), counted in link_heartbeat_wire_bytes_total beside the inflated size of the same frames
// (link_heartbeat_wire_sampled_inflated_bytes_total), whose ratio is the compression.
const (
	heartbeatWireSampleEvery = 16
	// A frame past this is not sampled: the estimate is for the ordinary beat, and the cost per sample is bounded.
	heartbeatWireSampleMaxBytes = 256 << 10
)

// countHeartbeatBytes adds one heartbeat frame's inflated size, `data` being the message as it was read.
func (m *gatewayMetrics) countHeartbeatBytes(hb *linkpb.Heartbeat, data []byte) {
	var whole, digest int
	for _, f := range hb.GetFacts() {
		if len(f.GetJson()) > 0 {
			whole += proto.Size(f)
		} else {
			digest += proto.Size(f)
		}
	}
	m.heartbeatBytes.add(float64(len(data)-whole-digest), "typed")
	m.heartbeatBytes.add(float64(whole), "fact_whole")
	m.heartbeatBytes.add(float64(digest), "fact_digest")
	if len(data) <= heartbeatWireSampleMaxBytes && m.heartbeatSeen.Add(1)%heartbeatWireSampleEvery == 0 {
		m.heartbeatWireInflated.add(float64(len(data)))
		m.heartbeatWire.add(float64(deflatedSize(data)))
	}
}

type sizeWriter struct{ n int }

func (w *sizeWriter) Write(p []byte) (int, error) { w.n += len(p); return len(p), nil }

var flatePool = sync.Pool{New: func() any {
	w, _ := flate.NewWriter(io.Discard, flate.BestSpeed)
	return w
}}

// deflatedSize is what data deflates to with no context carried between messages.
func deflatedSize(data []byte) int {
	w := flatePool.Get().(*flate.Writer)
	defer flatePool.Put(w)
	var out sizeWriter
	w.Reset(&out)
	_, _ = w.Write(data)
	_ = w.Close()
	return out.n
}
