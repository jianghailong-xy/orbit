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
	heartbeatWireSampleMaxBytes = 1 << 20
)

// countHeartbeatBytes adds one heartbeat's size, from onHeartbeat: the one place a beat passes whether it arrived as one
// message or, past sendPieceBytes, as Chunks joined (a joined frame has no single raw message, so sizes are the
// encoded Frame's). The wire estimate encodes the frame again and deflates it as the link would send it: cut into
// pieces of at most sendPieceBytes, each deflated when it is linkCompressionThreshold or more, and summed.
func (m *gatewayMetrics) countHeartbeatBytes(hb *linkpb.Heartbeat) {
	var whole, digest int
	for _, f := range hb.GetFacts() {
		if len(f.GetJson()) > 0 {
			whole += proto.Size(f)
		} else {
			digest += proto.Size(f)
		}
	}
	frame := &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}
	total := proto.Size(frame)
	m.heartbeatBytes.add(float64(total-whole-digest), "typed")
	m.heartbeatBytes.add(float64(whole), "fact_whole")
	m.heartbeatBytes.add(float64(digest), "fact_digest")
	if total > heartbeatWireSampleMaxBytes || m.heartbeatSeen.Add(1)%heartbeatWireSampleEvery != 0 {
		return
	}
	data, err := proto.Marshal(frame)
	if err != nil {
		return
	}
	wire := 0
	for len(data) > 0 {
		n := min(len(data), sendPieceBytes)
		if n >= linkCompressionThreshold {
			wire += deflatedSize(data[:n])
		} else {
			wire += n
		}
		data = data[n:]
	}
	m.heartbeatWireInflated.add(float64(total))
	m.heartbeatWire.add(float64(wire))
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
