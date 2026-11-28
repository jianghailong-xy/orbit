package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner's half of the slow-path fix (docs/runner-link-design.md §15.15): liveness from bytes read, no pings while
// writes block, a write's deadline that is "no progress" rather than "10 s per message", the cause of an end named,
// 16 KiB pieces, the backoff after a connection that dies young, and heartbeats between an EventBatch's pieces.
//
// The socket is slowed and stalled under the count (linkSocketLimits.wrap), as a weak path does to it. The limits are shortened
// here; TestTheSlowPathLimitsAreAsSpecified pins the real ones.

// linkValve is a socket the test slows or stalls.
type linkValve struct {
	net.Conn
	// rate, when non-zero, is how many bytes a second writes go at.
	rate atomic.Int64
	// holdWrites and holdReads, while set, keep writes and reads from going until they are closed.
	holdWrites, holdReads atomic.Pointer[chan struct{}]
	// holdNextWrite has the next write held (holdWrites), whatever starts it.
	holdNextWrite atomic.Pointer[chan struct{}]
	// holdMinBytes, when non-zero, lets a write shorter than it through a hold: a ping or a pong is a few bytes, a
	// piece of a frame is KiB, so a test can stall its frame without catching a ping that was already on its way.
	holdMinBytes atomic.Int64
	// closed is closed with the socket: a held write or read then returns, as one blocked in the kernel does.
	closed    chan struct{}
	closeOnce sync.Once
}

func (v *linkValve) Close() error {
	v.closeOnce.Do(func() { close(v.closed) })
	return v.Conn.Close()
}

// wait waits for hold, if set, unless the socket closes first.
func (v *linkValve) wait(hold *chan struct{}) error {
	if hold == nil {
		return nil
	}
	select {
	case <-*hold:
		return nil
	case <-v.closed:
		return net.ErrClosed
	}
}

func (v *linkValve) Write(p []byte) (int, error) {
	if hold := v.holdNextWrite.Swap(nil); hold != nil {
		v.holdWrites.Store(hold)
	}
	if least := v.holdMinBytes.Load(); least == 0 || int64(len(p)) >= least {
		if err := v.wait(v.holdWrites.Load()); err != nil {
			return 0, err
		}
	}
	rate := v.rate.Load()
	if rate == 0 {
		return v.Conn.Write(p)
	}
	n := 0
	for n < len(p) {
		k := min(1024, len(p)-n)
		time.Sleep(time.Duration(k) * time.Second / time.Duration(rate))
		m, err := v.Conn.Write(p[n : n+k])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

func (v *linkValve) Read(p []byte) (int, error) {
	if err := v.wait(v.holdReads.Load()); err != nil {
		return 0, err
	}
	return v.Conn.Read(p)
}

// hold stalls p until the returned func is called, at most once.
func linkHold(p *atomic.Pointer[chan struct{}]) func() {
	ch := make(chan struct{})
	p.Store(&ch)
	var once sync.Once
	return func() {
		once.Do(func() {
			p.Store(nil)
			close(ch)
		})
	}
}

// slowPathRig is a work rig whose sockets go through valves, with the slow path's limits shortened.
type slowPathRig struct {
	*linkWorkRig
	mu     sync.Mutex
	valves []*linkValve
}

func newSlowPathRig(t *testing.T, stallLimit time.Duration) *slowPathRig {
	t.Helper()
	r := &slowPathRig{linkWorkRig: newLinkWorkRig(t)}
	old := linkSocketTuning.Load()
	linkSocketTuning.Store(&linkSocketLimits{stall: stallLimit, slowWrite: 100 * time.Millisecond, checkEvery: 20 * time.Millisecond,
		wrap: func(c net.Conn) net.Conn {
			v := &linkValve{Conn: c, closed: make(chan struct{})}
			r.mu.Lock()
			r.valves = append(r.valves, v)
			r.mu.Unlock()
			return v
		}})
	t.Cleanup(func() {
		r.mu.Lock()
		for _, v := range r.valves {
			for _, p := range []*atomic.Pointer[chan struct{}]{&v.holdWrites, &v.holdReads} {
				if ch := p.Swap(nil); ch != nil {
					close(*ch)
				}
			}
		}
		r.mu.Unlock()
	})
	// Registered after newLinkWorkRig's, so it runs before the link closes; the limits are put back after.
	t.Cleanup(func() {
		r.m.close()
		linkSocketTuning.Store(old)
	})
	return r
}

// valve is the valve of the newest connection.
func (r *slowPathRig) valve() *linkValve {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.valves[len(r.valves)-1]
}

// linkTestBatch is an EventBatch whose payload is about size bytes.
func linkTestBatch(session string, size int) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{SessionId: session,
		Events: []*linkpb.Event{{Seq: 1, Type: "assistant", PayloadJson: []byte(`{"text":"` + strings.Repeat("x", size) + `"}`)}}}}}
}

// linkTestRpc is an Rpc whose body is about size bytes.
func linkTestRpc(id string, size int) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id, Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{
		Method: "POST", Path: "/runner/test", JsonBody: []byte(`{"x":"` + strings.Repeat("y", size) + `"}`)}}}}}
}

// wireMessage is one message as the gateway read it.
type wireMessage struct {
	id      uint64
	size    int
	chunkOf uint64 // the frame it is a piece of, 0 for a whole frame
	last    bool
	kind    string // the body of a whole frame
	raw     []byte
}

// recordWire has the gateway keep every message the runner writes, in order.
func recordWire(r *linkWorkRig) func() []wireMessage {
	var mu sync.Mutex
	var msgs []wireMessage
	r.g.mu.Lock()
	r.g.onMessage = func(_ *fakeWorkConn, data []byte) {
		var f linkpb.Frame
		_ = proto.Unmarshal(data, &f)
		m := wireMessage{id: f.GetId(), size: len(data), raw: append([]byte(nil), data...)}
		if c := f.GetChunk(); c != nil {
			m.chunkOf, m.last = c.GetFrameId(), c.GetLast()
		} else {
			m.kind = fmt.Sprintf("%T", f.GetBody())
		}
		mu.Lock()
		msgs = append(msgs, m)
		mu.Unlock()
	}
	r.g.mu.Unlock()
	return func() []wireMessage {
		mu.Lock()
		defer mu.Unlock()
		return append([]wireMessage(nil), msgs...)
	}
}

// ── R1, R2: liveness and the write's deadline ──────────────────────────────────────────────────────────────

// The limits of the fix as the plan states them: 45 s of a blocked write with no progress and nothing read, a write
// over 1 s counted as blocking, pings every 20 s given 20 s, pieces of 16 KiB, batches of 256 KiB, the trim's own
// 1 MiB, and a ceiling of 8 s after a connection younger than 60 s.
func TestTheSlowPathLimitsAreAsSpecified(t *testing.T) {
	for name, got := range map[string][2]any{
		"linkWriteStallLimit": {linkWriteStallLimit, 45 * time.Second},
		"linkSlowWrite":       {linkSlowWrite, time.Second},
		"the sockets' stall":  {linkSocketTuning.Load().stall, 45 * time.Second},
		"the sockets' slow":   {linkSocketTuning.Load().slowWrite, time.Second},
		"linkWorkPingEvery":   {linkWorkPingEvery, 20 * time.Second},
		"linkWorkPingTimeout": {linkWorkPingTimeout, 20 * time.Second},
		"linkSendPieceBytes":  {linkSendPieceBytes, 16 << 10},
		"linkMaxFrameBytes":   {linkMaxFrameBytes, 256 << 10},
		"linkBatchMaxBytes":   {linkBatchMaxBytes, 256 << 10},
		"linkTrimmedMaxBytes": {linkTrimmedMaxBytes, 1 << 20},
		"linkYoungConn":       {linkYoungConn, time.Minute},
		"linkYoungBackoff":    {linkYoungBackoff, 8 * time.Second},
	} {
		if got[0] != got[1] {
			t.Errorf("%s = %v, want %v", name, got[0], got[1])
		}
	}
}

// While a write blocks, the runner does not ping: a ping written into a full send buffer would stall in the flush,
// and the library would close the connection after 5 s. Once the write goes, the pings resume. A stall shorter than
// the limit leaves the connection up.
func TestPingingIsSuspendedWhileAWriteBlocksAndResumesAfter(t *testing.T) {
	r := newSlowPathRig(t, 10*time.Second)
	c := r.useLink(t)
	conn := r.m.work.current()
	linkWaitFor(t, 5*time.Second, "pings on a quiet connection", func() bool { return r.g.pings.Load() >= 3 })

	// Only the frame's own writes are held: a ping the pinger had already started when the hold began goes through, as
	// it would into a send buffer with room. Held, it would run out its 2 s and the library would close the
	// connection, which on a starved machine it did.
	v := r.valve()
	v.holdMinBytes.Store(1 << 10)
	release := linkHold(&v.holdWrites)
	sent := make(chan error, 1)
	go func() { _, err := conn.send(linkTestRpc("held", 64<<10)); sent <- err }()
	linkWaitFor(t, 5*time.Second, "the write to block", func() bool { return conn.sock.writing.Load() > 0 })
	// A ping already on its way lands: wait until none has for three ping intervals, however slow the machine.
	settled, last := time.Now(), r.g.pings.Load()
	linkWaitFor(t, 10*time.Second, "pings to stop landing", func() bool {
		if n := r.g.pings.Load(); n != last {
			settled, last = time.Now(), n
		}
		return time.Since(settled) >= 600*time.Millisecond
	})
	before := r.g.pings.Load()
	time.Sleep(2 * time.Second) // ten pings' worth
	if n := r.g.pings.Load() - before; n != 0 {
		t.Fatalf("%d pings while a write blocked", n)
	}
	release()
	if err := <-sent; err != nil {
		t.Fatalf("the held write: %v", err)
	}
	after := r.g.pings.Load()
	linkWaitFor(t, 5*time.Second, "pings once the write went", func() bool { return r.g.pings.Load() >= after+3 })
	if cur := r.m.work.current(); cur == nil || cur.id != c.id || len(r.g.welcomed()) != 1 {
		t.Fatalf("a stall within the limit ended the connection: %s", r.logs.String())
	}
}

// A write that makes no progress, with nothing read meanwhile, ends the connection after the limit, and the log says so,
// not "use of closed network connection". Bytes read keep the clock from running out: a gateway still heard from is not
// a dead path. The limit is 3 s, so that a busy machine running the race detector does not stall what is moving past it.
func TestABlockedWriteWithNoProgressAndNothingReadIsDeadAfterTheLimit(t *testing.T) {
	const limit = 3 * time.Second
	t.Run("nothing read", func(t *testing.T) {
		r := newSlowPathRig(t, limit)
		r.useLink(t)
		conn := r.m.work.current()
		v := r.valve()
		linkHold(&v.holdReads)
		linkHold(&v.holdWrites)
		start := time.Now()
		go func() { _, _ = conn.send(linkTestRpc("stuck", 1<<10)) }()
		linkWaitFor(t, 20*time.Second, "the connection to end", conn.ended)
		took := time.Since(start)
		if took < limit || took > limit+3*time.Second {
			t.Fatalf("ended %s after the write blocked, want about %s", took, limit)
		}
		linkWaitFor(t, 5*time.Second, "its end logged", func() bool { return r.logs.has("ended (connection lost") })
		logs := r.logs.String()
		if !strings.Contains(logs, "a write on the socket made no progress for ") ||
			!strings.Contains(logs, "s, and nothing was read from the gateway meanwhile") {
			t.Fatalf("the end does not name the stalled write: %s", logs)
		}
		if strings.Contains(logs, "use of closed network connection") {
			t.Fatalf("the end is logged as a closed network connection: %s", logs)
		}
	})
	t.Run("the gateway still heard", func(t *testing.T) {
		r := newSlowPathRig(t, limit)
		c := r.useLink(t)
		conn := r.m.work.current()
		release := linkHold(&r.valve().holdWrites)
		defer release()
		go func() { _, _ = conn.send(linkTestRpc("stuck", 1<<10)) }()
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			for {
				select {
				case <-stop:
					return
				case <-time.After(200 * time.Millisecond):
					c.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}}}})
				}
			}
		}()
		time.Sleep(3 * limit)
		if conn.ended() {
			t.Fatalf("a connection whose gateway kept writing was ended: %s", r.logs.String())
		}
	})
}

// A write that keeps moving, however slowly, is never cut off: here one 320 KiB call goes at 32 KiB/s, about 10 s and
// over three times the limit, with nothing read meanwhile; each 4 KiB the library hands the socket takes about 125 ms.
// The 10 s deadline it replaces would have ended it.
func TestAWriteThatKeepsMovingSlowlyIsNotCutOff(t *testing.T) {
	const limit = 3 * time.Second
	r := newSlowPathRig(t, limit)
	c := r.useLink(t)
	conn := r.m.work.current()
	v := r.valve()
	release := linkHold(&v.holdReads)
	defer release()
	v.rate.Store(32 << 10)
	start := time.Now()
	if _, err := conn.send(linkTestRpc("slow", 320<<10)); err != nil {
		t.Fatalf("the slow write: %v", err)
	}
	if took := time.Since(start); took < 3*limit {
		t.Fatalf("the write took %s, too fast to prove anything", took)
	}
	release()
	v.rate.Store(0)
	time.Sleep(200 * time.Millisecond)
	if conn.ended() || len(r.g.welcomed()) != 1 {
		t.Fatalf("a slowly moving write ended its connection: %s", r.logs.String())
	}
	linkWaitFor(t, 5*time.Second, "the call at the gateway", func() bool { return len(r.g.rpcsTo("/runner/test")) == 1 })
	_ = c
}

// A quiet connection on a gateway that sends no pings stays up while the control plane holds every heartbeat's answer
// far longer than any liveness bound (here 7 s against pings every 200 ms given 2 s, and a 3 s stall limit; on the
// real link, 60–75 s against 20 s and 45 s): the runner's own pings keep it, answered by the gateway itself.
func TestAQuietConnectionStaysUpWithAcksHeldAndNoGatewayPings(t *testing.T) {
	r := newSlowPathRig(t, 3*time.Second)
	numberAnswers(r.linkWorkRig)
	c := r.useLink(t)
	r.g.setBeatDelay(7 * time.Second)
	for i := 1; i <= 2; i++ {
		applied, err := linkBeatCall(r.linkWorkRig, 20*time.Second)
		if err != nil || applied != i {
			t.Fatalf("beat %d: applied %d (%v)", i, applied, err)
		}
	}
	if cur := r.m.work.current(); cur == nil || cur.id != c.id || len(r.g.welcomed()) != 1 {
		t.Fatalf("held answers ended the connection: %s", r.logs.String())
	}
	if r.g.pings.Load() == 0 {
		t.Fatal("the runner sent no pings")
	}
}

// A gateway's ping while the runner's upload has filled the path: the pong is written at once, because a frame's write
// waits for room in the send buffer before it takes the library's write lock (linkSocket.waitRoom). Before, the pong
// waited behind a write blocked in a full buffer, the library gave up on it after 5 s, and the connection ended: what
// ended the runner's connection every 45 s at 30% loss with the gateway's R3 in place. Here the gateway stops reading,
// so the runner's send buffer and the gateway's receive buffer fill, and pings it 10 s later.
func TestAPongGoesAtOnceWhileTheUploadFillsTheSendBuffer(t *testing.T) {
	r := newLinkWorkRig(t)
	c := r.useLink(t)
	conn := r.m.work.current()
	if conn.sock.queue == nil {
		t.Skip("this system's send queue cannot be read")
	}
	release := make(chan struct{})
	c.stall.Store(&release)
	defer close(release)
	go func() {
		for i := 0; i < 128; i++ {
			if _, err := conn.send(linkTestBatch(fmt.Sprintf("s%d", i), 256<<10)); err != nil {
				return
			}
		}
	}()
	linkWaitFor(t, 30*time.Second, "the upload to wait for room", func() bool {
		return conn.sock.stalledFor(time.Now()) > time.Second
	})
	queued, size, _ := conn.sock.queue()
	t.Logf("the send queue holds %d bytes of a %d-byte buffer", queued, size)
	pinged := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		pinged <- c.ws.Ping(ctx)
	}()
	time.Sleep(10 * time.Second) // twice the library's 5 s for a pong
	if conn.ended() {
		t.Fatalf("the connection ended while the upload waited: %v", conn.endReason())
	}
	select {
	case err := <-pinged:
		t.Fatalf("the gateway's ping ended before its reader was let go: %v", err)
	default:
	}
}

// ── R6: the end names its cause ─────────────────────────────────────────────────────────────────────────────

// A ping written into a stalled socket hits the library's own 5 s for a control frame, which closes the connection.
// The end says so; it used to read "use of closed network connection".
func TestAPingThatCannotBeWrittenNamesTheCause(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	r.useLink(t)
	conn := r.m.work.current()
	release := make(chan struct{})          // closed by the rig's cleanup, once it is the held write's
	r.valve().holdNextWrite.Store(&release) // the next write is the next ping
	linkWaitFor(t, 15*time.Second, "the connection to end", conn.ended)
	linkWaitFor(t, 5*time.Second, "its end logged", func() bool { return r.logs.has("ended (connection lost") })
	logs := r.logs.String()
	if !strings.Contains(logs, "within the WebSocket library's 5s") {
		t.Fatalf("the end does not name the ping's deadline: %s", logs)
	}
	if strings.Contains(logs, "use of closed network connection") {
		t.Fatalf("the end is logged as a closed network connection: %s", logs)
	}
}

// The library's wording, which linkControlWriteExpired reads: a ping that waited out the write lock leaves the
// connection open and is not an expired write; a ping whose write began and stalled is.
func TestTheLibrarysControlFrameDeadlineWordingIsRead(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	r.m.work.pingEvery = time.Hour
	r.useLink(t)
	conn := r.m.work.current()
	release := linkHold(&r.valve().holdWrites)
	go func() { _, _ = conn.send(linkTestRpc("hold", 1<<10)) }()
	linkWaitFor(t, 5*time.Second, "the write to block", func() bool { return conn.sock.writing.Load() > 0 })
	_, err := conn.ping(6 * time.Second)
	if err == nil || linkControlWriteExpired(err) || !strings.Contains(err.Error(), "failed to acquire lock") {
		t.Fatalf("a ping behind the write lock: %v", err)
	}
	if conn.ended() {
		t.Fatal("a ping that waited out the lock ended the connection")
	}
	release()

	hold := make(chan struct{}) // closed by the rig's cleanup
	r.valve().holdNextWrite.Store(&hold)
	_, err = conn.ping(6 * time.Second)
	if !linkControlWriteExpired(err) {
		t.Fatalf("a ping whose write stalled: %v", err)
	}
	linkWaitFor(t, 5*time.Second, "the library to close the connection", conn.ended)
}

// A gateway's Close still names the end, whatever this side recorded.
func TestAGatewayCloseStillNamesTheEnd(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	c := r.useLink(t)
	conn := r.m.work.current()
	conn.fail("something recorded first")
	c.closeWith(linkpb.CloseCode_CLOSE_CODE_SUPERSEDED, "from the test", 0)
	linkWaitFor(t, 5*time.Second, "its end logged", func() bool { return r.logs.has("closed by the gateway: CLOSE_CODE_SUPERSEDED") })
}

// ── R7: the backoff after a connection that dies young ─────────────────────────────────────────────────────

// A connection that ends younger than a minute is followed by a wait of up to 8 s at least, even once a reconciled beat
// has started the backoff over; an older one by the backoff alone. The ceiling grows past 8 s with the attempts as
// before.
func TestTheWaitAfterAYoungConnectionHasAnEightSecondCeiling(t *testing.T) {
	ceiling := func(n int, lasted time.Duration) time.Duration {
		var most time.Duration
		for range 3000 {
			most = max(most, linkLostBackoff(n, lasted, linkYoungConn, linkYoungBackoff))
		}
		return most
	}
	for _, c := range []struct {
		n      int
		lasted time.Duration
		low    time.Duration
		high   time.Duration
	}{
		{0, 5 * time.Second, 7 * time.Second, 8*time.Second + time.Millisecond},
		{0, 59 * time.Second, 7 * time.Second, 8*time.Second + time.Millisecond},
		{2, time.Second, 7 * time.Second, 8*time.Second + time.Millisecond},
		{4, time.Second, 14 * time.Second, 16*time.Second + time.Millisecond},
		{9, time.Second, 50 * time.Second, time.Minute + time.Millisecond},
		{0, time.Minute, 0, time.Second + time.Millisecond},
		{0, time.Hour, 0, time.Second + time.Millisecond},
		{3, 2 * time.Minute, 7 * time.Second, 8*time.Second + time.Millisecond},
	} {
		if got := ceiling(c.n, c.lasted); got < c.low || got > c.high {
			t.Errorf("attempt %d after a connection of %s: waits reached %s, want within (%s, %s]", c.n, c.lasted, got, c.low, c.high)
		}
	}
}

// ── R5: pieces ────────────────────────────────────────────────────────────────────────────────────────────

// Every message the runner writes is at most 16 KiB + 64 B, whatever it sends: a 1 MiB EventBatch, a 300 KiB call, a
// heartbeat with every fact whole, and small frames.
func TestEveryMessageIsAtMostSixteenKiB(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	wire := recordWire(r.linkWorkRig)
	r.useLink(t)
	conn := r.m.work.current()
	if _, err := linkBeatCall(r.linkWorkRig, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	for _, f := range []*linkpb.Frame{linkTestBatch("s", 1<<20), linkTestRpc("big", 300<<10), linkTestRpc("small", 10)} {
		if _, err := conn.send(f); err != nil {
			t.Fatal(err)
		}
	}
	linkWaitFor(t, 10*time.Second, "the call at the gateway", func() bool { return len(r.g.rpcsTo("/runner/test")) == 2 })
	largest, pieces := 0, 0
	for _, m := range wire() {
		largest = max(largest, m.size)
		if m.chunkOf != 0 {
			pieces++
		}
	}
	if largest > linkSendPieceBytes+64 {
		t.Fatalf("a %d-byte message, over %d", largest, linkSendPieceBytes+64)
	}
	if pieces < 80 {
		t.Fatalf("%d pieces for 1.3 MiB of frames", pieces)
	}
	t.Logf("%d messages, %d of them pieces, the largest %d bytes", len(wire()), pieces, largest)
}

// ── Step 8: heartbeats and calls between an EventBatch's pieces ─────────────────────────────────────────────

// A heartbeat sent while a 1 MiB EventBatch is going out on a throttled connection is written within two of its pieces:
// the one being written, and one more at most.
func TestAHeartbeatMidwayThroughABatchIsWrittenWithinTwoPieces(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	wire := recordWire(r.linkWorkRig)
	r.useLink(t)
	conn := r.m.work.current()
	r.valve().rate.Store(256 << 10) // a 16 KiB piece every ~60 ms
	batchDone := make(chan error, 1)
	go func() { _, err := conn.send(linkTestBatch("s", 1<<20)); batchDone <- err }()
	piecesSeen := func() int {
		n := 0
		for _, m := range wire() {
			if m.chunkOf != 0 {
				n++
			}
		}
		return n
	}
	linkWaitFor(t, 10*time.Second, "the batch under way", func() bool { return piecesSeen() >= 8 })
	before := piecesSeen()
	if _, err := conn.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: "p", BeatId: 99}}}); err != nil {
		t.Fatal(err)
	}
	if err := <-batchDone; err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	pieces := 0
	for _, m := range wire() {
		if m.kind == "*linkpb.Frame_Heartbeat" && m.id != 0 {
			if between := pieces - before; between > 2 {
				t.Fatalf("the heartbeat went %d pieces after it was sent", between)
			} else {
				t.Logf("the heartbeat went %d piece(s) after it was sent, %d into the batch", between, pieces)
			}
			return
		}
		if m.chunkOf != 0 {
			pieces++
		}
	}
	t.Fatal("no heartbeat on the wire")
}

// A live frame (trySend) never goes between an EventBatch's pieces: it does not go at all while the batch is mid-frame,
// and goes once the batch is through.
func TestTrySendFailsWhileABatchIsMidFrame(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	wire := recordWire(r.linkWorkRig)
	r.useLink(t)
	conn := r.m.work.current()
	r.valve().rate.Store(512 << 10)
	live := &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{SessionId: "s"}}}
	batchDone := make(chan error, 1)
	go func() { _, err := conn.send(linkTestBatch("s", 1<<20)); batchDone <- err }()
	linkWaitFor(t, 10*time.Second, "the batch under way", func() bool { return len(wire()) > 3 })
	tries := 0
	for done := false; !done; {
		select {
		case err := <-batchDone:
			if err != nil {
				t.Fatal(err)
			}
			done = true
		default:
			tries++
			if sent, err := conn.trySend(proto.Clone(live).(*linkpb.Frame)); sent || err != nil {
				t.Fatalf("trySend went (%v, %v) while the batch was mid-frame", sent, err)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if sent, err := conn.trySend(live); !sent || err != nil {
		t.Fatalf("trySend after the batch: %v, %v", sent, err)
	}
	t.Logf("%d tries during the batch", tries)
	linkWaitFor(t, 5*time.Second, "the live frame at the gateway", func() bool {
		msgs := wire()
		return len(msgs) > 0 && msgs[len(msgs)-1].kind == "*linkpb.Frame_LiveBatch"
	})
}

// linkSenders sends from bulk, urgent and live senders at once on conn, each frame of its own random size, and returns
// the frames sent whole by the urgent and bulk senders (ids set).
func linkSenders(t *testing.T, conn *linkWorkConn, rounds int) []*linkpb.Frame {
	t.Helper()
	var mu sync.Mutex
	var sent []*linkpb.Frame
	var wg sync.WaitGroup
	keep := func(f *linkpb.Frame) {
		mu.Lock()
		sent = append(sent, proto.Clone(f).(*linkpb.Frame))
		mu.Unlock()
	}
	for g := range 3 {
		wg.Add(3)
		go func() { // bulk
			defer wg.Done()
			for i := range rounds {
				f := linkTestBatch(fmt.Sprintf("s%d-%d", g, i), rand.IntN(300<<10))
				if _, err := conn.send(f); err != nil {
					t.Error(err)
					return
				}
				keep(f)
			}
		}()
		go func() { // urgent: heartbeats and calls, some large
			defer wg.Done()
			for i := range rounds * 2 {
				var f *linkpb.Frame
				if i%2 == 0 {
					f = &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: fmt.Sprintf("p%d", g), BeatId: uint64(i + 1),
						Facts: []*linkpb.Fact{{Kind: "k", Json: bytes.Repeat([]byte("f"), rand.IntN(40<<10))}}}}}
				} else {
					f = linkTestRpc(fmt.Sprintf("r%d-%d", g, i), rand.IntN(200<<10))
				}
				if _, err := conn.send(f); err != nil {
					t.Error(err)
					return
				}
				keep(f)
			}
		}()
		go func() { // live
			defer wg.Done()
			for i := range rounds * 20 {
				f := &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{SessionId: fmt.Sprintf("l%d-%d", g, i)}}}
				if ok, err := conn.trySend(f); err != nil {
					t.Error(err)
					return
				} else if ok {
					keep(f)
				}
				time.Sleep(time.Millisecond)
			}
		}()
	}
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(2 * time.Minute):
		t.Fatal("the senders did not finish: deadlocked")
	}
	return sent
}

// Bulk, urgent and live senders at once: none deadlocks, every message's id is larger than the last one's (a frame cut
// into pieces takes an id of its own, which only its pieces name), at most two frames are in pieces at once, and every
// frame comes out whole at the gateway.
func TestConcurrentBulkUrgentAndLiveSendersNeitherDeadlockNorMisnumber(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	wire := recordWire(r.linkWorkRig)
	r.useLink(t)
	conn := r.m.work.current()
	r.valve().rate.Store(8 << 20)
	sent := linkSenders(t, conn, 6)
	linkWaitFor(t, 20*time.Second, "every frame at the gateway", func() bool {
		whole := 0
		for _, m := range wire() {
			if m.chunkOf == 0 || m.last {
				whole++
			}
		}
		return whole >= len(sent)+1 // and Hello
	})
	msgs := wire()
	open := map[uint64]bool{}
	most := 0
	for i, m := range msgs {
		if i > 0 && m.id <= msgs[i-1].id {
			t.Fatalf("message %d has id %d after %d", i, m.id, msgs[i-1].id)
		}
		if m.chunkOf != 0 {
			open[m.chunkOf] = !m.last
			if m.last {
				delete(open, m.chunkOf)
			}
			most = max(most, len(open))
		}
	}
	if most > 2 {
		t.Fatalf("%d frames in pieces at once", most)
	}
	if conn.ended() {
		t.Fatalf("the connection ended: %s", r.logs.String())
	}
	t.Logf("%d frames in %d messages, at most %d in pieces at once", len(sent), len(msgs), most)
}

// A large urgent frame cut into pieces in the middle of a batch's: the gateway's own reassembler
// (src/link-gateway/chunk.go as it is in this checkout) joins both, and every frame the senders sent comes out of it.
func TestAnUrgentFrameAndABatchReassembleOnTheGatewaysReassembler(t *testing.T) {
	r := newSlowPathRig(t, time.Minute)
	wire := recordWire(r.linkWorkRig)
	r.useLink(t)
	conn := r.m.work.current()
	r.valve().rate.Store(1 << 20)
	batchDone := make(chan error, 1)
	batch := linkTestBatch("s", 1<<20)
	go func() { _, err := conn.send(batch); batchDone <- err }()
	linkWaitFor(t, 10*time.Second, "the batch under way", func() bool { return len(wire()) > 4 })
	urgent := linkTestRpc("urgent", 200<<10)
	if _, err := conn.send(urgent); err != nil {
		t.Fatal(err)
	}
	if err := <-batchDone; err != nil {
		t.Fatal(err)
	}
	sent := []*linkpb.Frame{batch, urgent}
	sent = append(sent, linkSenders(t, conn, 2)...)
	linkWaitFor(t, 20*time.Second, "every frame at the gateway", func() bool {
		whole := 0
		for _, m := range wire() {
			if m.chunkOf == 0 || m.last {
				whole++
			}
		}
		return whole >= len(sent)+1
	})
	var raw [][]byte
	interleaved := false
	open := map[uint64]bool{}
	for _, m := range wire() {
		raw = append(raw, m.raw)
		if m.chunkOf != 0 {
			open[m.chunkOf] = true
			if m.last {
				delete(open, m.chunkOf)
			}
			if len(open) == 2 {
				interleaved = true
			}
		}
	}
	if !interleaved {
		t.Fatal("no urgent frame went in pieces between a batch's")
	}
	got := gatewayReassembles(t, raw)
	want := map[string]int{}
	for _, f := range sent {
		want[linkFrameDigest(f)]++
	}
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if strings.HasPrefix(line, "open ") {
			if line != "open 2" {
				t.Fatalf("the gateway's reassembler held %s frames in pieces at once, want 2", line)
			}
			continue
		}
		if want[line] > 0 {
			want[line]--
			if want[line] == 0 {
				delete(want, line)
			}
		}
	}
	if len(want) != 0 {
		t.Fatalf("%d frames sent did not come out of the gateway's reassembler", len(want))
	}
}

// linkFrameDigest identifies a frame by its deterministic encoding.
func linkFrameDigest(f *linkpb.Frame) string {
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(f)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("frame %d  %d %x", f.GetId(), len(b), linkSum(b))
}

func linkSum(b []byte) uint64 {
	var h uint64 = 1469598103934665603
	for _, c := range b {
		h = (h ^ uint64(c)) * 1099511628211
	}
	return h
}

// gatewayJoin is the main of a program built from the gateway's reassembler: it joins the messages in the file it is
// given, prints a digest of each frame as linkFrameDigest does, and then how many frames were open at once at most.
const gatewayJoin = `package main

import (
	"encoding/binary"
	"fmt"
	"os"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

func sum(b []byte) uint64 {
	var h uint64 = 1469598103934665603
	for _, c := range b {
		h = (h ^ uint64(c)) * 1099511628211
	}
	return h
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var r reassembler
	open := 0
	for len(data) > 0 {
		n := binary.BigEndian.Uint32(data)
		m := data[4 : 4+n]
		data = data[4+n:]
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(m, f); err != nil {
			panic(err)
		}
		if c := f.GetChunk(); c != nil {
			j, err := r.add(c)
			if err != nil {
				fmt.Println("error", err)
				os.Exit(1)
			}
			open = max(open, len(r.partials))
			if j == nil {
				continue
			}
			f = j
		}
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(f)
		if err != nil {
			panic(err)
		}
		fmt.Printf("frame %d  %d %x\n", f.GetId(), len(b), sum(b))
	}
	fmt.Printf("open %d\n", open)
}
`

// gatewayReassembles feeds msgs to the gateway's reassembler, built from the gateway module's source in this checkout
// into a module of its own (the gateway is package main, which nothing imports), and returns what it printed.
func gatewayReassembles(t *testing.T, msgs [][]byte) string {
	t.Helper()
	gateway := filepath.Join("..", "link-gateway")
	if _, err := os.Stat(filepath.Join(gateway, "chunk.go")); err != nil {
		t.Skipf("no gateway source beside the runner: %v", err)
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command")
	}
	dir := t.TempDir()
	copyFile := func(from, to string) {
		b, err := os.ReadFile(from)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(to, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	copyFile(filepath.Join(gateway, "chunk.go"), filepath.Join(dir, "chunk.go"))
	copyFile(filepath.Join(gateway, "linkpb", "runner_link.pb.go"), filepath.Join(dir, "linkpb", "runner_link.pb.go"))
	copyFile("go.sum", filepath.Join(dir, "go.sum"))
	protobuf := ""
	mod, _ := os.ReadFile("go.mod")
	for _, line := range strings.Split(string(mod), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "google.golang.org/protobuf" {
			protobuf = f[1]
		}
	}
	files := map[string]string{
		"go.mod":  "module orbit/link-gateway\n\ngo 1.26.0\n\nrequire google.golang.org/protobuf " + protobuf + "\n",
		"main.go": gatewayJoin,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var in bytes.Buffer
	for _, m := range msgs {
		_ = binary.Write(&in, binary.BigEndian, uint32(len(m)))
		in.Write(m)
	}
	capture := filepath.Join(dir, "messages.bin")
	if err := os.WriteFile(capture, in.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(goBin, "run", ".", capture)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("the gateway's reassembler: %v\n%s", err, out)
	}
	return string(out)
}
