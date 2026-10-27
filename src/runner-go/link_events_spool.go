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
	"sync/atomic"
	"time"
)

// The disk half of the runner link's durable event buffer (docs/runner-link-design.md §5.8; task B8). A session's
// unacknowledged events past what memory may hold (linkSessionMemoryBytes, linkTotalMemoryBytes) wait here, in order,
// until the stream has room to send them; and when the runner stops, everything a session still holds is written here,
// so the next process sends it first (link_events.go).
//
// One directory per session under ~/.orbit/link-spool, holding segments of consecutive events, one JSON line per event.
// A segment being written is <first seq>.open.jsonl; a finished one is <first seq>-<last seq>.jsonl, with seqs
// zero-padded so that names sort in seq order. A segment's seqs follow one another: an event numbered after a jump (a
// Welcome lifted the session's floor) starts a segment of its own, so there may be a gap between two segments, never
// inside one. An event counts once its line is in the segment's file; a write the disk refuses counts nothing and
// finishes the segment for what it holds, and the stream keeps that event in memory instead. A process that dies while
// writing leaves an open segment whose last line may be cut short: the next one keeps its whole lines. A segment read
// into memory to be sent stays on disk until every event in it is stored (task 34mwBTpOPo3S9LM2SXs10): a process killed
// while it sends one (SIGKILL, the OOM killer) leaves it for the next, which sends it again, and the control plane
// stores each seq once. Every spool
// together stays within linkSpoolMaxBytes; past it, a session's events stay in memory instead (linkEventStream.over).
// A session's spool nobody has opened for linkSpoolStaleAfter is removed when a process starts: whatever session it
// was is long settled. What the spool loses (a segment that does not read back whole, a stopping runner's events the
// disk would not take) is logged and counted (linkSpool.lost).

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
	// lost counts the events the spool lost: in segments that did not read back whole, and those of a stopping runner
	// the disk would not take. lostCompletions counts the turn completions kept beside them (turn_complete_journal.go)
	// that the cleanup removed unsent.
	lost            atomic.Uint64
	lostCompletions atomic.Uint64

	mu    sync.Mutex
	bytes int64
}

// losing counts n events lost, and says how many have been lost so far.
func (sp *linkSpool) losing(n int) uint64 { return sp.lost.Add(uint64(n)) }

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
				if strings.HasSuffix(f.Name(), ".jsonl") {
					size += info.Size() // the segments: what the spool's bound is about
				}
				if info.ModTime().After(newest) {
					newest = info.ModTime()
				}
			}
		}
		if len(files) == 0 || time.Since(newest) > linkSpoolStaleAfter {
			// Every event still in it is one the control plane never acknowledged, and none of it will reach it now: said
			// before it goes, session by session, with how many and which, and counted as lost. So is every turn
			// completion kept beside them, which the control plane never answered.
			if n, first, last := linkSpoolDirEvents(dir, files); n > 0 {
				sp.log(fmt.Sprintf("runner link: removing the event spool of session %s, untouched since %s: its %d events, of seqs %d-%d, were never acknowledged by the control plane and are lost (%d lost so far)",
					entry.Name(), newest.Format(time.RFC3339), n, first, last, sp.losing(n)))
			}
			if turns := linkSpoolDirCompletions(dir, files); len(turns) > 0 {
				sp.log(fmt.Sprintf("runner link: removing the event spool of session %s, untouched since %s: its %d kept turn completion(s), of turn(s) %s, were never answered by the control plane and are lost (%d lost so far)",
					entry.Name(), newest.Format(time.RFC3339), len(turns), strings.Join(turns, ", "), sp.lostCompletions.Add(uint64(len(turns)))))
			}
			if err := os.RemoveAll(dir); err != nil {
				sp.log(fmt.Sprintf("runner link: the event spool of session %s could not be removed: %v", entry.Name(), err))
			} else if len(files) > 0 {
				sp.log(fmt.Sprintf("runner link: removed the event spool of session %s, untouched since %s", entry.Name(), newest.Format(time.RFC3339)))
			}
			continue
		}
		sp.bytes += size
	}
}

// linkSpoolDirEvents is how many events a session's spool directory holds, and the lowest and highest of their seqs: a
// finished segment's by its name, an open one's by its whole lines (load).
func linkSpoolDirEvents(dir string, files []os.DirEntry) (n int, first, last uint64) {
	note := func(a, b uint64, count int) {
		if count <= 0 {
			return
		}
		if n == 0 || a < first {
			first = a
		}
		last = max(last, b)
		n += count
	}
	for _, f := range files {
		name := f.Name()
		switch {
		case strings.HasSuffix(name, ".open.jsonl"):
			if events, _, _ := linkSpoolRead(filepath.Join(dir, name), 0); len(events) > 0 {
				note(events[0].seq, events[len(events)-1].seq, len(events))
			}
		case strings.HasSuffix(name, ".jsonl"):
			if a, b, ok := linkSpoolRange(strings.TrimSuffix(name, ".jsonl")); ok {
				note(a, b, int(b-a+1))
			}
		}
	}
	return n, first, last
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
	// taken are the segments read into the stream's memory (takeFirst) and kept on disk until every event in them is
	// stored (dropThrough). Neither n nor segs counts them: their events are the stream's memory's now.
	taken []*linkSpoolSegment
}

type linkSpoolSegment struct {
	path        string
	first, last uint64
	n           int
	bytes       int64
	// lastRow is the highest seq in it of an event the control plane stores as a row (linkEvent.row); last for a segment
	// an earlier process finished, which is known by its name only.
	lastRow uint64
}

// linkSpoolWriter writes the open segment, one whole line at a time at the end of what the file holds.
type linkSpoolWriter struct {
	f   *os.File
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
// finishes it. A gap between two segments is kept: what follows a jump in seqs (a Welcome lifted the session's floor)
// is as good as what precedes it, and the stream crosses the gap on a new connection. A segment that overlaps the one
// before it was never written by a spool, and is removed.
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
			segs = append(segs, &linkSpoolSegment{path: path, first: first, last: last, n: int(last - first + 1), bytes: info.Size(),
				lastRow: last})
		}
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].first < segs[j].first })
	kept := segs[:0]
	for _, seg := range segs {
		if n := len(kept); n > 0 && seg.first <= kept[n-1].last {
			lost := q.sp.losing(seg.n)
			q.sp.log(fmt.Sprintf("runner link: the event spool in %s holds seqs %d-%d twice; %s, which holds them again, is removed (%d events lost so far)",
				q.dir, seg.first, min(seg.last, kept[n-1].last), filepath.Base(seg.path), lost))
			_ = os.Remove(seg.path)
			q.sp.uncharge(seg.bytes)
			continue
		}
		kept = append(kept, seg)
	}
	q.segs = kept
	for _, seg := range kept {
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
	events, _, err := linkSpoolRead(path, 0)
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
	seg := &linkSpoolSegment{path: finished, first: first, last: last, n: len(events), bytes: size}
	for _, ev := range events {
		if ev.row {
			seg.lastRow = ev.seq
		}
	}
	return seg
}

// linkSpoolRead reads a segment's events after stored, stopping at the first line that is not a whole event following
// on from the one before it, which it reports. read counts the whole lines, those through stored included.
func linkSpoolRead(path string, stored uint64) (events []*linkEvent, read int, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	var prev uint64
	for len(data) > 0 {
		line, rest, found := bytes.Cut(data, []byte("\n"))
		data = rest
		if !found {
			return events, read, fmt.Errorf("%s ends in a line cut short", filepath.Base(path))
		}
		var l linkSpoolLine
		if err := json.Unmarshal(line, &l); err != nil || l.Seq == 0 || (prev > 0 && l.Seq != prev+1) {
			return events, read, fmt.Errorf("%s has a damaged line after seq %d", filepath.Base(path), prev)
		}
		prev = l.Seq
		read++
		if l.Seq <= stored {
			continue
		}
		events = append(events, &linkEvent{seq: l.Seq, typ: l.Type, tsMs: l.TS, turnID: l.TurnID, payload: []byte(l.Payload),
			boundary: l.Boundary, critical: l.Critical, progress: l.Progress, row: linkRowPayload(l.Type, l.Payload)})
	}
	return events, read, nil
}

// linkRowPayload is linkRowEvent for an event as the spool keeps it: its payload still JSON.
func linkRowPayload(eventType string, payload json.RawMessage) bool {
	if eventType != evSystem {
		return !linkLiveOnlyTypes[eventType]
	}
	var p map[string]interface{}
	_ = json.Unmarshal(payload, &p)
	return linkRowEvent(eventType, p)
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

// append writes ev after everything on disk, in a segment of its own when it does not follow on from the open one's
// last seq. errLinkSpoolFull, or the disk's own error, says it did not: then the open segment is finished for what its
// file holds, and ev is not counted.
func (q *linkSpoolQueue) append(ev *linkEvent) error {
	line, err := linkSpoolEncode(ev)
	if err != nil {
		return err
	}
	if q.w != nil && (q.w.seg.bytes+int64(len(line)) > linkSpoolSegmentBytes || ev.seq != q.w.seg.last+1) {
		if err := q.finish(false); err != nil {
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
		q.w = &linkSpoolWriter{f: f, seg: seg}
	}
	seg := q.w.seg
	if n, err := q.w.f.WriteAt(line, seg.bytes); err != nil {
		q.sp.uncharge(int64(len(line)))
		if n > 0 {
			_ = q.w.f.Truncate(seg.bytes) // a line cut short is no line; the next process would keep the whole ones anyway
		}
		_ = q.finish(false)
		return err
	}
	if seg.n == 0 {
		q.segs = append(q.segs, seg)
	}
	seg.last, seg.n, seg.bytes = ev.seq, seg.n+1, seg.bytes+int64(len(line))
	if ev.row {
		seg.lastRow = ev.seq
	}
	q.n++
	return nil
}

// finish closes the open segment and names it for the events its file holds; one that holds none is removed. sync
// waits for the disk to have it: what a stopping runner leaves for the next process does, while a segment rotated or
// read back in the meantime need not, and a sync there would hold up the session's flush behind a busy disk.
func (q *linkSpoolQueue) finish(sync bool) error {
	w := q.w
	if w == nil {
		return nil
	}
	q.w = nil
	var err error
	if sync {
		err = w.f.Sync()
	}
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	if w.seg.n == 0 {
		_ = os.Remove(w.seg.path)
		return err
	}
	finished := filepath.Join(q.dir, linkSpoolSegmentName(w.seg.first, w.seg.last, false))
	if rerr := os.Rename(w.seg.path, finished); rerr == nil {
		w.seg.path = finished
	} else if err == nil {
		err = rerr
	}
	return err
}

// takeFirst takes the oldest segment's events into memory: those after stored. The segment stays on disk, taken, until
// every event in it is stored (dropThrough), so that a process killed before then leaves it to the next. What of it
// does not read back is logged and counted as lost, and leaves a gap the stream crosses on its next connection; what
// does is kept in a segment of its own in its place, so that the next process reads only that.
func (q *linkSpoolQueue) takeFirst(stored uint64) []*linkEvent {
	if len(q.segs) == 0 {
		return nil
	}
	seg := q.segs[0]
	if q.w != nil && q.w.seg == seg {
		_ = q.finish(false)
	}
	events, read, err := linkSpoolRead(seg.path, stored)
	q.segs = q.segs[1:]
	q.n -= seg.n
	if gone := seg.n - read; gone > 0 {
		lost := q.sp.losing(gone)
		q.sp.log(fmt.Sprintf("runner link: the event spool lost %d events of a session, of seqs %d-%d: %v (%d lost so far)",
			gone, seg.first, seg.last, err, lost))
		seg = q.rewrite(seg, events)
	} else if len(events) == 0 {
		q.drop(seg) // every event in it is stored
		seg = nil
	}
	if seg != nil {
		q.taken = append(q.taken, seg)
	}
	return events
}

// rewrite replaces a segment that did not read back whole with one of the events that did, events, and returns it; nil
// when there are none, or the disk does not take them, which leaves them in memory alone.
func (q *linkSpoolQueue) rewrite(seg *linkSpoolSegment, events []*linkEvent) *linkSpoolSegment {
	// Written before the damaged one goes, which takes the directory with it when nothing else is in it.
	var whole *linkSpoolSegment
	if len(events) > 0 {
		whole = &linkSpoolSegment{path: filepath.Join(q.dir, linkSpoolSegmentName(events[0].seq, events[len(events)-1].seq, false)),
			first: events[0].seq, last: events[len(events)-1].seq, n: len(events)}
		if err := linkSpoolWrite(whole.path, events); err != nil {
			_ = os.Remove(whole.path)
			whole = nil
		}
	}
	if whole != nil {
		if info, err := os.Stat(whole.path); err == nil {
			whole.bytes = info.Size()
		}
		q.sp.mu.Lock()
		q.sp.bytes += whole.bytes
		q.sp.mu.Unlock()
		for _, ev := range events {
			if ev.row {
				whole.lastRow = ev.seq
			}
		}
	}
	q.drop(seg)
	return whole
}

// dropThrough removes every segment whose events are all stored through seq, the open one and the taken ones too, and
// returns how many events those not taken held and the highest seq among them of an event stored as a row: the taken
// ones' events are the stream's memory's, which counts them itself.
func (q *linkSpoolQueue) dropThrough(seq uint64) (dropped int, lastRow uint64) {
	for len(q.segs) > 0 && q.segs[0].last <= seq {
		if q.w != nil && q.w.seg == q.segs[0] {
			_ = q.finish(false)
		}
		dropped += q.segs[0].n
		lastRow = max(lastRow, q.segs[0].lastRow)
		q.dropSegment(0)
	}
	for len(q.taken) > 0 && q.taken[0].last <= seq {
		seg := q.taken[0]
		q.taken = q.taken[1:]
		q.drop(seg)
	}
	return dropped, lastRow
}

func (q *linkSpoolQueue) dropSegment(i int) {
	seg := q.segs[i]
	q.n -= seg.n
	q.segs = append(q.segs[:i], q.segs[i+1:]...)
	q.drop(seg)
}

// drop deletes a segment no longer in segs or taken, and the session's directory once it holds nothing more.
func (q *linkSpoolQueue) drop(seg *linkSpoolSegment) {
	_ = os.Remove(seg.path)
	q.sp.uncharge(seg.bytes)
	if len(q.segs) == 0 && len(q.taken) == 0 {
		_ = os.Remove(q.dir) // only once it is empty
	}
}

// remove deletes the session's spool: nothing in it will ever be stored. The turn completions kept beside it are not its
// to remove: they go when a supervisor sends them, or with the cleanup, each said (turn_complete_journal.go).
func (q *linkSpoolQueue) remove() {
	if q.w != nil {
		_ = q.w.f.Close()
		q.w = nil
	}
	for _, seg := range append(q.segs, q.taken...) {
		_ = os.Remove(seg.path)
		q.sp.uncharge(seg.bytes)
	}
	q.segs, q.taken, q.n = nil, nil, 0
	_ = os.Remove(q.dir) // only once it is empty
}

// untake hands the taken segments back to the disk's count, and returns the events of head none of them holds: those a
// taken segment holds are on disk already, for the next process.
func (q *linkSpoolQueue) untake(head []*linkEvent) []*linkEvent {
	if len(q.taken) == 0 {
		return head
	}
	var rest []*linkEvent
	for _, ev := range head {
		held := false
		for _, seg := range q.taken {
			held = held || (ev.seq >= seg.first && ev.seq <= seg.last)
		}
		if !held {
			rest = append(rest, ev)
		}
	}
	for _, seg := range q.taken {
		q.segs = append(q.segs, seg)
		q.n += seg.n
	}
	q.taken = nil
	return rest
}

// persist writes what the stream holds in memory to disk, around what is there already: head, the events before
// everything on disk, and tail, those after it, a segment for each run of consecutive seqs. What of head a taken
// segment holds stays in that segment, which is not written again. The segments are finished and synced, for the next
// process. A failure is no reason to stop: the open segment keeps what its file holds, and every run is written that
// the disk takes. It returns what failed; the events of a run that was not written are logged and counted as lost.
func (q *linkSpoolQueue) persist(head, tail []*linkEvent) error {
	errs := []error{q.finish(true)}
	head = q.untake(head)
	for _, events := range [][]*linkEvent{head, tail} {
		for len(events) > 0 {
			n := 1
			for n < len(events) && events[n].seq == events[n-1].seq+1 {
				n++
			}
			run := events[:n]
			events = events[n:]
			if err := q.persistRun(run); err != nil {
				lost := q.sp.losing(len(run))
				q.sp.log(fmt.Sprintf("runner link: %d events of seqs %d-%d could not be kept for the next process: %v (%d lost so far)",
					len(run), run[0].seq, run[len(run)-1].seq, err, lost))
				errs = append(errs, err)
			}
		}
	}
	sort.Slice(q.segs, func(i, j int) bool { return q.segs[i].first < q.segs[j].first })
	return errors.Join(errs...)
}

// persistRun writes one run of consecutive events as a finished, synced segment.
func (q *linkSpoolQueue) persistRun(run []*linkEvent) error {
	if err := os.MkdirAll(q.dir, 0o700); err != nil {
		return err
	}
	first, last := run[0].seq, run[len(run)-1].seq
	path := filepath.Join(q.dir, linkSpoolSegmentName(first, last, false))
	if err := linkSpoolWrite(path, run); err != nil {
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
	seg := &linkSpoolSegment{path: path, first: first, last: last, n: len(run), bytes: size}
	for _, ev := range run {
		if ev.row {
			seg.lastRow = ev.seq
		}
	}
	q.segs = append(q.segs, seg)
	q.n += len(run)
	return nil
}
