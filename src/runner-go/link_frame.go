package main

import (
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// Frames of the runner link (contracts/runner-link/v1) as WebSocket messages: one message carries one encoded Frame
// of at most linkMaxFrameBytes, and a larger frame travels as Chunks that the receiver joins in index order. The
// link gateway does the same on its side (src/link-gateway/chunk.go).

const (
	// linkMaxFrameBytes is Limits.max_frame_bytes in protocol v1 (docs/runner-link-design.md §5.1): the largest
	// encoded Frame one WebSocket message carries, in either direction.
	linkMaxFrameBytes = 256 << 10
	// Bounds on frames being joined from pieces. A frame that would outgrow them is a protocol error: nothing the
	// gateway sends is legitimately that large, and memory held for one connection must not grow without limit.
	linkMaxJoinedFrameBytes = 8 << 20
	linkMaxPartialFrames    = 4
	linkMaxPartialBytes     = 16 << 20
)

var errLinkChunk = errors.New("link chunk")

// encodeLinkFrame encodes f as the WebSocket messages it travels in: one when it fits in limit bytes, otherwise
// Chunks whose Frame ids are taken from nextID, each piece sized so that its own encoded Frame fits.
func encodeLinkFrame(f *linkpb.Frame, limit int, nextID func() uint64) ([][]byte, error) {
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
		cb, err := proto.Marshal(&linkpb.Frame{Id: nextID(), Body: &linkpb.Frame_Chunk{Chunk: &linkpb.Chunk{
			FrameId: f.GetId(), Index: uint32(i), Last: n == len(b), Data: b[:n],
		}}})
		if err != nil {
			return nil, err
		}
		out = append(out, cb)
		b = b[n:]
	}
	return out, nil
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
