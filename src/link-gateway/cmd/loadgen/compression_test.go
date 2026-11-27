package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// TestMeasureLinkCompression measures what permessage-deflate would do to the runner link's traffic
// (docs/runner-link-design.md §15.17): the bytes on the wire and the CPU of both ends, through the WebSocket library
// both ends use, for each compression mode it offers, on the frames a runner sends: heartbeats (a connection's first,
// with every part whole, and steady ones, by digest), durable event batches and live batches. The frames are this
// loadgen's (synth.go, live.go), and, with LINK_MEASURE_CORPUS naming Claude Code transcripts (*.jsonl, a glob), event
// and live batches made of real engine output: the loadgen's text is drawn from a few hundred words and compresses
// better than an engine's. Only sizes and times are reported, never content. It is a measurement, not a test:
//
//	LINK_MEASURE_COMPRESSION=1 LINK_MEASURE_CORPUS='/path/*.jsonl' go test -run TestMeasureLinkCompression -v ./cmd/loadgen
func TestMeasureLinkCompression(t *testing.T) {
	if os.Getenv("LINK_MEASURE_COMPRESSION") == "" {
		t.Skip("LINK_MEASURE_COMPRESSION is not set")
	}
	rng := rand.New(rand.NewPCG(7, 11))
	streams := []measureStream{
		{name: "heartbeat, first (all parts whole)", msgs: repeatMsgs(firstBeats(rng, 50), 20)},
		{name: "heartbeat, steady (by digest, 14 sessions)", msgs: steadyBeats(rng, 1000)},
		{name: "event batches (loadgen text)", msgs: synthEventBatches(rng, 4000)},
		{name: "live batches (loadgen text)", msgs: synthLiveBatches(rng, 4000)},
	}
	if glob := os.Getenv("LINK_MEASURE_CORPUS"); glob != "" {
		texts := corpusItems(t, glob, 30000)
		t.Logf("corpus: %d content items from %s", len(texts), glob)
		streams = append(streams,
			measureStream{name: "event batches (real engine output)", msgs: corpusEventBatches(rng, texts, 4000)},
			measureStream{name: "live batches (real engine output)", msgs: corpusLiveBatches(rng, texts, 4000)})
	}
	modes := []measureMode{
		{name: "off", mode: websocket.CompressionDisabled},
		{name: "no-context-takeover, threshold 512", mode: websocket.CompressionNoContextTakeover, threshold: 512},
		{name: "no-context-takeover, threshold 128", mode: websocket.CompressionNoContextTakeover, threshold: 128},
		{name: "context-takeover, threshold 128", mode: websocket.CompressionContextTakeover, threshold: 128},
	}
	t.Logf("%-44s %-36s %8s %10s %10s %7s %9s %9s", "traffic", "mode", "msgs", "raw B/msg", "wire B/msg", "ratio", "cpu µs/msg", "+cpu µs")
	for _, s := range streams {
		var base float64
		for _, m := range modes {
			r := measure(t, s.msgs, m)
			if m.mode == websocket.CompressionDisabled {
				base = r.cpuPerMsg
			}
			t.Logf("%-44s %-36s %8d %10.0f %10.0f %7.3f %9.1f %+9.1f", s.name, m.name, len(s.msgs),
				float64(r.raw)/float64(len(s.msgs)), float64(r.wire)/float64(len(s.msgs)), float64(r.wire)/float64(r.raw),
				r.cpuPerMsg, r.cpuPerMsg-base)
		}
	}
	// Each end's own cost, without the other's and without the sockets: a runner compresses what it sends, the gateway
	// decompresses it. As the library does without context takeover: a pooled BestSpeed writer reset for each message,
	// and a pooled reader reset for each.
	t.Logf("%-44s %12s %12s %12s", "traffic (no context takeover, each end alone)", "flate B/msg", "deflate µs", "inflate µs")
	for _, s := range streams {
		size, deflate, inflate := flateCost(s.msgs)
		t.Logf("%-44s %12.0f %12.2f %12.2f", s.name, size, deflate, inflate)
	}
	// Memory: what stays per connection, as the heap of n idle pairs once each end wrote and read a message, for two n.
	// What a pool keeps does not grow with n; what a connection keeps does.
	for _, m := range modes {
		small, large := heapOf(t, m, 100), heapOf(t, m, 400)
		t.Logf("heap of idle connection pairs, %s: 100 pairs %.1f MB, 400 pairs %.1f MB, %.1f KB a pair", m.name,
			small/(1<<20), large/(1<<20), (large-small)/300/1024)
	}
}

// flateCost is a message's mean compressed size, and the µs to compress and to decompress it, each alone.
func flateCost(msgs [][]byte) (size, deflate, inflate float64) {
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.BestSpeed)
	compressed := make([][]byte, len(msgs))
	start := cpuNow()
	for i, m := range msgs {
		buf.Reset()
		w.Reset(&buf)
		_, _ = w.Write(m)
		_ = w.Flush()
		compressed[i] = append([]byte(nil), buf.Bytes()...)
	}
	deflate = float64(cpuNow()-start) / float64(time.Microsecond) / float64(len(msgs))
	var total int
	for _, c := range compressed {
		total += len(c)
	}
	r := flate.NewReader(bytes.NewReader(nil))
	start = cpuNow()
	for _, c := range compressed {
		_ = r.(flate.Resetter).Reset(bytes.NewReader(c), nil)
		_, _ = io.Copy(io.Discard, r)
	}
	inflate = float64(cpuNow()-start) / float64(time.Microsecond) / float64(len(msgs))
	return float64(total) / float64(len(msgs)), deflate, inflate
}

type measureStream struct {
	name string
	msgs [][]byte
}

type measureMode struct {
	name      string
	mode      websocket.CompressionMode
	threshold int
}

type measureResult struct {
	raw, wire int64
	cpuPerMsg float64 // µs of process CPU per message, both ends
}

func frameBytes(f *linkpb.Frame) []byte {
	b, err := proto.Marshal(f)
	if err != nil {
		panic(err)
	}
	return b
}

func repeatMsgs(msgs [][]byte, n int) [][]byte {
	var out [][]byte
	for i := 0; i < n; i++ {
		out = append(out, msgs...)
	}
	return out
}

func sessionIDs(rng *rand.Rand, n int) []string {
	var ids []string
	for i := 0; i < n; i++ {
		ids = append(ids, newUUID(rng))
	}
	return ids
}

// firstBeats are n runners' first beats on a connection: every part whole.
func firstBeats(rng *rand.Rand, n int) [][]byte {
	var out [][]byte
	for i := 0; i < n; i++ {
		out = append(out, frameBytes(&linkpb.Frame{Id: uint64(i + 1), Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{
			ProcessId: newUUID(rng), IdleCapacity: 2, SessionIds: sessionIDs(rng, 14), SupportedProviders: supportedProviders,
			Facts: runnerFacts(i), BeatId: 1,
		}}}))
	}
	return out
}

// steadyBeats are one runner's beats 30 s apart: its parts by digest, one moving part whole (planUsage's), as a
// connection carries them.
func steadyBeats(rng *rand.Rand, n int) [][]byte {
	facts := digestsOf(runnerFacts(1))
	ids := sessionIDs(rng, 14)
	process := newUUID(rng)
	var out [][]byte
	for i := 0; i < n; i++ {
		beat := append(append([]*linkpb.Fact{}, facts...), fact("executingAt", time.Unix(1_800_000_000+int64(30*i), 0).UTC().Format(time.RFC3339)))
		out = append(out, frameBytes(&linkpb.Frame{Id: uint64(i + 1), Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{
			ProcessId: process, SessionIds: ids, SupportedProviders: supportedProviders, Facts: beat, BeatId: uint64(i + 1),
		}}}))
	}
	return out
}

// synthEventBatches are batches as the loadgen sends them: a session's events up to its boundary event (a
// tool_result), from 4 sessions in turn.
func synthEventBatches(rng *rand.Rand, n int) [][]byte {
	sessions := []*session{{id: newUUID(rng)}, {id: newUUID(rng)}, {id: newUUID(rng)}, {id: newUUID(rng)}}
	var out [][]byte
	for i := 0; len(out) < n; i++ {
		s := sessions[i%len(sessions)]
		eb := &linkpb.EventBatch{SessionId: s.id}
		for {
			ev, boundary := s.nextEvent(rng, 1_800_000_000_000+int64(i))
			eb.Events = append(eb.Events, ev)
			if boundary || len(eb.Events) >= 100 {
				break
			}
		}
		out = append(out, frameBytes(&linkpb.Frame{Id: uint64(len(out) + 1), Body: &linkpb.Frame_EventBatch{EventBatch: eb}}))
	}
	return out
}

// liveBatch is a LiveBatch of deltas, as a runner gathers them for 50 ms.
func liveBatch(id int, session, turn string, deltas []string) []byte {
	lb := &linkpb.LiveBatch{SessionId: session}
	for i, d := range deltas {
		payload, _ := json.Marshal(map[string]string{"text": d})
		lb.Events = append(lb.Events, &linkpb.LiveEvent{LiveSeq: uint64(id*8 + i), Type: "text_delta",
			TsUnixMs: 1_800_000_000_000 + int64(id*50+i), TurnId: turn, PayloadJson: payload})
	}
	return frameBytes(&linkpb.Frame{Id: uint64(id), Body: &linkpb.Frame_LiveBatch{LiveBatch: lb}})
}

// synthLiveBatches are batches of 1-4 deltas of about 100 bytes, the loadgen's.
func synthLiveBatches(rng *rand.Rand, n int) [][]byte {
	session, turn := newUUID(rng), newUUID(rng)
	var out [][]byte
	for i := 0; i < n; i++ {
		var deltas []string
		for j := between(rng, 1, 4); j > 0; j-- {
			deltas = append(deltas, fmt.Sprintf("@@%d@@ %s", 1_800_000_000_000+int64(i*50), text(rng, between(rng, liveTextMin, liveTextMax)-20)))
		}
		out = append(out, liveBatch(i+1, session, turn, deltas))
	}
	return out
}

// corpusItem is one content item of an engine's message: text, thinking, a tool call or a tool result.
type corpusItem struct {
	kind    string
	payload []byte
	text    string
}

// corpusItems reads up to max content items from the transcripts glob names.
func corpusItems(t *testing.T, glob string, max int) []corpusItem {
	paths, err := filepath.Glob(glob)
	if err != nil || len(paths) == 0 {
		t.Fatalf("LINK_MEASURE_CORPUS %q names no file (%v)", glob, err)
	}
	sort.Strings(paths)
	var items []corpusItem
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 16<<20)
		for sc.Scan() && len(items) < max {
			var line struct {
				Message struct {
					Content json.RawMessage `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal(sc.Bytes(), &line) != nil {
				continue
			}
			var parts []map[string]any
			if json.Unmarshal(line.Message.Content, &parts) != nil {
				continue
			}
			for _, part := range parts {
				kind, _ := part["type"].(string)
				var txt string
				switch kind {
				case "text":
					txt, _ = part["text"].(string)
				case "thinking":
					txt, _ = part["thinking"].(string)
				case "tool_use", "tool_result":
					b, _ := json.Marshal(part)
					txt = string(b)
				default:
					continue
				}
				if txt == "" {
					continue
				}
				payload, _ := json.Marshal(part)
				items = append(items, corpusItem{kind: kind, payload: payload, text: txt})
			}
		}
		f.Close()
		if len(items) >= max {
			break
		}
	}
	if len(items) == 0 {
		t.Fatal("the corpus holds no content item")
	}
	return items
}

// corpusEventBatches are the corpus's items in order as durable events, batched up to each tool_result.
func corpusEventBatches(rng *rand.Rand, items []corpusItem, n int) [][]byte {
	session, turn := newUUID(rng), newUUID(rng)
	var out [][]byte
	seq := uint64(0)
	eb := &linkpb.EventBatch{SessionId: session}
	for i := 0; len(out) < n; i++ {
		it := items[i%len(items)]
		seq++
		eb.Events = append(eb.Events, &linkpb.Event{Seq: seq, Type: it.kind, TsUnixMs: 1_800_000_000_000 + int64(i), TurnId: turn, PayloadJson: it.payload})
		if it.kind == "tool_result" || len(eb.Events) >= 100 {
			out = append(out, frameBytes(&linkpb.Frame{Id: uint64(len(out) + 1), Body: &linkpb.Frame_EventBatch{EventBatch: eb}}))
			eb = &linkpb.EventBatch{SessionId: session}
		}
	}
	return out
}

// corpusLiveBatches are the corpus's text cut into deltas of about 100 bytes, 1-4 to a batch.
func corpusLiveBatches(rng *rand.Rand, items []corpusItem, n int) [][]byte {
	session, turn := newUUID(rng), newUUID(rng)
	var deltas []string
	for _, it := range items {
		if it.kind != "text" && it.kind != "thinking" {
			continue
		}
		for s := it.text; len(s) > 0; {
			k := min(len(s), between(rng, 60, 100))
			deltas = append(deltas, s[:k])
			s = s[k:]
		}
		if len(deltas) > n*4 {
			break
		}
	}
	var out [][]byte
	for i := 0; len(out) < n && len(deltas) > 0; i++ {
		k := min(len(deltas), between(rng, 1, 4))
		out = append(out, liveBatch(i+1, session, turn, deltas[:k]))
		deltas = deltas[k:]
	}
	return out
}

// countingConn counts the bytes written on a connection: what the wire carries from the runner's side.
type countingConn struct {
	net.Conn
	n *atomic.Int64
}

func (c countingConn) Write(b []byte) (int, error) {
	c.n.Add(int64(len(b)))
	return c.Conn.Write(b)
}

func cpuNow() time.Duration {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

// pair is a runner's side and the gateway's side of one connection in mode m over loopback TCP, with the bytes the
// runner's side writes counted.
func pair(t *testing.T, m measureMode, wire *atomic.Int64) (client, server *websocket.Conn, done func()) {
	accepted := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: m.mode, CompressionThreshold: m.threshold})
		if err != nil {
			return
		}
		ws.SetReadLimit(1 << 20)
		accepted <- ws
		<-r.Context().Done()
	}))
	dialer := &net.Dialer{}
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := dialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return countingConn{Conn: c, n: wire}, nil
	}}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, srv.URL, &websocket.DialOptions{HTTPClient: hc, CompressionMode: m.mode, CompressionThreshold: m.threshold})
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(1 << 20)
	s := <-accepted
	return c, s, func() {
		_ = c.CloseNow()
		_ = s.CloseNow()
		srv.Close()
	}
}

// measure sends msgs from the runner's side to the gateway's and reads them there: the bytes the wire carried and the
// process's CPU per message, the median of five runs.
func measure(t *testing.T, msgs [][]byte, m measureMode) measureResult {
	var raw int64
	for _, b := range msgs {
		raw += int64(len(b))
	}
	var cpus []float64
	var wireBytes int64
	for run := 0; run < 5; run++ {
		var wire atomic.Int64
		c, s, done := pair(t, m, &wire)
		wire.Store(0) // the upgrade request is not traffic
		read := make(chan error, 1)
		go func() {
			for range msgs {
				if _, _, err := s.Read(context.Background()); err != nil {
					read <- err
					return
				}
			}
			read <- nil
		}()
		runtime.GC()
		start := cpuNow()
		for _, b := range msgs {
			if err := c.Write(context.Background(), websocket.MessageBinary, b); err != nil {
				t.Fatal(err)
			}
		}
		if err := <-read; err != nil {
			t.Fatal(err)
		}
		cpus = append(cpus, float64(cpuNow()-start)/float64(time.Microsecond)/float64(len(msgs)))
		wireBytes = wire.Load()
		done()
	}
	sort.Float64s(cpus)
	return measureResult{raw: raw, wire: wireBytes, cpuPerMsg: cpus[len(cpus)/2]}
}

// heapOf is the heap n connection pairs hold once each side has written and read one message, in bytes.
func heapOf(t *testing.T, m measureMode, n int) float64 {
	msg := []byte(text(rand.New(rand.NewPCG(1, 2)), 4096))[:4096]
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	var dones []func()
	for i := 0; i < n; i++ {
		var wire atomic.Int64
		c, s, done := pair(t, m, &wire)
		dones = append(dones, done)
		go func() {
			_, _, _ = s.Read(context.Background())
			_ = s.Write(context.Background(), websocket.MessageBinary, msg)
		}()
		if err := c.Write(context.Background(), websocket.MessageBinary, msg); err != nil {
			t.Fatal(err)
		}
		if _, _, err := c.Read(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	for _, d := range dones {
		d()
	}
	return float64(int64(after.HeapInuse) - int64(before.HeapInuse))
}
