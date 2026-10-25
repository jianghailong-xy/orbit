package main

import (
	"encoding/json"
	"flag"
	"os"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// What the gateway publishes on NATS for the apiserver to read, pinned in testdata/b4-live.json: live batches on
// ses.<id>.live and answers to turn prefix requests. The apiserver's spec decodes the same file with its own reader
// (src/apiserver/src/realtime/runner-hints-live.spec.ts), so a field renamed on either side turns one of them red.
//
//	go test -run TestLiveFixtures -args -update-live-fixtures   # after a change to what the gateway publishes

var updateLiveFixtures = flag.Bool("update-live-fixtures", false, "write testdata/b4-live.json from the gateway's encoder")

type liveFixtureCase struct {
	Name    string `json:"name"`
	Subject string `json:"subject"`
	// Message is what the gateway publishes, as its encoder writes it.
	Message string `json:"message"`
}

// liveFixtureFrames are the frames the fixture holds, built as the gateway builds them (live.go).
func liveFixtureFrames() []struct {
	name, subject string
	frame         *linkpb.Frame
} {
	const session = "0190a0b0-0000-7000-8000-0000000000a1"
	const turn = "0190a0b0-0000-7000-8000-0000000000b1"
	return []struct {
		name, subject string
		frame         *linkpb.Frame
	}{
		{"live: reply and thinking deltas", liveSubject(session), &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{
			SessionId: session,
			Events: []*linkpb.LiveEvent{
				{LiveSeq: 41, Type: "thinking_delta", TsUnixMs: 1761380000123, TurnId: turn, PayloadJson: []byte(`{"text":"weighing <b> & ü"}`)},
				{LiveSeq: 42, Type: "text_delta", TsUnixMs: 1761380000124, TurnId: turn, PayloadJson: []byte(`{"text":"Hello wor"}`)},
				{LiveSeq: 9007199254740990, Type: "text_delta", TsUnixMs: 1761380000125, TurnId: turn, PayloadJson: []byte(`{"text":"ld — 中文"}`)},
			},
		}}}},
		{"live: a tool output snapshot, a background tail, and an event the live stream may not carry", liveSubject(session), &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{
			SessionId: session,
			Events: []*linkpb.LiveEvent{
				{LiveSeq: 43, Type: "tool_output", TsUnixMs: 1761380000126, TurnId: turn, PayloadJson: []byte(`{"toolUseId":"toolu_01","content":"line 1\nline 2"}`)},
				{LiveSeq: 44, Type: "background_output", TsUnixMs: 1761380000127, PayloadJson: []byte(`{"shellId":"shell-1","text":"tail"}`)},
				{LiveSeq: 45, Type: "assistant", TsUnixMs: 1761380000128, TurnId: turn, PayloadJson: []byte(`{"text":"durable events never ride the live stream"}`)},
			},
		}}}},
		{"prefix: what the turn has streamed so far", "_INBOX.fixture.1", &linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: &linkpb.TurnPrefixResponse{
			RequestId: "0190a0b0-0000-4000-8000-0000000000c1", SessionId: session, TurnId: turn,
			Text: "Hello wor", Thinking: "weighing <b> & ü", ThroughLiveSeq: 42,
		}}}},
		{"prefix: no turn is streaming, or nobody could be asked", "_INBOX.fixture.2", &linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: &linkpb.TurnPrefixResponse{
			RequestId: "0190a0b0-0000-4000-8000-0000000000c2", SessionId: session,
		}}}},
	}
}

func TestLiveFixtures(t *testing.T) {
	const path = "testdata/b4-live.json"
	frames := liveFixtureFrames()
	if *updateLiveFixtures {
		var cases []liveFixtureCase
		for _, f := range frames {
			b, err := protojson.Marshal(f.frame)
			if err != nil {
				t.Fatal(err)
			}
			// protojson's output may vary in its spacing between builds; stored compact, the apiserver reads JSON.
			var compact json.RawMessage
			if err := json.Unmarshal(b, &compact); err != nil {
				t.Fatal(err)
			}
			cb, _ := json.Marshal(compact)
			cases = append(cases, liveFixtureCase{Name: f.name, Subject: f.subject, Message: string(cb)})
		}
		out, _ := json.MarshalIndent(map[string]any{
			"generatedBy": "src/link-gateway/fixtures_test.go (go test -run TestLiveFixtures -args -update-live-fixtures), with the gateway's protojson encoder",
			"cases":       cases,
		}, "", "  ")
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []liveFixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != len(frames) {
		t.Fatalf("the fixture holds %d cases, the gateway builds %d: regenerate it", len(fixture.Cases), len(frames))
	}
	for i, c := range fixture.Cases {
		// Strict: what the fixture holds is a frame the gateway could have published, every field of it known.
		var f linkpb.Frame
		if err := protojson.Unmarshal([]byte(c.Message), &f); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if !proto.Equal(&f, frames[i].frame) || c.Subject != frames[i].subject || c.Name != frames[i].name {
			t.Fatalf("%s: the fixture is not what the gateway publishes now; regenerate it", c.Name)
		}
	}
}
