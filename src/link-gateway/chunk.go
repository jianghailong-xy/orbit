package main

import (
	"errors"
	"fmt"
	"sync/atomic"

	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Frames larger than one WebSocket message may carry travel as Chunks (contracts/runner-link/v1: Chunk): the
// sender cuts the encoded Frame into pieces and the receiver joins the pieces of one frame_id in index order.

// Bounds on frames being joined. A frame that would outgrow them is a protocol error: no frame of protocol v1 is
// legitimately that large, and memory held for one runner must not grow without limit.
const (
	maxChunkedFrameBytes    = 8 << 20
	maxPartialFramesPerConn = 4
	maxPartialBytesPerConn  = 16 << 20
)

// partialBytes counts the bytes of every partial frame the process holds, across connections.
var partialBytes atomic.Int64

// maxPartialBytesTotal bounds partialBytes; a piece that would pass it closes its connection.
const maxPartialBytesTotal = 256 << 20

type partialFrame struct {
	next  uint32
	bytes []byte
}

// reassembler joins one connection's chunked frames.
type reassembler struct {
	partials map[uint64]*partialFrame
	held     int
}

var errChunk = errors.New("chunk")

// add takes one piece. It returns the decoded frame once the last piece has arrived, nil while pieces are missing,
// and an error for anything the protocol does not allow.
func (r *reassembler) add(c *linkpb.Chunk) (*linkpb.Frame, error) {
	if r.partials == nil {
		r.partials = map[uint64]*partialFrame{}
	}
	p := r.partials[c.GetFrameId()]
	if p == nil {
		if c.GetIndex() != 0 {
			return nil, fmt.Errorf("%w: frame %d starts at piece %d", errChunk, c.GetFrameId(), c.GetIndex())
		}
		if len(r.partials) >= maxPartialFramesPerConn {
			return nil, fmt.Errorf("%w: more than %d frames in pieces at once", errChunk, maxPartialFramesPerConn)
		}
		p = &partialFrame{}
		r.partials[c.GetFrameId()] = p
	}
	if c.GetIndex() != p.next {
		return nil, fmt.Errorf("%w: frame %d piece %d arrived where %d was due", errChunk, c.GetFrameId(), c.GetIndex(), p.next)
	}
	n := len(c.GetData())
	if len(p.bytes)+n > maxChunkedFrameBytes || r.held+n > maxPartialBytesPerConn {
		return nil, fmt.Errorf("%w: frame %d outgrows the bounds on frames in pieces", errChunk, c.GetFrameId())
	}
	if partialBytes.Add(int64(n)) > maxPartialBytesTotal {
		partialBytes.Add(int64(-n))
		return nil, fmt.Errorf("%w: the gateway holds too many frames in pieces", errChunk)
	}
	p.bytes = append(p.bytes, c.GetData()...)
	r.held += n
	p.next++
	if !c.GetLast() {
		return nil, nil
	}
	r.drop(c.GetFrameId())
	var f linkpb.Frame
	if err := proto.Unmarshal(p.bytes, &f); err != nil {
		return nil, fmt.Errorf("%w: frame %d does not decode once joined: %v", errChunk, c.GetFrameId(), err)
	}
	if _, nested := f.GetBody().(*linkpb.Frame_Chunk); nested {
		return nil, fmt.Errorf("%w: frame %d is itself a chunk", errChunk, c.GetFrameId())
	}
	return &f, nil
}

func (r *reassembler) drop(id uint64) {
	if p := r.partials[id]; p != nil {
		r.held -= len(p.bytes)
		partialBytes.Add(int64(-len(p.bytes)))
		delete(r.partials, id)
	}
}

// close lets go of every partial frame, which a closed connection discards.
func (r *reassembler) close() {
	for id := range r.partials {
		r.drop(id)
	}
}

// encodeFrame encodes f as the WebSocket messages it travels in: one when it fits in limit bytes, otherwise Chunks
// whose Frame ids are taken from nextID, each piece sized so that its own encoded Frame fits.
func encodeFrame(f *linkpb.Frame, limit int, nextID func() uint64) ([][]byte, error) {
	b, err := proto.Marshal(f)
	if err != nil {
		return nil, err
	}
	if len(b) <= limit {
		return [][]byte{b}, nil
	}
	// A piece's own Frame adds its id, the Chunk's frame_id, index and last flag, and two length prefixes: well
	// under 64 bytes.
	piece := limit - 64
	var out [][]byte
	for i := 0; len(b) > 0; i++ {
		n := min(piece, len(b))
		cf := &linkpb.Frame{Id: nextID(), Body: &linkpb.Frame_Chunk{Chunk: &linkpb.Chunk{
			FrameId: f.GetId(), Index: uint32(i), Last: n == len(b), Data: b[:n],
		}}}
		cb, err := proto.Marshal(cf)
		if err != nil {
			return nil, err
		}
		out = append(out, cb)
		b = b[n:]
	}
	return out, nil
}
