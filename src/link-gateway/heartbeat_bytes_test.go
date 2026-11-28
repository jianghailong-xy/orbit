package main

import (
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

func TestHeartbeatBytesByPartAndSampledWire(t *testing.T) {
	m := newGatewayMetrics("test", &denyList{})
	hb := &linkpb.Heartbeat{IdleCapacity: 2, Facts: []*linkpb.Fact{
		{Kind: "engines", Sha256: "aa", Json: []byte(strings.Repeat(`{"a":1}`, 200))},
		{Kind: "skills", Sha256: "bb"},
	}}
	data, err := proto.Marshal(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < heartbeatWireSampleEvery; i++ {
		m.countHeartbeatBytes(hb, data)
	}
	n := float64(heartbeatWireSampleEvery)
	whole, digest := m.heartbeatBytes.get("fact_whole"), m.heartbeatBytes.get("fact_digest")
	typed := m.heartbeatBytes.get("typed")
	if whole <= 1400*n || digest == 0 || typed == 0 {
		t.Fatalf("whole %v digest %v typed %v", whole, digest, typed)
	}
	if got := whole + digest + typed; got != float64(len(data))*n {
		t.Fatalf("parts add to %v, frames are %v", got, float64(len(data))*n)
	}
	// One beat in heartbeatWireSampleEvery is deflated: repetitive JSON compresses well.
	if in := m.heartbeatWireInflated.get(); in != float64(len(data)) {
		t.Fatalf("sampled inflated %v want %d", in, len(data))
	}
	if wire := m.heartbeatWire.get(); wire <= 0 || wire >= float64(len(data)) {
		t.Fatalf("wire estimate %v for %d inflated", wire, len(data))
	}
}
