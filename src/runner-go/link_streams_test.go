package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// Byte streams on the runner's side (link_streams.go): a fake gateway (link_work_harness_test.go) opens them, and a
// Unix socket listener stands in for x11vnc on the browser's VNC socket.

const (
	streamOne   = "0190a0b0-0000-7000-8000-0000000000e1"
	streamTwo   = "0190a0b0-0000-7000-8000-0000000000e2"
	streamThree = "0190a0b0-0000-7000-8000-0000000000e3"
)

// asManagedRunner gives the process the managed entrypoint's instance identity for the test.
func asManagedRunner(t *testing.T) {
	t.Helper()
	t.Setenv(envManagedRunnerGeneration, "7")
	t.Setenv(envManagedRunnerPodUID, "0190a0b0-0000-7000-8000-0000000000f7")
	resetManagedInstanceCache(t)
}

// noBrowserViewer is a viewer that starts no browser: the stand-in below is already listening. The default,
// linkStreamViewer, starts this process's browser supervisor when there is one, which execs Xvfb, x11vnc and Chromium.
func noBrowserViewer() (func(), error) { return func() {}, nil }

// vncStandIn is a listener on a Unix socket, standing in for x11vnc.
type vncStandIn struct {
	path  string
	ln    net.Listener
	conns chan net.Conn
}

func listenVNC(t *testing.T) *vncStandIn {
	t.Helper()
	// A short directory: a Unix socket's path is limited to about a hundred bytes.
	dir, err := os.MkdirTemp("", "vnc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	v, err := listenVNCAt(t, filepath.Join(dir, "vnc.sock"))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// listenVNCAt listens on path; it may be called off the test's goroutine.
func listenVNCAt(t *testing.T, path string) (*vncStandIn, error) {
	v := &vncStandIn{path: path, conns: make(chan net.Conn, 8)}
	var err error
	if v.ln, err = net.Listen("unix", v.path); err != nil {
		return nil, err
	}
	t.Cleanup(func() { _ = v.ln.Close() })
	go func() {
		for {
			c, err := v.ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() })
			v.conns <- c
		}
	}()
	return v, nil
}

func (v *vncStandIn) accepted(t *testing.T) net.Conn {
	t.Helper()
	select {
	case c := <-v.conns:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("the runner did not connect to the VNC socket")
		return nil
	}
}

// streamRig is a link rig whose gateway offers the browser and records the stream frames the runner sends.
type linkStreamRig struct {
	*linkWorkRig
	conn   *fakeWorkConn
	frames chan *linkpb.Frame
}

func newLinkStreamRig(t *testing.T, browser bool, socket string) *linkStreamRig {
	t.Helper()
	r := &linkStreamRig{linkWorkRig: newLinkWorkRig(t), frames: make(chan *linkpb.Frame, 1024)}
	r.g.welcome = func(_ *fakeWorkConn, w *linkpb.Welcome) { w.Browser = browser }
	r.g.onStream = func(_ *fakeWorkConn, f *linkpb.Frame) { r.frames <- f }
	r.m.work.streams.socket = func() string { return socket }
	r.m.work.streams.viewer = noBrowserViewer
	r.conn = r.useLink(t)
	return r
}

func (r *linkStreamRig) open(id string, kind linkpb.StreamKind) {
	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamOpen{StreamOpen: &linkpb.StreamOpen{StreamId: id, Kind: kind}}})
}

// next is the next stream frame the runner sent.
func (r *linkStreamRig) next(t *testing.T) *linkpb.Frame {
	t.Helper()
	select {
	case f := <-r.frames:
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no stream frame from the runner")
		return nil
	}
}

// quiet checks the runner sends no stream frame for d.
func (r *linkStreamRig) quiet(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case f := <-r.frames:
		t.Fatalf("an unexpected frame: %v", f)
	case <-time.After(d):
	}
}

func (r *linkStreamRig) closed(t *testing.T, id string) linkpb.StreamCloseCode {
	t.Helper()
	f := r.next(t).GetStreamClose()
	if f == nil || f.GetStreamId() != id {
		t.Fatalf("got %v, want the StreamClose of %s", f, id)
	}
	return f.GetCode()
}

// A managed runner declares link-stream-v1 in its Hello; a self-managed one does not.
func TestOnlyAManagedRunnerDeclaresStreams(t *testing.T) {
	r := newLinkWorkRig(t)
	if c := r.useLink(t); slices.Contains(c.hello.GetCapabilities(), linkStreamCapability) {
		t.Fatal("a self-managed runner declared streams")
	}
	asManagedRunner(t)
	m := newLinkWorkRig(t)
	if c := m.useLink(t); !slices.Contains(c.hello.GetCapabilities(), linkStreamCapability) {
		t.Fatal("a managed runner did not declare streams")
	}
}

// A stream bridges the VNC socket both ways: the socket's bytes go out as StreamData, the gateway's are written to the
// socket and credited back, and either side's close ends the other.
func TestALinkStreamBridgesTheVNCSocketBothWays(t *testing.T) {
	asManagedRunner(t)
	vnc := listenVNC(t)
	r := newLinkStreamRig(t, true, vnc.path)

	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	sock := vnc.accepted(t)
	if f := r.next(t).GetStreamOpened(); f.GetStreamId() != streamOne {
		t.Fatalf("got %v, want StreamOpened", f)
	}
	if _, err := sock.Write([]byte("RFB 003.008\n")); err != nil {
		t.Fatal(err)
	}
	if d := r.next(t).GetStreamData(); string(d.GetData()) != "RFB 003.008\n" || d.GetStreamId() != streamOne {
		t.Fatalf("StreamData %v", d)
	}
	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{StreamId: streamOne, Data: []byte("RFB 003.008\n")}}})
	got := make([]byte, 12)
	_ = sock.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(sock, got); err != nil || string(got) != "RFB 003.008\n" {
		t.Fatalf("the socket read %q, %v", got, err)
	}
	if c := r.next(t).GetStreamCredit(); c.GetBytes() != 12 || c.GetStreamId() != streamOne {
		t.Fatalf("StreamCredit %v", c)
	}

	// The gateway closes it: the socket is closed, and nothing is said back.
	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{StreamId: streamOne, Code: linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL}}})
	if _, err := sock.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("the socket after the gateway's close: %v", err)
	}
	r.quiet(t, 200*time.Millisecond)
	linkWaitFor(t, 5*time.Second, "the stream to be let go", func() bool { return r.m.work.streams.count() == 0 })

	// The VNC server closes it: the gateway is told NORMAL.
	r.open(streamTwo, linkpb.StreamKind_STREAM_KIND_VNC)
	sock = vnc.accepted(t)
	r.next(t)
	_ = sock.Close()
	if code := r.closed(t, streamTwo); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL {
		t.Fatalf("closed %v", code)
	}

	// The connection ends: the socket is closed.
	r.open(streamThree, linkpb.StreamKind_STREAM_KIND_VNC)
	sock = vnc.accepted(t)
	r.next(t)
	r.conn.drop()
	_ = sock.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := sock.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("the socket after the connection ended: %v", err)
	}
}

// The runner sends no more than the window before the gateway credits it, and goes on as far as each credit allows.
func TestALinkStreamSendsNoFurtherThanItsCredit(t *testing.T) {
	asManagedRunner(t)
	vnc := listenVNC(t)
	r := newLinkStreamRig(t, true, vnc.path)
	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	sock := vnc.accepted(t)
	r.next(t)
	go func() { _, _ = sock.Write(make([]byte, 1<<20)) }()

	sent := 0
	for sent < linkStreamWindow {
		d := r.next(t).GetStreamData()
		if len(d.GetData()) > linkStreamMaxData {
			t.Fatalf("a StreamData of %d bytes", len(d.GetData()))
		}
		sent += len(d.GetData())
	}
	if sent != linkStreamWindow {
		t.Fatalf("sent %d bytes on a window of %d", sent, linkStreamWindow)
	}
	r.quiet(t, 300*time.Millisecond)
	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{StreamId: streamOne, Bytes: 64 << 10}}})
	more := 0
	for more < 64<<10 {
		more += len(r.next(t).GetStreamData().GetData())
	}
	if more != 64<<10 {
		t.Fatalf("sent %d bytes on a credit of %d", more, 64<<10)
	}
	r.quiet(t, 300*time.Millisecond)
}

// A gateway that sends past the window has the stream closed FLOW_VIOLATION.
func TestALinkStreamPastItsWindowIsClosed(t *testing.T) {
	asManagedRunner(t)
	vnc := listenVNC(t)
	r := newLinkStreamRig(t, true, vnc.path)
	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	vnc.accepted(t) // never read: what the gateway sends waits in the runner's queue
	r.next(t)
	big := bytes.Repeat([]byte{1}, linkStreamMaxData)
	for i := 0; i <= 4*linkStreamWindow/linkStreamMaxData; i++ {
		r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{StreamId: streamOne, Data: big}}})
	}
	for {
		f := r.next(t)
		if c := f.GetStreamClose(); c != nil {
			if c.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION {
				t.Fatalf("closed %v", c)
			}
			return
		}
	}
}

// A StreamOpen is refused unless the runner is managed, the Welcome offered the browser and the kind is VNC; a third
// stream is refused TOO_MANY_STREAMS, and a socket nobody listens on UNAVAILABLE.
func TestALinkStreamIsOpenedOnlyWhenEverythingAllowsIt(t *testing.T) {
	vnc := listenVNC(t)
	t.Run("self-managed", func(t *testing.T) {
		r := newLinkStreamRig(t, true, vnc.path)
		r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
		if code := r.closed(t, streamOne); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
			t.Fatalf("closed %v", code)
		}
	})
	t.Run("browser not offered", func(t *testing.T) {
		asManagedRunner(t)
		r := newLinkStreamRig(t, false, vnc.path)
		r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
		if code := r.closed(t, streamOne); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
			t.Fatalf("closed %v", code)
		}
	})
	t.Run("unknown kind", func(t *testing.T) {
		asManagedRunner(t)
		r := newLinkStreamRig(t, true, vnc.path)
		r.open(streamOne, linkpb.StreamKind_STREAM_KIND_UNSPECIFIED)
		if code := r.closed(t, streamOne); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
			t.Fatalf("closed %v", code)
		}
	})
	t.Run("third stream", func(t *testing.T) {
		asManagedRunner(t)
		r := newLinkStreamRig(t, true, vnc.path)
		r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
		r.next(t)
		r.open(streamTwo, linkpb.StreamKind_STREAM_KIND_VNC)
		r.next(t)
		r.open(streamThree, linkpb.StreamKind_STREAM_KIND_VNC)
		if code := r.closed(t, streamThree); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_TOO_MANY_STREAMS {
			t.Fatalf("closed %v", code)
		}
	})
	t.Run("no VNC server", func(t *testing.T) {
		asManagedRunner(t)
		r := newLinkStreamRig(t, true, filepath.Join(filepath.Dir(vnc.path), "absent.sock"))
		r.m.work.streams.dialWait = 300 * time.Millisecond
		r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
		if code := r.closed(t, streamOne); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_UNAVAILABLE {
			t.Fatalf("closed %v", code)
		}
	})
}

// The runner's own check (docs/runner-browser-design.md §2): a process the managed image's entrypoint did not start has
// no ORBIT_MANAGED_RUNNER_GENERATION, and refuses every StreamOpen even when the Welcome offered the browser, so that a
// gateway that relays one anyway, or a self-managed runner offered it by mistake, still never reaches the VNC socket.
// The same for an identity the entrypoint did not finish: the Pod UID alone, or an empty generation.
func TestALinkStreamIsRefusedWithoutTheManagedEntrypointsGeneration(t *testing.T) {
	vnc := listenVNC(t)
	for _, c := range []struct {
		name string
		env  func(t *testing.T)
	}{
		{"no managed identity", func(t *testing.T) {}},
		{"the Pod UID alone", func(t *testing.T) {
			t.Setenv(envManagedRunnerPodUID, "0190a0b0-0000-7000-8000-0000000000f7")
		}},
		{"an empty generation", func(t *testing.T) {
			t.Setenv(envManagedRunnerGeneration, "")
			t.Setenv(envManagedRunnerPodUID, "0190a0b0-0000-7000-8000-0000000000f7")
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			withoutManagedInstance(t)
			c.env(t)
			resetManagedInstanceCache(t)
			r := newLinkStreamRig(t, true, vnc.path)
			if !r.m.work.browserOffered() {
				t.Fatal("the Welcome did not offer the browser")
			}
			r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
			if code := r.closed(t, streamOne); code != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED {
				t.Fatalf("closed %v", code)
			}
			if n := r.m.work.streams.count(); n != 0 {
				t.Fatalf("%d streams open", n)
			}
			select {
			case conn := <-vnc.conns:
				conn.Close()
				t.Fatal("the VNC socket was dialed")
			case <-time.After(200 * time.Millisecond):
			}
		})
	}
}

// A viewer's stream starts the browser when it is not running, counts as an open viewer until it ends, and waits for
// the VNC socket the browser makes a moment after it starts. A browser that cannot start is answered UNAVAILABLE, with
// the reason.
func TestALinkStreamStartsTheBrowserForItsViewer(t *testing.T) {
	asManagedRunner(t)
	// A short directory: a Unix socket's path is limited to about a hundred bytes.
	dir, err := os.MkdirTemp("", "vnc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "vnc.sock")
	r := newLinkStreamRig(t, true, path)
	var mu sync.Mutex
	started, open := 0, 0
	var vnc *vncStandIn
	r.m.work.streams.viewer = func() (func(), error) {
		mu.Lock()
		defer mu.Unlock()
		started++
		open++
		// The socket appears only after the browser was asked to start, a little later.
		time.AfterFunc(300*time.Millisecond, func() {
			mu.Lock()
			defer mu.Unlock()
			var err error
			if vnc, err = listenVNCAt(t, path); err != nil {
				t.Error(err)
			}
		})
		return func() {
			mu.Lock()
			defer mu.Unlock()
			open--
		}, nil
	}

	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	if f := r.next(t).GetStreamOpened(); f.GetStreamId() != streamOne {
		t.Fatalf("got %v, want StreamOpened", f)
	}
	mu.Lock()
	if started != 1 || open != 1 {
		t.Fatalf("browser asked to start %d times, %d viewers open; want 1 and 1", started, open)
	}
	got := vnc
	mu.Unlock()
	sock := got.accepted(t)

	r.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{StreamId: streamOne, Code: linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL}}})
	_ = sock.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := sock.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("the socket after the gateway's close: %v", err)
	}
	linkWaitFor(t, 5*time.Second, "the viewer to be counted out", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return open == 0
	})

	r.m.work.streams.viewer = func() (func(), error) {
		return nil, errors.New("The browser could not start: chromium: not found")
	}
	r.open(streamTwo, linkpb.StreamKind_STREAM_KIND_VNC)
	f := r.next(t).GetStreamClose()
	if f.GetStreamId() != streamTwo || f.GetCode() != linkpb.StreamCloseCode_STREAM_CLOSE_CODE_UNAVAILABLE ||
		f.GetMessage() != "The browser could not start: chromium: not found" {
		t.Fatalf("got %v, want UNAVAILABLE with the reason", f)
	}
}

// A stream at full credit both ways does not hold up the runner's heartbeats: the VNC server writes without pause and
// the gateway credits each StreamData at once, while the gateway sends as much as the window allows and the runner
// credits each write to the socket; every heartbeat still has its answer within a second (docs/runner-link-design.md
// §9's bound on an acknowledgement).
func TestASaturatedLinkStreamDoesNotHoldUpHeartbeats(t *testing.T) {
	asManagedRunner(t)
	vnc := listenVNC(t)
	r := &linkStreamRig{linkWorkRig: newLinkWorkRig(t), frames: make(chan *linkpb.Frame, 1024)}
	r.g.welcome = func(_ *fakeWorkConn, w *linkpb.Welcome) { w.Browser = true }
	r.m.work.streams.socket = func() string { return vnc.path }
	r.m.work.streams.viewer = noBrowserViewer
	var upBytes, downBytes atomic.Int64
	downRoom := make(chan int, 4096)
	opened := make(chan struct{})
	var measured atomic.Bool // set once the measurement is over: the teardown closes the socket, and the stream with it
	r.g.onStream = func(c *fakeWorkConn, f *linkpb.Frame) {
		switch {
		case f.GetStreamOpened() != nil:
			close(opened)
		case f.GetStreamData() != nil:
			upBytes.Add(int64(len(f.GetStreamData().GetData())))
			go c.send(&linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{
				StreamId: streamOne, Bytes: uint32(len(f.GetStreamData().GetData())),
			}}})
		case f.GetStreamCredit() != nil:
			downRoom <- int(f.GetStreamCredit().GetBytes())
		case f.GetStreamClose() != nil && !measured.Load():
			t.Errorf("the stream closed: %v", f.GetStreamClose())
		}
	}
	r.conn = r.useLink(t)
	r.open(streamOne, linkpb.StreamKind_STREAM_KIND_VNC)
	sock := vnc.accepted(t)
	<-opened

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { // the VNC server: writes without pause
		defer wg.Done()
		chunk := make([]byte, 64<<10)
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = sock.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
			_, _ = sock.Write(chunk)
		}
	}()
	go func() { // the VNC server: reads what the viewer sends
		defer wg.Done()
		buf := make([]byte, 64<<10)
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			n, _ := sock.Read(buf)
			downBytes.Add(int64(n))
		}
	}()
	go func() { // the gateway: sends the viewer's bytes as far as the window allows
		defer wg.Done()
		room := linkStreamWindow
		piece := &linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{StreamId: streamOne, Data: make([]byte, linkStreamMaxData)}}}
		for {
			for room >= linkStreamMaxData {
				r.conn.send(proto.Clone(piece).(*linkpb.Frame))
				room -= linkStreamMaxData
			}
			select {
			case n := <-downRoom:
				room += n
			case <-stop:
				return
			}
		}
	}()

	time.Sleep(200 * time.Millisecond)
	var worst time.Duration
	for i := 0; i < 20; i++ {
		start := time.Now()
		if _, err := linkBeatCall(r.linkWorkRig, 5*time.Second); err != nil {
			t.Fatalf("beat %d: %v", i, err)
		}
		worst = max(worst, time.Since(start))
		time.Sleep(50 * time.Millisecond)
	}
	measured.Store(true)
	close(stop)
	wg.Wait()
	t.Logf("saturated: %.1f MiB up and %.1f MiB down; the slowest of 20 heartbeats took %s", float64(upBytes.Load())/(1<<20), float64(downBytes.Load())/(1<<20), worst)
	if upBytes.Load() < 10*linkStreamWindow || downBytes.Load() < 10*linkStreamWindow {
		t.Fatalf("the stream was not saturated: %d bytes up, %d down", upBytes.Load(), downBytes.Load())
	}
	if worst > time.Second {
		t.Fatalf("a heartbeat took %s under a saturated stream", worst)
	}
}
