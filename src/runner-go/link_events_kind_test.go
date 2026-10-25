package main

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The server's reading of the events a runner sends, as its own code says (testdata/b8-link-events.json, from
// scripts/runner-link/gen-event-kind-fixtures.mjs).
type linkEventKindFixture struct {
	NonReplayableEventTypes            []string `json:"nonReplayableEventTypes"`
	MeaningfulSystemSubtypes           []string `json:"meaningfulSystemSubtypes"`
	PingKeys                           []string `json:"pingKeys"`
	CoordinatorContextBoundarySubtypes []string `json:"coordinatorContextBoundarySubtypes"`
	LiveEventSeqPlaceholder            struct {
		Type                string                 `json:"type"`
		Payload             map[string]interface{} `json:"payload"`
		Noise               bool                   `json:"noise"`
		CoordinatorBoundary bool                   `json:"coordinatorBoundary"`
	} `json:"liveEventSeqPlaceholder"`
	Cases []struct {
		Name    string                 `json:"name"`
		Type    string                 `json:"type"`
		Payload map[string]interface{} `json:"payload"`
		Noise   bool                   `json:"noise"`
	} `json:"cases"`
	Boundaries []struct {
		Subtype string `json:"subtype"`
		Bare    struct {
			Payload map[string]interface{} `json:"payload"`
			Noise   bool                   `json:"noise"`
		} `json:"bare"`
		Enriched struct {
			Payload map[string]interface{} `json:"payload"`
			Noise   bool                   `json:"noise"`
		} `json:"enriched"`
	} `json:"boundaries"`
}

func readLinkEventKindFixture(t *testing.T) linkEventKindFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/b8-link-events.json")
	if err != nil {
		t.Fatal(err)
	}
	var f linkEventKindFixture
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	if err := dec.Decode(&f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 20 || len(f.Boundaries) == 0 || len(f.NonReplayableEventTypes) == 0 {
		t.Fatalf("the fixture holds too little: %d cases, %d boundaries", len(f.Cases), len(f.Boundaries))
	}
	return f
}

func linkSetOf(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func linkSorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

// The runner's twin of isNoiseSystemEvent, the live-only types and the coordinator-context boundaries agree with the
// server's own code on every case it was asked about: a ping the runner kept would leave a hole in run_event, and a
// kept event it dropped is lost.
func TestLinkEventKindsAreTheServers(t *testing.T) {
	f := readLinkEventKindFixture(t)
	if got, want := linkSetOf(linkLiveOnlyTypes), linkSorted(f.NonReplayableEventTypes); !reflect.DeepEqual(got, want) {
		t.Errorf("live-only types: runner %v, server %v", got, want)
	}
	if got, want := linkSetOf(linkMeaningfulSystemSubtypes), linkSorted(f.MeaningfulSystemSubtypes); !reflect.DeepEqual(got, want) {
		t.Errorf("meaningful subtypes: runner %v, server %v", got, want)
	}
	if got, want := linkSetOf(linkPingKeys), linkSorted(f.PingKeys); !reflect.DeepEqual(got, want) {
		t.Errorf("ping keys: runner %v, server %v", got, want)
	}
	if got, want := linkSetOf(linkCoordinatorBoundarySubtypes), linkSorted(f.CoordinatorContextBoundarySubtypes); !reflect.DeepEqual(got, want) {
		t.Errorf("coordinator-context boundary subtypes: runner %v, server %v", got, want)
	}
	for _, c := range f.Cases {
		if got := linkNoiseSystemEvent(c.Type, c.Payload); got != c.Noise {
			t.Errorf("%s (%s %v): the runner says noise=%v, the server %v", c.Name, c.Type, c.Payload, got, c.Noise)
		}
		fate, payload := linkEventFateOf(c.Type, c.Payload, "codex")
		switch {
		case linkLiveOnlyTypes[c.Type]:
			if fate != linkLive {
				t.Errorf("%s: a live-only event is %v over the link", c.Name, fate)
			}
		case c.Noise && linkCoordinatorBoundarySubtypes[stringField(c.Payload, "subtype")]:
			if fate != linkDurable || payload["provider"] != "codex" {
				t.Errorf("%s: a ping-shaped boundary goes %v with %v", c.Name, fate, payload)
			}
		case c.Noise:
			if fate != linkDropped {
				t.Errorf("%s: a noise ping is %v over the link", c.Name, fate)
			}
		default:
			if fate != linkDurable || !reflect.DeepEqual(payload, c.Payload) {
				t.Errorf("%s: a durable event goes %v with %v", c.Name, fate, payload)
			}
		}
	}
	for _, b := range f.Boundaries {
		if !b.Bare.Noise || b.Enriched.Noise {
			t.Fatalf("the server reads the boundary %s bare as noise=%v, enriched as noise=%v", b.Subtype, b.Bare.Noise, b.Enriched.Noise)
		}
		fate, payload := linkEventFateOf(evSystem, b.Bare.Payload, "codex")
		if fate != linkDurable || !reflect.DeepEqual(payload, b.Enriched.Payload) {
			t.Errorf("the bare boundary %s goes %v with %v; the server stores %v", b.Subtype, fate, payload, b.Enriched.Payload)
		}
		if linkNoiseSystemEvent(evSystem, payload) {
			t.Errorf("the enriched boundary %s is still noise to the runner", b.Subtype)
		}
		if b.Bare.Payload["provider"] != nil {
			t.Errorf("enriching %s changed the payload it was given", b.Subtype)
		}
	}
	p := f.LiveEventSeqPlaceholder
	if got := linkLiveEventSeqPlaceholder(); !reflect.DeepEqual(got, p.Payload) || p.Type != evSystem {
		t.Errorf("the placeholder is %v; the fixture's is %s %v", got, p.Type, p.Payload)
	}
	if !p.Noise || p.CoordinatorBoundary || !linkNoiseSystemEvent(evSystem, linkLiveEventSeqPlaceholder()) {
		t.Errorf("the placeholder must be a bare ping the server neither stores nor reads (noise %v, boundary %v)", p.Noise, p.CoordinatorBoundary)
	}
}

func stringField(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

// An event goes whole as long as the frame it would go in alone fits within a frame's ceiling once joined from
// Chunks; past it, the event keeps its seq and goes without its large fields, saying how large it was. Every trimmed
// event is logged and counted.
func TestLinkEventsTrimOnlyWhatNoFrameCarries(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	m := newLinkMode(NewTransport("http://127.0.0.1:1", "runner-token"), logs.log)
	t.Cleanup(m.close)
	s := m.events.open("session-trim")
	defer s.release()
	// The longest content whose one-event frame still fits: the frame's length prefixes grow with it.
	ts := nowISO()
	frameWith := func(n int) int {
		raw, _ := json.Marshal(map[string]interface{}{"toolUseId": "toolu_1", "content": strings.Repeat("a", n)})
		return s.oneEventFrameSize(&linkEvent{seq: 1, typ: evToolResult, tsMs: linkEventTime(ts), turnID: "turn-1", payload: raw})
	}
	room := linkEventFrameCeiling - frameWith(0)
	for frameWith(room) > linkEventFrameCeiling {
		room--
	}
	under := RunEvent{Seq: 1, Type: evToolResult, TS: ts, TurnID: "turn-1",
		Payload: map[string]interface{}{"toolUseId": "toolu_1", "content": strings.Repeat("a", room)}}
	over := RunEvent{Seq: 2, Type: evToolResult, TS: nowISO(), TurnID: "turn-1",
		Payload: map[string]interface{}{"toolUseId": "toolu_2", "isError": false, "content": strings.Repeat("b", room+1)}}
	whole := s.linkEventOf(under)
	if size := s.oneEventFrameSize(whole); size > linkEventFrameCeiling || size < linkEventFrameCeiling-8 {
		t.Fatalf("the event just under the ceiling goes in a %d-byte frame, the ceiling is %d", size, linkEventFrameCeiling)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(whole.payload, &got); err != nil || got["content"] != under.Payload["content"] {
		t.Fatalf("the event just under the ceiling did not go whole (%d bytes)", len(whole.payload))
	}
	if n := m.events.trimmed.Load(); n != 0 {
		t.Fatalf("%d events trimmed that fit", n)
	}
	trimmed := s.linkEventOf(over)
	if trimmed.seq != 2 || trimmed.typ != evToolResult || trimmed.turnID != "turn-1" {
		t.Errorf("the trimmed event is seq %d %s in turn %s", trimmed.seq, trimmed.typ, trimmed.turnID)
	}
	got = nil
	if err := json.Unmarshal(trimmed.payload, &got); err != nil {
		t.Fatal(err)
	}
	if got["toolUseId"] != "toolu_2" || got["isError"] != false || got["content"] != nil {
		t.Errorf("the trimmed payload is %v", got)
	}
	if size, _ := got["omittedBytes"].(float64); int(size) <= room || got["omittedFields"] == nil {
		t.Errorf("the trimmed payload does not say what it left out: %v", got)
	}
	if n := m.events.trimmed.Load(); n != 1 {
		t.Errorf("%d events counted as trimmed, want 1", n)
	}
	if line := strings.Join(logs.all(), "\n"); !strings.Contains(line, "event seq 2 (tool_result) of session session-trim is") {
		t.Errorf("the trim was not logged with its session, seq and size: %s", line)
	}
	if size := s.oneEventFrameSize(trimmed); size > linkBatchMaxBytes {
		t.Errorf("the trimmed event still needs a %d-byte frame", size)
	}
}
