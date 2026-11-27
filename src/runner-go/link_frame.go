package main

import (
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// Frames of the runner link (contracts/runner-link/v1) as WebSocket messages: one message carries one encoded Frame
// of at most linkMaxFrameBytes (the runner writes none over linkSendPieceBytes), and a larger frame travels as Chunks that the receiver joins in index order. The
// link gateway does the same on its side (src/link-gateway/chunk.go).

const (
	// linkMaxFrameBytes is Limits.max_frame_bytes in protocol v1 (docs/runner-link-design.md §5.1): the largest
	// encoded Frame one WebSocket message carries, in either direction.
	linkMaxFrameBytes = 256 << 10
	// linkSendPieceBytes is the largest message the runner writes: a larger frame goes as Chunks (§15.15). On a slow
	// path a heartbeat or a call waits behind one piece at most, never behind a whole 256 KiB message, and so does the
	// WebSocket library's pong, whose write it bounds to 5 s. What the runner takes in stays linkMaxFrameBytes.
	linkSendPieceBytes = 16 << 10
	// Bounds on frames being joined from pieces. A frame that would outgrow them is a protocol error: nothing the
	// gateway sends is legitimately that large, and memory held for one connection must not grow without limit.
	linkMaxJoinedFrameBytes = 8 << 20
	linkMaxPartialFrames    = 4
	linkMaxPartialBytes     = 16 << 20
)

var errLinkChunk = errors.New("link chunk")

// linkPieces is one encoded frame on its way out as messages: whole when it fits in limit bytes, otherwise as Chunks
// of it. Each message is encoded only as it is taken (next), so a sender that lets other frames go between the pieces
// gives every message it writes the next id it holds.
type linkPieces struct {
	b       []byte // what is still to go of the encoded frame
	frameID uint64
	index   uint32
	limit   int
	whole   bool
	over    bool // every message has been taken
}

// newLinkPieces encodes f, whose id is set, to go out in messages of at most limit bytes.
func newLinkPieces(f *linkpb.Frame, limit int) (*linkPieces, error) {
	b, err := proto.Marshal(f)
	if err != nil {
		return nil, err
	}
	return &linkPieces{b: b, frameID: f.GetId(), limit: limit, whole: len(b) <= limit}, nil
}

// done reports whether every message has been taken.
func (p *linkPieces) done() bool { return p.over }

// next is the next message: the whole frame, or the next Chunk of it in a Frame of its own whose id is id (unused for a
// frame that goes whole).
func (p *linkPieces) next(id uint64) ([]byte, error) {
	if p.whole {
		b := p.b
		p.b, p.over = nil, true
		return b, nil
	}
	// A piece's own Frame adds its id, the Chunk's frame_id, index and last flag, and two length prefixes: well under
	// 64 bytes.
	n := min(p.limit-64, len(p.b))
	cb, err := proto.Marshal(&linkpb.Frame{Id: id, Body: &linkpb.Frame_Chunk{Chunk: &linkpb.Chunk{
		FrameId: p.frameID, Index: p.index, Last: n == len(p.b), Data: p.b[:n],
	}}})
	if err != nil {
		return nil, err
	}
	p.b = p.b[n:]
	p.index++
	p.over = len(p.b) == 0
	return cb, nil
}

// linkReassembler joins one connection's chunked frames.
type linkReassembler struct {
	partials map[uint64][]byte
	next     map[uint64]uint32
	held     int
}

// add takes one piece. It returns the decoded frame once the last piece has arrived, nil while pieces are missing,
// and an error for anything the protocol does not allow.
func (r *linkReassembler) add(c *linkpb.Chunk) (*linkpb.Frame, error) {
	if r.partials == nil {
		r.partials, r.next = map[uint64][]byte{}, map[uint64]uint32{}
	}
	id := c.GetFrameId()
	b, open := r.partials[id]
	if !open {
		if c.GetIndex() != 0 {
			return nil, fmt.Errorf("%w: frame %d starts at piece %d", errLinkChunk, id, c.GetIndex())
		}
		if len(r.partials) >= linkMaxPartialFrames {
			return nil, fmt.Errorf("%w: more than %d frames in pieces at once", errLinkChunk, linkMaxPartialFrames)
		}
	}
	if c.GetIndex() != r.next[id] {
		return nil, fmt.Errorf("%w: frame %d piece %d arrived where %d was due", errLinkChunk, id, c.GetIndex(), r.next[id])
	}
	n := len(c.GetData())
	if len(b)+n > linkMaxJoinedFrameBytes || r.held+n > linkMaxPartialBytes {
		return nil, fmt.Errorf("%w: frame %d outgrows the bounds on frames in pieces", errLinkChunk, id)
	}
	b = append(b, c.GetData()...)
	r.held += n
	r.next[id]++
	if !c.GetLast() {
		r.partials[id] = b
		return nil, nil
	}
	r.held -= len(b)
	delete(r.partials, id)
	delete(r.next, id)
	var f linkpb.Frame
	if err := proto.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("%w: frame %d does not decode once joined: %v", errLinkChunk, id, err)
	}
	if f.GetChunk() != nil {
		return nil, fmt.Errorf("%w: frame %d is itself a chunk", errLinkChunk, id)
	}
	return &f, nil
}
