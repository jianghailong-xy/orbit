package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// What the runner sends over HTTPS today (RunEvent, HeartbeatRequest in src/runner-go/types.go), encoded the way
// its transport encodes request bodies: json.Marshal, which escapes <, > and & and compacts.
type httpRunEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	TS      string                 `json:"ts"`
	TurnID  string                 `json:"turnId,omitempty"`
	Payload map[string]interface{} `json:"payload"`
}

type httpRunEventBatch struct {
	LeaseOwner string         `json:"leaseOwner,omitempty"`
	Events     []httpRunEvent `json:"events"`
}

const testProcess = "0190a0b0-0000-4000-8000-0000000000a1"

func testHello() *linkpb.Hello {
	return &linkpb.Hello{ProcessId: testProcess, RunnerVersion: "0.1.230"}
}

func heartbeatBody(t testing.TB) []byte {
	t.Helper()
	runsAsRoot := false
	body := map[string]any{
		"status": "ONLINE", "idleCapacity": 3, "version": "0.1.230", "leaseOwner": testProcess,
		"supervisedSessionIds": []string{"s-2", "s-1"},
		"commands":             []map[string]any{{"name": "review", "description": "Review <diff> & tell \"me\"", "source": "project"}},
		"modelCatalog":         map[string]any{"claude": []map[string]any{{"id": "claude-opus-5-5", "contextWindow": 1000000, "label": "Opus 5.5 — 長文"}}},
		"runtimeDefaultModels": map[string]string{"claude": "claude-opus-5-5", "codex": "gpt-6"},
		"runsAsRoot":           &runsAsRoot,
		"reposRoot":            "/home/runner/repos/naïve",
		"engines":              []map[string]any{{"engine": "claude", "installed": true, "version": "2.3.0", "signedIn": nil}},
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// reencode writes the same JSON value another way: no HTML escaping, indented, members in reverse order where it
// can choose. A mirror built by another encoder than the HTTP body's must still match.
func reencode(t testing.TB, raw []byte) []byte {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "   ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func heartbeatRequest(body []byte) *linkpb.TunnelRequest {
	return &linkpb.TunnelRequest{Method: "POST", Path: "/runner/heartbeat", JsonBody: body}
}

func fields(diffs []shadowDiff) string {
	var f []string
	for _, d := range diffs {
		f = append(f, d.field)
	}
	return strings.Join(f, ",")
}

func TestHeartbeatMirrorMatches(t *testing.T) {
	body := heartbeatBody(t)
	if !bytes.Contains(body, []byte(`\u003cdiff\u003e \u0026`)) {
		t.Fatalf("the body is not HTML-escaped as json.Marshal writes it: %s", body)
	}
	hb := heartbeatFromBody(body)
	if diffs := compareHeartbeat(hb, heartbeatRequest(body), testHello()); len(diffs) != 0 {
		t.Fatalf("diffs %v", diffs)
	}
	// Facts written by another encoder (unescaped, indented) with the digest of those bytes still match.
	for _, f := range hb.GetFacts() {
		f.Json = reencode(t, f.GetJson())
		f.Sha256 = sha256Hex(f.GetJson())
	}
	hb.SessionIds = []string{"s-1", "s-2"} // a set: order is not a difference
	hb.ProcessId = strings.ToUpper(testProcess)
	if diffs := compareHeartbeat(hb, heartbeatRequest(body), testHello()); len(diffs) != 0 {
		t.Fatalf("re-encoded facts: diffs %v", diffs)
	}
}

func TestHeartbeatMirrorDifferences(t *testing.T) {
	body := heartbeatBody(t)
	cases := []struct {
		name  string
		alter func(hb *linkpb.Heartbeat, hello *linkpb.Hello, req *linkpb.TunnelRequest)
		want  string
	}{
		{"idle capacity", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) { hb.IdleCapacity++ }, "idleCapacity"},
		{"draining", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) { hb.Draining = true }, "draining"},
		{"a session missing", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hb.SessionIds = hb.SessionIds[:1]
		}, "supervisedSessionIds"},
		{"another process", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) { hb.ProcessId = "p-other" }, "leaseOwner"},
		{"another version", func(_ *linkpb.Heartbeat, hello *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hello.RunnerVersion = "0.1.231"
		}, "version"},
		{"a fact missing", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) { hb.Facts = hb.Facts[1:] }, "fact_missing"},
		{"a fact extra", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: "skills", Sha256: sha256Hex([]byte("[]")), Json: []byte("[]")})
		}, "fact_extra"},
		{"a typed member as a fact", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hb.Facts = append(hb.Facts, &linkpb.Fact{Kind: "draining", Sha256: sha256Hex([]byte("false")), Json: []byte("false")})
		}, "fact_extra"},
		{"a fact twice", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hb.Facts = append(hb.Facts, hb.Facts[0])
		}, "fact_duplicate"},
		{"a fact without its json", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) { hb.Facts[0].Json = nil }, "fact_json_missing"},
		{"a fact's digest", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			hb.Facts[0].Sha256 = sha256Hex([]byte("x"))
		}, "fact_digest"},
		{"a fact's value", func(hb *linkpb.Heartbeat, _ *linkpb.Hello, _ *linkpb.TunnelRequest) {
			for _, f := range hb.Facts {
				if f.GetKind() == "reposRoot" {
					f.Json = []byte(`"/home/runner/repos/naive"`)
					f.Sha256 = sha256Hex(f.Json)
				}
			}
		}, "fact_value"},
		{"another route", func(_ *linkpb.Heartbeat, _ *linkpb.Hello, req *linkpb.TunnelRequest) { req.Path = "/runner/heartbeats" }, "route"},
		{"not JSON", func(_ *linkpb.Heartbeat, _ *linkpb.Hello, req *linkpb.TunnelRequest) { req.JsonBody = []byte("{") }, "body"},
		{"status", func(_ *linkpb.Heartbeat, _ *linkpb.Hello, req *linkpb.TunnelRequest) {
			req.JsonBody = bytes.Replace(req.JsonBody, []byte(`"ONLINE"`), []byte(`"OFFLINE"`), 1)
		}, "status"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hb, hello, req := heartbeatFromBody(body), testHello(), heartbeatRequest(append([]byte(nil), body...))
			c.alter(hb, hello, req)
			diffs := compareHeartbeat(hb, req, hello)
			if !strings.Contains(fields(diffs), c.want) {
				t.Fatalf("diffs %v, want %s", diffs, c.want)
			}
		})
	}
}

func eventsBody(t testing.TB, n int) ([]byte, *linkpb.EventBatch) {
	t.Helper()
	batch := httpRunEventBatch{LeaseOwner: testProcess}
	eb := &linkpb.EventBatch{SessionId: "s-1"}
	start := time.Date(2026, 10, 25, 6, 0, 0, 123_000_000, time.UTC)
	for i := 0; i < n; i++ {
		ts := start.Add(time.Duration(i) * 7 * time.Millisecond)
		payload := map[string]interface{}{
			"text":    fmt.Sprintf("<tool> & \"output\" %d — 中文 naïve\u2028end", i),
			"numbers": []interface{}{1, 1.5, 1e21, -0.25},
			"nested":  map[string]interface{}{"empty": map[string]interface{}{}, "null": nil, "t": true},
		}
		turn := ""
		if i%2 == 0 {
			turn = "t-1"
		}
		batch.Events = append(batch.Events, httpRunEvent{Seq: i + 1, Type: "assistant", TS: ts.Format("2006-01-02T15:04:05.000Z07:00"), TurnID: turn, Payload: payload})
		eb.Events = append(eb.Events, &linkpb.Event{Seq: uint64(i + 1), Type: "assistant", TsUnixMs: ts.UnixMilli(), TurnId: turn})
	}
	body, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	// The typed payloads are encoded by another encoder than the body: unescaped, indented, with extra whitespace.
	for i, e := range batch.Events {
		raw, _ := json.Marshal(e.Payload)
		eb.Events[i].PayloadJson = append([]byte("\n  "), reencode(t, raw)...)
	}
	return body, eb
}

func eventsRequest(body []byte) *linkpb.TunnelRequest {
	return &linkpb.TunnelRequest{Method: "POST", Path: "/runner/sessions/s-1/events", JsonBody: body}
}

func TestEventMirrorMatchesAcrossEncoders(t *testing.T) {
	body, eb := eventsBody(t, 5)
	if !bytes.Contains(body, []byte(`\u003ctool\u003e \u0026`)) || bytes.Contains(eb.Events[0].PayloadJson, []byte(`\u003c`)) {
		t.Fatal("the two sides are not encoded differently")
	}
	if diffs := compareEvents(eb, eventsRequest(body), testHello()); len(diffs) != 0 {
		t.Fatalf("diffs %v", diffs)
	}
}

func TestEventMirrorDifferences(t *testing.T) {
	cases := []struct {
		name  string
		alter func(eb *linkpb.EventBatch, req *linkpb.TunnelRequest)
		want  string
	}{
		{"seq", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.Events[1].Seq = 9 }, "seq"},
		{"type", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.Events[1].Type = "tool_result" }, "type"},
		{"ts", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.Events[1].TsUnixMs++ }, "ts"},
		{"turn", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.Events[1].TurnId = "t-9" }, "turnId"},
		{"payload text", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) {
			eb.Events[1].PayloadJson = bytes.Replace(eb.Events[1].PayloadJson, []byte("naïve"), []byte("naive"), 1)
		}, "payload"},
		{"payload number", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) {
			eb.Events[1].PayloadJson = bytes.Replace(eb.Events[1].PayloadJson, []byte("1.5"), []byte("1.25"), 1)
		}, "payload"},
		{"an event missing", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.Events = eb.Events[:2] }, "events_length"},
		{"another session", func(eb *linkpb.EventBatch, _ *linkpb.TunnelRequest) { eb.SessionId = "s-2" }, "route"},
		{"another lease owner", func(_ *linkpb.EventBatch, req *linkpb.TunnelRequest) {
			req.JsonBody = bytes.Replace(req.JsonBody, []byte(testProcess), []byte("p-other"), 1)
		}, "leaseOwner"},
		{"a member the link drops", func(_ *linkpb.EventBatch, req *linkpb.TunnelRequest) {
			req.JsonBody = bytes.Replace(req.JsonBody, []byte(`"seq":1,`), []byte(`"seq":1,"liveSeq":4,`), 1)
		}, "event_member"},
		{"a batch member the link drops", func(_ *linkpb.EventBatch, req *linkpb.TunnelRequest) {
			req.JsonBody = bytes.Replace(req.JsonBody, []byte(`{"leaseOwner"`), []byte(`{"final":true,"leaseOwner"`), 1)
		}, "batch_member"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, eb := eventsBody(t, 3)
			req := eventsRequest(body)
			c.alter(eb, req)
			if diffs := compareEvents(eb, req, testHello()); !strings.Contains(fields(diffs), c.want) {
				t.Fatalf("diffs %v, want %s", diffs, c.want)
			}
		})
	}
}

func TestJSONValueEquality(t *testing.T) {
	same := [][2]string{
		{`{"a":"<b>&"}`, `{"a":"\u003cb\u003e\u0026"}`},
		{`{"a":1,"b":[1,2]}`, " { \"b\" : [ 1 , 2 ] ,\n\t\"a\" : 1 } "},
		{`"café"`, `"caf\u00e9"`},
		{`"\u2028"`, "\"\u2028\""},
		{`1`, `1.0`},
		{`100`, `1e2`},
		{`0.1`, `0.10`},
		{`null`, ` null `},
		{`{"a":{}}`, `{"a": {}}`},
	}
	for _, c := range same {
		if !jsonEqual([]byte(c[0]), []byte(c[1])) {
			t.Errorf("%s and %s should be equal", c[0], c[1])
		}
	}
	different := [][2]string{
		{`1`, `"1"`},
		{`[1,2]`, `[2,1]`},
		{`{"a":1}`, `{"a":1,"b":null}`},
		{`{"a":null}`, `{}`},
		{`9007199254740993`, `9007199254740992`},
		{`true`, `1`},
		{`""`, `null`},
		{`{"a":1}`, `{"a":1} trailing`},
		{`{"a":1}`, `{"a":1`},
		{`"a"`, `"A"`},
	}
	for _, c := range different {
		if jsonEqual([]byte(c[0]), []byte(c[1])) {
			t.Errorf("%s and %s should differ", c[0], c[1])
		}
	}
}

// shadowFixture is a shadowState on a connection that exists only for its metrics, log and clock.
func shadowFixture(t *testing.T) (*shadowState, *gatewayMetrics, *time.Time) {
	t.Helper()
	g := newGateway(testConfig(), slog.New(slog.NewTextHandler(&syncBuffer{}, nil)))
	c := &conn{g: g, id: "c-test", log: g.log, hello: testHello()}
	s := newShadowState(c)
	now := time.Now()
	s.now = func() time.Time { return now }
	t.Cleanup(func() { s.close() })
	return s, g.metrics, &now
}

func mirrorRPC(connID string, frameID uint64, req *linkpb.TunnelRequest) *linkpb.Rpc {
	return &linkpb.Rpc{RequestId: fmt.Sprintf("shadow:%s:%d", connID, frameID), Body: &linkpb.Rpc_Tunnel{Tunnel: req}}
}

func TestMirrorHalvesPairInEitherOrder(t *testing.T) {
	s, m, _ := shadowFixture(t)
	body := heartbeatBody(t)
	s.typed(5, &shadowEntry{kind: "heartbeat", heartbeat: heartbeatFromBody(body)}, 100)
	s.mirror(mirrorRPC("c-test", 5, heartbeatRequest(body)), 100)
	s.mirror(mirrorRPC("c-test", 9, heartbeatRequest(body)), 100)
	s.typed(9, &shadowEntry{kind: "heartbeat", heartbeat: heartbeatFromBody(body)}, 100)
	ebBody, eb := eventsBody(t, 2)
	s.typed(11, &shadowEntry{kind: "events", events: eb}, 100)
	s.mirror(mirrorRPC("c-test", 11, eventsRequest(ebBody)), 100)
	if m.shadowPairs.get("heartbeat", "match") != 2 || m.shadowPairs.get("events", "match") != 1 || m.shadowEvents.get() != 2 {
		t.Fatalf("pairs %v %v events %v", m.shadowPairs.get("heartbeat", "match"), m.shadowPairs.get("events", "match"), m.shadowEvents.get())
	}
	if len(s.typedQ)+len(s.rawQ) != 0 || s.bytes != 0 {
		t.Fatal("paired halves still held")
	}
}

func TestMirrorsThatCannotPairAreCounted(t *testing.T) {
	s, m, now := shadowFixture(t)
	body := heartbeatBody(t)
	s.mirror(&linkpb.Rpc{RequestId: "shadow:nonsense", Body: &linkpb.Rpc_Tunnel{Tunnel: heartbeatRequest(body)}}, 10)
	s.mirror(mirrorRPC("c-older", 3, heartbeatRequest(body)), 10)
	if m.shadowUnpaired.get("raw", "malformed") != 1 || m.shadowUnpaired.get("raw", "wrong_connection") != 1 {
		t.Fatal("refused mirrors not counted")
	}
	s.typed(1, &shadowEntry{kind: "heartbeat", heartbeat: heartbeatFromBody(body)}, 10)
	s.mirror(mirrorRPC("c-test", 2, heartbeatRequest(body)), 10)
	*now = now.Add(shadowTTL + time.Second)
	s.expire()
	if m.shadowUnpaired.get("typed", "expired") != 1 || m.shadowUnpaired.get("raw", "expired") != 1 {
		t.Fatal("expired halves not counted")
	}
	s.typed(4, &shadowEntry{kind: "heartbeat", heartbeat: heartbeatFromBody(body)}, 10)
	s.close()
	if m.shadowUnpaired.get("typed", "closed") != 1 {
		t.Fatal("halves left at close not counted")
	}
}

// Halves waiting for their other half are bounded in number and bytes per connection, and in bytes across the
// process; what a bound pushes out is counted, and the memory held returns to nothing.
func TestMirrorBuffersAreBounded(t *testing.T) {
	s, m, now := shadowFixture(t)
	body := heartbeatBody(t)
	for i := 0; i < 10_000; i++ {
		*now = now.Add(time.Millisecond)
		s.typed(uint64(i), &shadowEntry{kind: "heartbeat", heartbeat: heartbeatFromBody(body)}, 1000)
		if len(s.typedQ) > shadowMaxPending || s.bytes > shadowMaxConnBytes {
			t.Fatalf("after %d: %d held, %d bytes", i, len(s.typedQ), s.bytes)
		}
	}
	if got := m.shadowUnpaired.get("typed", "evicted"); got != 10_000-shadowMaxPending {
		t.Fatalf("evicted %v", got)
	}
	for i := 0; i < 20; i++ {
		s.mirror(mirrorRPC("c-test", uint64(100_000+i), heartbeatRequest(body)), 512<<10)
		if s.bytes > shadowMaxConnBytes {
			t.Fatalf("%d bytes held", s.bytes)
		}
	}
	s.mirror(mirrorRPC("c-test", 1, heartbeatRequest(body)), shadowMaxConnBytes+1)
	if m.shadowUnpaired.get("raw", "evicted") == 0 {
		t.Fatal("a half too large to hold was not counted")
	}
	s.close()
	if s.bytes != 0 || shadowPending.Load() != 0 {
		t.Fatalf("%d bytes held after close, %d across the process", s.bytes, shadowPending.Load())
	}
}

// bigEventBatch is a mirrored event batch whose HTTP body is about size bytes.
func bigEventBatch(t testing.TB, size int) (*linkpb.EventBatch, []byte) {
	t.Helper()
	text := strings.Repeat("output <line> & more\n", 64)
	var batch httpRunEventBatch
	eb := &linkpb.EventBatch{SessionId: "s-big"}
	ts := time.Date(2026, 10, 25, 6, 0, 0, 0, time.UTC)
	for i := 1; ; i++ {
		e := httpRunEvent{Seq: i, Type: "tool_result", TS: ts.Format("2006-01-02T15:04:05.000Z07:00"), Payload: map[string]interface{}{"output": text}}
		batch.Events = append(batch.Events, e)
		raw, _ := json.Marshal(e.Payload)
		eb.Events = append(eb.Events, &linkpb.Event{Seq: uint64(i), Type: e.Type, TsUnixMs: ts.UnixMilli(), PayloadJson: raw})
		if len(batch.Events)*len(text) > size {
			break
		}
	}
	body, _ := json.Marshal(batch)
	return eb, body
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
