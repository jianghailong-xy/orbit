package main

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

func TestHeartbeatBytesByPartAndSampledWire(t *testing.T) {
	m := newGatewayMetrics("test", &denyList{})
	hb := &linkpb.Heartbeat{IdleCapacity: 2, Facts: []*linkpb.Fact{
		{Kind: "engines", Sha256: "aa", Json: []byte(strings.Repeat(`{"a":1}`, 200))},
		{Kind: "skills", Sha256: "bb"},
	}}
	size := proto.Size(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}})
	for i := 0; i < heartbeatWireSampleEvery; i++ {
		m.countHeartbeatBytes(hb)
	}
	n := float64(heartbeatWireSampleEvery)
	whole, digest, typed := m.heartbeatBytes.get("fact_whole"), m.heartbeatBytes.get("fact_digest"), m.heartbeatBytes.get("typed")
	if whole <= 1400*n || digest == 0 || typed == 0 {
		t.Fatalf("whole %v digest %v typed %v", whole, digest, typed)
	}
	if got := whole + digest + typed; got != float64(size)*n {
		t.Fatalf("parts add to %v, frames are %v", got, float64(size)*n)
	}
	if in := m.heartbeatWireInflated.get(); in != float64(size) {
		t.Fatalf("sampled inflated %v want %d", in, size)
	}
	if wire := m.heartbeatWire.get(); wire <= 0 || wire >= float64(size) {
		t.Fatalf("wire estimate %v for %d inflated", wire, size)
	}
}

// A heartbeat over one piece reaches the gateway as Chunks and is counted once, as a whole one is.
func TestHeartbeatBytesCountsChunkedAndWholeBeatsOnce(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) { heartbeatAnswer(w, r, body) })
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	m := h.g.metrics
	total := func() float64 {
		return m.heartbeatBytes.get("typed") + m.heartbeatBytes.get("fact_whole") + m.heartbeatBytes.get("fact_digest")
	}

	small := heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, IdleCapacity: 1})
	tc.send(small)
	tc.await("heartbeat_ack", 5*time.Second, nil)
	if got, want := total(), bodySize(small); got != want {
		t.Fatalf("whole beat counted %v, want %v", got, want)
	}

	big := heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, IdleCapacity: 1, Facts: []*linkpb.Fact{
		{Kind: "skills", Sha256: "aa", Json: []byte(`"` + strings.Repeat("x", 40<<10) + `"`)},
	}})
	tc.outID++
	big.Id = tc.outID
	msgs, err := encodeFrame(big, sendPieceBytes, func() uint64 { tc.outID++; return tc.outID })
	if err != nil || len(msgs) < 3 {
		t.Fatalf("pieces %d err %v", len(msgs), err)
	}
	before := total()
	for _, msg := range msgs {
		tc.sendRaw(msg)
	}
	tc.await("heartbeat_ack", 5*time.Second, nil)
	if got, want := total()-before, bodySize(big); got != want {
		t.Fatalf("chunked beat counted %v, want %v", got, want)
	}
	if w := m.heartbeatBytes.get("fact_whole"); w < 40<<10 {
		t.Fatalf("fact_whole %v", w)
	}
}

// bodySize is a frame's encoded size without its id, which is all the gateway counts of it.
func bodySize(f *linkpb.Frame) float64 {
	return float64(proto.Size(&linkpb.Frame{Body: f.GetBody()}))
}
