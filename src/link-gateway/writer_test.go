package main

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// What the gateway writes, in which order (conn.go): three tiers, control first, and a frame in pieces yields to a
// higher tier between two pieces (§5.1). A runner that does not read loses what is droppable and is closed when its
// control queue fills (§6.1).

// steppedWriter stands in for the WebSocket under a connection's writer: each message waits on the test, which takes
// it from written and lets the writer go on with step.
type steppedWriter struct {
	written chan []byte
	step    chan struct{}
}

func stepWriter(c *conn) *steppedWriter {
	w := &steppedWriter{written: make(chan []byte), step: make(chan struct{})}
	c.writeWS = func(ctx context.Context, b []byte) error {
		select {
		case w.written <- b:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-w.step:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return w
}

// next is the next message the writer writes, decoded, and lets that write finish.
func (w *steppedWriter) next(t *testing.T) *linkpb.Frame {
	t.Helper()
	var b []byte
	select {
	case b = <-w.written:
	case <-time.After(5 * time.Second):
		t.Fatal("the writer wrote nothing")
	}
	var f linkpb.Frame
	if err := proto.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	w.step <- struct{}{}
	return &f
}

// writerConn is a connection whose writer runs on a steppedWriter, with no WebSocket under it.
func writerConn(t *testing.T) (*conn, *steppedWriter) {
	h := newHarness(t, nil)
	c := newConn(h.g, nil, &linkClaims{RunnerID: runnerA, LeaseOwner: processA}, "127.0.0.1")
	c.welcomed = true
	w := stepWriter(c)
	go c.writeLoop()
	t.Cleanup(c.cancel)
	return c, w
}

func ackFrame() *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_LINK}}}
}

func TestAControlFrameIsWrittenBetweenThePiecesOfALargeFrame(t *testing.T) {
	c, w := writerConn(t)
	big := &linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: "r-1",
		Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{Status: 200, JsonBody: bytes.Repeat([]byte("x"), 600<<10)}}}}}
	c.send(big, false)
	// The first piece is on its way when an acknowledgement is queued.
	var first []byte
	select {
	case first = <-w.written:
	case <-time.After(5 * time.Second):
		t.Fatal("nothing written")
	}
	c.send(ackFrame(), true)
	w.step <- struct{}{}

	var joined reassembler
	var f0 linkpb.Frame
	_ = proto.Unmarshal(first, &f0)
	if f0.GetChunk().GetFrameId() != big.GetId() || f0.GetChunk().GetIndex() != 0 {
		t.Fatalf("first message %s", summarize(&f0))
	}
	if _, err := joined.add(f0.GetChunk()); err != nil {
		t.Fatal(err)
	}
	if f := w.next(t); f.GetHeartbeatAck() == nil {
		t.Fatalf("after the first piece came %s, want the acknowledgement queued meanwhile", summarize(f))
	}
	var whole *linkpb.Frame
	for whole == nil {
		f := w.next(t)
		if f.GetChunk() == nil {
			t.Fatalf("a piece was expected, got %s", summarize(f))
		}
		var err error
		if whole, err = joined.add(f.GetChunk()); err != nil {
			t.Fatal(err)
		}
	}
	if !proto.Equal(whole.GetRpcResult(), big.GetRpcResult()) {
		t.Fatal("the joined frame is not the one sent")
	}
}

func TestFramesAreWrittenByTierBeforeArrival(t *testing.T) {
	c, w := writerConn(t)
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}}}}, false)
	// While the first frame is on its way: one of each tier, the lowest first.
	var first []byte
	select {
	case first = <-w.written:
	case <-time.After(5 * time.Second):
		t.Fatal("nothing written")
	}
	_ = first
	c.offerLive(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{RequestId: "p-1"}}})
	c.offer(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Commands{Commands: &linkpb.CommandsHint{}}}}})
	c.send(ackFrame(), true)
	w.step <- struct{}{}
	var order []string
	for i := 0; i < 3; i++ {
		order = append(order, bodyName(w.next(t)))
	}
	if strings.Join(order, ",") != "heartbeat_ack,hint,turn_prefix_request" {
		t.Fatalf("written in the order %v", order)
	}
}

func TestAFullLiveQueueDropsWithoutClosingTheConnection(t *testing.T) {
	h := newHarness(t, nil)
	c := newConn(h.g, nil, &linkClaims{RunnerID: runnerA, LeaseOwner: processA}, "127.0.0.1")
	c.welcomed = true
	request := func() *linkpb.Frame {
		return &linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{RequestId: "p"}}}
	}
	for i := 0; i < liveQueue; i++ {
		if !c.offerLive(request()) {
			t.Fatalf("frame %d of %d was not queued", i+1, liveQueue)
		}
	}
	if c.offerLive(request()) {
		t.Fatal("a frame was queued past a full live queue")
	}
	select {
	case <-c.closing:
		t.Fatal("a full live queue closed the connection")
	default:
	}
	if got := h.g.metrics.queueFull.get("live", "dropped"); got != 1 {
		t.Fatalf("link_queue_full_total{queue=\"live\",result=\"dropped\"} = %v", got)
	}
}

// A runner that stops reading: its acknowledgements fill the socket and then the control queue, and the connection is
// closed as a slow consumer rather than allowed to hold memory.
func TestARunnerThatStopsReadingIsClosedAsASlowConsumer(t *testing.T) {
	padding := strings.Repeat("x", 200<<10)
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeJSON(w, 200, map[string]any{"maxConcurrent": 1, "padding": padding})
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{
		HTTPClient: h.srv.Client(), HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token(runnerA, processA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxChunkedFrameBytes)
	hello, _ := proto.Marshal(linkHello(processA))
	if err := ws.Write(ctx, websocket.MessageBinary, hello); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ws.Read(ctx); err != nil { // Welcome; nothing is read after it
		t.Fatal(err)
	}
	beat, _ := proto.Marshal(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	deadline := time.Now().Add(45 * time.Second)
	for h.g.metrics.disconnects.get("slow_consumer") == 0 && time.Now().Before(deadline) {
		wctx, wcancel := context.WithTimeout(ctx, time.Second)
		err := ws.Write(wctx, websocket.MessageBinary, beat)
		wcancel()
		if err != nil {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	eventually(t, 30*time.Second, "closed as a slow consumer", func() bool { return h.g.metrics.disconnects.get("slow_consumer") == 1 })
	if got := h.g.metrics.queueFull.get("control", "closed"); got < 1 {
		t.Fatalf("link_queue_full_total{queue=\"control\",result=\"closed\"} = %v", got)
	}
}

// A frame larger than one message reaches the runner in pieces it joins (contracts Chunk).
func TestALargeAnswerReachesTheRunnerInPieces(t *testing.T) {
	large := `{"events":"` + strings.Repeat("é", 300<<10) + `"}`
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(large))
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "big-1",
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/events"}}}}})
	var joined reassembler
	pieces := 0
	deadline := time.After(10 * time.Second)
	for {
		var f *linkpb.Frame
		select {
		case f = <-tc.frames:
		case <-deadline:
			t.Fatal("no answer")
		}
		c := f.GetChunk()
		if c == nil {
			t.Fatalf("got %s, want pieces", summarize(f))
		}
		pieces++
		whole, err := joined.add(c)
		if err != nil {
			t.Fatal(err)
		}
		if whole != nil {
			if body := whole.GetRpcResult().GetTunnel().GetJsonBody(); string(body) != large {
				t.Fatalf("joined %d bytes, want %d", len(body), len(large))
			}
			break
		}
	}
	if pieces < 3 {
		t.Fatalf("%d pieces", pieces)
	}
}
