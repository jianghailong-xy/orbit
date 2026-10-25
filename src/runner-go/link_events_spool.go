package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The disk half of the runner link's durable event buffer (docs/runner-link-design.md §5.8; task B8). A session's
// unacknowledged events past what memory may hold (linkSessionMemoryBytes, linkTotalMemoryBytes) wait here, in order,
// until the stream has room to send them; and when the runner stops, everything a session still holds is written here,
// so the next process sends it first (link_events.go).
//
// One directory per session under ~/.orbit/link-spool, holding segments of consecutive events, one JSON line per event.
// A segment being written is <first seq>.open.jsonl; a finished one is <first seq>-<last seq>.jsonl, with seqs
// zero-padded so that names sort in seq order. A process that dies while writing leaves an open segment whose last line
// may be cut short: the next one keeps its whole lines. Every spool together stays within linkSpoolMaxBytes; past it,
// a session's events stay in memory instead (linkEventStream.over). A session's spool nobody has opened for
// linkSpoolStaleAfter is removed when a process starts: whatever session it was is long settled.

const (
	linkSpoolMaxBytes     = 2 << 30
	linkSpoolSegmentBytes = 1 << 20
	linkSpoolStaleAfter   = 72 * time.Hour
)

var errLinkSpoolFull = errors.New("the link spool is full")

func linkSpoolDir() string { return filepath.Join(machineHome(), "link-spool") }

// linkSpool is every session's spool, and the bytes they take together.
type linkSpool struct {
	dir  string
	log  func(...any)
	once sync.Once

	mu    sync.Mutex
	bytes int64
}

func newLinkSpool(dir string, log func(...any)) *linkSpool {
	return &linkSpool{dir: dir, log: log}
}

// init counts what earlier processes left, and removes what has been left too long to matter. Once, at the first
// session's open.
func (sp *linkSpool) init() {
	entries, err := os.ReadDir(sp.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(sp.dir, entry.Name())
		files, _ := os.ReadDir(dir)
		var size int64
		var newest time.Time
		for _, f := range files {
			if info, err := f.Info(); err == nil {
				size += info.Size()
				if info.ModTime().After(newest) {
					newest = info.ModTime()
				}
			}
		}
		if len(files) == 0 || time.Since(newest) > linkSpoolStaleAfter {
			if err := os.RemoveAll(dir); err == nil && len(files) > 0 {
				sp.log(fmt.Sprintf("runner link: removed the event spool of session %s, untouched since %s", entry.Name(), newest.Format(time.RFC3339)))
			}
			continue
		}
		sp.bytes += size
	}
}

// charge takes n bytes of the spool's bound, when there is room.
func (sp *linkSpool) charge(n int64) bool {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.bytes+n > linkSpoolMaxBytes {
		return false
	}
	sp.bytes += n
	return true
}

func (sp *linkSpool) uncharge(n int64) {
	sp.mu.Lock()
	sp.bytes = max(sp.bytes-n, 0)
	sp.mu.Unlock()
}

// used is what every spool takes together.
func (sp *linkSpool) used() int64 {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.bytes
}

// queue is one session's spool, with whatever an earlier process left in it.
func (sp *linkSpool) queue(key string) *linkSpoolQueue {
	sp.once.Do(sp.init)
	q := &linkSpoolQueue{sp: sp, dir: filepath.Join(sp.dir, spoolNamePart(key))}
	q.load()
	return q
}

// linkSpoolQueue is one session's events on disk, oldest segment first. Not safe for concurrent use: its stream's lock
// guards it.
type linkSpoolQueue struct {
	sp   *linkSpool
	dir  string
	segs []*linkSpoolSegment
	// w writes the newest segment while it is open; nil once it is finished.
	w *linkSpoolWriter
	n int
}

type linkSpoolSegment struct {
	path        string
	first, last uint64
	n           int
	bytes       int64
}

type linkSpoolWriter struct {
	f   *os.File
	buf *bufio.Writer
	seg *linkSpoolSegment
}

// linkSpoolLine is one event as a segment holds it.
type linkSpoolLine struct {
	Seq      uint64          `json:"seq"`
	Type     string          `json:"type"`
	TS       int64           `json:"ts"`
	TurnID   string          `json:"turnId,omitempty"`
	Payload  json.RawMessage `json:"payload"`
	Boundary bool            `json:"boundary,omitempty"`
	Critical bool            `json:"critical,omitempty"`
	Progress string          `json:"progress,omitempty"`
}

func (q *linkSpoolQueue) count() int { return q.n }

// first is the lowest seq on disk, 0 when there is none.
func (q *linkSpoolQueue) first() uint64 {
	if len(q.segs) == 0 {
		return 0
	}
	return q.segs[0].first
}

// last is the highest seq on disk, 0 when there is none.
func (q *linkSpoolQueue) last() uint64 {
	if len(q.segs) == 0 {
		return 0
	}
	return q.segs[len(q.segs)-1].last
}

func linkSpoolSegmentName(first, last uint64, open bool) string {
	if open {
		return fmt.Sprintf("%020d.open.jsonl", first)
	}
	return fmt.Sprintf("%020d-%020d.jsonl", first, last)
}

// load reads which segments an earlier process left: a finished one by its name, an open one by its whole lines, which
// finishes it. Segments that do not follow on from the one before them are damaged, and are removed with everything
// after them, so what is left is consecutive.
func (q *linkSpoolQueue) load() {
	files, err := os.ReadDir(q.dir)
	if err != nil {
		return
	}
	var segs []*linkSpoolSegment
	for _, f := range files {
		name := f.Name()
		path := filepath.Join(q.dir, name)
		info, err := f.Info()
		if err != nil {
			continue
		}
		switch {
		case strings.HasSuffix(name, ".open.jsonl"):
			if seg := q.finishOpen(path); seg != nil {
				segs = append(segs, seg)
			}
		case strings.HasSuffix(name, ".jsonl"):
			first, last, ok := linkSpoolRange(strings.TrimSuffix(name, ".jsonl"))
			if !ok {
				_ = os.Remove(path)
				continue
			}
			segs = append(segs, &linkSpoolSegment{path: path, first: first, last: last, n: int(last - first + 1), bytes: info.Size()})
		}
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].first < segs[j].first })
	for i, seg := range segs {
		if i > 0 && seg.first != segs[i-1].last+1 {
			q.sp.log(fmt.Sprintf("runner link: the event spool in %s does not follow on after seq %d; the %d segments from seq %d on are removed",
				q.dir, segs[i-1].last, len(segs)-i, seg.first))
			for _, rest := range segs[i:] {
				_ = os.Remove(rest.path)
				q.sp.uncharge(rest.bytes)
			}
			segs = segs[:i]
			break
		}
	}
	q.segs = segs
	for _, seg := range segs {
		q.n += seg.n
	}
}

// linkSpoolRange reads a finished segment's name.
func linkSpoolRange(name string) (uint64, uint64, bool) {
	a, b, ok := strings.Cut(name, "-")
	if !ok {
		return 0, 0, false
	}
	first, err1 := strconv.ParseUint(a, 10, 64)
	last, err2 := strconv.ParseUint(b, 10, 64)
	return first, last, err1 == nil && err2 == nil && first > 0 && last >= first
}

// finishOpen keeps the whole, consecutive lines of a segment a process left open, and names the segment for them.
func (q *linkSpoolQueue) finishOpen(path string) *linkSpoolSegment {
	events, err := linkSpoolRead(path, 0)
	info, statErr := os.Stat(path)
	if len(events) == 0 || statErr != nil {
		_ = os.Remove(path)
		if statErr == nil {
			q.sp.uncharge(info.Size())
		}
		return nil
	}
	if err != nil {
		// Cut short while it was written: what follows the last whole line was never sent, and its seq is numbered again.
		if werr := linkSpoolWrite(path, events); werr != nil {
			_ = os.Remove(path)
			q.sp.uncharge(info.Size())
			return nil
		}
	}
	first, last := events[0].seq, events[len(events)-1].seq
	finished := filepath.Join(q.dir, linkSpoolSegmentName(first, last, false))
	if err := os.Rename(path, finished); err != nil {
		finished = path
	}
	size := info.Size()
	if fi, err := os.Stat(finished); err == nil {
		q.sp.uncharge(size)
		size = fi.Size()
		q.sp.mu.Lock()
		q.sp.bytes += size
		q.sp.mu.Unlock()
	}
	return &linkSpoolSegment{path: finished, first: first, last: last, n: len(events), bytes: size}
}

// linkSpoolRead reads a segment's events after stored, stopping at the first line that is not a whole event following
// on from the one before it, which it reports.
func linkSpoolRead(path string, stored uint64) ([]*linkEvent, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []*linkEvent
	var prev uint64
	for len(data) > 0 {
		line, rest, found := bytes.Cut(data, []byte("\n"))
		data = rest
		if !found {
			return out, fmt.Errorf("%s ends in a line cut short", filepath.Base(path))
		}
		var l linkSpoolLine
		if err := json.Unmarshal(line, &l); err != nil || l.Seq == 0 || (prev > 0 && l.Seq != prev+1) {
			return out, fmt.Errorf("%s has a damaged line after seq %d", filepath.Base(path), prev)
		}
		prev = l.Seq
		if l.Seq <= stored {
			continue
		}
		out = append(out, &linkEvent{seq: l.Seq, typ: l.Type, tsMs: l.TS, turnID: l.TurnID, payload: []byte(l.Payload),
			boundary: l.Boundary, critical: l.Critical, progress: l.Progress})
	}
	return out, nil
}

func linkSpoolEncode(ev *linkEvent) ([]byte, error) {
	b, err := json.Marshal(linkSpoolLine{Seq: ev.seq, Type: ev.typ, TS: ev.tsMs, TurnID: ev.turnID, Payload: json.RawMessage(ev.payload),
		Boundary: ev.boundary, Critical: ev.critical, Progress: ev.progress})
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// linkSpoolWrite writes events to path whole, synced.
func linkSpoolWrite(path string, events []*linkEvent) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, ev := range events {
		line, err := linkSpoolEncode(ev)
		if err == nil {
			_, err = w.Write(line)
		}
		if err != nil {
			_ = f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// append writes ev after everything on disk. errLinkSpoolFull, or the disk's own error, says it did not.
func (q *linkSpoolQueue) append(ev *linkEvent) error {
	line, err := linkSpoolEncode(ev)
	if err != nil {
		return err
	}
	if q.w != nil && q.w.seg.bytes+int64(len(line)) > linkSpoolSegmentBytes {
		if err := q.finish(); err != nil {
			return err
		}
	}
	if !q.sp.charge(int64(len(line))) {
		return errLinkSpoolFull
	}
	if q.w == nil {
		if err := os.MkdirAll(q.dir, 0o700); err != nil {
			q.sp.uncharge(int64(len(line)))
			return err
		}
		seg := &linkSpoolSegment{path: filepath.Join(q.dir, linkSpoolSegmentName(ev.seq, ev.seq, true)), first: ev.seq}
		f, err := os.OpenFile(seg.path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			q.sp.uncharge(int64(len(line)))
			return err
		}
		q.w = &linkSpoolWriter{f: f, buf: bufio.NewWriterSize(f, 64<<10), seg: seg}
		q.segs = append(q.segs, seg)
	}
	if _, err := q.w.buf.Write(line); err != nil {
		q.sp.uncharge(int64(len(line)))
		return err
	}
	seg := q.w.seg
	seg.last, seg.n, seg.bytes = ev.seq, seg.n+1, seg.bytes+int64(len(line))
	q.n++
	return nil
}

// finish closes the open segment and names it for the events it holds.
func (q *linkSpoolQueue) finish() error {
	w := q.w
	if w == nil {
		return nil
	}
	q.w = nil
	err := w.buf.Flush()
	if err == nil {
		err = w.f.Sync()
	}
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	finished := filepath.Join(q.dir, linkSpoolSegmentName(w.seg.first, w.seg.last, false))
	if rerr := os.Rename(w.seg.path, finished); rerr == nil {
		w.seg.path = finished
	} else if err == nil {
		err = rerr
	}
	return err
}

// takeFirst takes the oldest segment off the disk: its events after stored. A segment that cannot be read whole is
// reported, and what it lost leaves a gap the stream crosses on its next connection.
func (q *linkSpoolQueue) takeFirst(stored uint64) []*linkEvent {
	if len(q.segs) == 0 {
		return nil
	}
	seg := q.segs[0]
	if q.w != nil && q.w.seg == seg {
		_ = q.finish()
	}
	events, err := linkSpoolRead(seg.path, stored)
	if err != nil {
		read := uint64(0)
		if len(events) > 0 {
			read = events[len(events)-1].seq
		}
		q.sp.log(fmt.Sprintf("runner link: the event spool lost events of a session: %v; seqs %d-%d are gone (read through %d)",
			err, seg.first, seg.last, read))
	}
	q.dropSegment(0)
	return events
}

// dropThrough removes every segment whose events are all stored through seq, and returns how many events they held.
func (q *linkSpoolQueue) dropThrough(seq uint64) int {
	dropped := 0
	for len(q.segs) > 0 && q.segs[0].last <= seq && (q.w == nil || q.w.seg != q.segs[0]) {
		dropped += q.segs[0].n
		q.dropSegment(0)
	}
	return dropped
}

func (q *linkSpoolQueue) dropSegment(i int) {
	seg := q.segs[i]
	_ = os.Remove(seg.path)
	q.sp.uncharge(seg.bytes)
	q.n -= seg.n
	q.segs = append(q.segs[:i], q.segs[i+1:]...)
	if len(q.segs) == 0 {
		_ = os.Remove(q.dir) // only once it is empty
	}
}

// remove deletes the session's spool: nothing in it will ever be stored.
func (q *linkSpoolQueue) remove() {
	if q.w != nil {
		_ = q.w.f.Close()
		q.w = nil
	}
	for _, seg := range q.segs {
		q.sp.uncharge(seg.bytes)
	}
	q.segs, q.n = nil, 0
	_ = os.RemoveAll(q.dir)
}

// persist writes what the stream holds in memory to disk, around what is there already: head, the events before
// everything on disk, and tail, those after it. The segments are finished and synced, for the next process.
func (q *linkSpoolQueue) persist(head, tail []*linkEvent) error {
	if err := q.finish(); err != nil {
		return err
	}
	for _, events := range [][]*linkEvent{head, tail} {
		if len(events) == 0 {
			continue
		}
		if err := os.MkdirAll(q.dir, 0o700); err != nil {
			return err
		}
		first, last := events[0].seq, events[len(events)-1].seq
		path := filepath.Join(q.dir, linkSpoolSegmentName(first, last, false))
		if err := linkSpoolWrite(path, events); err != nil {
			_ = os.Remove(path)
			return err
		}
		size := int64(0)
		if info, err := os.Stat(path); err == nil {
			size = info.Size()
		}
		q.sp.mu.Lock()
		q.sp.bytes += size // kept whatever the bound: this is the runner stopping
		q.sp.mu.Unlock()
		seg := &linkSpoolSegment{path: path, first: first, last: last, n: len(events), bytes: size}
		if len(q.segs) > 0 && first < q.segs[0].first {
			q.segs = append([]*linkSpoolSegment{seg}, q.segs...)
		} else {
			q.segs = append(q.segs, seg)
		}
		q.n += len(events)
	}
	return nil
}
