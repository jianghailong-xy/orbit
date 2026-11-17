package main

import (
	"fmt"
	"net"
	"path/filepath"
	"sync"
	"time"

	"orbit/linkpb"
)

// Byte streams over the runner link (docs/runner-browser-design.md §4; contracts/runner-link/v1, StreamOpen): the
// gateway relays a viewer's StreamOpen, and the runner bridges the stream's bytes to the managed runner browser's VNC
// server, x11vnc on $ORBIT_HOME/browser/vnc.sock.
//
// The runner declares link-stream-v1 in Hello only as a managed runner (the managed entrypoint's
// ORBIT_MANAGED_RUNNER_* identity), and opens a stream only while that holds, the connection's Welcome offered the
// browser (Welcome.browser) and the kind is VNC. Each direction has a window of linkStreamWindow bytes: the runner
// sends the socket's bytes only as far as the gateway's StreamCredit allows, and credits back what it has written to
// the socket. Its StreamData go out only when nothing else is being written on the connection (trySend), at most
// linkStreamMaxData at a time, so a heartbeat or a call never waits behind more than one of them. What the gateway
// sends is queued for the socket's own writer, so the connection's reading goroutine never waits on the socket.

const (
	linkStreamCapability = "link-stream-v1"
	linkStreamWindow     = 256 << 10
	linkStreamMaxData    = 32 << 10
	linkStreamMax        = 2
	linkStreamDialWait   = 5 * time.Second
	// linkStreamRetry is how long the sender waits before it tries again a connection busy with another frame.
	linkStreamRetry = time.Millisecond
)

// linkStreamsDeclared says whether this process speaks byte streams: only a managed runner does.
func linkStreamsDeclared() bool { return currentManagedInstance() != nil }

// linkVNCSocket is where the browser's VNC server listens.
func linkVNCSocket() string { return filepath.Join(machineHome(), "browser", "vnc.sock") }

// linkStreams is the open streams of one link.
type linkStreams struct {
	w *linkWork
	// declared, offered and socket are what a stream needs, as functions so tests can set them.
	declared func() bool
	offered  func() bool
	socket   func() string

	mu   sync.Mutex
	open map[string]*linkStream
}

func newLinkStreams(w *linkWork) *linkStreams {
	return &linkStreams{w: w, declared: linkStreamsDeclared, offered: w.browserOffered, socket: linkVNCSocket,
		open: map[string]*linkStream{}}
}

// linkStream is one open stream: its connection, its socket, and the room each direction has.
type linkStream struct {
	s    *linkStreams
	id   string
	conn *linkWorkConn
	sock net.Conn

	mu sync.Mutex
	// upRoom is how many bytes the runner may still send; queued, the gateway's bytes waiting for the socket, which
	// never pass the window.
	upRoom int
	queued [][]byte
	qBytes int
	ended  bool
	// roomed is signalled when the gateway credits room, queuedMore when bytes for the socket arrive.
	roomed, queuedMore chan struct{}
	done               chan struct{} // closed when the stream ends
}

// onFrame takes a stream frame on the connection's reading goroutine: nothing here waits.
func (s *linkStreams) onFrame(conn *linkWorkConn, f *linkpb.Frame) {
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_StreamOpen:
		s.onOpen(conn, body.StreamOpen)
	case *linkpb.Frame_StreamData:
		if st := s.get(conn, body.StreamData.GetStreamId()); st != nil {
			st.fromGateway(body.StreamData.GetData())
		}
	case *linkpb.Frame_StreamCredit:
		if st := s.get(conn, body.StreamCredit.GetStreamId()); st != nil {
			st.credit(int(body.StreamCredit.GetBytes()))
		}
	case *linkpb.Frame_StreamClose:
		if st := s.get(conn, body.StreamClose.GetStreamId()); st != nil {
			st.end(0, "", false)
		}
	}
}

func (s *linkStreams) get(conn *linkWorkConn, id string) *linkStream {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.open[id]; st != nil && st.conn == conn {
		return st
	}
	return nil
}

// count is how many streams are open, for the tests.
func (s *linkStreams) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.open)
}

// refuse answers a StreamOpen with a StreamClose, off the reading goroutine.
func refuseLinkStream(conn *linkWorkConn, id string, code linkpb.StreamCloseCode, message string) {
	go func() {
		_, _ = conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{
			StreamId: id, Code: code, Message: message,
		}}})
	}()
}

func (s *linkStreams) onOpen(conn *linkWorkConn, open *linkpb.StreamOpen) {
	id := open.GetStreamId()
	switch {
	case id == "":
		return
	case !s.declared():
		refuseLinkStream(conn, id, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "this runner does not declare "+linkStreamCapability)
		return
	case !s.offered():
		refuseLinkStream(conn, id, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "the managed runner browser is not offered to this runner")
		return
	case open.GetKind() != linkpb.StreamKind_STREAM_KIND_VNC:
		refuseLinkStream(conn, id, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "unknown stream kind")
		return
	}
	st := &linkStream{s: s, id: id, conn: conn, upRoom: linkStreamWindow,
		roomed: make(chan struct{}, 1), queuedMore: make(chan struct{}, 1), done: make(chan struct{})}
	s.mu.Lock()
	switch {
	case s.open[id] != nil:
		s.mu.Unlock()
		refuseLinkStream(conn, id, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "the stream id is already in use")
		return
	case len(s.open) >= linkStreamMax:
		s.mu.Unlock()
		refuseLinkStream(conn, id, linkpb.StreamCloseCode_STREAM_CLOSE_CODE_TOO_MANY_STREAMS,
			fmt.Sprintf("this runner already has %d open streams", linkStreamMax))
		return
	}
	s.open[id] = st
	s.mu.Unlock()
	go st.run()
}

// run dials the socket, says the stream is open, and bridges it until it ends.
func (st *linkStream) run() {
	sock, err := net.DialTimeout("unix", st.s.socket(), linkStreamDialWait)
	if err != nil {
		st.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_UNAVAILABLE, "the browser's VNC socket does not answer", true)
		return
	}
	st.mu.Lock()
	if st.ended {
		st.mu.Unlock()
		_ = sock.Close()
		return
	}
	st.sock = sock
	st.mu.Unlock()
	if _, err := st.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamOpened{StreamOpened: &linkpb.StreamOpened{StreamId: st.id}}}); err != nil {
		st.end(0, "", false)
		return
	}
	go st.writeSocket()
	go func() {
		select {
		case <-st.conn.done:
			st.end(0, "", false) // the connection is gone, and the gateway has ended the stream with it
		case <-st.done:
		}
	}()
	st.readSocket()
}

// readSocket sends the socket's bytes as far as the window allows.
func (st *linkStream) readSocket() {
	buf := make([]byte, linkStreamMaxData)
	for {
		st.mu.Lock()
		room := st.upRoom
		st.mu.Unlock()
		if room == 0 {
			select {
			case <-st.roomed:
				continue
			case <-st.done:
				return
			}
		}
		n, err := st.sock.Read(buf[:min(room, len(buf))])
		if n > 0 {
			st.mu.Lock()
			st.upRoom -= n
			st.mu.Unlock()
			if !st.sendLow(&linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{
				StreamId: st.id, Data: append([]byte(nil), buf[:n]...),
			}}}) {
				st.end(0, "", false)
				return
			}
		}
		if err != nil {
			st.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL, "the browser's VNC server closed the connection", true)
			return
		}
	}
}

// sendLow writes f only when nothing else is being written on the connection: stream data is the lowest tier. It
// reports whether f went; false once the connection or the stream has ended.
func (st *linkStream) sendLow(f *linkpb.Frame) bool {
	for {
		sent, err := st.conn.trySend(f)
		if err != nil {
			return false
		}
		if sent {
			return true
		}
		select {
		case <-st.done:
			return false
		case <-st.conn.done:
			return false
		case <-time.After(linkStreamRetry):
		}
	}
}

// writeSocket writes the gateway's bytes to the socket in order, and credits each write back.
func (st *linkStream) writeSocket() {
	for {
		st.mu.Lock()
		var next []byte
		if len(st.queued) > 0 {
			next = st.queued[0]
			st.queued[0] = nil
			st.queued = st.queued[1:]
		}
		st.mu.Unlock()
		if next == nil {
			select {
			case <-st.queuedMore:
				continue
			case <-st.done:
				return
			}
		}
		if _, err := st.sock.Write(next); err != nil {
			st.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL, "the browser's VNC server closed the connection", true)
			return
		}
		st.mu.Lock()
		st.qBytes -= len(next)
		st.mu.Unlock()
		if _, err := st.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{
			StreamId: st.id, Bytes: uint32(len(next)),
		}}}); err != nil {
			st.end(0, "", false)
			return
		}
	}
}

// fromGateway queues the viewer's bytes for the socket; past the window the stream is closed.
func (st *linkStream) fromGateway(data []byte) {
	if len(data) == 0 {
		return
	}
	st.mu.Lock()
	if st.ended {
		st.mu.Unlock()
		return
	}
	if st.qBytes+len(data) > linkStreamWindow {
		st.mu.Unlock()
		st.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION, "the gateway sent past the stream's window", true)
		return
	}
	st.queued = append(st.queued, data)
	st.qBytes += len(data)
	st.mu.Unlock()
	signalLinkStream(st.queuedMore)
}

// credit takes the gateway's StreamCredit.
func (st *linkStream) credit(n int) {
	st.mu.Lock()
	st.upRoom = min(st.upRoom+n, linkStreamWindow)
	st.mu.Unlock()
	signalLinkStream(st.roomed)
}

func signalLinkStream(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// end closes the stream once: the socket is closed, and the gateway is told why when tell says so (it is not when it
// closed the stream itself, or the connection is gone).
func (st *linkStream) end(code linkpb.StreamCloseCode, message string, tell bool) {
	st.mu.Lock()
	if st.ended {
		st.mu.Unlock()
		return
	}
	st.ended = true
	sock := st.sock
	st.queued, st.qBytes = nil, 0
	close(st.done)
	st.mu.Unlock()
	st.s.mu.Lock()
	if st.s.open[st.id] == st {
		delete(st.s.open, st.id)
	}
	st.s.mu.Unlock()
	if sock != nil {
		_ = sock.Close()
	}
	if tell {
		go func() {
			_, _ = st.conn.send(&linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{
				StreamId: st.id, Code: code, Message: message,
			}}})
		}()
	}
}
