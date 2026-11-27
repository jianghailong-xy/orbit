package main

import (
	"context"
	"net"
	"sync/atomic"
	"time"
)

// The socket under a link connection (docs/runner-link-design.md §15.13, §15.15): the raw TCP connection a WebSocket
// was dialled on, under the proxy's CONNECT exchange and every TLS layer, counted as it carries bytes. The WebSocket
// library writes to it through a 4 KiB buffer, so its counts move every few KiB.
//
// Only bytes read prove the path carries: bytes written land in a kernel buffer, or a proxy's on the same host, whatever
// the path does. What writing tells is whether writes block: a write in flight, or one that took over linkSlowWrite.
// The pinger does not ping while they do (a ping written into a full send buffer stalls, and the library closes the
// connection when its 5 s deadline passes), and the connection's watchdog ends it once a write has made no progress,
// and nothing has been read either, for linkWriteStallLimit (linkConn.watch).
//
// A frame's write never fills the send buffer either (waitRoom): it waits, before the WebSocket library takes its
// write lock, until the kernel's send queue is under half the buffer. Every write of the library's own holds that lock,
// a pong's included, and gives up after 5 s, its wait for the lock counted: a pong behind a write blocked in a full
// buffer through a stall of the path ended the connection (§15.15). With room kept, a pong takes the lock and goes into
// the buffer at once, however long the path stalls. While a write waits for room, the acknowledgements that drain the
// queue are its progress.

const (
	// linkWriteStallLimit is how long a write may make no progress, with nothing read meanwhile, before the connection
	// is taken for dead. At 30% packet loss a stall that long takes about seven losses of one segment in a row.
	linkWriteStallLimit = 45 * time.Second
	// linkSlowWrite is how long a write may take and the socket still not count as blocking at the pinger's next tick.
	linkSlowWrite = time.Second
	// linkStallCheckEvery is how often the watchdog looks.
	linkStallCheckEvery = time.Second
)

// linkSocketLimits are the limits a socket is watched by, taken when it is dialled.
type linkSocketLimits struct {
	stall, slowWrite, checkEvery time.Duration
	// wrap, when set, is put between the dialled connection and the count: what tests throttle and stall it with.
	wrap func(net.Conn) net.Conn
}

// linkSocketTuning is the limits sockets dialled from now on take: the constants above, which tests shorten.
var linkSocketTuning atomic.Pointer[linkSocketLimits]

func init() {
	linkSocketTuning.Store(&linkSocketLimits{stall: linkWriteStallLimit, slowWrite: linkSlowWrite, checkEvery: linkStallCheckEvery})
}

// linkSocketWritePiece is the most one write to the socket hands the kernel at once, so that a write slowly going out
// shows its progress as it goes.
const linkSocketWritePiece = 16 << 10

// linkSocket is the counted connection.
type linkSocket struct {
	net.Conn
	limits        *linkSocketLimits
	read, written atomic.Int64
	// When bytes were last read and written, in Unix nanoseconds.
	lastRead, lastWritten atomic.Int64
	// writing counts the writes in flight, and writeSince is when the first of them began (Unix nanoseconds, 0 for
	// none).
	writing    atomic.Int32
	writeSince atomic.Int64
	// slow is set by a write that took over linkSlowWrite, and cleared when the pinger looks (blocking).
	slow atomic.Bool
	// closedWriting, once the socket is closed with a write in flight, is how long that write had gone without progress.
	closedWriting atomic.Int64
	// queue reads the kernel's send queue and the send buffer's size (linkSocketQueue); nil where it cannot.
	queue func() (queued, size int, ok bool)
}

// linkRoomCheckEvery is how often a write waiting for room looks again.
const linkRoomCheckEvery = 10 * time.Millisecond

func (s *linkSocket) Read(p []byte) (int, error) {
	n, err := s.Conn.Read(p)
	if n > 0 {
		s.read.Add(int64(n))
		s.lastRead.Store(time.Now().UnixNano())
	}
	return n, err
}

func (s *linkSocket) Write(p []byte) (int, error) {
	defer s.writeBegins()()
	total := 0
	for len(p) > 0 {
		k := min(len(p), linkSocketWritePiece)
		n, err := s.Conn.Write(p[:k])
		if n > 0 {
			total += n
			s.written.Add(int64(n))
			s.lastWritten.Store(time.Now().UnixNano())
		}
		if err != nil {
			return total, err
		}
		p = p[k:]
	}
	return total, nil
}

// writeBegins counts a write in flight, and returns what counts it over.
func (s *linkSocket) writeBegins() func() {
	start := time.Now()
	if s.writing.Add(1) == 1 {
		s.writeSince.Store(start.UnixNano())
	}
	return func() {
		if time.Since(start) > s.limits.slowWrite {
			s.slow.Store(true)
		}
		if s.writing.Add(-1) == 0 {
			s.writeSince.Store(0)
		}
	}
}

// roomFor reports whether n more bytes leave the kernel's send queue under half the send buffer, or the queue is empty.
func (s *linkSocket) roomFor(n int) (queued int, room bool) {
	queued, size, ok := s.queue()
	return queued, !ok || queued == 0 || (queued+n)*2 <= size
}

// waitRoom waits until n bytes can be written without filling the send buffer, or ctx ends. The wait is a write in
// flight, and each acknowledgement that shortens the queue is its progress.
func (s *linkSocket) waitRoom(ctx context.Context, n int) error {
	if s.queue == nil {
		return nil
	}
	last, room := s.roomFor(n)
	if room {
		return nil
	}
	defer s.writeBegins()()
	tick := time.NewTicker(linkRoomCheckEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
		queued, room := s.roomFor(n)
		if room {
			return nil
		}
		if queued < last {
			s.lastWritten.Store(time.Now().UnixNano())
		}
		last = queued
	}
}

func (s *linkSocket) Close() error {
	if d := s.stalledFor(time.Now()); d > 0 {
		s.closedWriting.CompareAndSwap(0, int64(d))
	}
	return s.Conn.Close()
}

// stalledFor is how long the write in flight has gone without progress, and the socket without a byte read: zero with
// no write in flight.
func (s *linkSocket) stalledFor(now time.Time) time.Duration {
	since := s.writeSince.Load()
	if since == 0 {
		return 0
	}
	last := max(since, s.lastWritten.Load(), s.lastRead.Load())
	return max(now.Sub(time.Unix(0, last)), time.Nanosecond)
}

// blocking reports whether writes block: one is in flight, or one took over linkSlowWrite since the last look.
func (s *linkSocket) blocking() bool {
	slow := s.slow.Swap(false)
	return s.writing.Load() > 0 || slow
}

// linkSocketSlot is where the dialer leaves the socket it dialled for one WebSocket's opening, in the context of that
// opening (dialLink).
type linkSocketSlot struct{ s atomic.Pointer[linkSocket] }

type linkSocketSlotKey struct{}

// linkSocketDialer dials as d does, and counts a connection dialled for a WebSocket's opening.
func linkSocketDialer(d *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := d.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		slot, _ := ctx.Value(linkSocketSlotKey{}).(*linkSocketSlot)
		if slot == nil {
			return c, nil
		}
		limits := linkSocketTuning.Load()
		if limits.wrap != nil {
			c = limits.wrap(c)
		}
		s := &linkSocket{Conn: c, limits: limits, queue: linkSocketQueue(c)}
		slot.s.Store(s)
		return s, nil
	}
}
