package main

import (
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Byte streams (docs/runner-browser-design.md §4; contracts/runner-link/v1, StreamOpen). The apiserver asks for one
// over NATS: a request on the runner's subject, rnr.<runnerId>, carrying a Frame with only stream_open set. The gateway
// that holds a connection of the runner whose Hello declared link-stream-v1, and that the welcome route found to be a
// verified managed runner offered the browser (streamable), relays it to that connection and answers
// the request with the runner's StreamOpened or StreamClose. From then on it relays the stream's bytes: what the
// apiserver publishes on vnc.<streamId>.down goes to the runner as StreamData and StreamCredit frames, and what the
// runner sends goes out on vnc.<streamId>.up, each NATS message one binary-encoded Frame.
//
// The gateway keeps each direction's window (streamWindow) and closes a stream whose peer sends past it, so that
// neither side can make it hold more than a window per stream. StreamData is written on the lowest tier (tierStream),
// below the live stream, in frames of at most maxStreamDataBytes, so a control frame waits for one of them at most.
// A runner has at most maxStreamsPerRunner streams open on this gateway. A stream ends with the connection it was
// opened on.

const (
	// streamCapability is the Hello capability of a runner that speaks byte streams.
	streamCapability = "link-stream-v1"
	// streamPasteCapability is the Hello capability of a runner that takes StreamPaste.
	streamPasteCapability = "link-stream-paste-v1"
	// maxPasteBytes bounds a StreamPaste's text, as the apiserver does (browser-viewer.ts, MAX_PASTE_BYTES).
	maxPasteBytes       = 64 << 10
	streamSubjectPrefix = "vnc."
	// streamWindow is each direction's window per stream, in bytes.
	streamWindow = 256 << 10
	// maxStreamsPerRunner bounds the open streams of one runner (two tabs or devices watching).
	maxStreamsPerRunner = 2
	// maxStreamDataBytes bounds one StreamData frame.
	maxStreamDataBytes = 32 << 10
	// streamCreditBatch is how much of the viewer's credit the gateway gathers before it tells the runner, unless the
	// viewer has credited everything the runner sent: one StreamCredit for every StreamData would fill a slow link to
	// the runner with credits, ahead of the stream's own data.
	streamCreditBatch = streamWindow / 2
	// streamOpenTimeout is how long the runner has to answer a StreamOpen.
	streamOpenTimeout = 10 * time.Second
)

func streamDownSubject(id string) string { return streamSubjectPrefix + id + ".down" }
func streamUpSubject(id string) string   { return streamSubjectPrefix + id + ".up" }

// stream is one open (or opening) stream.
type stream struct {
	g      *gateway
	id     string
	runner string
	c      *conn

	mu sync.Mutex
	// reply is the open request's reply subject, until it is answered.
	reply string
	sub   *nats.Subscription
	timer *time.Timer
	// opened says the runner answered StreamOpened; ended, that the stream is over.
	opened, ended bool
	// upRoom is how many bytes the runner may still send; downRoom, how many the apiserver may. upOwed is the viewer's
	// credit the runner has not been told yet (streamCreditBatch).
	upRoom, downRoom, upOwed int64
}

// streamBook is every stream of the gateway's connections.
type streamBook struct {
	mu        sync.Mutex
	byID      map[string]*stream
	perRunner map[string]int
}

func newStreamBook() *streamBook {
	return &streamBook{byID: map[string]*stream{}, perRunner: map[string]int{}}
}

// add records s, unless its id is taken (an error naming that) or its runner has as many streams as it may (refused
// with TOO_MANY_STREAMS).
func (b *streamBook) add(s *stream) (linkpb.StreamCloseCode, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byID[s.id] != nil {
		return linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "the stream id is already in use"
	}
	if b.perRunner[s.runner] >= maxStreamsPerRunner {
		return linkpb.StreamCloseCode_STREAM_CLOSE_CODE_TOO_MANY_STREAMS,
			fmt.Sprintf("the runner already has %d open streams", maxStreamsPerRunner)
	}
	b.byID[s.id] = s
	b.perRunner[s.runner]++
	return 0, ""
}

func (b *streamBook) remove(s *stream) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.byID[s.id] != s {
		return
	}
	delete(b.byID, s.id)
	if b.perRunner[s.runner]--; b.perRunner[s.runner] <= 0 {
		delete(b.perRunner, s.runner)
	}
}

// of is the stream named id on connection c, or nil.
func (b *streamBook) of(c *conn, id string) *stream {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s := b.byID[id]; s != nil && s.c == c {
		return s
	}
	return nil
}

// onConn is every stream of connection c.
func (b *streamBook) onConn(c *conn) []*stream {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*stream
	for _, s := range b.byID {
		if s.c == c {
			out = append(out, s)
		}
	}
	return out
}

// open is the open count, for the metrics and the tests.
func (b *streamBook) open() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.byID)
}

// streamable reports whether a stream may be opened on the connection: its Hello declared link-stream-v1 and named a
// ManagedInstance, and its Welcome offered the browser, which the welcome route does only for a managed runner whose
// instance matches the manager's record (generation and Pod UID) with the browser switch on
// (runner-link-welcome.controller.ts). A self-managed runner is never streamable, whatever it declares: it has no
// managed mapping, so it is never offered the browser (docs/runner-browser-design.md §2).
func (c *conn) streamable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.browser && c.hello.GetManagedInstance() != nil && slices.Contains(c.hello.GetCapabilities(), streamCapability)
}

// pastable reports whether the connection's runner takes StreamPaste (link-stream-paste-v1).
func (c *conn) pastable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Contains(c.hello.GetCapabilities(), streamPasteCapability)
}

// openStream takes a StreamOpen request from NATS for runner, answered on reply.
func (g *gateway) openStream(runner string, open *linkpb.StreamOpen, reply string) {
	m := g.metrics
	id, ok := sessionUUID(open.GetStreamId())
	if reply == "" || !ok {
		m.streams.inc("malformed")
		return
	}
	refuse := func(code linkpb.StreamCloseCode, message, result string) {
		m.streams.inc(result)
		g.answerStream(reply, &linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{
			StreamId: id, Code: code, Message: message,
		}}})
	}
	if open.GetKind() != linkpb.StreamKind_STREAM_KIND_VNC {
		refuse(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED, "unknown stream kind", "refused")
		return
	}
	// The newest connection of the runner that may carry a stream.
	var best *conn
	var bestAt time.Time
	conns := g.reg.connsOf(runner)
	for _, c := range conns {
		if at := c.welcomeTime(); c.streamable() && (best == nil || at.After(bestAt)) {
			best, bestAt = c, at
		}
	}
	if best == nil {
		if len(conns) == 0 {
			refuse(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "no connection of the runner", "no_connection")
		} else {
			refuse(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_REFUSED,
				"the runner is not a verified managed runner offered the browser, or does not declare "+streamCapability, "refused")
		}
		return
	}
	s := &stream{g: g, id: id, runner: runner, c: best, reply: reply, upRoom: streamWindow, downRoom: streamWindow}
	if code, message := g.streams.add(s); code != 0 {
		refuse(code, message, "too_many")
		return
	}
	sub, err := g.hints.nc.Subscribe(streamDownSubject(id), func(msg *nats.Msg) { s.fromViewer(msg.Data) })
	if err != nil {
		g.streams.remove(s)
		refuse(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "subscribing to the stream failed", "nats_down")
		return
	}
	s.mu.Lock()
	s.sub = sub
	s.timer = time.AfterFunc(streamOpenTimeout, func() {
		s.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_TIMEOUT, "the runner did not answer StreamOpen in time", true, "timeout")
	})
	s.mu.Unlock()
	if !best.offer(&linkpb.Frame{Body: &linkpb.Frame_StreamOpen{StreamOpen: &linkpb.StreamOpen{
		StreamId: id, Kind: linkpb.StreamKind_STREAM_KIND_VNC,
	}}}) {
		s.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "the runner's connection did not take StreamOpen", false, "dropped")
	}
}

// answerStream answers an open request, once, in the JSON the runner subject's messages use.
func (g *gateway) answerStream(reply string, f *linkpb.Frame) {
	data, err := protojson.Marshal(f)
	if err == nil {
		err = g.hints.nc.Publish(reply, data)
	}
	if err != nil {
		g.log.Warn("a stream open answer was not published", "err", err)
	}
}

// publishUp sends f to the viewer's side on vnc.<id>.up. Called with s.mu held, so the stream's messages keep their
// order.
func (s *stream) publishUp(f *linkpb.Frame) error {
	data, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	return s.g.hints.nc.Publish(streamUpSubject(s.id), data)
}

// end closes the stream once: the viewer's side is told (the open request's answer, or a StreamClose on .up), and the
// runner too when toRunner says so. result is what it is counted under.
func (s *stream) end(code linkpb.StreamCloseCode, message string, toRunner bool, result string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.endLocked(code, message, toRunner, true, result)
}

func (s *stream) endLocked(code linkpb.StreamCloseCode, message string, toRunner, toViewer bool, result string) {
	if s.ended {
		return
	}
	s.ended = true
	s.g.streams.remove(s)
	if s.timer != nil {
		s.timer.Stop()
	}
	if s.sub != nil {
		_ = s.sub.Unsubscribe()
	}
	s.g.metrics.streams.inc(result)
	closeFrame := func() *linkpb.Frame {
		return &linkpb.Frame{Body: &linkpb.Frame_StreamClose{StreamClose: &linkpb.StreamClose{
			StreamId: s.id, Code: code, Message: message,
		}}}
	}
	if toViewer {
		if !s.opened {
			s.g.answerStream(s.reply, closeFrame())
		} else if err := s.publishUp(closeFrame()); err != nil {
			s.c.log.Warn("a stream's close was not published", "stream", s.id, "err", err)
		}
	}
	if toRunner {
		s.c.offer(closeFrame())
	}
}

// onStreamFrame handles a stream frame from the runner's connection c.
func (c *conn) onStreamFrame(f *linkpb.Frame) {
	var id string
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_StreamOpened:
		id = body.StreamOpened.GetStreamId()
	case *linkpb.Frame_StreamData:
		id = body.StreamData.GetStreamId()
	case *linkpb.Frame_StreamCredit:
		id = body.StreamCredit.GetStreamId()
	case *linkpb.Frame_StreamClose:
		id = body.StreamClose.GetStreamId()
	case *linkpb.Frame_StreamPasted:
		id = body.StreamPasted.GetStreamId()
	}
	canonical, _ := sessionUUID(id)
	s := c.g.streams.of(c, canonical)
	if s == nil {
		// A stream that has ended, or was never this connection's: nothing more is sent on it.
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	violation := func(message string) {
		s.endLocked(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION, message, true, true, "flow_violation")
	}
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_StreamOpened:
		if s.opened {
			return
		}
		s.opened = true
		s.timer.Stop()
		s.g.answerStream(s.reply, &linkpb.Frame{Body: &linkpb.Frame_StreamOpened{StreamOpened: &linkpb.StreamOpened{StreamId: s.id}}})
		s.reply = ""
		s.g.metrics.streams.inc("opened")
	case *linkpb.Frame_StreamData:
		data := body.StreamData.GetData()
		switch {
		case !s.opened:
			violation("StreamData before StreamOpened")
		case int64(len(data)) > s.upRoom:
			violation("the runner sent past the stream's window")
		default:
			s.upRoom -= int64(len(data))
			s.relayUp(&linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{StreamId: s.id, Data: data}}})
		}
	case *linkpb.Frame_StreamCredit:
		n := int64(body.StreamCredit.GetBytes())
		if s.downRoom+n > streamWindow {
			violation("the runner credited more than the stream's window")
			return
		}
		s.downRoom += n
		s.relayUp(&linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{StreamId: s.id, Bytes: uint32(n)}}})
	case *linkpb.Frame_StreamClose:
		s.endLocked(body.StreamClose.GetCode(), body.StreamClose.GetMessage(), false, true, "closed_by_runner")
	case *linkpb.Frame_StreamPasted:
		if s.opened {
			s.relayUp(&linkpb.Frame{Body: &linkpb.Frame_StreamPasted{StreamPasted: &linkpb.StreamPasted{
				StreamId: s.id, PasteId: body.StreamPasted.GetPasteId(), Error: body.StreamPasted.GetError(),
			}}})
		}
	}
}

// relayUp publishes a frame of the runner's on .up; a stream NATS does not take is ended.
func (s *stream) relayUp(f *linkpb.Frame) {
	if err := s.publishUp(f); err != nil {
		s.endLocked(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "NATS did not take the stream's bytes", true, false, "nats_down")
	}
}

// fromViewer handles one message from vnc.<id>.down, in the order NATS delivers them.
func (s *stream) fromViewer(data []byte) {
	var f linkpb.Frame
	err := proto.Unmarshal(data, &f)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	violation := func(message string) {
		s.endLocked(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION, message, true, true, "flow_violation")
	}
	if err != nil {
		violation("a message on the stream's subject is not a link frame")
		return
	}
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_StreamData:
		data := body.StreamData.GetData()
		switch {
		case !s.opened:
			violation("StreamData before the stream opened")
			return
		case int64(len(data)) > s.downRoom:
			violation("the viewer sent past the stream's window")
			return
		}
		s.downRoom -= int64(len(data))
		for len(data) > 0 {
			piece := data[:min(len(data), maxStreamDataBytes)]
			data = data[len(piece):]
			if !s.c.offerTier(&linkpb.Frame{Body: &linkpb.Frame_StreamData{StreamData: &linkpb.StreamData{
				StreamId: s.id, Data: piece,
			}}}, tierStream) {
				s.endLocked(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_FLOW_VIOLATION, "the runner reads the stream too slowly", true, true, "slow_runner")
				return
			}
		}
	case *linkpb.Frame_StreamCredit:
		n := int64(body.StreamCredit.GetBytes())
		outstanding := streamWindow - s.upRoom // sent by the runner and not yet credited to it
		if s.upOwed+n > outstanding {
			violation("the viewer credited more than the runner sent")
			return
		}
		s.upOwed += n
		if s.upOwed < streamCreditBatch && s.upOwed < outstanding {
			return
		}
		n, s.upOwed = s.upOwed, 0
		s.upRoom += n
		if !s.c.offer(&linkpb.Frame{Body: &linkpb.Frame_StreamCredit{StreamCredit: &linkpb.StreamCredit{StreamId: s.id, Bytes: uint32(n)}}}) {
			s.endLocked(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "the runner's connection did not take a credit", true, true, "dropped")
		}
	case *linkpb.Frame_StreamClose:
		code := body.StreamClose.GetCode()
		if code == linkpb.StreamCloseCode_STREAM_CLOSE_CODE_UNSPECIFIED {
			code = linkpb.StreamCloseCode_STREAM_CLOSE_CODE_NORMAL
		}
		s.endLocked(code, body.StreamClose.GetMessage(), true, false, "closed_by_viewer")
	case *linkpb.Frame_StreamPaste:
		// Text the owner pasted (docs/runner-browser-design.md §5): outside the stream's window, on the control tier,
		// and never logged. A runner that does not take it is answered here, so the viewer is not left waiting.
		paste := body.StreamPaste
		switch {
		case !s.opened:
			violation("StreamPaste before the stream opened")
			return
		case len(paste.GetText()) > maxPasteBytes:
			violation(fmt.Sprintf("a paste of more than %d bytes", maxPasteBytes))
			return
		}
		answer := func(message string) {
			s.relayUp(&linkpb.Frame{Body: &linkpb.Frame_StreamPasted{StreamPasted: &linkpb.StreamPasted{
				StreamId: s.id, PasteId: paste.GetPasteId(), Error: message,
			}}})
		}
		if !s.c.pastable() {
			answer("This runner cannot take a paste yet; it needs an update")
			return
		}
		if !s.c.offer(&linkpb.Frame{Body: &linkpb.Frame_StreamPaste{StreamPaste: &linkpb.StreamPaste{
			StreamId: s.id, PasteId: paste.GetPasteId(), Text: paste.GetText(),
		}}}) {
			answer("The runner's connection did not take the paste")
		}
	}
}

// closeStreams ends every stream of a connection that has ended: the viewers are told, the runner is gone.
func (g *gateway) closeStreams(c *conn) {
	for _, s := range g.streams.onConn(c) {
		s.end(linkpb.StreamCloseCode_STREAM_CLOSE_CODE_CONNECTION_LOST, "the runner's link connection closed", false, "connection_closed")
	}
}
