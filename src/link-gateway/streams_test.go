package main

import (
	"bytes"
	"context"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Byte streams (streams.go) through the NATS stand-in (hints_test.go), which plays the apiserver's side: it asks for a
// stream on the runner's subject, publishes the viewer's bytes on vnc.<streamId>.down and reads the runner's on .up.

const (
	streamA = "0190a0b0-0000-7000-8000-0000000000e1"
	streamB = "0190a0b0-0000-7000-8000-0000000000e2"
	streamC = "0190a0b0-0000-7000-8000-0000000000e3"
	// heartbeatAckBound is the bound a HeartbeatAck is held to: an acknowledgement's p99 under one second
	// (docs/runner-link-design.md §9; linkDurationBounds, memlimit.go's "1 s rule").
	heartbeatAckBound = time.Second
)

// streamHello is linkHello declaring link-stream-v1.
func streamHello(process string) *linkpb.Frame {
	f := linkHello(process)
	f.GetHello().Capabilities = append(f.GetHello().Capabilities, streamCapability)
	return f
}

// streamRig is a gateway with a backend that answers heartbeats, NATS, and one runner connection that speaks streams.
type streamRig struct {
	t       *testing.T
	h       *harness
	backend *fakeBackend
	nats    *natsStandIn
	tc      *testConn
	// sendMu serializes the runner's writes, which several goroutines of a test make.
	sendMu sync.Mutex
}

func newStreamRig(t *testing.T, hello func(string) *linkpb.Frame) *streamRig {
	return newStreamRigWith(t, hello, nil)
}

// welcomeBrowserOffered is the welcome route's answer for a managed runner whose instance matches the manager's record,
// with the browser switch on: the browser is offered.
func welcomeBrowserOffered(w http.ResponseWriter, _ *http.Request, _ []byte) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{}, "browser": true})
}

// newStreamRigWith is newStreamRig with the gateway's writes to the runner wrapped by wrap (gateway.wrapWrite).
func newStreamRigWith(t *testing.T, hello func(string) *linkpb.Frame,
	wrap func(func(context.Context, []byte) error) func(context.Context, []byte) error) *streamRig {
	return newStreamRigWelcomed(t, hello, welcomeBrowserOffered, wrap)
}

// newStreamRigWelcomed is newStreamRigWith with the welcome route answering as welcome does.
func newStreamRigWelcomed(t *testing.T, hello func(string) *linkpb.Frame, welcome func(http.ResponseWriter, *http.Request, []byte),
	wrap func(func(context.Context, []byte) error) func(context.Context, []byte) error) *streamRig {
	t.Helper()
	backend := newFakeBackend(t, heartbeatAnswer)
	backend.setWelcome(welcome)
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) { c.FrameLog = "lifecycle" })
	h.g.wrapWrite = wrap
	n := listenNATS(t, "127.0.0.1:0")
	relayTo(t, h, n.url())
	tc, resp, err := h.dial(h.token(runnerA, processA))
	if err != nil {
		t.Fatalf("dial: %v (%v)", err, resp)
	}
	tc.send(hello(processA))
	tc.expect("welcome", 5*time.Second)
	eventually(t, 5*time.Second, "the runner's subject is subscribed", func() bool { return n.subscribers("rnr."+runnerA) == 1 })
	return &streamRig{t: t, h: h, backend: backend, nats: n, tc: tc}
}

func (r *streamRig) send(f *linkpb.Frame) {
	r.sendMu.Lock()
	defer r.sendMu.Unlock()
	r.tc.send(f)
}

// ask publishes a StreamOpen request for id, as the apiserver does, with reply as its reply subject.
func (r *streamRig) ask(id, reply string) {
	r.t.Helper()
	data, err := protojson.Marshal(&linkpb.Frame{Body: &linkpb.Frame_StreamOpen{StreamOpen: &linkpb.StreamOpen{
		StreamId: id, Kind: linkpb.StreamKind_STREAM_KIND_VNC,
	}}})
	if err != nil {
		r.t.Fatal(err)
	}
	if n := r.nats.deliverMsg("rnr."+runnerA, reply, nil, data); n != 1 {
		r.t.Fatalf("the request reached %d subscribers", n)
	}
}

// answer is the gateway's answer to the open request with reply subject reply.
func (r *streamRig) answer(reply string) *linkpb.Frame {
	r.t.Helper()
	var got [][]byte
	eventually(r.t, 5*time.Second, "the open request is answered", func() bool {
		got = r.nats.publishedOn(reply)
		return len(got) > 0
	})
	if len(got) != 1 {
		r.t.Fatalf("the open request was answered %d times", len(got))
	}
	var f linkpb.Frame
	if err := protojson.Unmarshal(got[0], &f); err != nil {
		r.t.Fatalf("the answer %s: %v", got[0], err)
	}
	return &f
}

// open asks for stream id and has the runner open it.
func (r *streamRig) open(id string) {
	r.t.Helper()
	reply := "_INBOX.open-" + id
	r.ask(id, reply)
	got := r.tc.await("stream_open", 5*time.Second, nil).GetStreamOpen()
	if got.GetStreamId() != id || got.GetKind() != linkpb.StreamKind_STREAM_KIND_VNC {
		r.t.Fatalf("StreamOpen %v", got)
	}
	r.send(&linkpb.Frame{Body: &linkpb.Frame_StreamOpened{StreamOpened: &linkpb.StreamOpened{StreamId: id}}})
	if a := r.answer(reply); a.GetStreamOpened().GetStreamId() != id {
		r.t.Fatalf("the open request was answered %v", a)
	}
	eventually(r.t, 5*time.Second, "the stream's down subject is subscribed", func() bool {
		return r.nats.subscribers(streamDownSubject(id)) == 1
	})
}

// down publishes f on the stream's .down subject, as the apiserver does for its viewer.
func (r *streamRig) down(id string, f *linkpb.Frame) {
	r.t.Helper()
	data, err := proto.Marshal(f)
	if err != nil {
		r.t.Fatal(err)
	}
	if n := r.nats.publish(streamDownSubject(id), data); n != 1 {
		r.t.Fatalf("published on %s to %d subscribers", streamDownSubject(id), n)
	}
}

// up is every frame the gateway published on the stream's .up subject so far.
func (r *streamRig) up(id string) []*linkpb.Frame {
	r.t.Helper()
	var out []*linkpb.Frame
	for _, data := range r.nats.publishedOn(streamUpSubject(id)) {
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(data, f); err != nil {
			r.t.Fatalf("a message on %s does not decode: %v", streamUpSubject(id), err)
		}
		out = append(out, f)
	}
	return out
}

func dataFrame(id string, b []byte) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{StreamId: id, Data: b}}}
}

func creditFrame(id string, n int) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{StreamId: id, Bytes: uint32(n)}}}
}

func streamCloseFrame(id string, code linkpb.StreamCloseCode) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{StreamId: id, Code: code}}}
}

// Bytes go both ways through NATS: the runner's StreamData and StreamCredit come out on .up in order, the viewer's
// StreamData on .down reaches the runner in pieces of at most 32 KiB, and the viewer's close reaches the runner and lets
// the subscription go.
func TestAStreamRelaysBytesBothWaysThroughNATS(t *testing.T) {
	r := newStreamRig(t, streamHello)
	r.open(streamA)

	r.send(dataFrame(streamA, []byte("RFB 003.008\n")))
	r.send(dataFrame(streamA, []byte("frame")))
	eventually(t, 5*time.Second, "the runner's frames are published", func() bool { return len(r.up(streamA)) == 2 })
	up := r.up(streamA)
	if string(up[0].GetStreamData().GetData()) != "RFB 003.008\n" || string(up[1].GetStreamData().GetData()) != "frame" ||
		up[0].GetStreamData().GetStreamId() != streamA {
		t.Fatalf("published on .up: %v", up)
	}

	// The viewer's bytes, 100 KiB in one message: the runner gets them in order, in frames of at most 32 KiB.
	sent := bytes.Repeat([]byte("0123456789abcdef"), 100<<10/16)
	r.down(streamA, dataFrame(streamA, sent))
	var got []byte
	for len(got) < len(sent) {
		d := r.tc.await("stream_data", 5*time.Second, nil).GetStreamData()
		if d.GetStreamId() != streamA || len(d.GetData()) > maxStreamDataBytes {
			t.Fatalf("StreamData of %d bytes for %s", len(d.GetData()), d.GetStreamId())
		}
		got = append(got, d.GetData()...)
	}
	if !bytes.Equal(got, sent) {
		t.Fatal("the runner got other bytes than the viewer sent")
	}
	// The runner's credit for them reaches the viewer, after its data.
	r.send(creditFrame(streamA, len(sent)))
	eventually(t, 5*time.Second, "the runner's credit is published", func() bool { return len(r.up(streamA)) == 3 })
	if c := r.up(streamA)[2].GetStreamCredit(); c.GetBytes() != uint32(len(sent)) {
		t.Fatalf("published %v", c)
	}
	// The viewer's credit for the runner's 17 bytes reaches the runner.
	r.down(streamA, creditFrame(streamA, 17))
	if c := r.tc.await("stream_credit", 5*time.Second, nil).GetStreamCredit(); c.GetBytes() != 17 || c.GetStreamId() != streamA {
		t.Fatalf("StreamCredit %v", c)
	}

	r.down(streamA, streamCloseFrame(streamA, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL))
	if c := r.tc.await("stream_close", 5*time.Second, nil).GetStreamClose(); c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL {
		t.Fatalf("StreamClose %v", c)
	}
	eventually(t, 5*time.Second, "the down subject is let go", func() bool { return r.nats.subscribers(streamDownSubject(streamA)) == 0 })
	if r.h.g.streams.open() != 0 {
		t.Fatal("the stream is still recorded")
	}
	// A frame for the closed stream is ignored: nothing more goes out on .up.
	r.send(dataFrame(streamA, []byte("late")))
	r.tc.quiet(200 * time.Millisecond)
	if n := len(r.up(streamA)); n != 3 {
		t.Fatalf("%d messages on .up after the close", n)
	}
}

// A runner has at most two streams: the third is refused TOO_MANY_STREAMS without reaching it, and once one closes
// another opens.
func TestAThirdStreamOfARunnerIsRefused(t *testing.T) {
	r := newStreamRig(t, streamHello)
	r.open(streamA)
	r.open(streamB)

	r.ask(streamC, "_INBOX.third")
	a := r.answer("_INBOX.third").GetStreamClose()
	if a.GetStreamId() != streamC || a.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_TOO_MANY_STREAMS {
		t.Fatalf("the third stream was answered %v", a)
	}
	r.tc.quiet(200 * time.Millisecond)
	if n := r.nats.subscribers(streamDownSubject(streamC)); n != 0 {
		t.Fatalf("the refused stream's subject has %d subscribers", n)
	}
	if got := r.h.g.metrics.streams.get("too_many"); got != 1 {
		t.Fatalf("too_many counted %v", got)
	}

	// The runner ends one; the viewer is told on .up, and a third may open.
	r.send(streamCloseFrame(streamB, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL))
	eventually(t, 5*time.Second, "the runner's close is published", func() bool { return len(r.up(streamB)) == 1 })
	if c := r.up(streamB)[0].GetStreamClose(); c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL {
		t.Fatalf("published %v", c)
	}
	r.open(streamC)
}

// A runner whose Hello does not declare link-stream-v1 is never sent StreamOpen: the request is refused.
func TestAStreamIsOpenedOnlyOnARunnerThatDeclaresTheCapability(t *testing.T) {
	r := newStreamRig(t, linkHello)
	r.ask(streamA, "_INBOX.old")
	if a := r.answer("_INBOX.old").GetStreamClose(); a.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
		t.Fatalf("answered %v", a)
	}
	r.tc.quiet(200 * time.Millisecond)
}

// Only a verified managed runner is sent StreamOpen (docs/runner-browser-design.md §2): one whose Hello names a
// ManagedInstance that the welcome route found to match the manager's record, and was so offered the browser. A
// connection that declares link-stream-v1 but whose instance the route refused (a generation or Pod UID other than the
// recorded one, or none: 403), or that the route did not offer the browser (a self-managed runner, or the switch off),
// or whose Hello names no instance at all, has the request refused, and the runner never sees it.
func TestAStreamIsOpenedOnlyOnAVerifiedManagedRunner(t *testing.T) {
	refusedInstance := func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeJSON(w, http.StatusForbidden, map[string]any{"code": "MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED",
			"message": "Pod 0190a0b0-0000-7000-8000-0000000000aa is not the instance authorized for generation 7."})
	}
	notOffered := func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		writeJSON(w, http.StatusOK, map[string]any{"sessions": []any{}, "browser": false})
	}
	noInstance := func(process string) *linkpb.Frame {
		f := streamHello(process)
		f.GetHello().ManagedInstance = nil
		return f
	}
	for _, c := range []struct {
		name    string
		hello   func(string) *linkpb.Frame
		welcome func(http.ResponseWriter, *http.Request, []byte)
	}{
		{"a ManagedInstance the welcome route refused", streamHello, refusedInstance},
		{"the browser not offered", streamHello, notOffered},
		{"no ManagedInstance in the Hello", noInstance, welcomeBrowserOffered},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := newStreamRigWelcomed(t, c.hello, c.welcome, nil)
			r.ask(streamA, "_INBOX.unverified")
			a := r.answer("_INBOX.unverified").GetStreamClose()
			if a.GetStreamId() != streamA || a.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
				t.Fatalf("answered %v", a)
			}
			r.tc.quiet(200 * time.Millisecond)
			if n := r.nats.subscribers(streamDownSubject(streamA)); n != 0 {
				t.Fatalf("the refused stream's subject has %d subscribers", n)
			}
			if got := r.h.g.metrics.streams.get("refused"); got != 1 {
				t.Fatalf("refused counted %v", got)
			}
		})
	}

	// The welcome route is asked with the Hello's instance, which is what it checks against the manager's record.
	r := newStreamRig(t, streamHello)
	calls := r.backend.welcomeCalls()
	if len(calls) != 1 || calls[0].Header.Get(managedGenerationHeader) != "7" || calls[0].Header.Get(managedPodUIDHeader) != "pod-1" {
		t.Fatalf("the welcome route was asked %v", calls)
	}
	r.open(streamA)
}

// A peer that sends past its window has the stream closed FLOW_VIOLATION, and both sides are told.
func TestAStreamSentPastItsWindowIsClosed(t *testing.T) {
	r := newStreamRig(t, streamHello)
	r.open(streamA)
	piece := make([]byte, maxStreamDataBytes)
	for i := 0; i < streamWindow/maxStreamDataBytes; i++ {
		r.send(dataFrame(streamA, piece))
	}
	r.send(dataFrame(streamA, []byte{1}))
	if c := r.tc.await("stream_close", 5*time.Second, nil).GetStreamClose(); c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION {
		t.Fatalf("StreamClose %v", c)
	}
	eventually(t, 5*time.Second, "the viewer is told", func() bool {
		up := r.up(streamA)
		return len(up) == streamWindow/maxStreamDataBytes+1 &&
			up[len(up)-1].GetStreamClose().GetCode() == linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION
	})

	// The viewer's side too.
	r.open(streamB)
	r.down(streamB, dataFrame(streamB, make([]byte, streamWindow+1)))
	if c := r.tc.await("stream_close", 5*time.Second, nil).GetStreamClose(); c.GetStreamId() != streamB ||
		c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION {
		t.Fatalf("StreamClose %v", c)
	}
}

// A stream ends with the connection it was opened on: the viewer is told CONNECTION_LOST.
func TestAStreamEndsWithItsConnection(t *testing.T) {
	r := newStreamRig(t, streamHello)
	r.open(streamA)
	_ = r.tc.ws.CloseNow()
	eventually(t, 5*time.Second, "the viewer is told", func() bool {
		up := r.up(streamA)
		return len(up) == 1 && up[0].GetStreamClose().GetCode() == linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST
	})
	eventually(t, 5*time.Second, "the down subject is let go", func() bool { return r.nats.subscribers(streamDownSubject(streamA)) == 0 })
}

// A saturated stream does not delay the link's control traffic (docs/runner-browser-design.md §4): with a stream
// sending at full credit both ways (the runner up, the viewer down, each crediting back at once what it receives),
// every HeartbeatAck comes within heartbeatAckBound of its Heartbeat. On loopback, and on a link of 128 KiB/s to the
// runner, where a stream's window waiting ahead of an ack would hold it 2 s: only the stream tier keeps it to the one
// StreamData being written (32 KiB, 250 ms).
func TestASaturatedStreamDoesNotDelayHeartbeatAcks(t *testing.T) {
	t.Run("loopback", func(t *testing.T) { saturate(t, nil, 10) })
	t.Run("128KiB/s", func(t *testing.T) {
		const rate = 128 << 10 // bytes a second
		saturate(t, func(write func(context.Context, []byte) error) func(context.Context, []byte) error {
			// A link of that bandwidth: each message is on the wire len/rate after the last one ended. The writer sleeps
			// only once it is 2 ms ahead, since a sleep of a few microseconds per small frame lasts a millisecond.
			var free time.Time
			return func(ctx context.Context, b []byte) error {
				free = later(free, time.Now()).Add(time.Duration(len(b)) * time.Second / rate)
				if wait := time.Until(free); wait > 2*time.Millisecond {
					time.Sleep(wait)
				}
				return write(ctx, b)
			}
		}, 1)
	})
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// saturate runs a stream at full credit both ways while it times heartbeats, and fails past heartbeatAckBound. The
// viewer's side must move at least downWindows windows.
func saturate(t *testing.T, wrap func(func(context.Context, []byte) error) func(context.Context, []byte) error, downWindows int64) {
	r := newStreamRigWith(t, streamHello, wrap)
	r.open(streamA)

	var upBytes, downBytes, upStalls, downStalls atomic.Int64
	// The viewer: credits back each StreamData from the runner, and sends its own whenever it has room, from its
	// window and the runner's StreamCredit.
	downRoom := make(chan int, 1024)
	r.nats.mu.Lock()
	r.nats.tap = func(subject string, payload []byte) bool {
		if subject != streamUpSubject(streamA) {
			return true
		}
		var f linkpb.Frame
		if proto.Unmarshal(payload, &f) != nil {
			return true
		}
		switch {
		case f.GetStreamData() != nil:
			n := len(f.GetStreamData().GetData())
			upBytes.Add(int64(n))
			data, _ := proto.Marshal(creditFrame(streamA, n))
			r.nats.publish(streamDownSubject(streamA), data)
			return false
		case f.GetStreamCredit() != nil:
			downRoom <- int(f.GetStreamCredit().GetBytes())
			return false
		}
		return true
	}
	r.nats.mu.Unlock()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	piece := bytes.Repeat([]byte{0xA5}, maxStreamDataBytes)
	pieceFrame, _ := proto.Marshal(dataFrame(streamA, piece))

	// The viewer's sender: always at full credit.
	wg.Add(1)
	go func() {
		defer wg.Done()
		room := streamWindow
		for {
			for room >= maxStreamDataBytes {
				r.nats.publish(streamDownSubject(streamA), pieceFrame)
				room -= maxStreamDataBytes
			}
			downStalls.Add(1)
			select {
			case n := <-downRoom:
				room += n
			case <-stop:
				return
			}
		}
	}()

	// The runner: reads every frame, credits back each StreamData at once, takes the viewer's credit for its own
	// sender, and times each HeartbeatAck.
	upRoom := make(chan int, 1024)
	var ackMu sync.Mutex
	sentAt := map[uint64]time.Time{}
	var latencies []time.Duration
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case f := <-r.tc.frames:
				switch {
				case f.GetStreamData() != nil:
					n := len(f.GetStreamData().GetData())
					downBytes.Add(int64(n))
					r.send(creditFrame(streamA, n))
				case f.GetStreamCredit() != nil:
					upRoom <- int(f.GetStreamCredit().GetBytes())
				case f.GetHeartbeatAck() != nil:
					ackMu.Lock()
					if at, ok := sentAt[f.GetHeartbeatAck().GetBeatId()]; ok {
						latencies = append(latencies, time.Since(at))
						delete(sentAt, f.GetHeartbeatAck().GetBeatId())
					}
					ackMu.Unlock()
				case f.GetStreamClose() != nil:
					t.Errorf("the stream closed under saturation: %v", f.GetStreamClose())
				}
			case <-stop:
				return
			case <-r.tc.done:
				return
			}
		}
	}()
	// The runner's sender: always at full credit.
	wg.Add(1)
	go func() {
		defer wg.Done()
		room := streamWindow
		for {
			for room >= maxStreamDataBytes {
				r.send(dataFrame(streamA, piece))
				room -= maxStreamDataBytes
			}
			upStalls.Add(1)
			select {
			case n := <-upRoom:
				room += n
			case <-stop:
				return
			}
		}
	}()

	// Heartbeats every 50 ms for 3 s while both directions run at full credit.
	const beats = 60
	time.Sleep(200 * time.Millisecond) // both senders reach full credit first
	for id := uint64(1); id <= beats; id++ {
		ackMu.Lock()
		sentAt[id] = time.Now()
		ackMu.Unlock()
		r.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA, BeatId: id}))
		time.Sleep(50 * time.Millisecond)
	}
	eventually(t, 2*heartbeatAckBound, "every beat is acknowledged", func() bool {
		ackMu.Lock()
		defer ackMu.Unlock()
		return len(latencies) == beats
	})
	close(stop)
	wg.Wait()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p50, p99, worst := latencies[len(latencies)/2], latencies[len(latencies)*99/100], latencies[len(latencies)-1]
	t.Logf("saturated: %.1f MiB up and %.1f MiB down in %d and %d waits for credit; HeartbeatAck p50 %s, p99 %s, max %s over %d beats",
		float64(upBytes.Load())/(1<<20), float64(downBytes.Load())/(1<<20), upStalls.Load(), downStalls.Load(),
		p50, p99, worst, len(latencies))
	// Saturated: each side ran out of credit and waited for more, again and again, and moved many windows' worth.
	if upStalls.Load() < 10 || downStalls.Load() < downWindows || upBytes.Load() < 10*streamWindow || downBytes.Load() < downWindows*streamWindow {
		t.Fatalf("the stream was not saturated: %d and %d bytes, %d and %d waits for credit",
			upBytes.Load(), downBytes.Load(), upStalls.Load(), downStalls.Load())
	}
	if worst > heartbeatAckBound {
		t.Fatalf("a HeartbeatAck took %s under a saturated stream, past the %s bound (p50 %s, p99 %s)", worst, heartbeatAckBound, p50, p99)
	}
	if got := r.h.g.metrics.streams.get("flow_violation") + r.h.g.metrics.streams.get("slow_runner"); got != 0 {
		t.Fatalf("the stream was closed %v times", got)
	}
	if r.h.g.streams.open() != 1 {
		t.Fatal("the stream did not stay open")
	}
}
